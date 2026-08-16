<h1 align="center">dsh-rider</h1>

<p align="center">
  DSH 官方 bundle 插件：免费网络搜索工具 <code>duckduckgo_search</code>（零 API key）
  + 前置视觉理解工具 <code>vision_understand</code>（会话模型不支持图片时，用 dsh 配置的
  支持视觉的模型理解图片）+ 对话输入框粘贴图片捕获 + 对话窗口拖拽上传任意文件
  （文件暂存进会话工作区，附件清单随消息自动注入，草稿零污染）
  + 视觉模型图片模态声明（pi-ai 手写 provider 的 <code>input:[text,image]</code> 补丁，
  dsh 面板不暴露该字段）。
  DuckDuckGo（ddg-kit）优先，自动读取 Windows 系统代理；DuckDuckGo 不可达/限流时
  自动回退 Bing。并注入系统提示指引让 agent 优先使用它（内置 deepseek 网页搜索仅作最终后备）。
</p>

## 能力面

### Tools

| 工具 | 说明 |
|---|---|
| `duckduckgo_search` | 免费网络搜索：DuckDuckGo（[ddg-kit](https://github.com/lennney/ddg-kit)）优先，失败自动回退 Bing；返回标题/URL/摘要列表，`engine` 字段标明实际来源 |
| `vision_understand` | 前置视觉理解：会话模型不支持图片输入时，把图片（本地路径 / http(s) URL / data: URL）交给 dsh 配置中支持视觉的模型理解，返回文字描述；模型选择：工具参数 > settings（`dsh-rider.visionProvider/visionModel`）> 自动发现。注意所选视觉模型必须在 pi-ai 声明 `input` 含 image（见「为视觉模型补图片模态声明」） |

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

1. 工具参数 `provider` + `model`（显式指定跳过 dsh-rider 自己的自动发现过滤，但**绕不过** pi-ai provider 在 `ctx.llm.stream` 内部对 `model.input` 的强制校验——见下文「为视觉模型补图片模态声明」）；
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
`input: [text, image]`，视觉调用会以 `UNSUPPORTED_CONTENT` 失败——pi-ai provider 在
`ctx.llm.stream` 内部强制校验 `model.input`（dsh 面板不暴露该字段）。dsh-rider 提供
「为视觉模型补图片模态声明」卡片一键补声明（见下文），等效于手改：

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

- 默认关（避免在支持图片的会话模型上拦截原生粘贴附件）。纯文本会话模型下想用时，在
  **设置 → dsh-rider** 页打开「在对话输入框捕获粘贴/拖拽的图片」即可（状态持久化到本机）。
- 复用同一个 `/api/dsh-rider-vision/understand` 路由与视觉调用逻辑，模型选择优先级
  与 `vision_understand` / 图片理解卡片一致（工具参数 > settings > 自动发现）。
- 文字粘贴不被拦截，正常落入输入框；含图片的粘贴才走视觉路由。

> 技术细节见决策记录 `decisions/implemented/2026-08-15-composer-paste-vision-dock.md`。

# 对话输入框拖拽上传文件（任意类型，stash 管线）

DSH 原生 composer 只接受图片附件——拖入/粘贴非图片文件会被原生 InputBar 拒绝并提示
「不支持的文件类型」（官方 `dsh-client-ui-attachment` 也明示「仅支持图片」）。dsh-rider
借鉴社区插件 [dsh-attachments](https://github.com/CocoSgt/dsh-attachments) 的成熟设计
（自研实现，不抄代码）补上**任意文件暂存**：

- **入口三件套**：① 输入框工具栏的**回形针按钮**（文件选择器，multi-select 无类型过滤）；
  ② **全窗口拖拽**（拖到页面任意位置出现释放遮罩；有 composer 上下文才接管，否则
  原生行为原样保留）；③ **粘贴**（从资源管理器复制的文件；文本里含 `📎 … → .dsh/uploads/…`
  引用行会自动重新物化成卡片）。
- 文件落盘到**会话工作区** `<cwd>/.dsh/uploads/`（按会话隔离，agent 相对路径即可读），
  **附件卡片内嵌在 composer 卡片内部**（输入块上方，随卡片流布局，不遮挡任何外部
  选项/按钮）：扩展名图标/名称/大小/移除；图片带本地缩略图。
- **草稿零污染**：不在输入框写任何引用文本。发送下一条消息时，dsh-rider 在
  `agent/pre-step` wave 把附件清单作为一条 user 消息注入模型请求（紧跟用户消息之前，
  与官方 dsh-agent-instructions 同构）——进会话历史、可重放，卡片自动消失；agent 用
  fs/pwsh 工具按相对路径读取文件内容。纯文本会话模型同样适用（不触发图片准入拦截）。
- 卡片可**移除**（删除落盘文件）、**复制引用**（wire 格式，粘回 composer 重新物化）、
  **全部清除**。已发送消息引用的文件保留在磁盘（历史仍指向它们）；未发送的暂存是
  内存态，重启 web 后卡片消失、文件仍在。
- 粘贴图片仍走「对话捕获」（视觉理解/原生附件）；**拖入与按钮选择的图片同样暂存成卡片**
  （模型需要看时用视觉工具按路径读）。跨项目引用支持：从历史消息复制的引用行会经
  全局索引把文件从来源项目迁移进当前工作区。
- 大小上限默认 32MB/文件（base64 wire 的现实约束，设置页 `uploadMaxBytes` 可调）；
  文件名白名单清洗 + 时间戳前缀防撞名，路径 resolve 后前缀校验防穿越。
- 默认开；可在 **设置 → dsh-rider** 页关闭「在对话窗口捕获拖拽/粘贴的文件并暂存」。

> 技术细节见决策记录 `decisions/implemented/2026-08-16-composer-file-stash.md`。

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

装包后，dsh 设置导航会出现 **dsh-rider** 独立设置页：四个字段（视觉提供商 /
视觉模型 / 默认指令 / 单文件暂存上限（MB），保存即写入 `dsh-rider`
settings 命名空间，live 生效无需重启） + 四张卡片（「为视觉模型补图片模态声明」
「对话粘贴捕获开关」「对话文件暂存开关」「图片理解」）。等效于
手改 `settings.yaml`：

```yaml
dsh-rider:
  visionProvider: siliconflow
  visionModel: zai-org/GLM-5.2
  visionPrompt: 请详细描述这张图片的内容
  uploadMaxBytes: 32                # 单文件暂存上限（MB，0 = 默认 32）
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
  settings 命名空间 + 六条自建 HTTP 路由：`/api/dsh-rider-vision` 配置读写、
  `/api/dsh-rider-vision/understand` 图片理解、`/api/dsh-rider-vision/declare`
  图片模态声明、`/api/dsh-rider-stash` 文件暂存（落盘/列表/撤回/清空）、
  `/api/dsh-rider-stash/restage` 引用行物化、`/api/dsh-rider-stash/read` 预览
  读回 + `agent/pre-step` 注入）；`client/index.js` =
  client half（`settings.section` 独立设置页含四张卡片 + `conversation.input.dock`
  粘贴图片捕获与附件卡片 + `conversation.input.left` 回形针按钮 + 全窗拖放遮罩，
  CJS 源码即产物，零构建链）；
  搜索实现依赖 `ddg-kit@0.1.1`（声明在 dependencies，随包安装进 profile 闘包）；
  视觉能力全部走官方服务（`ctx.llm` / `ctx.attachments` / `ctx.settings` /
  `ctx.agentDefaultModel` / `ctx.webServer`，零新增依赖）。
- 门禁：`node scripts/gates/run.mjs`（机械检查 + 自证测试；entry 门禁用依赖
  stub 做真实 import 与 apply() 注册形状校验；`vision-execute` 门禁用全服务
  fake ctx 跑工具 execute 的成功/失败路径冒烟；`stash-execute` 门禁在临时
  工作区跑暂存路由全路径（落盘/列表/撤回/清空/restage 迁移/超限/穿越）+ 
  pre-step 注入纯函数直测；`client-bundle`/`client-execute`
  门禁用 vm 沙箱执行真实 client bundle（含 fetch stub 与 document stub）并冒烟
  设置页的表单流（编辑→保存→重置→清除→丢弃），均无需 node_modules）。
- 决策记录：`decisions/implemented/`。
