/**
 * dsh-rider client half：dsh 设置 → 插件页面的配置卡片。
 *
 * 在「设置 → 插件」的 configurable tab（settings.plugin.item slot）注册一张
 * dsh-rider 卡片，编辑前置视觉理解的默认配置（visionProvider / visionModel /
 * visionPrompt），保存写入 `dsh-rider` settings 命名空间（live 生效）。
 *
 * 依赖纪律（client bundle purity）：
 *  - require 只允许平台静态词（react / react/jsx-runtime /
 *    @deepseek-ai/dsh-client-ui-slots / @deepseek-ai/dsh-client-ui-primitives）；
 *  - 跨包协作走 cordis 服务注入（slots / locale / settingsScope），不 import
 *    任何 @deepseek-ai 官方 client 包（client-modules 禁止跨插件值 import）；
 *  - 表单状态机自实现（官方 CardForm 在 dsh-client-ui-settings-plugins 包内，
 *    不可 import）——对齐其语义：staged draft、save 单点写入、空文本=清除、
 *    overridden 以 user 层 presence 判定。
 *
 * 本文件即产物（CJS + __ModuleLoader__.load 包装，零构建链，git 源一行安装）；
 * 决策见 decisions/implemented/2026-08-14-vision-settings-ui-card.md。
 */

window.__ModuleLoader__.load({
  id: 'dsh-rider',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')

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
    }

    /* --------------------------- 表单状态机 --------------------------- */

    /** 内部标记：该字段将清除（re-inherit composition layer）。 */
    const CLEAR = '\u0000clear'

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * dsh-rider 卡片表单：对齐官方 CardForm 语义的 staged 状态机——
     * 草稿与 settings scope 分离，save 是唯一写入点；空草稿/清除 = unset。
     */
    class RiderVisionCardController {
      constructor(scope) {
        this.scope = scope
        this.drafts = {}
        this.saving = false
        this.failed = false
        this.listeners = new Set()
        this.snapshot = null
        scope.subscribe(() => this.publish())
        this.store = {
          getSnapshot: () => this.projection(),
          subscribe: (listener) => {
            this.listeners.add(listener)
            return () => this.listeners.delete(listener)
          },
        }
      }

      /** 一个字段的控件状态：草稿文本、保存后是否覆盖、是否非法（文本字段恒合法）。 */
      fieldState(field, snap, user) {
        const draft = this.drafts[field]
        const hasDraft = draft !== undefined
        const stored = isRecord(snap.value) ? snap.value[field] : undefined
        const text = hasDraft ? (draft === CLEAR ? '' : draft) : String(stored ?? '')
        const overridden = hasDraft ? draft !== CLEAR && draft !== '' : field in user
        return { text, overridden, invalid: false }
      }

      projection() {
        const snap = this.scope.getSnapshot()
        const user = isRecord(snap.user) ? snap.user : {}
        const available = snap.status !== 'unavailable'
        return {
          available,
          writable: snap.writable === true && available,
          dirty: Object.keys(this.drafts).length > 0,
          invalid: false,
          saving: this.saving,
          failed: this.failed,
          visionProvider: this.fieldState('visionProvider', snap, user),
          visionModel: this.fieldState('visionModel', snap, user),
          visionPrompt: this.fieldState('visionPrompt', snap, user),
        }
      }

      publish() {
        this.snapshot = this.projection()
        for (const listener of [...this.listeners]) listener()
      }

      async save() {
        if (this.saving) return
        this.saving = true
        this.failed = false
        this.publish()
        try {
          for (const [field, draft] of Object.entries(this.drafts)) {
            if (draft === CLEAR || draft === '') await this.scope.unset(field)
            else await this.scope.set(field, draft)
          }
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
            this.save()
          },
          discard: () => {
            this.drafts = {}
            this.publish()
          },
        }
      }

      inject() {
        return { hooks: { riderVisionCard: this.store }, ...this.actions() }
      }
    }

    /* ------------------------------ 卡片 ------------------------------ */

    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 12,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      background: 'var(--dsw-alias-bg-module-platform, transparent)',
    }
    const titleStyle = {
      margin: 0,
      fontSize: 14,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary, inherit)',
      lineHeight: 1.5,
    }
    const descStyle = {
      margin: '0 0 6px',
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary, inherit)',
      lineHeight: 1.5,
    }
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }
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

    function fieldRow(t, field, label, hint, state, disabled, props) {
      return React.createElement(
        'div', { key: field, style: fieldStyle },
        React.createElement('div', { style: fieldHeadStyle },
          React.createElement('label', { htmlFor: `rider-${field}`, style: labelStyle }, label),
          state.overridden
            ? React.createElement('span', { style: badgeStyle }, t('overridden'))
            : null,
          state.overridden
            ? React.createElement('button', { type: 'button', style: resetStyle, disabled, onClick: () => props.resetField(field) }, t('reset'))
            : null,
        ),
        React.createElement(Input, {
          id: `rider-${field}`,
          value: state.text,
          disabled,
          style: inputStyle,
          placeholder: hint,
          onChange: (event) => props.edit(field, event.target.value),
        }),
        React.createElement('p', { style: hintStyle }, hint),
      )
    }

    function RiderVisionCard(props) {
      const t = props.t
      const state = props.useRiderVisionCard((snapshot) => snapshot)
      if (!state.available) return null
      const disabled = !state.writable
      const rows = [
        ['visionProvider', t('visionProvider'), t('visionProviderHint')],
        ['visionModel', t('visionModel'), t('visionModelHint')],
        ['visionPrompt', t('visionPrompt'), t('visionPromptHint')],
      ]
      return React.createElement(
        'div', { style: cardStyle },
        React.createElement('h4', { style: titleStyle }, t('title')),
        React.createElement('p', { style: descStyle }, t('description')),
        rows.map(([field, label, hint]) => fieldRow(t, field, label, hint, state[field], disabled, props)),
        React.createElement('div', { style: actionsStyle },
          state.dirty
            ? React.createElement(Button, { variant: 'ghost', size: 'sm', disabled, onClick: props.discard }, t('discard'))
            : null,
          React.createElement(
            Button,
            {
              variant: 'primary',
              size: 'sm',
              disabled: disabled || !state.dirty || state.saving,
              onClick: props.save,
            },
            state.saving ? t('saving') : t('save'),
          ),
          state.failed ? React.createElement('p', { style: errorStyle }, t('saveFailed')) : null,
        ),
      )
    }

    /* ------------------------------ 挂载 ------------------------------ */

    function apply(ctx) {
      const controller = new RiderVisionCardController(ctx.settingsScope.bind({ namespace: NS }))
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-rider: settings card dictionaries')
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          id: 'dsh-rider',
          order: 30,
          locale: NS,
          inject: () => controller.inject(),
        }, RiderVisionCard)
      })
    }

    exports.name = 'dsh-rider'
    exports.inject = ['slots', 'locale', 'settingsScope']
    exports.apply = apply
    return module.exports
  },
})
