/**
 * dsh-rider client half：设置导航里的「dsh-rider」设置页。
 *
 * 注册一张独立的 settings.section 设置页（order 50），编辑前置视觉理解的
 * 默认配置（visionProvider / visionModel / visionPrompt）。数据通道走 Node half
 * 自建的 HTTP 路由 `/api/dsh-rider-vision`（fetch GET 读 / POST 写或重置），
 * 而非官方 settingsScope wire —— 后者要求目标 settings namespace 被 apiproxy
 * 显式暴露给 Web client（WEB_SETTINGS_NAMESPACES 硬编码 allowlist，rc.6 第三方
 * 插件 namespace 不在内，卡片必然 return null）。host 路由 handler 在进程内
 * 直连 ctx.settings scope（applies:'live'，写即 commit+emit，零重启热更新）。
 * 解法对齐 plugin-registry 的薄控制台（settings.section + 自建 /api 路由）。
 *
 * 组件自包含纪律（对齐 plugin-registry ConsolePanel + 官方 settings.section
 * example）：settings.section 的组件**不接 props**（slot 框架不像
 * settings.plugin.item 那样注入 t/useXxx）——组件用 useSyncExternalStore 直接
 * 订阅模块级 controller 单例的 store，文案 t 为模块级函数，零 props 依赖。
 *
 * 依赖纪律（client bundle purity）：
 *  - require 只允许平台静态词（react / react-dom / @deepseek-ai/dsh-client-ui-primitives）；
 *  - 跨包协作走 cordis 服务注入（slots / locale），不 import 任何
 *    @deepseek-ai 官方 client 包（client-modules 禁止跨插件值 import）；
 *  - 表单状态机自实现（staged draft、save 单点写入、空文本=清除、overridden
 *    以 user 层 presence 判定），resolved/user 两层来自 GET 响应。
 *
 * 本文件即产物（CJS + __ModuleLoader__.load 包装，零构建链，git 源一行安装）；
 * 决策见 decisions/implemented/2026-08-15-vision-settings-section-page.md。
 */

window.__ModuleLoader__.load({
  id: 'dsh-rider',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    // react-dom 在 dsh-client-web 的平台静态词表内（见 dsh-client-web/lib/index.js 的
    // module map），与官方 dsh-client-ui-trajectory 一样可在 client bundle 直接 require。
    const { createPortal } = require('react-dom')
    const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement.bind(React)

    /* ------------------------------ 文案 ------------------------------ */

    /** 字典命名空间（locale 域，与 settings 命名空间互不相干）。 */
    const NS = 'dsh-rider'

    const en = {
      title: 'dsh-rider — vision settings',
      description: 'Vision model used by `vision_understand` (front-loaded image understanding). Leave empty to auto-discover the first configured model with image input modality.',
      visionProvider: 'Vision provider',
      visionProviderHint: 'Provider route configured in DSH (e.g. openai, siliconflow). Must pair with a model.',
      visionModel: 'Vision model',
      visionModelHint: 'Model id under that provider (e.g. zai-org/GLM-5.2).',
      visionPrompt: 'Default prompt',
      visionPromptHint: 'Instruction sent to the vision model when the tool call omits `prompt`.',
      overridden: 'overridden',
      reset: 'Reset',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saveFailed: 'Save failed',
      loading: 'Loading…',
      loadFailed: 'Failed to load settings',
      imageTitle: 'Image understanding',
      imageDescription: 'Paste (Ctrl/Cmd+V), drag-drop, or click to upload an image — it goes directly to a vision-capable model via dsh-rider, bypassing DSH\'s conversation image-attachment gate (which blocks images on text-only models). Useful when your session model cannot see images.',
      imageHint: 'The image is sent to the dsh-rider-configured vision model; the returned description is shown below. Does not enter the conversation flow.',
      imageDropzone: 'Paste / drop / click to upload an image',
      imageSupported: 'png · jpg · webp · gif',
      imageClear: 'Clear',
      imageUnderstand: 'Understand',
      imageUnderstanding: 'Understanding…',
      imageCopy: 'Copy',
      imageCopied: 'Copied',
      modelUsed: 'model',
      imageNoModel: 'No vision model configured — set visionProvider/visionModel above, or ensure a provider declares an image-capable model.',
      composerCaptureToggle: 'Capture pasted/dropped images in the composer',
      composerCaptureHint: 'When on, pasting or dropping an image into the composer sends it straight to the vision model and shows the description above the input (the image is NOT attached to the message — bypassing DSH\'s image gate on text-only models). Useful for text-only models; turn off to use native paste-to-attach on image-capable models.',
      composerTitle: 'Pasted image \u2192 vision',
      composerFailed: 'Vision call failed',
      declareTitle: 'Declare image modality for the vision model',
      declareDesc: 'pi-ai hand-written provider models that omit `input` fall back to text-only, so vision calls fail with UNSUPPORTED_CONTENT (the dsh settings panel does not expose this field). This writes `input: [text, image]` onto the vision model\'s entry via the official ctx.settings.mutate API — takes effect after restarting dsh web.',
      declareModelLabel: 'Target model',
      declareStatus: 'Current status',
      declareDeclared: 'image modality declared \u2713',
      declareNotDeclared: 'not declared (text-only fallback)',
      declareBtn: 'Declare image input',
      declareRemoveBtn: 'Remove declaration',
      declareDoing: 'Writing\u2026',
      declareDone: 'Declared \u2014 restart dsh web to take effect',
      declareRemoved: 'Removed \u2014 restart dsh web to take effect',
      declareFailed: 'Failed',
      declareNoVisionModel: 'Set visionProvider/visionModel above first',
    }

    const zh = {
      title: 'dsh-rider — 前置视觉设置',
      description: '`vision_understand`（前置视觉理解）使用的视觉模型。留空则自动发现第一个声明支持图片输入的已配置模型。',
      visionProvider: '视觉提供商',
      visionProviderHint: 'dsh 中已配置的提供商路由（如 openai / siliconflow），需与模型同时填写。',
      visionModel: '视觉模型',
      visionModelHint: '该提供商下的模型 id（如 zai-org/GLM-5.2）。',
      visionPrompt: '默认指令',
      visionPromptHint: '工具调用未传 `prompt` 时发送给视觉模型的指令。',
      overridden: '已覆盖',
      reset: '重置',
      save: '保存',
      saving: '保存中…',
      discard: '丢弃',
      saveFailed: '保存失败',
      loading: '加载中…',
      loadFailed: '读取设置失败',
      imageTitle: '图片理解',
      imageDescription: '粘贴（Ctrl/Cmd+V）、拖拽或点击上传图片——图片经 dsh-rider 直接交给视觉模型，绕过 DSH 对话流的图片准入拦截（纯文本模型粘贴图片会被拦截）。会话模型看不到图片时可用此卡片看图。',
      imageHint: '图片发送给 dsh-rider 配置的视觉模型，返回的描述显示在下方，不进入对话流。',
      imageDropzone: '粘贴 / 拖拽 / 点击上传图片',
      imageSupported: 'png · jpg · webp · gif',
      imageClear: '清除',
      imageUnderstand: '理解',
      imageUnderstanding: '理解中…',
      imageCopy: '复制',
      imageCopied: '已复制',
      modelUsed: '模型',
      imageNoModel: '未配置视觉模型——请在上方填写 visionProvider/visionModel，或确保某提供商声明了支持图片的模型。',
      composerCaptureToggle: '在对话输入框捕获粘贴/拖拽的图片',
      composerCaptureHint: '开启后，在对话输入框粘贴或拖入图片时，dsh-rider 会直接把图片发给视觉模型并在输入框上方显示描述（图片不会作为消息附件发送，绕开 DSH 对纯文本模型的图片拦截）。纯文本会话模型适用；若会话模型支持图片且想用原生粘贴附件，请关闭此项。',
      composerTitle: '粘贴图片 \u2192 视觉理解',
      composerFailed: '视觉理解失败',
      declareTitle: '为视觉模型补图片模态声明',
      declareDesc: 'pi-ai 手写 provider 的 models 条目若没写 input，会回落到纯文本，视觉调用会以 UNSUPPORTED_CONTENT 失败（dsh 设置面板不暴露此字段）。本卡片经官方 ctx.settings.mutate API 给视觉模型的条目写 input:[text,image]——改完需重启 dsh web 生效。',
      declareModelLabel: '目标模型',
      declareStatus: '当前状态',
      declareDeclared: '已声明图片模态 \u2713',
      declareNotDeclared: '未声明（回落纯文本）',
      declareBtn: '声明图片输入',
      declareRemoveBtn: '移除声明',
      declareDoing: '写入中…',
      declareDone: '已声明——重启 dsh web 生效',
      declareRemoved: '已移除——重启 dsh web 生效',
      declareFailed: '失败',
      declareNoVisionModel: '请先在上方填写 visionProvider/visionModel',
    }

    /** 模块级文案函数：优先跟随 ctx.locale 绑定，回退中文字典。apply 时增强。 */
    let t = (key) => zh[key] ?? en[key] ?? key

    /* --------------------------- 表单状态机 --------------------------- */

    /** 内部标记：该字段将清除（re-inherit composition layer）。 */
    const CLEAR = '\u0000clear'
    const FIELDS = ['visionProvider', 'visionModel', 'visionPrompt']

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * dsh-rider 设置页表单：对齐官方 CardForm 语义的 staged 状态机——
     * 草稿与已读快照分离，save 是唯一写入点；空草稿/清除 = unset。
     * 数据经 fetch 自建路由读写（resolved/user 两层来自 GET 响应）。
     */
    class RiderVisionCardController {
      constructor() {
        this.drafts = {}
        this.saving = false
        this.failed = false
        this.loading = true
        this.loadFailed = false
        this.resolved = {}
        this.user = {}
        this.listeners = new Set()
        this.store = {
          getSnapshot: () => this.projection(),
          subscribe: (listener) => {
            this.listeners.add(listener)
            return () => this.listeners.delete(listener)
          },
        }
        void this.refresh()
      }

      /** 一个字段的控件状态：草稿文本、保存后是否覆盖、是否非法（文本字段恒合法）。 */
      fieldState(field) {
        const draft = this.drafts[field]
        const hasDraft = draft !== undefined
        const resolvedText = String(this.resolved[field] ?? '')
        const text = hasDraft ? (draft === CLEAR ? '' : draft) : resolvedText
        const overridden = hasDraft ? draft !== CLEAR && draft !== '' : field in this.user
        return { text, overridden, invalid: false }
      }

      projection() {
        return {
          loading: this.loading,
          loadFailed: this.loadFailed,
          dirty: Object.keys(this.drafts).length > 0,
          invalid: false,
          saving: this.saving,
          failed: this.failed,
          visionProvider: this.fieldState('visionProvider'),
          visionModel: this.fieldState('visionModel'),
          visionPrompt: this.fieldState('visionPrompt'),
        }
      }

      publish() {
        for (const listener of [...this.listeners]) listener()
      }

      /** GET /api/dsh-rider-vision 刷新 resolved + user 两层。 */
      async refresh() {
        this.loading = true
        this.loadFailed = false
        this.publish()
        try {
          const response = await fetch('/api/dsh-rider-vision', { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.message ?? 'load failed')
          this.resolved = isRecord(body.resolved) ? body.resolved : {}
          this.user = isRecord(body.user) ? body.user : {}
        } catch {
          this.loadFailed = true
        }
        this.loading = false
        this.publish()
      }

      /** POST /api/dsh-rider-vision：草稿按字段转 update patch / reset。 */
      async save() {
        if (this.saving) return
        this.saving = true
        this.failed = false
        this.publish()
        try {
          const patch = {}
          let allClear = true
          for (const field of FIELDS) {
            const draft = this.drafts[field]
            if (draft === undefined) continue
            if (draft === CLEAR || draft === '') {
              patch[field] = ''
            } else {
              patch[field] = draft
              allClear = false
            }
          }
          // 全字段清除等价 replace({})——确保 user 层彻底重置回 base/默认。
          const hasEveryField = FIELDS.every((f) => Object.prototype.hasOwnProperty.call(this.drafts, f))
          const body = (allClear && hasEveryField) ? { reset: true } : { update: patch }
          const response = await fetch('/api/dsh-rider-vision', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const result = await response.json()
          if (result?.ok !== true) throw new Error(result?.message ?? 'save failed')
          this.resolved = isRecord(result.resolved) ? result.resolved : {}
          this.user = isRecord(result.user) ? result.user : {}
          this.drafts = {}
        } catch {
          this.failed = true
        }
        this.saving = false
        this.publish()
      }

      actions() {
        return {
          edit: (field, text) => {
            this.drafts[field] = text
            this.publish()
          },
          resetField: (field) => {
            this.drafts[field] = CLEAR
            this.publish()
          },
          save: () => {
            void this.save()
          },
          discard: () => {
            this.drafts = {}
            this.publish()
          },
          retry: () => {
            void this.refresh()
          },
        }
      }

      /** inject 面：供门禁经 slot.opts.inject() 访问 store/actions（组件不依赖它）。 */
      inject() {
        return { hooks: { riderVisionCard: this.store }, ...this.actions() }
      }
    }

    /** 模块级 controller 单例（apply 时创建；组件经此订阅，零 props 依赖）。 */
    let controller = null

    /* ------------------------------ 卡片 ------------------------------ */

    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      maxWidth: 720,
      color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const titleStyle = {
      margin: 0,
      fontSize: 16,
      fontWeight: 500,
      lineHeight: '24px',
      color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const descStyle = {
      margin: '0 0 6px',
      fontSize: 14,
      lineHeight: '22px',
      color: 'var(--dsw-alias-label-tertiary, inherit)',
    }
    const editorStyle = {
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-module-platform, transparent)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6 }
    const fieldHeadStyle = { display: 'flex', alignItems: 'center', gap: 8 }
    const labelStyle = {
      flex: 1,
      minWidth: 0,
      fontSize: 13,
      fontWeight: 500,
      color: 'var(--dsw-alias-label-primary, inherit)',
      lineHeight: 1.5,
    }
    const badgeStyle = {
      whiteSpace: 'nowrap',
      fontSize: 11,
      color: 'var(--dsw-alias-label-secondary, inherit)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 999,
      padding: '1px 8px',
    }
    const resetStyle = {
      font: 'inherit',
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary, inherit)',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
    }
    const hintStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.5 }
    const inputStyle = { width: '100%', boxSizing: 'border-box' }
    const actionsStyle = { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }
    const errorStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error, #c0392b)' }
    const mutedStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' }
    const sectionTitleStyle = {
      margin: '24px 0 0',
      fontSize: 14,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary, inherit)',
      lineHeight: 1.5,
    }
    const dropzoneStyle = {
      border: '1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      borderRadius: 12,
      padding: '24px 16px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      textAlign: 'center',
      transition: 'border-color .15s, background .15s',
      background: 'var(--dsw-alias-bg-module-platform, transparent)',
    }
    const dropzoneHoverStyle = {
      ...dropzoneStyle,
      borderColor: 'var(--dsw-alias-accent-primary, #4f9eff)',
      background: 'var(--dsw-alias-bg-elevated, rgba(79,158,255,.05))',
    }
    const previewWrapStyle = { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }
    const previewImgStyle = { maxWidth: '100%', maxHeight: 280, borderRadius: 8, objectFit: 'contain', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))' }
    const resultBoxStyle = {
      margin: 0,
      padding: '12px 14px',
      fontSize: 13,
      lineHeight: 1.6,
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-module-platform, transparent)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 8,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }
    const metaStyle = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, inherit)', fontFamily: 'ui-monospace, monospace' }

    /** 读取 File 为 data URL（base64）。 */
    function fileToDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
    }

    /* ------------ 对话 composer 级粘贴图片捕获（conversation.input.dock） ------------ */

    /**
     * 「对话粘贴捕获」开关，localStorage 持久化（默认开）。同一模块作用域内，设置页
     * 的开关与 dock 组件共享（dock 在事件发生时读 getEnabled()，设置页订阅刷新）。
     * 不走 Node half settings 命名空间——纯客户端偏好，零重启、零路由。
     */
    const composerVisionState = { enabled: false, listeners: new Set() }
    try {
      if (localStorage.getItem('dsh-rider.composerVision') === 'on') composerVisionState.enabled = true
    } catch {
      // vm 沙箱 / 无 localStorage 环境：保持默认关
    }
    const composerVisionStore = {
      getEnabled: () => composerVisionState.enabled,
      setEnabled: (value) => {
        composerVisionState.enabled = !!value
        try {
          localStorage.setItem('dsh-rider.composerVision', composerVisionState.enabled ? 'on' : 'off')
        } catch {
          // 持久化失败不阻断（内存态仍生效）
        }
        for (const listener of [...composerVisionState.listeners]) listener()
      },
      subscribe: (listener) => {
        composerVisionState.listeners.add(listener)
        return () => composerVisionState.listeners.delete(listener)
      },
    }

    /** dock 结果卡样式：position: fixed，锚在 composer 上方（fallback 右下角）。 */
    const dockCardStyle = {
      position: 'fixed',
      zIndex: 9_999,
      boxSizing: 'border-box',
      maxHeight: '70vh',
      overflow: 'auto',
      borderRadius: 12,
      background: 'var(--dsw-alias-bg-elevated, #1f1f1f)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      boxShadow: '0 12px 32px rgba(0,0,0,.32)',
      padding: '12px 14px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }
    const dockHeadStyle = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }
    const dockTitleStyle = { flex: 1, margin: 0, fontSize: 12, fontWeight: 600 }
    const dockThumbStyle = {
      maxWidth: '100%',
      maxHeight: 160,
      borderRadius: 8,
      objectFit: 'contain',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      display: 'block',
      marginBottom: 8,
    }
    const dockCloseStyle = {
      ...resetStyle,
      fontSize: 14,
      lineHeight: 1,
      padding: '2px 6px',
    }

    /**
     * 对话 composer 级粘贴/拖拽图片捕获。
     *
     * 挂在 `conversation.input.dock`（session 级，composer 卡片上方一整行）——但**渲染
     * 零 inline 占位**：所有可见输出经 createPortal 画到 document.body 上的浮层
     * （对齐 dsh-ads AdLayer 的 dock+portal 模式：slot 只是带 React 生命周期、且把层
     * 绑定到 open session 而非泄漏全局）。组件本身：
     *  - 轮询找到 composer 元素（textarea/contenteditable，取最靠下的、排除对话框内），
     *    在 capture 阶段拦截 paste/drop——含图片则 preventDefault + stopImmediatePropagation
     *    赢过原生 composer 的粘贴路径，把图片走 dsh-rider 自建 /understand 路由直抵
     *    视觉模型（不经 DSH 对话流，绕开 apiproxy 对纯文本模型的图片准入拦截）；
     *  - 文字粘贴不拦截，正常落入 composer；
     *  - 切换 session（sessionId 变）重置进行中的任务。
     * 复用 fileToDataURL / resultBoxStyle / mutedStyle / metaStyle / errorStyle / Button。
     */
    function ComposerVisionDock(props) {
      const sessionId = props && props.sessionId
      const [composerEl, setComposerEl] = useState(null)
      const [anchor, setAnchor] = useState(null) // {left, width, bottomGap}
      const [task, setTask] = useState(null)    // {id, preview?, name?, status, text?, model?, provider?, note?, error?}
      const reqId = useRef(0)

      /** 找 composer 元素并更新锚点；composer 切换时 reattach（经 composerEl effect）。 */
      useEffect(() => {
        let current = null
        const scan = () => {
          let best = null
          let bestTop = -Infinity
          const inputs = document.querySelectorAll('textarea, [contenteditable="true"]')
          for (const node of inputs) {
            // 排除设置/弹窗内的输入（settings 卡片自有 paste），排除自身浮层
            if (node.closest('[role="dialog"]')) continue
            if (node.closest('[data-dsh-rider-vision-overlay]')) continue
            const rect = node.getBoundingClientRect()
            if (rect.height === 0) continue
            if (rect.top > bestTop) { bestTop = rect.top; best = node }
          }
          if (best !== current) { current = best; setComposerEl(best) }
          if (best) {
            const r = best.getBoundingClientRect()
            setAnchor({ left: r.left, width: r.width, bottomGap: window.innerHeight - r.top })
          }
        }
        scan()
        const timer = setInterval(scan, 1500)
        const onResize = () => scan()
        window.addEventListener('resize', onResize)
        return () => {
          clearInterval(timer)
          window.removeEventListener('resize', onResize)
        }
      }, [sessionId])

      /** paste/drop 挂到 composer 元素；capture 阶段拦截图片，赢过原生粘贴路径。 */
      useEffect(() => {
        if (!composerEl) return
        const takeImage = (file) => {
          if (!file || !file.type || !file.type.startsWith('image/')) return false
          void runUnderstand(file)
          return true
        }
        const onPaste = (e) => {
          if (!composerVisionStore.getEnabled()) return
          const items = e.clipboardData && e.clipboardData.items
          if (!items) return
          for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
              const file = item.getAsFile && item.getAsFile()
              if (file && takeImage(file)) {
                e.preventDefault()
                e.stopPropagation()
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
                break
              }
            }
          }
        }
        const onDrop = (e) => {
          if (!composerVisionStore.getEnabled()) return
          const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
          if (file && takeImage(file)) {
            e.preventDefault()
            e.stopPropagation()
          }
        }
        const onDragOver = (e) => {
          if (!composerVisionStore.getEnabled()) return
          const types = e.dataTransfer && e.dataTransfer.types
          if (types && Array.from(types).indexOf('Files') >= 0) e.preventDefault()
        }
        composerEl.addEventListener('paste', onPaste, true)
        composerEl.addEventListener('drop', onDrop, false)
        composerEl.addEventListener('dragover', onDragOver, false)
        return () => {
          composerEl.removeEventListener('paste', onPaste, true)
          composerEl.removeEventListener('drop', onDrop, false)
          composerEl.removeEventListener('dragover', onDragOver, false)
        }
      }, [composerEl])

      /** 切换 session：作废进行中的任务并清空浮层。 */
      useEffect(() => {
        reqId.current += 1
        setTask(null)
      }, [sessionId])

      /** 把图片走 dsh-rider 自建 /understand 路由；reqId 防陈旧结果覆盖。 */
      async function runUnderstand(file) {
        const myId = (reqId.current += 1)
        let previewUrl = null
        try {
          previewUrl = await fileToDataURL(file)
        } catch {
          previewUrl = null
        }
        if (reqId.current !== myId) return
        setTask({ id: myId, preview: previewUrl, name: file.name, status: 'busy' })
        try {
          const response = await fetch('/api/dsh-rider-vision/understand', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ image: previewUrl || '' }),
          })
          const body = await response.json()
          if (reqId.current !== myId) return
          if (!body || body.ok !== true) throw new Error((body && body.message) || t('composerFailed'))
          setTask({
            id: myId, preview: previewUrl, name: file.name, status: 'done',
            text: body.text, model: body.model, provider: body.provider, note: body.note,
          })
        } catch (error) {
          if (reqId.current !== myId) return
          setTask({
            id: myId, preview: previewUrl, name: file.name, status: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const onClose = useCallback(() => {
        reqId.current += 1
        setTask(null)
      }, [])
      const onCopy = useCallback(async () => {
        if (!task || !task.text) return
        try { await navigator.clipboard.writeText(task.text) } catch {
          // 复制失败静默
        }
      }, [task])

      if (!task) return null

      const cardStyle = Object.assign({}, dockCardStyle)
      if (anchor) {
        cardStyle.left = Math.max(8, anchor.left)
        cardStyle.width = Math.min(Math.max(280, anchor.width), 460)
        cardStyle.bottom = Math.max(8, anchor.bottomGap + 12)
      } else {
        cardStyle.right = 16
        cardStyle.bottom = 16
        cardStyle.width = 360
      }

      return createPortal(
        h('div', { style: cardStyle, 'data-dsh-rider-vision-overlay': 'true' },
          h('div', { style: dockHeadStyle },
            h('span', { style: dockTitleStyle }, t('composerTitle')),
            h('button', { type: 'button', onClick: onClose, style: dockCloseStyle, 'aria-label': 'close' }, '\u2715'),
          ),
          task.preview
            ? h('img', { src: task.preview, alt: task.name || '', style: dockThumbStyle })
            : null,
          task.status === 'busy'
            ? h('p', { style: mutedStyle }, t('imageUnderstanding'))
            : null,
          task.status === 'error'
            ? h('p', { style: errorStyle }, t('composerFailed') + (task.error ? '\uff1a' + task.error : ''))
            : null,
          task.status === 'done'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('span', { style: metaStyle }, task.provider + '/' + task.model),
                  h(Button, { variant: 'ghost', size: 'sm', onClick: onCopy }, t('imageCopy')),
                ),
                h('pre', { style: resultBoxStyle }, task.text),
                task.note ? h('p', { style: mutedStyle }, task.note) : null,
              )
            : null,
        ),
        document.body,
      )
    }

    /**
     * 「为视觉模型补图片模态声明」卡片：读 GET /declare 列出所有 provider×model 的
     * input 声明状态 + 当前 visionModel 高亮；POST /declare 给 visionModel 条目写
     * input:[text,image]（或 remove:true 删除）。经 DSH 官方 ctx.settings.mutate API
     * 同层落盘（host 进程内直连 llm-pi-ai namespace），apply:'restart'，改完提示重启。
     * 不接 props，自包含（订阅 controller 拿 visionProvider/visionModel）。组件渲染
     * 时刷新 survey；写入后本地乐观更新 declared 状态（重启前 survey 仍反映旧值，但
     * UI 用返回值标注「已声明」+ 重启提示）。
     */
    function DeclareImageCard() {
      const [survey, setSurvey] = useState([])
      const [visionProvider, setVisionProvider] = useState('')
      const [visionModel, setVisionModel] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null) // {declared, removed} | null
      const [error, setError] = useState(null)

      const refresh = async () => {
        try {
          const r = await fetch('/api/dsh-rider-vision/declare', { headers: { accept: 'application/json' } })
          const body = await r.json()
          if (body && body.ok === true) {
            setSurvey(Array.isArray(body.models) ? body.models : [])
            setVisionProvider(body.visionProvider || '')
            setVisionModel(body.visionModel || '')
          }
        } catch {
          // 静默：survey 保持空
        }
      }
      useEffect(() => { void refresh() }, [])

      const target = survey.find((m) => m.provider === visionProvider && m.model === visionModel)
      const declared = result ? result.declared : (target ? target.declared : false)

      const onDeclare = async (remove) => {
        if (busy) return
        if (!visionProvider || !visionModel) { setError(t('declareNoVisionModel')); return }
        setBusy(true); setError(null); setResult(null)
        try {
          const r = await fetch('/api/dsh-rider-vision/declare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: visionProvider, model: visionModel, remove: remove === true }),
          })
          const body = await r.json()
          if (!body || body.ok !== true) throw new Error((body && body.message) || 'declare failed')
          setResult({ declared: !remove, removed: remove === true })
          void refresh()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
        setBusy(false)
      }

      return h('div', { style: editorStyle, 'data-dsh-rider-vision-overlay': 'true' },
        h('h3', { style: Object.assign({}, titleStyle, { fontSize: 14, margin: 0 }) }, t('declareTitle')),
        h('p', { style: descStyle }, t('declareDesc')),
        h('div', { style: fieldStyle },
          h('div', { style: fieldHeadStyle },
            h('label', { style: labelStyle }, t('declareModelLabel')),
            h('span', { style: badgeStyle }, visionProvider && visionModel ? visionProvider + ' / ' + visionModel : t('declareNoVisionModel')),
          ),
          h('p', { style: hintStyle },
            t('declareStatus') + '\uff1a' +
            (declared ? t('declareDeclared') : t('declareNotDeclared')),
          ),
        ),
        h('div', { style: actionsStyle },
          declared
            ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => onDeclare(true) }, busy ? t('declareDoing') : t('declareRemoveBtn'))
            : h(Button, { variant: 'primary', size: 'sm', disabled: busy || !visionProvider || !visionModel, onClick: () => onDeclare(false) }, busy ? t('declareDoing') : t('declareBtn')),
        ),
        result && result.declared ? h('p', { style: mutedStyle }, t('declareDone')) : null,
        result && result.removed ? h('p', { style: mutedStyle }, t('declareRemoved')) : null,
        error ? h('p', { style: errorStyle }, t('declareFailed') + '\uff1a' + error) : null,
      )
    }

    /**
     * 设置页内「对话粘贴捕获」开关：勾选即写 localStorage（默认开）。订阅
     * composerVisionStore 刷新勾选态。dsh-ads 式自包含——不接 props，零 namespace 门槛。
     */
    function ComposerCaptureToggleCard() {
      const [enabled, setEnabled] = useState(composerVisionStore.getEnabled())
      useEffect(() => composerVisionStore.subscribe(() => setEnabled(composerVisionStore.getEnabled())), [])
      const onToggle = (e) => composerVisionStore.setEnabled(e && e.target && e.target.checked)
      return h('div', { style: editorStyle, 'data-dsh-rider-vision-overlay': 'true' },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: onToggle,
            style: {
              marginTop: 4,
              width: 16, height: 16,
              accentColor: 'var(--dsh-alias-accent-primary, #4f9eff)',
              cursor: 'pointer',
            },
          }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h3', { style: Object.assign({}, titleStyle, { fontSize: 14, margin: 0 }) }, t('composerCaptureToggle')),
            h('p', { style: hintStyle }, t('composerCaptureHint')),
          ),
        ),
      )
    }

    /**
     * 图片理解卡片：粘贴/拖拽/上传图片 → 预览 → POST /understand → 显示描述。
     * 经 Node half 自建路由直抵视觉模型，不经 DSH 对话流（绕开图片准入拦截）。
     * 不接 props，全自包含（模块级 t + useState）。
     */
    function ImageUnderstandCard() {
      const [preview, setPreview] = useState(null) // {url,name}
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null) // {text, model, provider}
      const [error, setError] = useState(null)
      const [hover, setHover] = useState(false)
      const [copied, setCopied] = useState(false)
      const fileInputRef = useState(null)

      const loadImage = async (file) => {
        if (!file || !file.type.startsWith('image/')) return
        try {
          const url = await fileToDataURL(file)
          setPreview({ url, name: file.name })
          setResult(null)
          setError(null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }

      const onUnderstand = async () => {
        if (!preview || busy) return
        setBusy(true)
        setError(null)
        setResult(null)
        setCopied(false)
        try {
          const response = await fetch('/api/dsh-rider-vision/understand', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ image: preview.url }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.message ?? 'understand failed')
          setResult({ text: body.text, model: body.model, provider: body.provider, note: body.note })
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
        setBusy(false)
      }

      const onClear = () => { setPreview(null); setResult(null); setError(null); setCopied(false) }

      const onCopy = async () => {
        if (!result?.text) return
        try { await navigator.clipboard.writeText(result.text); setCopied(true) } catch {}
      }

      const onPaste = (e) => {
        const items = e.clipboardData?.items
        if (!items) return
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) { void loadImage(file); e.preventDefault(); break }
          }
        }
      }
      const onDrop = (e) => {
        e.preventDefault(); setHover(false)
        const file = e.dataTransfer?.files?.[0]
        if (file) void loadImage(file)
      }
      const onDragOver = (e) => { e.preventDefault(); setHover(true) }
      const onDragLeave = () => setHover(false)

      const dzStyle = hover ? dropzoneHoverStyle : dropzoneStyle

      return h('div', { style: editorStyle, onPaste },
        // 标题 + 说明
        h('h3', { style: { ...titleStyle, fontSize: 14, margin: 0 } }, t('imageTitle')),
        h('p', { style: descStyle }, t('imageDescription')),
        // 预览或上传区
        preview
          ? h('div', { style: previewWrapStyle },
              h('img', { src: preview.url, alt: preview.name, style: previewImgStyle }),
              h('span', { style: metaStyle }, preview.name),
            )
          : h('div', {
              style: dzStyle,
              onDrop, onDragOver, onDragLeave,
              onClick: () => fileInputRef[0]?.click?.(),
            },
              h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } }, t('imageDropzone')),
              h('span', { style: metaStyle }, t('imageSupported')),
            ),
        h('input', {
          ref: (el) => { fileInputRef[0] = el },
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          style: { display: 'none' },
          onChange: (e) => { const f = e.target.files?.[0]; if (f) void loadImage(f); e.target.value = '' },
        }),
        // 操作
        h('div', { style: actionsStyle },
          preview
            ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onClear }, t('imageClear'))
            : null,
          h(Button, {
            variant: 'primary', size: 'sm',
            disabled: !preview || busy,
            onClick: onUnderstand,
          }, busy ? t('imageUnderstanding') : t('imageUnderstand')),
        ),
        error ? h('p', { style: errorStyle }, error) : null,
        // 结果
        result
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: metaStyle }, `${t('modelUsed')}: ${result.provider}/${result.model}`),
                h(Button, { variant: 'ghost', size: 'sm', onClick: onCopy }, copied ? t('imageCopied') : t('imageCopy')),
              ),
              h('pre', { style: resultBoxStyle }, result.text),
              result.note ? h('p', { style: mutedStyle }, result.note) : null,
            )
          : null,
        h('p', { style: hintStyle }, t('imageHint')),
      )
    }

    function fieldRow(field, label, hint, state, disabled, actions) {
      return h(
        'div', { key: field, style: fieldStyle },
        h('div', { style: fieldHeadStyle },
          h('label', { htmlFor: `rider-${field}`, style: labelStyle }, label),
          state.overridden ? h('span', { style: badgeStyle }, t('overridden')) : null,
          state.overridden
            ? h('button', { type: 'button', style: resetStyle, disabled, onClick: () => actions.resetField(field) }, t('reset'))
            : null,
        ),
        h(Input, {
          id: `rider-${field}`,
          value: state.text,
          disabled,
          style: inputStyle,
          placeholder: hint,
          onChange: (event) => actions.edit(field, event.target.value),
        }),
        h('p', { style: hintStyle }, hint),
      )
    }

    /** 设置页组件：不接 props（settings.section 不注入 t/useXxx）。自包含订阅模块级单例。
     *  用 useState+useEffect 手动订阅 external store（对齐 plugin-registry ConsolePanel，
     *  零 react 版本风险——不依赖 useSyncExternalStore）。 */
    function RiderVisionPage() {
      const [state, setState] = useState(controller ? controller.store.getSnapshot() : { loading: true })
      useEffect(() => {
        if (!controller) return
        const update = () => setState(controller.store.getSnapshot())
        update()
        return controller.store.subscribe(update)
      }, [])
      const actions = controller ? controller.actions() : null
      if (!actions || state.loading) {
        return h('div', { style: pageStyle }, h('p', { style: mutedStyle }, t('loading')))
      }
      if (state.loadFailed) {
        return h('div', { style: pageStyle },
          h('p', { style: errorStyle }, t('loadFailed')),
          h(Button, { variant: 'outline', size: 'sm', onClick: actions.retry }, t('reset')),
        )
      }
      const disabled = state.saving
      const rows = [
        ['visionProvider', t('visionProvider'), t('visionProviderHint')],
        ['visionModel', t('visionModel'), t('visionModelHint')],
        ['visionPrompt', t('visionPrompt'), t('visionPromptHint')],
      ]
      return h(
        'div', { style: pageStyle },
        h('h2', { style: titleStyle }, t('title')),
        h('p', { style: descStyle }, t('description')),
        h(
          'div', { style: editorStyle },
          rows.map((row) => {
            const [field, label, hint] = row
            return fieldRow(field, label, hint, state[field], disabled, actions)
          }),
          h('div', { style: actionsStyle },
            state.dirty
              ? h(Button, { variant: 'ghost', size: 'sm', disabled, onClick: actions.discard }, t('discard'))
              : null,
            h(
              Button,
              {
                variant: 'primary',
                size: 'sm',
                disabled: disabled || !state.dirty,
                onClick: actions.save,
              },
              state.saving ? t('saving') : t('save'),
            ),
            state.failed ? h('p', { style: errorStyle }, t('saveFailed')) : null,
          ),
        ),
        // 为视觉模型补图片模态声明（pi-ai 手写 provider 的 input 字段补丁）
        h(DeclareImageCard),
        // 对话粘贴捕获开关（写 localStorage；dock 组件读同一 store）
        h(ComposerCaptureToggleCard),
        // 图片理解卡片（绕过 DSH 对话流图片准入拦截，直连视觉模型）
        h(ImageUnderstandCard),
      )
    }

    /* ------------------------------ 挂载 ------------------------------ */

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-rider: settings page dictionaries')
      // 文案函数：优先跟随 ctx.locale 绑定（若服务提供），回退模块级中英字典。
      try {
        const bound = ctx.locale?.bind?.(NS)
        if (typeof bound === 'function') t = bound
      } catch {
        // 保持默认中文字典回退
      }
      controller = new RiderVisionCardController()
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-rider',
          order: 50,
          label: () => 'dsh-rider',
          inject: () => (controller ? controller.inject() : {}),
        }, RiderVisionPage))
      // 对话 composer 级粘贴/拖拽图片捕获：dock 挂空组件（渲染靠 portal），复用
      // 已有的 /api/dsh-rider-vision/understand 路由，图片不走 DSH 对话流（绕开
      // apiproxy 对纯文本模型的图片准入拦截）。对齐 dsh-ads AdLayer 的 dock+portal 模式。
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-rider-composer-vision',
          order: 60,
          inject: () => ({}),
        }, ComposerVisionDock))
    }

    exports.name = 'dsh-rider'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
