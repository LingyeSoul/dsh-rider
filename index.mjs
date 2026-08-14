/**
 * dsh-rider Node half：Cordis 插件入口。
 *
 * 能力一：`duckduckgo_search` 工具 —— 免费网络搜索。
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
 * 能力二：`vision_understand` 工具 —— 前置视觉理解。
 *   - 背景：DSH 框架在 `dsh-host-apiproxy` 的 prompt handler `admit()` 中，于
 *     持久化用户消息与进入 agent turn 之前校验——若消息含 `type:'image'` 块且
 *     当前会话模型 inputModalities 不含 image，直接返回 attachment-error
 *     （`MODEL_DOES_NOT_SUPPORT_IMAGES`，前端提示"当前模型不支持图片"），
 *     含图片的消息不会进入 agent turn。因此会话模型是纯文本模型时，用户无法
 *     靠"粘贴图片"触发本工具——agent 收不到图片块。主入口改为用户以**文字**
 *     提供图片来源（本地路径 / http(s) URL / data: URL），消息是纯文本不触发
 *     拦截，进入 agent turn 后由系统提示（tool:vision 段）引导 agent 调用本工具。
 *   - 工具收到图片来源后，由本工具把图片交给 dsh 配置中支持视觉的模型理解，
 *     返回文字描述（agent 再转述给用户）。
 *   - 模型选择：工具参数 provider/model 显式指定 > `dsh-rider` settings 命名
 *     空间（visionProvider/visionModel）> 自动发现（遍历 ctx.llm 已注册提供商
 *     的模型，取第一个声明 inputModalities 含 image 的）。
 *   - 显式指定（参数或 settings）信任用户、跳过 inputModalities 过滤——已配置
 *     但未声明 image 模态的视觉模型（如 siliconflow 的 GLM 系）仍可用。
 *   - 图片必须经 ctx.attachments.saveImage 入库（adapter 经 readImage 取字节），
 *     校验通过才构造 {type:'image', attachment} 消息块，走 ctx.llm.stream。
 *
 * 能力三：前置视觉设置页 HTTP 路由 —— `/api/dsh-rider-vision`。
 *   - 背景：dsh「设置→插件→插件配置」的 settings.plugin.item 卡片只在目标
 *     settings namespace 被 apiproxy 显式暴露给 Web client 时渲染
 *     （WEB_SETTINGS_NAMESPACES 硬编码 allowlist，rc.6 尚未把 expose 决策
 *     下放到 settings.register()，见 dsh-host-apiproxy 注释「deferred work」）。
 *     dsh-rider 作为第三方插件，其 namespace 不在 allowlist，卡片必然
 *     return null（available=false）。解法对齐 plugin-registry 的薄控制台：
 *     client half 改注册顶级 settings.section 设置页（inject 返回空对象，
 *     零 namespace 门槛），数据通道走 Node half 自建的 HTTP 路由，handler
 *     在 host 进程内直连 ctx.settings scope 读写（不经 wire，绕开暴露限制；
 *     register 时 applies:'live'，写即 commit+emit，零重启热更新）。
 *   - GET 读 dsh-rider 段三个字段的 user 层覆盖值与 resolved 值；
 *   - POST 写：update 合并 patch（字段置值）/ replace({}) 清空 user 层（重置）。
 *   - POST '/api/dsh-rider-vision/understand'：图片理解——client half 设置页的
 *     「图片理解」卡片粘贴/上传图片（base64 data URL）经此路由，handler 在 host
 *     进程内复用 vision_understand 的 resolveImageSource/resolveVisionModel/
 *     runVisionCall 直接走 ctx.llm.stream 调视觉模型，返回文字描述。**不经 DSH
 *     对话流**（apiproxy prompt handler 的图片准入拦截不触发），是纯文本会话模型
 *     下"粘贴图片看图"的正解——用户在 dsh-rider 设置页粘贴图片，而非在对话流
 *     发送（后者会被框架拦截）。
 *
 * 背景见 decisions/implemented/2026-08-14-native-ddg-kit-tool.md、
 * 2026-08-14-vision-preprocessor-tool.md 与
 * 2026-08-15-vision-settings-section-page.md。
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DdgError, SafeSearchType, createDdgClient } from 'ddg-kit'

const execFileAsync = promisify(execFile)

export const name = 'dsh-rider'

export const inject = ['tools', 'systemPrompt', 'llm', 'attachments', 'settings', 'agentDefaultModel', 'webServer']

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

/* =========================================================================
 * 前置视觉理解（vision_understand）
 * ========================================================================= */

const IMAGE_EXT_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MEDIA_TYPE_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-gif': 'image/gif',
}
const SUPPORTED_MEDIA_TYPES = new Set(Object.values(IMAGE_EXT_MEDIA_TYPES))
const VISION_DEFAULT_PROMPT =
  'Describe this image in detail, including any text, people, objects, layout, and context. 请详细描述这张图片的内容。'
const VISION_TIMEOUT_MS = 120_000

/** 归一化图片 media type：声明值（可带参数）与扩展名互相兜底，别名收敛到标准名。 */
function normalizeMediaType(declared, ext) {
  for (const candidate of [declared, IMAGE_EXT_MEDIA_TYPES[ext]]) {
    if (!candidate) continue
    const type = candidate.split(';')[0].trim().toLowerCase()
    if (SUPPORTED_MEDIA_TYPES.has(type)) return type
    const alias = MEDIA_TYPE_ALIASES[type]
    if (alias) return alias
  }
  throw new Error(
    `不支持的图片格式（声明「${declared ?? '无'}」、扩展名「${ext ?? '无'}」）；支持：${[...SUPPORTED_MEDIA_TYPES].join(', ')}`,
  )
}

/**
 * 解析图片来源为图片字节。三种形态：
 *  - data:image/...;base64,...：直接解码；
 *  - http(s) URL：fetch 下载，mediaType 取 Content-Type、扩展名兜底；
 *  - 本地路径：readFile 读取（绝对路径或 dsh web 进程工作目录相对路径）。
 */
async function resolveImageSource(source, signal) {
  const trimmed = String(source).trim()
  if (trimmed === '') throw new Error('image 不能为空')
  if (trimmed.startsWith('data:')) {
    const match = /^data:([^;,]*)?(?:;[^,]*)?,(.*)$/s.exec(trimmed)
    if (match === null) throw new Error('data URL 格式非法（应为 data:image/...;base64,...）')
    const data = Buffer.from(match[2] ?? '', 'base64')
    if (data.length === 0) throw new Error('data URL 未包含图片数据')
    return { data, mediaType: normalizeMediaType(match[1] ?? '', ''), name: undefined }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let url
    try {
      url = new URL(trimmed)
    } catch {
      throw new Error(`图片 URL 非法：${trimmed}`)
    }
    const response = await fetch(url, { signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0) throw new Error('下载的图片为空')
    return {
      data,
      mediaType: normalizeMediaType(response.headers.get('content-type') ?? '', extname(url.pathname)),
      name: basename(url.pathname) || undefined,
    }
  }
  const localMediaType = normalizeMediaType('', extname(trimmed))
  let data
  try {
    data = await readFile(trimmed)
  } catch (error) {
    throw new Error(`读取本地图片失败（${error.code ?? error.name}）：${trimmed}（支持本地路径 / http(s) URL / data: URL）`)
  }
  if (data.length === 0) throw new Error('本地图片文件为空')
  return { data, mediaType: localMediaType, name: basename(trimmed) || undefined }
}

/**
 * 解析本次调用的视觉模型路由。优先级：
 *  1. 工具参数 provider/model 显式指定（必须成对；信任用户，不查 inputModalities）；
 *  2. settings（dsh-rider 命名空间）visionProvider/visionModel（同样视为用户显式选择）；
 *  3. 自动发现：遍历 ctx.llm 已注册提供商，取第一个声明 inputModalities 含 image 的模型。
 */
async function resolveVisionModel(ctx, visionSettings, providerArg, modelArg) {
  if ((providerArg === undefined) !== (modelArg === undefined)) {
    throw new Error('provider 与 model 必须同时提供（或不提供以自动选择支持视觉的模型）')
  }
  if (providerArg !== undefined && modelArg !== undefined) {
    return { provider: String(providerArg).trim(), model: String(modelArg).trim(), explicit: true }
  }
  const configured = visionSettings?.get() ?? {}
  if (configured.visionProvider && configured.visionModel) {
    return { provider: String(configured.visionProvider).trim(), model: String(configured.visionModel).trim(), explicit: true }
  }
  const providers = ctx.llm.listProviders()
  for (const provider of providers) {
    let models
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch {
      continue
    }
    const vision = models.find((model) => model.inputModalities?.includes('image') === true)
    if (vision !== undefined) return { provider: provider.id, model: vision.id, explicit: false }
  }
  const summary = providers.length === 0
    ? '当前没有已注册的 LLM 提供商（ctx.llm 无路由）'
    : providers.map((p) => `${p.id}（${p.name}）`).join('、')
  throw new Error(
    `未发现声明支持图片输入（inputModalities 含 image）的模型。可用提供商：${summary}。` +
    '可任选其一：① 工具参数显式传 provider/model（信任用户，跳过模态过滤）；' +
    '② 在 dsh 的 settings.yaml 对应 provider 的模型条目声明 `input: [text, image]` 后重启 web；' +
    '③ 在 settings.yaml 的 `dsh-rider` 段配置 visionProvider/visionModel。',
  )
}

/** 检查 dsh 当前默认会话模型是否已支持视觉，用于提示（失败静默，不阻断调用）。 */
async function currentModelVisionNote(ctx, signal) {
  try {
    const selection = ctx.agentDefaultModel.currentSelection()
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
    if (info.inputModalities?.includes('image') === true) {
      return `当前会话默认模型 ${selection.provider}/${selection.model} 已声明支持图片输入，通常无需前置视觉处理`
    }
  } catch {
    // 默认模型未配置 / 路由未注册 / 元数据不可用：无法判断，不提示
  }
  return undefined
}

/** 图片入库（durable ref）→ 构造 user 消息（text + image 块）→ 流式调用视觉模型并收集文本。 */
async function runVisionCall(ctx, { provider, model, image, prompt, signal }) {
  const limits = ctx.attachments.imageLimits
  if (image.data.length > limits.maxImageBytes) {
    throw new Error(`图片 ${image.data.length} 字节超过限制 ${limits.maxImageBytes} 字节`)
  }
  const ref = await ctx.attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: image.name })
  const message = createUserMessage({
    content: [
      { type: 'text', text: prompt },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'user' },
  })
  let text = ''
  let reasoning = ''
  for await (const chunk of ctx.llm.stream({ provider, model, messages: [message], signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        const failure = chunk.reason.failure
        throw new Error(`视觉模型 ${provider}/${model} 调用失败（${failure.code}）：${failure.message}`)
      }
    }
  }
  if (text.trim() === '') {
    throw new Error(`视觉模型 ${provider}/${model} 未返回文本描述${reasoning.trim() === '' ? '' : '（仅返回了推理过程）'}`)
  }
  return {
    provider,
    model,
    text: text.trim(),
    reasoning: reasoning.trim() === '' ? undefined : reasoning.trim(),
    image: {
      name: image.name,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
      bytes: ref.bytes,
    },
  }
}

/** dsh-rider settings 命名空间：前置视觉理解的默认模型选择（均为可选）。 */
const VISION_SETTINGS_NS = settingsNamespace('dsh-rider')
const VISION_SETTINGS_SCHEMA = z.object({
  visionProvider: z.string(),
  visionModel: z.string(),
  visionPrompt: z.string(),
})

export function apply(ctx) {
  const visionSettings = ctx.settings.register(VISION_SETTINGS_NS, VISION_SETTINGS_SCHEMA, { applies: 'live' })

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

  ctx.tools.register(defineTool({
    name: 'vision_understand',
    description: 'Front-loaded vision understanding: DSH blocks image attachments sent to a model without image input modality (returns "当前模型不支持图片"), so when the session model cannot see images and the user references an image by local file path, http(s) URL, or data: URL in their message, call this tool with that image source — a vision-capable model configured in DSH describes the image and returns the description as text. The session model itself cannot view the image, so you MUST call this tool to understand any image the user points to by path/URL; do not guess or claim you can see it. Model selection: explicit provider/model arguments (must be given together) > dsh-rider settings visionProvider/visionModel > first model discovered with image input modality. 前置视觉理解：DSH 会拦截发往不支持图片的模型的图片附件（提示"当前模型不支持图片"），因此会话模型看不到图片时，用户会以文字形式给出图片来源（本地路径 / http(s) URL / data: URL）——你见到消息里的图片路径/URL 且需要理解图片内容时，必须调用本工具让 dsh 配置的视觉模型理解图片并返回文字描述，不要假装自己能看到图片。模型选择：工具参数 provider/model 显式指定 > dsh-rider settings visionProvider/visionModel > 自动发现第一个声明支持图片输入的模型。',
    parameters: {
      image: {
        type: 'string',
        required: true,
        description: '图片来源：本地文件绝对路径（或 dsh 工作目录相对路径）/ http(s) URL / data:image/...;base64,...。支持 png/jpeg/webp/gif。',
      },
      prompt: {
        type: 'string',
        description: `给视觉模型的指令（默认：「${VISION_DEFAULT_PROMPT}」）。可用 settings 的 dsh-rider.visionPrompt 全局覆盖。`,
      },
      provider: {
        type: 'string',
        description: '视觉模型提供商路由（dsh 已配置，如 deepseek-official / openai / siliconflow）。必须与 model 同时提供；缺省用 settings 或自动发现。',
      },
      model: {
        type: 'string',
        description: '视觉模型 id（该提供商下的模型）。必须与 provider 同时提供；缺省用 settings 或自动发现。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          text: { type: 'string', required: true },
          reasoning: { type: 'string' },
          note: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              mediaType: { type: 'string', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              bytes: { type: 'number', required: true },
            },
          },
        },
      },
      render(args, value) {
        const lines = [`视觉模型 ${value.provider}/${value.model} 对图片的理解：`, value.text]
        if (value.note) lines.push(`（注意：${value.note}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: VISION_TIMEOUT_MS,
    async execute(args, exec) {
      const signal = exec?.signal
      const image = await resolveImageSource(args.image, signal)
      const prompt = (args.prompt ?? visionSettings.get()?.visionPrompt ?? VISION_DEFAULT_PROMPT).trim()
      if (prompt === '') throw new Error('prompt 不能为空')
      const vision = await resolveVisionModel(ctx, visionSettings, args.provider, args.model)
      const note = await currentModelVisionNote(ctx, signal)
      const result = await runVisionCall(ctx, { provider: vision.provider, model: vision.model, image, prompt, signal })
      return { ...result, note }
    },
  }))

  ctx.systemPrompt.section({
    name: 'tool:vision',
    order: 116,
    text: [
      'DSH blocks image attachments sent to a model without image input modality (the user sees "当前模型不支持图片，请切换支持图片的模型"), so a user who wants you to look at an image on a text-only model will reference it by local file path, http(s) URL, or data: URL in their message text instead of attaching it.',
      'When the user mentions an image by path/URL and you need to understand its contents, call `vision_understand` with that image source — the session model cannot view the image, so you MUST call the tool rather than guessing or claiming you can see it; relay the returned description back to the user.',
      'DSH 会拦截发往不支持图片的模型的图片附件（用户会看到"当前模型不支持图片，请切换支持图片的模型"），所以用户想在纯文本模型上看图时，会以文字形式给出图片路径/URL 而非直接粘贴图片。当用户在消息里提到图片路径/URL 且需要理解图片内容时，调用 `vision_understand` 传入该图片来源——会话模型本身看不到图片，你必须调用工具而非猜测或假装能看到，再把返回的描述转述给用户。',
    ].join('\n'),
  })

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

  /* 前置视觉设置页 HTTP 路由（见文件头「能力三」）。client half 的
   * settings.section 设置页经此 self-built route 读写 dsh-rider 段——
   * host 进程内直连 ctx.settings scope，不经 apiproxy wire 的 namespace
   * 暴露限制（第三方插件 namespace 不在 WEB_SETTINGS_NAMESPACES
   * allowlist），写即 commit+emit（register 时 applies:'live'），零重启。 */
  if (ctx.webServer !== undefined) {
    ctx.effect(() => {
      const stop = ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-rider-vision',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(body))
          }
          const readUserLayer = () => {
            const settings = ctx.get('settings')
            const descriptor = settings?.describe?.()?.find?.((d) => d.ns === VISION_SETTINGS_NS)
            const user = descriptor?.user
            return typeof user === 'object' && user !== null ? user : {}
          }
          const method = req?.method
          try {
            if (method === 'GET') {
              const stored = visionSettings.get() ?? {}
              const user = readUserLayer()
              send(200, {
                ok: true,
                resolved: {
                  visionProvider: stored.visionProvider ?? '',
                  visionModel: stored.visionModel ?? '',
                  visionPrompt: stored.visionPrompt ?? '',
                },
                user,
              })
              return
            }
            if (method !== 'POST') {
              send(405, { ok: false, message: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            if (body.reset === true) {
              await visionSettings.replace({})
            } else {
              const patch = {}
              for (const field of ['visionProvider', 'visionModel', 'visionPrompt']) {
                if (Object.prototype.hasOwnProperty.call(body.update ?? {}, field)) {
                  const value = body.update[field]
                  patch[field] = typeof value === 'string' ? value.trim() : ''
                }
              }
              await visionSettings.update(patch)
            }
            const stored = visionSettings.get() ?? {}
            const user = readUserLayer()
            send(200, {
              ok: true,
              resolved: {
                visionProvider: stored.visionProvider ?? '',
                visionModel: stored.visionModel ?? '',
                visionPrompt: stored.visionPrompt ?? '',
              },
              user,
            })
          } catch (error) {
            send(500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      /* 图片理解路由：'/api/dsh-rider-vision/understand'。
       * client half 设置页的「图片理解」卡片经此路由粘贴/上传图片——图片以
       * base64 data URL 走 HTTP body，不经 DSH 对话流（apiproxy prompt handler
       * 的图片准入拦截不触发），handler 在 host 进程内复用 vision_understand 的
       * resolveImageSource/resolveVisionModel/runVisionCall，直接走 ctx.llm.stream
       * 调视觉模型，返回文字描述。这是纯文本会话模型下"粘贴图片看图"的正解。 */
      const stopUnderstand = ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-rider-vision/understand',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(body))
          }
          const ac = new AbortController()
          req?.on?.('close', () => { if (!res.writableEnded) ac.abort() })
          try {
            if (req?.method !== 'POST') {
              send(405, { ok: false, message: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            const source = body.image
            if (typeof source !== 'string' || source.trim() === '') {
              send(400, { ok: false, message: 'image 不能为空（需 data:image/...;base64,... 或 http(s) URL 或本地路径）' })
              return
            }
            const image = await resolveImageSource(source, ac.signal)
            const prompt = (typeof body.prompt === 'string' && body.prompt.trim() !== ''
              ? body.prompt
              : visionSettings.get()?.visionPrompt ?? VISION_DEFAULT_PROMPT).trim()
            if (prompt === '') { send(400, { ok: false, message: 'prompt 不能为空' }); return }
            const vision = await resolveVisionModel(ctx, visionSettings, body.provider, body.model)
            const note = await currentModelVisionNote(ctx, ac.signal)
            const result = await runVisionCall(ctx, {
              provider: vision.provider,
              model: vision.model,
              image,
              prompt,
              signal: ac.signal,
            })
            send(200, { ok: true, ...result, note })
          } catch (error) {
            if (ac.signal.aborted) { send(499, { ok: false, message: '请求已取消' }); return }
            send(500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      return () => { stop?.(); stopUnderstand?.() }
    }, 'dsh-rider: vision settings + understand routes')
  }
}

/** 读取请求 JSON body（POST），容错非 JSON / 读流出错。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req?.on?.('data', (chunk) => { raw += chunk?.toString?.('utf8') ?? String(chunk) })
    req?.on?.('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req?.on?.('error', () => resolve({}))
  })
}
