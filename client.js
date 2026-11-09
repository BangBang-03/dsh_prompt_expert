/**
 * dsh-prompt-expert — browser half.
 *
 * The form is copied from WorkBuddy's composer enhancer, which is one icon
 * button in the action row that changes state in place:
 *
 *   idle     ✨  "增强提示词"   click → rewrite the draft
 *   working  ◌   "增强中..."    click → cancel
 *   applied  ↩   "恢复原文"     click → put the previous draft back
 *   error    ✨  <the error>    click → retry (red tint, tooltip carries it)
 *
 * The rewrite is written straight into the input — no preview panel, no
 * before/after diff. The reader's own next edit ends the "applied" state, so
 * the button never offers an undo for text they already changed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-expert',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-expert'
    const ENDPOINT = '/prompt-expert/enhance'

    /**
     * Host-owned composer markers. A quoted selection is either an official
     * `QuoteNode` (rendered as `[data-composer-quote]` with its full text in
     * `[data-quote-preview-text]`) or a reference chip owned by
     * `dsh-client-ui-quote` (source `quote`, wire text starting with `❝`).
     * Both have to survive an enhancement; only the reader's own words are
     * rewritten.
     */
    const COMPOSER_CARD = '[data-composer-card]'
    const COMPOSER_QUOTE = '[data-composer-quote]'
    const COMPOSER_QUOTE_TEXT = '[data-quote-preview-text]'
    const QUOTE_SOURCE = 'quote'
    const QUOTE_MARK = '❝'

    // --- draft compatibility helpers ---------------------------------------

    /** The host's Markdown form for one official quote (blockquote lines). */
    function formatQuoteText(text) {
      return String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => `> ${line}`).join('\n')
    }

    /** Whether one state occurrence is a quoted selection, not a file/session ref. */
    function isQuoteChip(occurrence) {
      if (occurrence === null || typeof occurrence !== 'object') return false
      if (occurrence.source === QUOTE_SOURCE) return true
      const clipboardText = typeof occurrence.clipboardText === 'string' ? occurrence.clipboardText : ''
      return clipboardText.includes(QUOTE_MARK)
    }

    /** Snapshot reference form of one chip; editor-local ids are dropped. */
    function referenceOf(occurrence, offset, clipboardText) {
      return {
        source: occurrence.source,
        ref: occurrence.ref,
        offset,
        length: clipboardText.length,
        label: typeof occurrence.label === 'string' ? occurrence.label : clipboardText,
        clipboardText,
        ...(occurrence.appearance === undefined ? {} : { appearance: occurrence.appearance }),
        ...(occurrence.invalid === true ? { invalid: true } : {}),
      }
    }

    /** One snapshot (text + atomic spans) rebuilt from the current draft. */
    function snapshotOf(draft, spans) {
      const references = []
      const quotes = []
      for (const span of spans) {
        if (span.kind === 'quote') quotes.push({ offset: span.offset, length: span.length, text: span.text })
        else references.push(referenceOf(span.occurrence, span.offset, span.originalText))
      }
      return { text: draft, references, quotes }
    }

    /** Find `text` in the draft without matching inside an atomic span. */
    function findFreeSpan(draft, text, spans, from) {
      const occupied = [...spans].sort((a, b) => a.offset - b.offset)
      let cursor = from
      for (;;) {
        const at = draft.indexOf(text, cursor)
        if (at < 0) return -1
        const end = at + text.length
        let blocked = false
        for (const span of occupied) {
          if (at < span.offset + span.length && end > span.offset) {
            blocked = true
            cursor = span.offset + span.length
            break
          }
        }
        if (!blocked) return at
      }
    }

    /**
     * Read the official quote nodes of the composer that owns `button`.
     * `null` means the DOM could not be inspected; an array (possibly empty)
     * is the complete ordered list of quote texts.
     */
    function readQuoteTexts(button) {
      try {
        const card = button !== null && typeof button.closest === 'function' ? button.closest(COMPOSER_CARD) : null
        if (card === null || card === undefined) return null
        const texts = []
        for (const node of card.querySelectorAll(COMPOSER_QUOTE)) {
          const textNode = node.querySelector(COMPOSER_QUOTE_TEXT)
          if (textNode === null) return null
          texts.push(textNode.textContent ?? '')
        }
        return texts
      } catch {
        return null
      }
    }

    /**
     * Work out what can be rewritten without touching the reader's chips.
     * Quoted selections are kept verbatim and moved above the rewrite; file
     * or session references and slash commands still block, because moving
     * those would change the meaning of the prompt.
     */
    function planEnhancement(state, quoteTexts) {
      const draft = typeof state?.draft === 'string' ? state.draft : ''
      const occurrences = Array.isArray(state?.occurrences) ? state.occurrences : []
      const spans = []
      for (const occurrence of occurrences) {
        if (occurrence === null || typeof occurrence !== 'object') continue
        if (!isQuoteChip(occurrence)) return { kind: 'blocked', reason: 'reference' }
        const originalText = typeof occurrence.clipboardText === 'string' ? occurrence.clipboardText : ''
        const placementText = originalText.replace(/^\n+/, '').replace(/\n+$/, '')
        if (
          placementText === ''
          || typeof occurrence.ref !== 'string'
          || typeof occurrence.offset !== 'number'
          || occurrence.offset < 0
        ) {
          return { kind: 'blocked', reason: 'reference' }
        }
        spans.push({
          kind: 'reference',
          occurrence,
          offset: occurrence.offset,
          length: originalText.length,
          originalText,
          placementText,
        })
      }
      if (state?.claim !== undefined) return { kind: 'blocked', reason: 'command' }

      if (Array.isArray(quoteTexts)) {
        let from = 0
        for (const text of quoteTexts) {
          if (String(text).trim() === '') continue
          const clipboardText = formatQuoteText(text)
          if (clipboardText.trim() === '') continue
          const offset = findFreeSpan(draft, clipboardText, spans, from)
          if (offset < 0) return { kind: 'blocked', reason: 'quote' }
          spans.push({
            kind: 'quote',
            text,
            offset,
            length: clipboardText.length,
            originalText: clipboardText,
            placementText: clipboardText,
          })
          from = offset + clipboardText.length
        }
      } else if (/^ {0,3}>/mu.test(draft)) {
        // No DOM to read the quote node from: replacing the draft would turn
        // its atomic quote into plain text, so leave the draft alone.
        return { kind: 'blocked', reason: 'quote' }
      }

      spans.sort((a, b) => a.offset - b.offset)
      for (let i = 1; i < spans.length; i += 1) {
        if (spans[i].offset < spans[i - 1].offset + spans[i - 1].length) {
          return { kind: 'blocked', reason: 'reference' }
        }
      }

      // Everything outside the atomic spans is the prompt to rewrite.
      let ownText = ''
      let cursor = 0
      for (const span of spans) {
        ownText += draft.slice(cursor, span.offset)
        cursor = span.offset + span.length
      }
      ownText += draft.slice(cursor)
      ownText = ownText.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
      if (ownText === '') return { kind: 'empty' }
      return { kind: 'ok', ownText, spans, previous: spans.length === 0 ? draft : snapshotOf(draft, spans) }
    }

    /** Rebuild the draft with every preserved span above the rewritten text. */
    function enhancedSnapshot(spans, enhanced) {
      let text = ''
      const references = []
      const quotes = []
      for (const span of spans) {
        if (text !== '' && !text.endsWith('\n')) text += '\n'
        const offset = text.length
        text += span.placementText
        if (span.kind === 'quote') quotes.push({ offset, length: span.placementText.length, text: span.text })
        else references.push(referenceOf(span.occurrence, offset, span.placementText))
      }
      if (text !== '') {
        if (!text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n'
      }
      text += enhanced
      return { text, references, quotes }
    }

    // --- end draft compatibility helpers -----------------------------------

    /** Simplified Chinese copy (the source of truth). */
    const zh = {
      'button.title': '增强提示词',
      'button.busy': '增强中...',
      'button.revert': '恢复原文',
      'error.generic': '增强失败，请重试。',
      'error.empty': '模型没有返回内容，请重试。',
      'error.chips': '草稿里有文件/会话引用或命令，请先移除再增强。',
      'error.quote': '暂时无法识别这条引用，请先移除再增强。',
      'error.onlyQuote': '输入框里只有引用，没有可增强的文字。',
      'error.noInput': '当前输入框不可写，无法填回结果。',
    }

    /** English copy, used when the page is not in Chinese. */
    const en = {
      'button.title': 'Enhance prompt',
      'button.busy': 'Enhancing...',
      'button.revert': 'Revert to original',
      'error.generic': 'Enhancement failed. Try again.',
      'error.empty': 'The model returned nothing. Try again.',
      'error.chips': 'The draft contains a file/session reference or a command; remove it first.',
      'error.quote': 'This quote could not be recognized; remove it first.',
      'error.onlyQuote': 'The input contains only a quote, so there is no text to enhance.',
      'error.noInput': 'This composer is not writable, so the result cannot be filled back.',
    }

    const dictionaries = { zh, en }

    /** The page's active dictionary, chosen without depending on the locale seat. */
    function activeDictionary() {
      try {
        const lang = String(document.documentElement.lang || navigator.language || '').toLowerCase()
        if (lang !== '' && !lang.startsWith('zh')) return en
      } catch {
        // A locked-down shell without a document: the user's language wins.
      }
      return zh
    }

    const dict = activeDictionary()

    /** Translate one key, preferring the locale seat the slot may provide. */
    function translate(props, key) {
      try {
        if (typeof props.t === 'function') {
          const localized = props.t(key)
          if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
        }
      } catch {
        // The seat is optional; never let it break the button.
      }
      return dict[key] ?? zh[key] ?? key
    }

    /** A four-point sparkle, drawn with `currentColor`. */
    function SparkleIcon() {
      return h(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M8 1.5 9.65 6.35 14.5 8 9.65 9.65 8 14.5 6.35 9.65 1.5 8 6.35 6.35Z',
          fill: 'currentColor',
        }),
      )
    }

    /** A left-turning return arrow: put the previous draft back. */
    function RevertIcon() {
      return h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M2.9 6.3h6.2a3.4 3.4 0 0 1 0 6.8H6.2' }),
        h('path', { d: 'M5.6 3.5 2.8 6.3l2.8 2.8' }),
      )
    }

    /** An indeterminate spinner, spun by the stylesheet. */
    function SpinnerIcon() {
      return h(
        'svg',
        {
          className: 'dpe-spin',
          width: 15,
          height: 15,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('circle', { cx: 8, cy: 8, r: 5.4, stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 1.6 }),
        h('path', { d: 'M8 2.6a5.4 5.4 0 0 1 5.4 5.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /**
     * The composer button.
     * @param {object} props - slot props: useInput, inputActions, sessionId, t.
     */
    function EnhanceButton(props) {
      const input = props.useInput((state) => state)
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const [phase, setPhase] = React.useState('idle')
      const [previous, setPrevious] = React.useState(null)
      const [applied, setApplied] = React.useState('')
      const [errorText, setErrorText] = React.useState('')
      const abortRef = React.useRef(null)
      const buttonRef = React.useRef(null)

      // A request still running when the composer unmounts must not hold a socket.
      React.useEffect(() => () => {
        const controller = abortRef.current
        if (controller !== null) controller.abort()
      }, [])

      // The reader's own edit ends the applied state: the undo would otherwise
      // offer to throw away text they have since written.
      React.useEffect(() => {
        if (phase === 'applied' && applied !== '' && draft.trim() !== applied.trim()) {
          setPhase('idle')
          setApplied('')
          setPrevious(null)
        }
      }, [applied, draft, phase])

      const fail = React.useCallback((key) => {
        setErrorText(translate(props, key))
        setPhase('error')
      }, [props])

      const start = React.useCallback(() => {
        const actions = props.inputActions
        if (draft.trim() === '') return
        if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') {
          fail('error.noInput')
          return
        }
        const plan = planEnhancement(input, readQuoteTexts(buttonRef.current))
        if (plan.kind === 'blocked') {
          fail(plan.reason === 'quote' ? 'error.quote' : 'error.chips')
          return
        }
        if (plan.kind === 'empty') {
          fail('error.onlyQuote')
          return
        }
        const controller = new AbortController()
        abortRef.current = controller
        setErrorText('')
        setPhase('busy')
        const body = { text: plan.ownText }
        if (typeof props.sessionId === 'string' && props.sessionId !== '') body.sessionId = props.sessionId
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
          .then(async (response) => {
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
              const detail = payload?.error?.message
              throw new Error(typeof detail === 'string' && detail !== '' ? detail : translate(props, 'error.generic'))
            }
            const next = typeof payload.value?.text === 'string' ? payload.value.text : ''
            if (next.trim() === '') throw new Error(translate(props, 'error.empty'))
            const write = plan.spans.length === 0 ? next : enhancedSnapshot(plan.spans, next)
            try {
              actions.setDraft(write)
            } catch {
              throw new Error(translate(props, 'error.noInput'))
            }
            setPrevious(plan.previous)
            setApplied(plan.spans.length === 0 ? next : write.text)
            setErrorText('')
            setPhase('applied')
          })
          .catch((error) => {
            if (controller.signal.aborted) {
              setPhase('idle')
              return
            }
            setErrorText(error instanceof Error && error.message !== '' ? error.message : translate(props, 'error.generic'))
            setPhase('error')
          })
          .finally(() => {
            if (abortRef.current === controller) abortRef.current = null
          })
      }, [draft, fail, input, props])

      const cancel = React.useCallback(() => {
        const controller = abortRef.current
        if (controller !== null) controller.abort()
        setPhase('idle')
      }, [])

      const revert = React.useCallback(() => {
        const actions = props.inputActions
        if (previous !== null && actions !== null && actions !== undefined && typeof actions.setDraft === 'function') {
          try {
            actions.setDraft(previous)
          } catch {
            // Keep the current draft instead of leaving an undo that cannot act.
          }
        }
        setApplied('')
        setPrevious(null)
        setErrorText('')
        setPhase('idle')
      }, [previous, props])

      const busy = phase === 'busy'
      const reverted = phase === 'applied'
      // WorkBuddy hides the control instead of showing a dead one.
      if (!busy && !reverted && draft.trim() === '') return null

      const label = phase === 'error' && errorText !== ''
        ? errorText
        : busy
          ? translate(props, 'button.busy')
          : reverted
            ? translate(props, 'button.revert')
            : translate(props, 'button.title')

      return h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'dpe-btn',
          'data-state': phase,
          title: label,
          'aria-label': label,
          onClick: busy ? cancel : reverted ? revert : start,
        },
        busy ? h(SpinnerIcon, null) : reverted ? h(RevertIcon, null) : h(SparkleIcon, null),
      )
    }

    const STYLES = `
.dpe-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);
cursor:pointer;transition:background-color .15s ease,color .15s ease;-webkit-app-region:no-drag}
.dpe-btn:hover{background:color-mix(in srgb,currentColor 10%,transparent);color:var(--dsw-alias-label-primary)}
.dpe-btn:active{background:color-mix(in srgb,currentColor 16%,transparent)}
.dpe-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dpe-btn[data-state="error"]{color:var(--dsw-alias-state-error-primary)}
.dpe-spin{animation:dpe-rotate .9s linear infinite;transform-origin:50% 50%}
@keyframes dpe-rotate{from{transform:rotate(0)}to{transform:rotate(360deg)}}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        // One stylesheet for the page, owned by this plugin's fiber.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-prompt-expert', '')
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => style.remove()
        }, 'prompt-expert: styles')

        // The locale seat is optional: the button ships its own dictionary, and
        // registering here only lets the host's language switch reach `t`.
        ctx.inject(['locale'], (localeCtx) => {
          const locale = localeCtx.get('locale')
          if (locale === undefined || typeof locale.register !== 'function') return
          return localeCtx.effect(() => locale.register(NS, dictionaries), 'prompt-expert: dictionaries')
        })

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'prompt-expert', order: 50, locale: NS },
          EnhanceButton,
        ))
      },
    }
  },
})
