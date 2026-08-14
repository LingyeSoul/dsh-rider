/**
 * dsh-rider Node half：Cordis 插件入口。
 *
 * 能力：`duckduckgo_search` 工具 —— 免费网络搜索。
 *   - 主引擎 DuckDuckGo（ddg-kit，社区维护的 duck-duck-scrape 兼容客户端）：
 *     bootstrap 取 VQD → preload 解析，失败自动回退 html/lite 表示；
 *     BOT_CHALLENGE 时按 cooldown 等待后重试一次。
 *   - 代理：优先 `DUCKDUCKGO_PROXY_URL` 环境变量；Windows 下回退读取系统代理
 *     （注册表 Internet Settings，含 v2rayN 等常见工具的设置），直连被封锁
 *     时经系统代理可达 DuckDuckGo（本机实测）。
 *   - 后备引擎 Bing（HTML 抓取）：DuckDuckGo 不可达/限流/挑战持续时自动回退，
 *     Bing 在封锁 DDG 的网络上通常直连可用。
 *   - 系统提示指引：order 115（> 内置 web_search 指引 110）——网络搜索优先
 *     使用本工具，内置 `web_search` 仅作最终后备。
 *
 * 背景见 decisions/implemented/2026-08-14-native-ddg-kit-tool.md。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DdgError, SafeSearchType, createDdgClient } from 'ddg-kit'

const execFileAsync = promisify(execFile)

export const name = 'dsh-rider'

export const inject = ['tools', 'systemPrompt']

const SAFE_SEARCH_MAP = {
  strict: SafeSearchType.STRICT,
  moderate: SafeSearchType.MODERATE,
  off: SafeSearchType.OFF,
}
const DDG_TIMEOUT_MS = 15_000
const DDG_CHALLENGE_COOLDOWN_MS = 10_000
const BING_TIMEOUT_MS = 15_000
const PROXY_CACHE_TTL_MS = 60_000
const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let proxyCache = { at: 0, url: undefined }
let proxyPromise = null

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'))
    return
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
})

/** 解析用于 DuckDuckGo 的代理：环境变量优先，Windows 下回退系统代理（注册表）。 */
async function resolveProxy() {
  const now = Date.now()
  if (now - proxyCache.at < PROXY_CACHE_TTL_MS) return proxyCache.url
  proxyPromise ??= (async () => {
    const fromEnv = process.env.DUCKDUCKGO_PROXY_URL?.trim()
    if (fromEnv) return fromEnv
    if (process.platform === 'win32') return readWindowsSystemProxy()
    return undefined
  })().finally(() => {
    proxyPromise = null
  })
  const url = await proxyPromise
  proxyCache = { at: Date.now(), url }
  return url
}

/** 读取 Windows 系统代理（HKCU Internet Settings，v2rayN/Clash 等均写入此处）。 */
async function readWindowsSystemProxy() {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { timeout: 3000, windowsHide: true, encoding: 'utf8' },
    )
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return undefined
    const raw = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1]
    if (!raw) return undefined
    // 支持 "127.0.0.1:8080" 与 "http=127.0.0.1:8080;https=..." 两种格式
    const httpEntry = raw.split(';').find((part) => part.startsWith('http='))
    const server = httpEntry ? httpEntry.slice('http='.length) : raw
    if (!server) return undefined
    return server.startsWith('http://') ? server : `http://${server}`
  } catch {
    return undefined
  }
}

/** ddg-kit 搜索：BOT_CHALLENGE 按 cooldown 等待后重试；其他瞬时错误（非超时）立即重试一次。 */
async function searchDdg(query, count, safeSearch, proxy, signal) {
  const client = createDdgClient({ challengeCooldownMs: DDG_CHALLENGE_COOLDOWN_MS })
  const attempt = () => client.search(query, { maxResults: count, safeSearch }, { proxy, signal, timeoutMs: DDG_TIMEOUT_MS })
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof DdgError) || signal?.aborted === true) throw error
    if (error.code === 'BOT_CHALLENGE' && error.cooldownMs > 0) {
      await sleep(Math.min(error.cooldownMs, DDG_CHALLENGE_COOLDOWN_MS), signal)
      return await attempt()
    }
    if (error.retryable === true && error.code !== 'TIMEOUT') return await attempt()
    throw error
  }
}

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', en: ' ', em: ' ',
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITY_MAP[entity] ?? match
  })
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

/** Bing HTML 抓取后备（本网络实测可用；DDG 被封锁时 Bing 直连通常可达）。 */
async function searchBing(query, count, signal) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=${count}`
  const response = await fetch(url, {
    headers: { 'user-agent': BING_UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal,
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`Bing returned HTTP ${response.status}`)
  const html = await response.text()
  const results = []
  for (const block of html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/g) ?? []) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/.exec(block)
    if (link === null) continue
    const title = stripTags(link[2])
    if (title === '') continue
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]
    results.push({ title, url: link[1], description: snippet === undefined ? '' : stripTags(snippet) })
    if (results.length >= count) break
  }
  return { noResults: results.length === 0, results }
}

function toOutput(engine, response) {
  return {
    engine,
    noResults: response.noResults,
    results: response.results.map((result) => {
      let hostname = ''
      try {
        hostname = new URL(result.url).hostname
      } catch {}
      return { title: result.title, url: result.url, description: result.description ?? '', hostname }
    }),
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'duckduckgo_search',
    description: 'Search the web with the free DuckDuckGo engine (via ddg-kit, no API key or quota), with automatic fallback to Bing when DuckDuckGo is unreachable or rate-limited. Returns a list of results with title, URL, and description.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query, max 400 characters.' },
      count: { type: 'number', description: 'Number of results to return, 1-20. Defaults to 10.' },
      safeSearch: { type: 'string', enum: ['strict', 'moderate', 'off'], description: 'Safe-search level. Defaults to moderate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engine: { type: 'string', enum: ['duckduckgo', 'bing'], required: true },
          noResults: { type: 'boolean', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                description: { type: 'string', required: true },
                hostname: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(args, value) {
        const lines = value.results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.description}`)
        const head = value.noResults
          ? '（无结果）'
          : `引擎：${value.engine}，共 ${value.results.length} 条结果`
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (query === '') throw new Error('query 不能为空')
      if (query.length > 400) throw new Error('query 最长 400 字符')
      const count = args.count === undefined ? 10 : Number(args.count)
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('count 必须是 1-20 的整数')
      const safeSearch = args.safeSearch === undefined ? 'moderate' : args.safeSearch
      const signal = exec?.signal
      try {
        const ddg = await searchDdg(query, count, SAFE_SEARCH_MAP[safeSearch], await resolveProxy(), signal)
        return toOutput('duckduckgo', ddg)
      } catch (error) {
        if (signal?.aborted === true) throw error
        console.warn(`duckduckgo_search: DuckDuckGo 失败（${error.code ?? error.name}），回退 Bing: ${error.message}`)
        try {
          return toOutput('bing', await searchBing(query, count, signal))
        } catch (bingError) {
          throw new Error(`DuckDuckGo 与 Bing 均失败：DDG ${error.message}；Bing ${bingError.message}`)
        }
      }
    },
  }))

  ctx.systemPrompt.section({
    name: 'tool:duckduckgo',
    order: 115,
    text: [
      'For web searches, prefer the free search tool `duckduckgo_search` (no API key or quota; uses DuckDuckGo via ddg-kit with automatic Bing fallback).',
      'Call it with `query` (required, max 400 chars); optionally `count` (1-20, default 10) and `safeSearch` (strict|moderate|off, default moderate).',
      'Use the built-in `web_search` tool only as a final fallback when `duckduckgo_search` fails.',
      '网络搜索优先使用免费的 duckduckgo_search（DuckDuckGo + Bing 后备），内置 web_search 仅作最终后备。',
    ].join('\n'),
  })
}
