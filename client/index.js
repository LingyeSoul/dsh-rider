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
 *  - require 只允许平台静态词（react / @deepseek-ai/dsh-client-ui-primitives）；
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
    const { useState, useEffect } = React
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
    }

    exports.name = 'dsh-rider'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
