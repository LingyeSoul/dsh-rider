<h1 align="center">dsh-rider</h1>

<p align="center">
  DSH 官方 bundle 插件：免费网络搜索工具 <code>duckduckgo_search</code>（零 API key）
  + 前置视觉理解工具 <code>vision_understand</code>（会话模型不支持图片时，
  用 dsh 配置的支持视觉的模型理解图片）。
  DuckDuckGo（ddg-kit）优先，自动读取 Windows 系统代理；DuckDuckGo 不可达/限流时
  自动回退 Bing。并注入系统提示指引让 agent 优先使用它（内置 deepseek 网页搜索仅作最终后备）。
</p>

## 能力面

### Tools

| 工具 | 说明 |
|---|---|
| `duckduckgo_search` | 免费网络搜索：DuckDuckGo（[ddg-kit](https://github.com/lennney/ddg-kit)）优先，失败自动回退 Bing；返回标题/URL/摘要列表，`engine` 字段标明实际来源 |
| `vision_understand` | 前置视觉理解：会话模型不支持图片输入时，把图片（本地路径 / http(s) URL / data: URL）交给 dsh 配置中支持视觉的模型理解，返回文字描述；模型选择：工具参数 > settings（`dsh-rider.visionProvider/visionModel`）> 自动发现 |

### MCP servers

无（v0.1 的 duckduckgo-mcp-server 已因 VQD 失败被原生工具替换，见决策记录
`decisions/implemented/2026-08-14-native-ddg-kit-tool.md`）。

### Skills

当前无 skill；仓库按多能力插件规划，后续能力以 SKILL.md 模式在 `skills/` 扩展。

## 前置视觉理解（vision_understand）

**使用场景**：会话模型不支持图片输入（无 image 模态，如 `deepseek-v4-flash`）、
而用户想让 agent 看一张图时，agent 调用 `vision_understand` 让支持视觉的模型
理解图片，再把返回的描述转述给用户。系统提示已注入指引（`tool:vision` 段），
模型会自动优先走此路径。

> **⚠️ 关于"直接粘贴图片"**：DSH 框架在 `dsh-host-apiproxy` 的 prompt 入口处，
> 于进入 agent turn **之前**校验——若消息含图片附件且当前会话模型不支持图片，
> 直接拦截并提示"当前模型不支持图片，请切换支持图片的模型"，含图片的消息**不会
> 到达 agent**（`vision_understand` 因此不会被触发）。这是框架级拦截
> （`MODEL_DOES_NOT_SUPPORT_IMAGES`），第三方插件无法绕过。
>
> **正确用法**：在纯文本会话模型下，以**文字形式**提供图片来源，让 agent 调
> `vision_understand`，而不是直接粘贴图片附件：
> - 「帮我看看 `E:\screenshots\error.png` 这张图是什么」
> - 「这张图片里的文字是什么：`https://example.com/chart.png`」
>
> 消息是纯文本（不含 image block），不触发 DSH 拦截，进入 agent turn 后系统
> 提示会引导 agent 调用 `vision_understand` 传入该路径/URL。若会话模型本身支持
> 图片（如 `gpt-4o`），直接粘贴即可，无需本工具。

```
工具：vision_understand
参数：
  image    (必填) 图片来源：本地文件路径 / http(s) URL / data:image/...;base64,...
  prompt   (可选) 给视觉模型的指令（默认详细描述图片）
  provider (可选) 视觉模型提供商路由（如 deepseek-official / openai / siliconflow）
  model    (可选) 视觉模型 id（须与 provider 同时提供）
```

**视觉模型选择优先级**：

1. 工具参数 `provider` + `model`（显式指定即信任用户，不检查模态声明）；
2. settings 配置（`$DSH_HOME/settings.yaml` 的 `dsh-rider:` 段，
   `visionProvider` / `visionModel` / `visionPrompt`，live 生效）；
3. 自动发现：遍历 dsh 已注册提供商，取第一个声明支持图片输入的模型
   （`inputModalities` 含 `image`）。

```yaml
# settings.yaml 示例：固定视觉模型（可选）
dsh-rider:
  visionProvider: siliconflow
  visionModel: zai-org/GLM-5.2
  visionPrompt: 请详细描述这张图片的内容
```

**注意**：pi-ai 手写配置的提供商（如 siliconflow）若模型条目未声明
`input: [text, image]`，自动发现会跳过它（避免把图片发给纯文本模型）。
此类模型请用参数/settings 显式指定，或在模型条目声明模态：

```yaml
llm-pi-ai:
  providers:
    siliconflow:
      models:
        - id: zai-org/GLM-5.2
          input: [text, image]   # 声明支持图片输入后，自动发现也会选中
```

返回结构：`{ provider, model, text, reasoning?, note?, image: {mediaType, width, height, bytes} }`；
`note` 在会话模型已支持视觉时给出提示（不阻断）。

## 图片理解卡片（设置页内粘贴/上传图片看图）

纯文本会话模型下，DSH 会在对话流拦截直接粘贴的图片（提示"当前模型不支持图片"）。
dsh-rider 设置页提供「图片理解」卡片，**绕开对话流**直接看图：图片经 dsh-rider
自建 HTTP 路由直抵 Node half 的视觉模型调用链（不经 apiproxy 的 prompt 入口，
不触发图片准入拦截）。

**用法**：打开设置 → dsh-rider 设置页 → 「图片理解」卡片 → 粘贴（Ctrl/Cmd+V）/
拖拽/点击上传图片 → 点「理解」→ 视觉模型返回的描述显示在卡片内（含模型元信息 +
复制按钮）。描述不自动写入对话流，可自行复制后以文字发给 agent。

模型选择与 vision_understand 工具一致（工具参数 > settings > 自动发现），复用
同一套视觉调用逻辑。若会话模型本身支持图片，直接对话流粘贴即可，无需本卡片。

> 技术细节见决策记录 `decisions/implemented/2026-08-15-image-understand-card.md`。

## 对话输入框粘贴图片捕获

「图片理解」卡片要切到设置页才能粘贴。dsh-rider 还在**对话输入框**直接装了捕获：
在 composer 里 Ctrl+V 粘贴（或拖入）图片 → dsh-rider 直接把图片发给视觉模型 → 描述
显示在输入框上方的浮层（含模型元信息 + 复制）。图片**不作为消息附件发送**，因此绕开
DSH 对纯文本会话模型的图片准入拦截（`MODEL_DOES_NOT_SUPPORT_IMAGES`）——纯文本模型下
也能在对话里顺手粘贴看图，无需切设置页。

- 默认开。若会话模型支持图片、想用原生「粘贴即附件」，在 **设置 → dsh-rider** 页关闭
  「在对话输入框捕获粘贴/拖拽的图片」即可（状态持久化到本机）。
- 复用同一个 `/api/dsh-rider-vision/understand` 路由与视觉调用逻辑，模型选择优先级
  与 `vision_understand` / 图片理解卡片一致（工具参数 > settings > 自动发现）。
- 文字粘贴不被拦截，正常落入输入框；含图片的粘贴才走视觉路由。

> 技术细节见决策记录 `decisions/implemented/2026-08-15-composer-paste-vision-dock.md`。

## 为视觉模型补图片模态声明（pi-ai 手写 provider）

dsh 的 pi-ai provider 在 `ctx.llm.stream` 内部强制校验模型的 `input` 模态——
手写 provider（如 siliconflow）的 `models` 条目若没写 `input`，会回落到纯文本，
视觉调用必以 `UNSUPPORTED_CONTENT` 失败（`pi-ai model "..." does not support
image input`）。dsh 设置面板不暴露 `input` 字段，用户无法在 UI 配。

dsh-rider 设置页提供「为视觉模型补图片模态声明」卡片：打开 **设置 → dsh-rider**
→ 该卡片显示了当前 `visionModel` 的声明状态，点「声明图片输入」即可经 DSH 官方
`ctx.settings.mutate` API 给该模型条目写 `input: [text, image]`。**改完需重启
dsh web 生效**（pi-ai 路由是注册级事实）。

- 建议对确认支持图片的模型声明（如 Kimi-K2.7-Code）。若模型本身不支持图片，声明后
  pi-ai 校验放行、但上游会返回真实错误。
- 声明后对话流原生粘贴也放行（apiproxy 的 `admit()` 同样查 `inputModalities`）——
  会话模型支持图片时，可直接在对话里粘贴图片附件，无需 dsh-rider 的 dock（可在
  设置页关闭「对话粘贴捕获」）。

> 技术细节见决策记录 `decisions/implemented/2026-08-15-image-modality-declare-route.md`。

## 设置界面配置（推荐）

装包后，dsh 设置导航会出现 **dsh-rider** 独立设置页：三个字段（视觉提供商 /
视觉模型 / 默认指令），保存即写入 `dsh-rider` settings 命名空间（live 生效，
无需重启）。等效于手改 `settings.yaml`：

```yaml
dsh-rider:
  visionProvider: siliconflow
  visionModel: zai-org/GLM-5.2
  visionPrompt: 请详细描述这张图片的内容
```

> **为什么是独立设置页而非「设置→插件→插件配置」卡片**：dsh rc.6 的「插件
> 配置」tab 只为 settings namespace 被 apiproxy 显式暴露给 Web client 的
> 插件渲染卡片（`WEB_SETTINGS_NAMESPACES` 硬编码 allowlist，仅含官方宿主插件
> 如 agent-loop/bash/web-search-deepseek）。第三方插件 namespace 不在
> allowlist，卡片必然不显示（框架 deferred work，尚未把 expose 决策下放到
> `settings.register()`）。本插件改走 `settings.section` 独立设置页 + Node half
> 自建 HTTP 路由（对齐 plugin-registry 的薄控制台模式），绕开暴露限制。详见
> 决策记录 `decisions/implemented/2026-08-15-vision-settings-section-page.md`。

## 搜索工具选择（系统提示指引）

内置 `web_search`（deepseek 网页搜索）会在系统提示中指示 agent 使用它。本插件
注入更高优先级的指引（`tool:duckduckgo` 段，order 115 > 内置的 110）：
**网络搜索优先使用 `duckduckgo_search`，内置 `web_search` 仅作最终后备**。

想关闭指引（恢复默认选择行为）：profile 层禁用 `dsh-rider` 条目，见「启停与配置覆盖」。

## 网络与代理（重要）

ddg-kit 本身忽略系统代理，本插件代为读取。

代理解析优先级：

1. `DUCKDUCKGO_PROXY_URL` 环境变量（dsh web 进程环境，ddg-kit 原生支持）；
2. Windows 系统代理（注册表 `HKCU\...\Internet Settings`，缓存 60s；非 Windows 平台无此项）；
3. 直连（无代理时）。

DuckDuckGo 经代理偶发风控（BOT_CHALLENGE）：插件按冷却等待后自动重试一次，
仍失败则回退 Bing（Bing 在本网络直连稳定，无需代理）。

## 安装

官方 bundle 插件，经 web profile 层栈安装（装完**重启 web**；依赖 ddg-kit 随包自动安装）：

```sh
# git 源（推荐，一行安装）
dsh plugin --profile web add "github:LingyeSoul/dsh-rider#main"

# 或本地目录（在包目录内执行，dsh 锚定 . 为绝对路径）
cd dsh-rider
dsh plugin --profile web add .
```

更新到新版本：`dsh plugin --profile web update dsh-rider` 后重启 web。
卸载：`dsh plugin --profile web remove dsh-rider` 后重启 web。

## 使用

安装后对话中直接让 agent「搜索一下 XXX」，agent 会优先调用 `duckduckgo_search`：

```
工具：duckduckgo_search
参数：
  query      (必填) 搜索词，最长 400 字符
  count      (可选) 结果条数 1-20，默认 10
  safeSearch (可选) strict / moderate / off，默认 moderate
```

返回结构：`{ engine: duckduckgo | bing, noResults, results: [{title, url, description, hostname}] }`
（`engine` 标明实际使用哪个引擎，便于判断 DDG 是否可用）。

示例输出：

```
引擎：duckduckgo，共 10 条结果
1. 张雪峰（教育博主、学业职业规划讲师）— 百度百科
   https://baike.baidu.com/item/...
   1984 年 5 月 18 日出生，2007 年从郑州大学毕业后开始北漂生涯……
2. ...
```

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile
插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：
`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`

## 手动 insert 行（免重启备选）

不想装包时，可把下面的行直接追加到 profile 的
`cordis.patch.yml`（`$DSH_HOME/profiles/web/`），配置 HMR **实时挂载，零重启**
（需另行安装本包使 `dsh-rider` 可解析，或自行复制 `index.mjs` 的实现）：

```yaml
- insert:
    - id: dsh-rider
      name: 'dsh-rider'
```

## 启停与配置覆盖

在 profile 层（不是本包内）覆盖，例如禁用整个插件：

```yaml
- disabled: true
  id: dsh-rider
```

## 开发

- 结构：`cordis.patch.yml` = bundle 组合层（自挂载）；`index.mjs` = Node half
  （`duckduckgo_search` + `vision_understand` 工具 + 系统提示指引 + `dsh-rider`
  settings 命名空间 + `/api/dsh-rider-vision` 配置读写 + 图片理解路由）；`client/index.js` =
  client half（`settings.section` 独立设置页 + `conversation.input.dock` 对话粘贴图片
  捕获，CJS 源码即产物，零构建链）；
  搜索实现依赖 `ddg-kit@0.1.1`（声明在 dependencies，随包安装进 profile 闭包）；
  视觉能力全部走官方服务（`ctx.llm` / `ctx.attachments` / `ctx.settings` /
  `ctx.agentDefaultModel` / `ctx.webServer`，零新增依赖）。
- 门禁：`node scripts/gates/run.mjs`（机械检查 + 自证测试；entry 门禁用依赖
  stub 做真实 import 与 apply() 注册形状校验；`vision-execute` 门禁用全服务
  fake ctx 跑工具 execute 的成功/失败路径冒烟；`client-bundle`/`client-execute`
  门禁用 vm 沙箱执行真实 client bundle（含 fetch stub）并冒烟设置页的表单流
  （编辑→保存→重置→清除→丢弃），均无需 node_modules）。
- 决策记录：`decisions/implemented/`。
