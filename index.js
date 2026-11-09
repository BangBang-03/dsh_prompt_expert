/**
 * dsh-prompt-expert — host half.
 *
 * One loopback route, `POST /prompt-expert/enhance`: it hands the composer
 * draft to the harness `llm` service and returns the rewrite as plain text.
 * The browser half (`exports './client'`) owns the ✨ button, fills the result
 * back into the input, and remembers the previous draft for one-click undo.
 *
 * Deliberately small: no settings section, no slash command, no streaming, no
 * rate limiter beyond a concurrency fence. The model route is the profile's
 * default model, and the call is billed to the requesting session.
 * @module dsh-prompt-expert
 */

/** Loader entry name. */
export const name = 'prompt-expert'

/** The model service is the only hard dependency; the route waits for webServer. */
export const inject = ['llm']

/** Route prefix owned by this plugin. */
const PREFIX = '/prompt-expert'
/** The one exact endpoint the browser half calls. */
const ENDPOINT = `${PREFIX}/enhance`
/** Draft characters accepted per request (Unicode code points). */
const MAX_INPUT_CHARS = 12_000
/** Hard cap on the request body in bytes. */
const MAX_BODY_BYTES = 256 * 1024
/** In-flight limit: one writer plus one impatient second click. */
const MAX_CONCURRENT = 2
/** Wall-clock budget for one model call. */
const TIMEOUT_MS = 90_000
/** Model output budget; a prompt rewrite never needs more. */
const MAX_OUTPUT_TOKENS = 4096
/** Rewrites need no deep reasoning; measured 10x cheaper than the route default. */
const REASONING_EFFORT = 'off'
/** Harness code for "this model declares no reasoning capability". */
const UNSUPPORTED_REASONING_EFFORT = 'UNSUPPORTED_REASONING_EFFORT'

/**
 * Instruction for the rewrite.
 *
 * The rules that matter are the negative ones: keep the user's language and
 * facts, never pad a one-line request into a template, and return the prompt
 * itself rather than a commentary about it. An enhancer that inflates a short
 * ask into a wall of bullet points is worse than no enhancer at all.
 */
const SYSTEM_PROMPT = [
  '你是提示词改写助手。用户会给你一条随手写下的请求，请把它改写成一条更清晰、可直接执行的提示词。',
  '',
  '规则：',
  '1. 保持原语言：中文输入就输出中文，英文输入就输出英文。',
  '2. 保留全部具体信息与约束（路径、文件名、数字、模型名、偏好、限制），不要新增用户没有说过的事实或需求。',
  '3. 补足可执行性：说清目标、必要的上下文、要交付什么、有无格式或验收要求。按需补，不要套模板。',
  '4. 简单请求保持简短：篇幅和原文同一量级，最多略长。不要堆砌标题和清单。',
  '5. 去掉寒暄、客套、解释和空话。',
  '6. 只输出改写后的提示词正文：不要加“以下是优化后的提示词”这类开场白，不要用 markdown 代码块包裹。',
].join('\n')

/** Strip a surrounding code fence and a leading "优化后的提示词：" label. */
function normalizeOutput(raw) {
  let text = raw.replace(/\r\n/g, '\n').trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text)
  if (fence !== null && fence[1].trim() !== '') text = fence[1].trim()
  text = text.replace(
    /^(?:以下是|这是)?\s*(?:优化后|改写后|增强后|润色后|enhanced|optimized|rewritten)\s*(?:的)?\s*(?:提示词|prompt)\s*[:：]?\s*\n+/i,
    '',
  )
  return text.trim()
}

/** Count Unicode code points, so emoji and CJK count once. */
function lengthOf(text) {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Whether the request arrived from this machine and this app only. */
function isTrustedRequest(req) {
  const address = req.socket.remoteAddress ?? ''
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined) return false
  const host = req.headers.host
  if (typeof host !== 'string' || host.trim() === '') return true
  const hostname = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const name = hostname.startsWith('[') ? hostname.slice(1, hostname.indexOf(']')) : hostname.split(':')[0]
  if (name !== 'localhost' && name !== '127.0.0.1' && name !== '::1') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.trim() !== '') {
    try {
      const url = new URL(origin)
      const bare = url.hostname.replace(/^\[|\]$/g, '')
      if (bare !== 'localhost' && bare !== '127.0.0.1' && bare !== '::1') return false
      const hostPort = /:(\d+)$/.exec(host)
      if (hostPort !== null) {
        const originPort = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
        if (originPort !== hostPort[1]) return false
      }
    } catch {
      return false
    }
  }
  return true
}

/** Read a JSON body of at most `maxBytes`; throws 'too large' past the cap. */
async function readBoundedJson(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one uncached JSON response. */
function writeJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  } catch {
    // The browser went away mid-request; there is nothing left to answer.
  }
}

/** `{ ok: true, value }` server failure envelope. */
function fail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Resolve the profile's default model route, or undefined when unset. */
function resolveRoute(ctx) {
  const service = ctx.get('agentDefaultModel')
  let selection
  try {
    selection = service?.currentSelection?.()
  } catch {
    return undefined
  }
  const provider = typeof selection?.provider === 'string' ? selection.provider : ''
  const model = typeof selection?.model === 'string' ? selection.model : ''
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

/** Whether a finish reason is the harness refusing our explicit effort. */
function isEffortRejection(reason) {
  if (reason === null || typeof reason !== 'object') return false
  const failure = reason.failure
  const code = reason.kind === 'error' && failure !== null && typeof failure === 'object'
    ? failure.code
    : undefined
  return code === UNSUPPORTED_REASONING_EFFORT
}

/**
 * Run one rewrite. The reasoning effort is dropped and the call retried once
 * when the route refuses it outright (a model that declares no reasoning
 * capability, e.g. a pure chat model).
 * @param {object} ctx - plugin context carrying `llm`.
 * @param {{provider: string, model: string}} route - resolved model route.
 * @param {string} text - the draft to rewrite.
 * @param {string} [sessionId] - requesting session, for usage attribution.
 * @param {AbortSignal} signal - cancellation for this request.
 * @returns {Promise<string>} the rewrite.
 */
async function enhance(ctx, route, text, sessionId, signal) {
  const messages = [{ role: 'user', content: [{ type: 'text', text }] }]
  const attempt = async (withEffort) => {
    const options = {
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages,
      temperature: 0.4,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal,
      ...(withEffort ? { reasoningEffort: REASONING_EFFORT } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    let output = ''
    let reason
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
        else if (chunk.type === 'finish') reason = chunk.reason
      }
    } catch (error) {
      // Abort is the caller's own doing; everything else is an upstream failure.
      if (signal.aborted) throw error
      if (withEffort && isEffortRejection({ kind: 'error', failure: { code: error?.code } })) {
        return { retry: true }
      }
      throw error
    }
    if (withEffort && isEffortRejection(reason)) return { retry: true }
    return { retry: false, output, reason }
  }
  let result = await attempt(true)
  if (result.retry) result = await attempt(false)
  const reason = result.reason
  if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
    const detail = reason.kind === 'aborted' ? '模型调用已中止' : '模型服务返回错误'
    const message = typeof reason.failure?.message === 'string' ? `${detail}：${reason.failure.message}` : detail
    throw Object.assign(new Error(message), { code: 'upstream' })
  }
  return result.output
}

/** Serve one enhance request. */
async function serve(ctx, gate, req, res) {
  if (!isTrustedRequest(req)) return fail(res, 403, 'forbidden', '仅允许本机页面调用。')
  const pathname = new URL(req.url ?? '/', 'http://local').pathname
  if (pathname !== ENDPOINT) return fail(res, 404, 'not-found', '未知路径。')
  if (req.method !== 'POST') return fail(res, 405, 'method', '只支持 POST。')

  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    res.setHeader('connection', 'close')
    return fail(res, 413, 'too-large', '请求体过大。')
  }
  let body
  try {
    body = await readBoundedJson(req, MAX_BODY_BYTES)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'too large'
    return fail(res, tooLarge ? 413 : 400, 'bad-json', tooLarge ? '请求体过大。' : '请求体不是有效 JSON。')
  }
  const text = typeof body?.text === 'string' ? body.text : ''
  const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  if (text.trim() === '') return fail(res, 422, 'empty', '输入框为空。')
  if (lengthOf(text) > MAX_INPUT_CHARS) {
    return fail(res, 413, 'too-long', `内容超过 ${MAX_INPUT_CHARS} 个字符上限。`)
  }
  const route = resolveRoute(ctx)
  if (route === undefined) return fail(res, 409, 'no-model', '没有可用的默认模型，请先在会话里选择模型。')
  if (gate.active >= MAX_CONCURRENT) return fail(res, 429, 'busy', '已有增强请求在进行，请稍候。')

  gate.active += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onClosed = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.once('close', onClosed)
  const startedAt = Date.now()
  try {
    const raw = await enhance(ctx, route, text, sessionId, controller.signal)
    const enhanced = normalizeOutput(raw)
    if (enhanced === '') return fail(res, 502, 'empty-output', '模型返回了空结果，请重试。')
    writeJson(res, 200, {
      ok: true,
      value: { text: enhanced, provider: route.provider, model: route.model, elapsedMs: Date.now() - startedAt },
    })
  } catch (error) {
    if (controller.signal.aborted && Date.now() - startedAt >= TIMEOUT_MS) {
      return fail(res, 504, 'timeout', '增强超时，请重试。')
    }
    if (res.writableEnded) return
    const message = error instanceof Error ? error.message : String(error)
    fail(res, 502, 'upstream', message === '' ? '模型调用失败。' : message)
  } finally {
    clearTimeout(timer)
    res.off('close', onClosed)
    gate.active -= 1
  }
}

/**
 * Mount the route. `webServer` is optional so the plugin stays inert in
 * compositions without a browser carrier instead of failing to activate.
 * @param {object} ctx - registrant context.
 */
export function apply(ctx) {
  const gate = { active: 0 }
  ctx.inject(['webServer'], (routeCtx) => {
    const webServer = routeCtx.get('webServer')
    if (webServer === undefined) return
    return routeCtx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => serve(ctx, gate, req, res),
      })
      return () => {
        try {
          dispose()
        } catch {
          // Already torn down with the service.
        }
      }
    }, 'prompt-expert: enhance route')
  })
}
