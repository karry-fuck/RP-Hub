# 设置与 API 连接实现文档

> 本文件说明 RP-Hub 的设置系统与 API 连接：设置面板结构、用户设置（user）中真正被 AI 使用的字段、settings 数据模型全字段、API 提供商管理、端点拼接、鉴权、三档模型、模型列表拉取、连接状态检查、错误处理、用量统计与生图服务（sta1n / OpenAI 兼容 / ComfyUI 三后端 + 占位异步填图 + 服务端工作流拉取）。
> 源码位置：`assets/js/app.js` 与 `index.html`。行号基于当前 main 分支版本 1.7.9。

---

## 1. 整体流程

```
[用户设置 user]            [全局设置 settings]
  name / description          apiUrl / apiKey / apiProviderId
  person（第二/第三称）        model / quality/balanced/fastModel
  avatar（仅 UI）              temperature / stream / imageGen* 等
      │                            │
      ▼                            ▼
buildUserInfoPrompt() ──► [User Info] 注入系统提示（userPrompt）
       │                       │
       ▼                       ▼
  {{user}} 正则替换      getApiEndpoint() 自动拼 /v1
  消息 name / 记忆 prompt     Authorization: Bearer {apiKey}
       │                       │
       └──────────┬────────────┘
                  ▼
        POST /v1/chat/completions（model=settings.model）
                  │
        ┌─────────┴──────────────┐
        ▼                        ▼
   成功 → recordApiUsage     失败 → extractApiErrorMessage → throwApiError
   状态检查：checkApiStatus（GET models）
             checkImageGenStatus（按 provider 分支）
             fetchQuota（POST /api/api/getUser 查额度）
```

---

## 2. 设置面板结构（index.html）

设置页主视图入口 `currentView === 'settings'`（1518）。面板分两大区块：

### 2.1 用户设置区块（1707-1756）

| 字段               | UI                | 行号 | 说明                           |
| ------------------ | ----------------- | ---- | ------------------------------ |
| `user.name`        | 文本输入框        | 1707 | "您的名字"                     |
| `user.person`      | 叙事视角切换      | 1714 | 第二人称(你) / 第三人称(他/她) |
| `user.description` | 详细设定 textarea | 1743 | 外貌/性格/背景故事             |

顶栏还带**人设多套管理**（userProfiles 下拉，1553-1616）：切换 `switchProfile`（11769）、新建 `createNewProfile`（11779）、删除 `deleteProfile`（11793，最少保留 1 套）。头像上传区域在 1651 起（`user.avatar`，仅 UI 展示）。

### 2.2 API 连接与服务区块（1765-2089）

teal→emerald 渐变头部（1768），内部按顺序：

| 子区块           | UI 控件                                                                                     | 行号      |
| ---------------- | ------------------------------------------------------------------------------------------- | --------- |
| 服务连接状态     | API/生图状态点 + 延迟 + 额度 + "立即检测"按钮                                               | 1787-1843 |
| API 提供商       | 下拉选择器（内置 + 自定义）+ URL 输入                                                       | 1845-1937 |
| API Key          | 密码框 `settings.apiKey`                                                                    | 1939-1954 |
| 预设模型①/②/③    | 三个模型选择器（quality/balanced/fast）                                                     | 1960-2038 |
| 温度             | 滑块 min0-max1-step0.01                                                                     | 2040-2052 |
| 刷新可用模型列表 | 按钮 → `fetchModels(true)`                                                                  | 2053-2065 |
| 生图设置         | 生图服务 provider 下拉 + 按 provider 条件渲染的字段（密钥/画风/尺寸/数量/ComfyUI 节点参数） | 3843-…    |

### 2.3 用量统计面板（2751-2820）

- 顶部"清空记录"按钮（2757）；四档过滤 segmented-switch：全部 / 主对话 / 记忆系统 / 变量分析（2768-2790，绑定 `tokenUsageFilter`）；
- 时间范围过滤下拉（2791-2822）：`tokenUsageTimeFilter` 全部/24h/7d/30d（`tokenUsageTimeRanges` 11856-11860）。

### 2.4 模型选择器弹窗（3756 起）

搜索框 `modelSearchQuery`（3771，选 embedding 模型时锁定为 'embedding'）+ 分类标签 `modelTags`（3778-3790）+ 过滤后的模型列表 `filteredModels`。

---

## 3. 用户设置中哪些字段被 AI 使用

### 3.1 user 数据模型（571-576）

```js
const user = reactive({
  name: "请前往设置自定义你的名称",
  description: "",
  avatar: "",
  person: "second", // 人称偏好：second 或 third
});
```

### 3.2 逐字段的 AI 使用点

| 字段               | 被 AI 使用？ | 使用位置与效果                                                                                                                                                                                                              |
| ------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.name`        | ✅           | ① `buildUserInfoPrompt`（577）注入 `[User Info]\nName:`；② 消息 name（4845/5066/5948）；③ 经典记忆 prompt 的用户角色名（6919）；④ `{{user}}` 全局正则替换成 `user.name`（10238，`DEFAULT_USER_REGEX_NAME`）                 |
| `user.description` | ✅           | `buildUserInfoPrompt` 注入 `Description:` 行（580）——模型据此了解你的外貌/性格/背景                                                                                                                                         |
| `user.person`      | ✅           | 第二人称/第三人称内建预设互斥：`existingSecondPersonPreset.enabled = user.person !== 'third'`（11513/11520）、`existingThirdPersonPreset.enabled = user.person === 'third'`（11535/11542）；`togglePerson`（12486）实时切换 |
| `user.avatar`      | ❌           | 仅 UI 头像展示（index.html 1655、消息气泡）                                                                                                                                                                                 |

### 3.3 [User Info] 注入链路

`buildUserInfoPrompt`（577-581）：

```
[User Info]
Name: {user.name}
Description: {user.description}
```

该文本作为 `userPrompt`（5745）按顺序插入系统提示第 7 段（详见 dialog-generation.md 4.2 节）。

### 3.4 人设多套切换

- `userProfiles`（585）存多套人设；`activeProfileId` 标记当前；
- **deep watch**（589-603）：编辑 user 任意字段自动写回当前人设，保持人设与运行时一致；
- `switchProfile`（11769）：`Object.assign(user, JSON.parse(JSON.stringify(profile)))` 整包替换运行时 user；
- `createNewProfile` 默认 `person: 'second'`（11785），`deleteProfile` 时若删的是当前人设则自动切到第一套（11804-11805）。

---

## 4. settings 数据模型（607-640）

按"是否影响 AI 行为"分三类：

### 4.1 直接影响对话请求

| 字段                                           | 默认                      | 用途                                                                                |
| ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `apiUrl` / `apiKey`                            | `DEFAULT_API_CONFIG` / '' | 请求地址与鉴权（见第 5 节）                                                         |
| `apiProviderId` / `apiProviderKeys`            | `'sta1n'` / `{}`          | 当前提供商 id + 按提供商分桶存的 key（见 5.2）                                      |
| `customApiUrl` / `customApiUrl2`               | ''                        | 自定义提供商的 URL 存储槽（`getCustomApiUrlKey` 668 按 id 取对应槽）                |
| `model`                                        | qualityModel              | **当前生效模型**，请求体 `model: settings.model`（5536）                            |
| `qualityModel` / `balancedModel` / `fastModel` | ''                        | 三档预设模型（见 5.4）                                                              |
| `temperature`                                  | 1.0                       | 请求体 `temperature`（6363）                                                        |
| `stream`                                       | true                      | 请求体 `stream`；true 时附加 `stream_options: { include_usage: true }`（6364-6366） |
| `autoFetchModels`                              | true                      | 自动拉取可用模型列表（`fetchModels` 触发条件）                                      |

### 4.2 影响其他 AI 子系统

| 字段                                                                                                                            | 默认                             | 用途                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `activeToolAggressiveness`                                                                                                      | `'adaptive'`                     | 主动工具攻击性分级（见 active-tools.md）；`activeToolAggressivenessVersion`（2）做版本迁移                             |
| `uiTemplateEnabled` / `uiTemplateModel` / `uiTemplateAnalysisDepth` / `uiTemplateInjectContext` / `uiTemplateMainModelAnalysis` | 见 4 节                          | UI 模板子系统（副模型分析/主模型更新），详见 ui-template.md                                                            |
| `imageProvider`                                                                                                                 | `'sta1n'`                        | 生图服务后端：`sta1n` / `openai` / `comfy`（见 8 节）                                                                  |
| `imageGenKey`                                                                                                                   | ''                               | sta1n 生图密钥：NAI画图正则与自动生图世界书（见 8 节）+ `fetchQuota` 额度查询                                          |
| `imageStyle` / `customImageArtists` / `imageSize` / `imageGenCount`                                                             | `'vertical'` / '' / `'竖图'` / 2 | sta1n 画图参数（艺术家/尺寸/数量，`enforceSpecialRules` 12807）                                                        |
| `imageGenDefaultTags`                                                                                                           | ''                               | 默认提示词 tag，任务构建时前端前置拼接（不进世界书、不改 AI 输出）                                                     |
| `imageGenModel`                                                                                                                 | `'gpt-image-1'`                  | openai 生图模型（`/v1/images/generations` body.model）                                                                 |
| `imageGenResolution`                                                                                                            | `'1024x1024'`                    | openai/comfy 生图分辨率（sta1n 继续用 `imageSize`；comfy 可含 `custom`）                                               |
| `imageGenSteps` / `imageGenCfg` / `imageGenDenoise`                                                                             | `40` / `6` / `1`                 | comfy `%steps%`/`%scale%`/`%denoise%`（sta1n 的 steps/scale 固定 40/6，不再读设置）                                    |
| `imageGenNegativePrompt`                                                                                                        | ''                               | comfy `%negative_prompt%`；sta1n 留空用内置长负向串                                                                    |
| `imageGenOpenaiBaseUrl` / `imageGenApiKey`                                                                                      | '' / ''                          | openai 生图专用地址/Key，留空回退对话 `apiUrl`/`apiKey`                                                                |
| `comfyUrl`                                                                                                                      | `'http://127.0.0.1:8188'`        | ComfyUI 浏览器直连地址                                                                                                 |
| `comfyWorkflow`                                                                                                                 | `'default'`                      | 选中工作流 id：`default` / 本地自定义名 / `server:<名>`（服务端已保存）/ `import:<名>`（会话级导入，刷新回落 default） |
| `comfyModel` / `comfySampler` / `comfyScheduler`                                                                                | '' / `'euler'` / `'normal'`      | ComfyUI 节点参数，空值由 `/object_info` 拉取后兜底                                                                     |
| `comfyCustomResolution`                                                                                                         | `'832x1216'`                     | `imageGenResolution==='custom'` 时占位构建用的自定义分辨率字符串                                                       |
| `comfySamplerNodeId` / `comfyResolutionNodeId`                                                                                  | `'auto'` / `'auto'`              | 要控制的工作流节点（`auto`=第一个 / 具体 id / `none`=不控制）；选中则注入占位符由 UI 全权控制                          |

### 4.3 纯 UI（不影响 AI）

| 字段                                            | 默认                            | 说明                                                                       |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `contextSize`                                   | `MAX_CONTEXT_SIZE`(1000000)     | 恒为 100 万（605），加载时兜底（2172/2574），实际不参与截断                |
| `useCharacterBackground`                        | true                            | 聊天背景图（index.html 437/593/621）                                       |
| `immersiveMode`                                 | false                           | 沉浸式渲染                                                                 |
| `fontFamily` / `fontFamilyVersion` / `fontSize` | `'modern'` / 4 / (宽>768?16:14) | 字体族/字号（`applyFontFamily` 647-650；fontFamilyVersion 迁移 2566-2572） |

### 4.4 工坊同步

`syncSettingsToGenerator`（754-798）：把整个 `settings` 通过 `postMessage('SYNC_SETTINGS')` 发给角色卡工坊 iframe；`WORKSHOP_READY` 事件（770-774）与多组 watch（776/796）触发同步。

---

## 5. API 提供商管理

### 5.1 提供商定义（156-191）

4 内置 + 2 自定义：

| id            | 名称        | apiUrl                          |
| ------------- | ----------- | ------------------------------- |
| `sta1n`       | STA1N API   | `https://cdn.sta1n.cn/v1`       |
| `deepseek`    | DeepSeek    | `https://api.deepseek.com/v1`   |
| `openrouter`  | OpenRouter  | `https://openrouter.ai/api/v1`  |
| `siliconflow` | SiliconFlow | `https://api.siliconflow.cn/v1` |
| `custom`      | 自定义      | 存 `settings.customApiUrl`      |
| `custom2`     | 自定义2     | 存 `settings.customApiUrl2`     |

- `DEFAULT_API_PROVIDER_ID = 'sta1n'`（156）；`DEFAULT_API_CONFIG` 含 apiUrl/apiKey/三档模型（157-164）；
- `popularModelFamilies = ['claude','gemini','deepseek','llama','glm','minimax','moonshot','grok']`（387），供模型选择器分类。

### 5.2 按提供商存 key

`apiProviderKeys`（611）是一个对象：`{ [providerId]: apiKey }`。

- `syncCurrentApiKeyToProvider`（675-684）：切换提供商前把当前 apiKey 写回 `apiProviderKeys[旧id]`，自定义提供商同步 URL 槽；
- `normalizeApiProviderSettings`（685-735）：加载时兜底所有提供商 key 为空串，`apiUrl` 有值但 providerId 失配时按 URL 反查 provider；
- `selectApiProvider`（726-735）：先 `syncCurrentApiKeyToProvider`，再把 apiUrl/apiKey 换成新提供商的配置（自定义用 `getCustomApiUrlKey` 取存储槽）；
- watch `settings.apiKey`（738）：编辑 key 时实时写回 `apiProviderKeys[当前id]`。

### 5.3 端点拼接与鉴权

```js
const getApiEndpoint = (path) =>
  settings.apiUrl.endsWith("/v1")
    ? `${settings.apiUrl}/${path}`
    : `${settings.apiUrl}/v1/${path}`;
```

请求统一带 `Authorization: Bearer ${settings.apiKey}`（6363 等处）。

### 5.4 三档模型与 currentModelMode

| 机制                 | 行号    | 说明                                                                            |
| -------------------- | ------- | ------------------------------------------------------------------------------- |
| 三档字段             | 637-639 | qualityModel / balancedModel / fastModel                                        |
| `modelMode` computed | 801-814 | setter 按档位把 `settings.model` 设为对应模型（聊天页顶栏切换）                 |
| watch settings.model | 776-793 | 新模型非 fast/balanced 时同步 `qualityModel`；按命中档位更新 `currentModelMode` |
| `requestModel`       | 5536    | 请求体 `model: settings.model`（即当前档位模型）                                |

### 5.5 模型列表拉取 — `fetchModels`（4665-4685）

- 无 key 时直接 return（手动触发会 toast 提示）；
- `GET getApiEndpoint('models')` + Bearer → `availableModels.value = data.data || []`；
- `openModelSelector`（4687-4696）：选 embedding 模型时锁定搜索词为 'embedding'。

### 5.6 模型选择器过滤（4103-4149）

- `modelTags`（4103）：按 `popularModelFamilies` 把 availableModels 分成 全部/各家族/其他，带计数；
- `filteredModels`（4128）：按标签 + 搜索词（embedding 场景固定 'embedding'）过滤，按 id 排序；
- `selectModel`（4698-4721）：普通目标写 `settings[target]`（若等于当前档位再同步 `settings.model`）；embedding/经典记忆目标写 `memorySettings`。

---

## 6. 连接状态检查（4723-4771）

`checkConnectionStatus(status, latency, label, request, isConnected)`（4723）：

- 置 status='checking'，AbortController + **10s 超时**；
- 请求成功且 `isConnected(response)`（默认 `response.ok`）→ 'connected' 并记延迟（performance.now 差值）；
- 失败/超时/非 ok → 'error'。

三个具体检查：

| 检查                  | 行号      | 请求方式                                                  | 成功判定                                                                        |
| --------------------- | --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `checkApiStatus`      | 4744-4755 | GET `getApiEndpoint('models')` + Bearer                   | `response.ok`                                                                   |
| `checkImageGenStatus` | 4757-4765 | HEAD `IMAGE_GEN_BASE_URL`，`mode:'no-cors'`               | 恒真（no-cors 拿不到状态）                                                      |
| `fetchQuota`          | 266-285   | POST `/api/api/getUser`，body `{ toUserId: imageGenKey }` | `data.status==='ok' && data.type==='sta1n'` → 解析 `data.data.value` 为额度次数 |

`checkAllStatuses`（4767-4771）三连触发：API + 生图 + 额度。

---

## 7. 错误处理与用量统计

### 7.1 API 错误解析（4415-4443）

| 函数                     | 行号 | 作用                                                                     |
| ------------------------ | ---- | ------------------------------------------------------------------------ |
| `getApiErrorStatus`      | 4402 | 从 payload.status/statusCode/code 及 error 子对象取数字状态码            |
| `formatApiErrorMessage`  | 4415 | 拼 `API Error: {status}` + 详情（`stringifyErrorDetail` 对对象 JSON 化） |
| `extractApiErrorMessage` | 4425 | 统一解析 error.message / error.detail / payload.message / payload.detail |
| `throwApiError`          | 4439 | 抛带 `isApiError` 标记的错误，上层 catch 不再二次包装                    |

非流式路径还有 `extractApiUsageFromText`（1987）在 JSON 解析失败时按 SSE 文本逐行提 usage。

### 7.2 用量记账（1982-2074）

| 函数                    | 行号  | 作用                                                                                                                           |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `getApiUsagePayload`    | 1982  | 兼容 `usage` / `usageMetadata` 两种字段                                                                                        |
| `readUsageNumber`       | 1975  | 依次取非负数字，返回第一个有效值（round）                                                                                      |
| `normalizeApiUsage`     | 2001  | 多提供商字段归一：prompt/completion/input/output/candidates、cache read/write、reasoning tokens，兜底 `total = input + output` |
| `recordApiUsage`        | 2062  | `unshift` 进 `tokenUsageHistory`（含 type/model/detail/characterName），`saveTokenUsageHistoryNow` 串行落库                    |
| `getTokenUsageCategory` | 11851 | `summary/embedding → memory`、`ui_template → variables`、其余 → `chat`（三档过滤的映射基础）                                   |

- 存储键 `token_usage_history`（2057）；
- 过滤：`filteredTokenUsageHistory`（11861）先按 `getTokenUsageCategory` 匹配 `tokenUsageFilter`，再按 `tokenUsageTimeFilter`（24h/7d/30d）截时间窗；
- 面板统计 `tokenUsageStats`（11877）用 `getUncachedInputTokens`（11872，`inputTokens - cacheReadTokens`）显示未命中缓存的真实输入。

---

## 8. 生图服务

生图服务支持三个后端（`settings.imageProvider`）：**sta1n**（默认，NAI 风格直链）、**OpenAI 兼容**（`/v1/images/generations`）、**ComfyUI**（本地浏览器直连）。核心代码在独立文件 `assets/js/image-gen.js`（挂 `window.RPHubImageGen`，IIFE 同构 card-utils.js），app.js 只留接线。

### 8.1 三个后端的生成函数（image-gen.js）

| provider | 函数                                                        | 流程                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sta1n`  | `generateImageWithSta1n(task, settings, cardUtils)`         | 纯拼 URL 无网络请求：`{base}/generate?tag=…&token={imageGenKey}&model=nai-diffusion-4-5-full&artist={getImageStyleArtists}&size={imageSize}&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=…&seed={seed}&nocache=0&noise_schedule=karras`。**steps/scale 为固定值 40/6**（设置 UI 已移除，仅 ComfyUI 分支可调）；negative 取 `imageGenNegativePrompt`，留空用内置长负向串；base 默认 `https://nai.sta1n.cn`（`DEFAULT_STA1N_BASE_URL`，可被 `imageGenBaseUrl` 覆盖）。`cardUtils.getImageStyleArtists`（app.js 12807）决定画风艺术家 |
| `openai` | `generateImageWithOpenAI(task, settings, signal)`           | `buildOpenAIImageEndpoint`：`imageGenOpenaiBaseUrl` 优先、回退 `apiUrl`，自动补 `/v1/images/generations`；Key 用 `imageGenApiKey` 优先、回退 `apiKey`，Bearer 鉴权；body `{ model: imageGenModel, prompt, size: normalizeOpenAISize(task.size, model), n: 1, response_format: 'b64_json' }`；响应宽容解析（`data` 数组 / 直接数组 / `data[0]`），取 `b64_json` → `data:image/png;base64,…`，或 `url` 直接用                                                                                                                                  |
| `comfy`  | `generateImageWithComfy(task, settings, workflows, signal)` | 取 `workflows[settings.comfyWorkflow]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |     | DEFAULT_COMFY_WORKFLOW`→`fillComfyWorkflow` 用 **split/join replaceAll**（`v.split('%x%').join(value)`，避免 JSON 内正则特殊字符）填 `%prompt% %negative_prompt% %seed% %steps% %scale% %sampler% %scheduler% %model% %width% %height% %denoise%`→`POST {comfyUrl}/prompt`→ 等首帧后轮询`GET /history/{prompt_id}`（1.5s 间隔，超 `timeoutMs`抛错）→ 取`outputs`首图`{filename,subfolder,type}`→ 返回`{comfyUrl}/view?filename=…&subfolder=…&type=…`直接作`<img src>` |

三函数统一签名 `(task, settings) => Promise<string>`，`task = { taskid, prompt, provider, size, seed }`；错误统一 `normalizeImageGenError` 包装（含状态码/响应体上下文）。

### 8.2 占位 + 异步填图（对话内自动生图）

OpenAI/ComfyUI 异步生成，无法内联进同步 `processRegex`，走"占位 + 异步填图"：

1. **构建占位（纯函数，无副作用）**：`buildImageGenPlaceholder(prompt, offset)`（app.js 3700）读 settings 组装 ctx，调 `buildPlaceholderHtml` 产出自包含任务信息的 HTML：`<div class="rphub-gen-wrap" data-rphub-gen data-taskid data-provider data-prompt data-size data-seed>` + 灰色 gif + "生成中…" + 隐藏重试按钮。taskid 确定性生成 `gen_{offset}_{hash}`，同文本幂等；`data-prompt` 用 `escapeHtmlAttr` 编码，解析 DOM 后自动还原。
2. **processRegex 特判**（app.js 5770）：按名字命中 `NAI画图正则` 且 `isDisplay` 时，用 `transformUnprotectedText` 保护 HTML/代码块后对每个 `image###提示词###` 调占位构建，跳过通用 replace。
3. **DOMPurify 放行**：`cleanConfig.ADD_ATTR` 把 `data-rphub-gen/data-taskid/data-prompt/data-provider/data-size/data-seed` 加入白名单，否则净化后 scanner 找不到任务信息。
4. **扫描**：对 `chatContainer` 挂 MutationObserver（新增节点 + 50ms 防抖）→ `scanPendingImageGen()`（app.js 3749）：查未 `data-resolved` 的占位，会话缓存 `resolvedGenCache[taskid]` 命中直接填 src；未命中组 task 入队。
5. **队列**：`createImageGenQueue({ concurrency: 3, timeoutMs: 120000 })`，并发 3、AbortController 超时、失败标记节点并显示重试按钮（点击换新 seed 重生成），多图并发各自随机 seed。
6. **默认 tag 前置**：`imageGenDefaultTags` 在任务构建时拼进 `data-prompt`（`[defaultTags, AI输出].filter(Boolean).join(',')`），不进世界书、不改 AI 输出。

### 8.3 ComfyUI 节点、工作流与自定义分辨率

- **节点参数**：`fetchComfyObjectInfo(comfyUrl)`（image-gen.js）GET `/object_info`，从 `CheckpointLoaderSimple.input.required.ckpt_name[0]`、`KSampler…sampler_name[0]`、`…scheduler[0]` 提取 `{models, samplers, schedulers}`，填充模型/sampler/scheduler 三个下拉；空值时兜底默认。
- **内置默认工作流**：`DEFAULT_COMFY_WORKFLOW` 为纯 txt2img（CheckpointLoaderSimple → CLIPTextEncode×2 → EmptyLatentImage → KSampler → VAEDecode → SaveImage）。本地自定义工作流存 `localStorage['rp_hub_comfy_workflows']`（`{default:null, 自定义名:…}`），可粘贴/保存/恢复默认。
- **服务端工作流拉取**：`fetchComfyServerWorkflows(comfyUrl, objectInfo)`（image-gen.js 805）GET `/api/userdata?dir=workflows` 列出用户保存的 workflow 文件，逐个 GET `/api/userdata/workflows%2F{名}` 读取（该路由为单段 `{file}`，`/` 必须编码 `%2F`）。保存的 workflow 是 **LiteGraph graph 格式**，需两步转换：
  - `graphToPrompt(graphData, objectInfo)`（image-gen.js 547）：跳过 `mode==1` 折叠节点与 PrimitiveNode/Note；用 `isWidgetInputType` 判定 widget 输入（现代 COMBO 类型是 `[["opt1",…],{config}]`，widget 基元 STRING/INT/FLOAT/BOOLEAN/SEED/COMBO）并按 `widgets_values` 顺序映射（**兼容旧式工作流**：`seed` 后的 `control_after_generate` 占位值 `randomize/fixed/increment/decrement` 自动跳过，避免该值并入后续参数导致 steps/cfg/sampler 等整体错位）；必需链接型输入断连的孤儿节点跳过；链接输入转 `[originId, originSlot]`；PrimitiveNode 值内联。
  - `injectComfyPlaceholders(apiPrompt, opts)`（image-gen.js）：**克隆返回**（`JSON.parse(JSON.stringify(...))`，不污染 DEFAULT 常量与工作流缓存）。`opts.samplerNodeId` / `opts.latentNodeId` 三态：`"auto"`/缺省取第一个该类节点、具体 id 精确匹配（字符串化）、`"none"` 跳过该类注入。CheckpointLoaderSimple 始终 `%model%`；目标 Empty*LatentImage `%width%`/`%height%`；目标 KSampler `%seed%/%steps%/%scale%/%sampler%/%scheduler%/%denoise%`；CLIPTextEncode 按所选采样器正/负输入引用区分 `%prompt%`/`%negative_prompt%`（**正负提示词始终注入**，`"none"` 时按第一个采样器推导，避免空图）。
  - `detectComfyNodes(apiPrompt)`（image-gen.js）：识别关键节点，返回 `{ samplers:[{id(classType),positiveId,negativeId}], latents:[{id,classType}] }`，供节点下拉与"提示词节点：正=X 负=Y"展示。
  - `fetchComfyObjectInfoRaw(comfyUrl)`：GET `/object_info` 返回完整 JSON（LiteGraph 导入时 graphToPrompt 需要）。
  - **注入时机**：`fetchComfyServerWorkflows` 转换后**不注入**（缓存保持工作流原值）；占位符注入发生在生成前 `generateImageWithComfy`（按 `settings.comfySamplerNodeId/comfyResolutionNodeId`）与预览时 `loadComfyWorkflowDraft`。
  - 结果出现在 workflow 下拉（`服务端：{名}`，value `server:{名}`）；选中后草稿显示转换后的 API JSON（含占位符），可直接编辑另存为本地自定义；`comfyWorkflowOptions` 合并内置 default / 本地自定义 / 服务端 / 导入四组。
- **自定义分辨率**：`comfyResolutionOptions` 含 `custom` 项；选自定义时显示 `settings.comfyCustomResolution` 输入框（默认 `832x1216`），`buildImageGenPlaceholder` 把 `'custom'` 解析成实际分辨率字符串再下发。
- **KSampler 参数区块与节点选择**：UI 集中展示采样器/调度器/steps/cfg/denoise 五字段（复用全局 `comfySampler`/`comfyScheduler`/`imageGenSteps`/`imageGenCfg`/`imageGenDenoise`）。`settings.comfySamplerNodeId` / `comfyResolutionNodeId`（默认 `"auto"`）选择要控制的工作流节点（`auto`=第一个 / 具体 id / `none`=不控制）；选中节点时注入占位符、由 UI 全权控制，未选中节点保持工作流原值。"无（不控制）"仅关闭采样参数注入，正负提示词仍注入（按第一个采样器推导）。
- **导入工作流 JSON**：`importComfyWorkflow(event)` 读取 `.json` 文件，自动检测格式——LiteGraph 图（`nodes+links`）经 `fetchComfyObjectInfoRaw` + `graphToPrompt` 转换，API 格式（含 `class_type`）直接用；导入即生效（会话级 `comfyImportedWorkflow`，下拉显示 `导入：{名}`），可"保存为工作流"固化到 localStorage，未固化刷新即失；启动时若 `settings.comfyWorkflow` 残留 `import:` 前缀则归一化回 `"default"`。

### 8.4 状态检查（按 provider 分支）

- `checkImageGenStatus`（app.js 6500）：`sta1n` 维持 HEAD no-cors 直连 `nai.sta1n.cn`；`openai` 复用 `checkApiStatus` 结果、UI 隐藏额度卡片；`comfy` 改 GET `{comfyUrl}/system_stats`。
- `fetchQuota`（app.js 286）开头守卫：仅 `imageProvider==='sta1n'` 且有 key 时才 POST `/api/api/getUser` 查额度，否则额度归零。
- `checkAllStatuses`（app.js 6544）：`fetchQuota()` 仅当 provider 不是 openai/comfy 时调用。

---

## 9. 关键点总结

- **用户设置只有 3 个字段影响 AI**：`name`（[User Info]/消息名/记忆/{{user}} 替换）、`description`（[User Info]）、`person`（第二/第三称预设互斥）；`avatar` 纯 UI。
- **人设多套是"整包快照"**：deep watch 反向写回 + `Object.assign` 整包切换，人设与运行时 user 永远一致。
- **settings 分三类**：直接影响请求（apiUrl/key/model/temperature/stream）、影响子系统（activeTool/UI模板/生图）、纯 UI（contextSize/背景/沉浸/字体）。
- **key 按提供商分桶**：`apiProviderKeys` 让 6 个提供商各自记住 key，切换不丢。
- **三档模型即三份预设**：`settings.model` 是唯一请求模型，档位切换只是把它替换为对应档字段。
- **状态检查 3 连**：API（GET models，10s 超时）、生图（按 provider：sta1n HEAD no-cors / openai 复用 API 状态 / comfy GET system_stats）、额度（仅 sta1n，POST getUser）。
- **错误统一标记**：`extractApiErrorMessage` + `isApiError` 保证一次解析、不二次包装。
- **用量多提供商兼容**：`normalizeApiUsage` 兜底十几种字段别名，三类过滤由 `getTokenUsageCategory` 映射。

**一句话**：设置系统以"用户人设（影响提示词的 3 个字段）+ 全局 settings（请求参数/子系统开关/纯 UI 三类）"为骨架，API 连接层负责提供商分桶存 key、`getApiEndpoint` 自动拼 `/v1`、Bearer 鉴权、三档模型切换与 `models` 列表拉取，配合 10s 超时的状态检查、统一错误解析、多提供商兼容的用量记账；生图服务扩展为 sta1n / OpenAI 兼容 / ComfyUI 三后端，对话内走"占位 + 异步填图"，ComfyUI 可拉取服务端已保存工作流（graph→API 转换）并支持自定义分辨率。
