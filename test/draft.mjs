/**
 * Draft compatibility checks for the browser half.
 *
 * The helpers live inside the loader factory (there is no build step and no
 * separate module), so this test extracts the marked helper block from
 * `client.js` and exercises it directly. It covers the two quote shapes the
 * composer can hold — the official QuoteNode and `dsh-client-ui-quote`'s
 * reference chip — plus the guards that must still refuse a rewrite.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const source = fs.readFileSync(clientPath, 'utf8')
const start = source.indexOf('    const COMPOSER_CARD')
const end = source.indexOf('    // --- end draft compatibility helpers')
if (start < 0 || end < 0) throw new Error('draft compatibility helper markers not found in client.js')
const helpers = source.slice(start, end)
const api = new Function(
  `${helpers}
  return { formatQuoteText, isQuoteChip, referenceOf, snapshotOf, findFreeSpan, readQuoteTexts, planEnhancement, enhancedSnapshot }`,
)()
const { formatQuoteText, planEnhancement, enhancedSnapshot } = api

let passed = 0
let failed = 0
function assert(condition, label) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`FAIL ${label}`)
}
function eq(actual, expected, label) {
  assert(
    actual === expected,
    `${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  )
}

/** Assert the host's DraftSnapshot invariants for one produced document. */
function validate(snapshot, label) {
  assert(typeof snapshot.text === 'string', `${label}: text is a string`)
  let end = 0
  for (const reference of snapshot.references) {
    assert(Number.isInteger(reference.offset) && reference.offset >= end, `${label}: ref offset ordered`)
    assert(Number.isInteger(reference.length) && reference.length > 0, `${label}: ref length positive`)
    eq(reference.length, reference.clipboardText.length, `${label}: ref length matches clipboardText`)
    eq(
      snapshot.text.slice(reference.offset, reference.offset + reference.length),
      reference.clipboardText,
      `${label}: ref text slice`,
    )
    end = reference.offset + reference.length
  }
  let quoteEnd = 0
  for (const quote of snapshot.quotes) {
    assert(Number.isInteger(quote.offset) && quote.offset >= quoteEnd, `${label}: quote offset ordered`)
    const formatted = formatQuoteText(quote.text)
    eq(quote.length, formatted.length, `${label}: quote length matches formatted text`)
    eq(snapshot.text.slice(quote.offset, quote.offset + quote.length), formatted, `${label}: quote text slice`)
    quoteEnd = quote.offset + quote.length
  }
  const spans = [
    ...snapshot.references.map((reference) => [reference.offset, reference.length]),
    ...snapshot.quotes.map((quote) => [quote.offset, quote.length]),
  ].sort((a, b) => a[0] - b[0])
  for (let index = 1; index < spans.length; index += 1) {
    assert(spans[index][0] >= spans[index - 1][0] + spans[index - 1][1], `${label}: spans do not overlap`)
  }
}

// 1. Plain text stays a plain rewrite.
{
  const draft = '帮我把这个插件的 readme 改成中文'
  const plan = planEnhancement({ draft, occurrences: [] }, [])
  eq(plan.kind, 'ok', 'plain: ok')
  eq(plan.ownText, draft, 'plain: own text is the draft')
  eq(plan.spans.length, 0, 'plain: no spans')
  eq(plan.previous, draft, 'plain: undo keeps the string form')
}

// 2. A dsh-client-ui-quote chip is preserved above the rewrite.
{
  const wire = '\n❝引用内容❞\n\n'
  const own = '做一次交付前的自查吧'
  const draft = wire + own
  const occurrence = { source: 'quote', ref: wire, offset: 0, length: wire.length, label: '引用内容', clipboardText: wire }
  const plan = planEnhancement({ draft, occurrences: [occurrence] }, [])
  eq(plan.kind, 'ok', 'quote chip: ok')
  eq(plan.ownText, own, 'quote chip: own text')
  eq(plan.spans.length, 1, 'quote chip: one span')
  validate(plan.previous, 'quote chip previous')
  const next = enhancedSnapshot(plan.spans, '请做一次交付前的自查。')
  validate(next, 'quote chip next')
  eq(next.text, '❝引用内容❞\n\n请做一次交付前的自查。', 'quote chip: quote stays above rewrite')
}

// 3. An official QuoteNode is preserved above the rewrite.
{
  const quote = '没有做的兼容处理：官方「引用」'
  const formatted = formatQuoteText(quote)
  const own = '做一次交付前的自查吧'
  const draft = `${formatted}\n\n${own}`
  const plan = planEnhancement({ draft, occurrences: [] }, [quote])
  eq(plan.kind, 'ok', 'official quote: ok')
  eq(plan.ownText, own, 'official quote: own text')
  eq(plan.spans.length, 1, 'official quote: one span')
  validate(plan.previous, 'official quote previous')
  const next = enhancedSnapshot(plan.spans, '请在发版前完成一次交付自查。')
  validate(next, 'official quote next')
  eq(next.text, `${formatted}\n\n请在发版前完成一次交付自查。`, 'official quote: quote stays above rewrite')
}

// 4. File/session references still block: moving them would change the prompt.
{
  const plan = planEnhancement(
    {
      draft: '@[a](file:a.txt) 看看',
      occurrences: [{ source: 'file', ref: 'file:a.txt', offset: 0, length: 16, label: 'a.txt', clipboardText: '@[a](file:a.txt)' }],
    },
    [],
  )
  eq(plan.kind, 'blocked', 'file ref: blocked')
  eq(plan.reason, 'reference', 'file ref: reason')
}

// 5. A claimed command still blocks.
{
  const plan = planEnhancement({ draft: '/goal 做点事', occurrences: [], claim: { token: '/goal' } }, [])
  eq(plan.kind, 'blocked', 'command: blocked')
  eq(plan.reason, 'command', 'command: reason')
}

// 6. A quote with no reader text has nothing to enhance.
{
  const wire = '\n❝只有引用❞\n\n'
  const plan = planEnhancement(
    { draft: wire, occurrences: [{ source: 'quote', ref: wire, offset: 0, length: wire.length, label: '只有引用', clipboardText: wire }] },
    [],
  )
  eq(plan.kind, 'empty', 'only quote: empty')
}

// 7. A quote node the DOM could not explain is left alone.
{
  const plan = planEnhancement({ draft: '> 别的内容\n\n做点事', occurrences: [] }, ['找不到的引用'])
  eq(plan.kind, 'blocked', 'unlocatable quote: blocked')
  eq(plan.reason, 'quote', 'unlocatable quote: reason')
}

// 8. Without DOM access, a blockquote draft is not rewritten into plain text.
{
  const plan = planEnhancement({ draft: '> 引用\n\n做点事', occurrences: [] }, null)
  eq(plan.kind, 'blocked', 'unknown official quote: blocked')
  eq(plan.reason, 'quote', 'unknown official quote: reason')
}

// 9. Two quotes with interleaved reader text.
{
  const first = '第一段'
  const second = '第二段'
  const draft = `${formatQuoteText(first)}\n\n中间的提示词\n\n${formatQuoteText(second)}\n\n收尾的提示词`
  const plan = planEnhancement({ draft, occurrences: [] }, [first, second])
  eq(plan.kind, 'ok', 'two quotes: ok')
  eq(plan.ownText, '中间的提示词\n\n收尾的提示词', 'two quotes: own text')
  const next = enhancedSnapshot(plan.spans, '增强后的提示词')
  validate(next, 'two quotes next')
  eq(next.text, `${formatQuoteText(first)}\n${formatQuoteText(second)}\n\n增强后的提示词`, 'two quotes: both above rewrite')
}

// 10. Duplicate quote texts match in document order.
{
  const quote = '同一句'
  const draft = `${formatQuoteText(quote)}\n\n先\n\n${formatQuoteText(quote)}\n\n后`
  const plan = planEnhancement({ draft, occurrences: [] }, [quote, quote])
  eq(plan.kind, 'ok', 'duplicate quotes: ok')
  assert(plan.spans[0].offset < plan.spans[1].offset, 'duplicate quotes: ordered')
  validate(plan.previous, 'duplicate quotes previous')
}

console.log(`\n${passed} checks passed, ${failed} failed`)
if (failed > 0) process.exit(1)
