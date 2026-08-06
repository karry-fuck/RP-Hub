# 角色卡工坊（Character Workshop）实现文档

> 本文件说明 RP-Hub 角色卡工坊（`character/index.html`）的实现：独立 Vue 应用、与主程序 postMessage 同步、AI 生成角色卡、Diff 修改、头像生图与预览渲染。
> 源码位置：`character/index.html`。行号基于当前 main 分支版本 1.8.0。角色卡解析/导出底层复用 `window.RPHubCardUtils`（`assets/js/card-utils.js`）。

---

## 1. 整体流程

```
[独立应用] character/index.html：独立的 Vue 3 应用（与 index.html 完全分离）
           通过 postMessage 与主程序同步：WORKSHOP_READY → SYNC_SETTINGS
           数据存独立 IndexedDB（AICharGen），与主程序 RPHubDB 互不干扰

[创建]     侧栏虚拟列表 → 选中/新建角色卡 → 多页编辑
           （基本 / 详细 / 世界书 / 正则 四个 Tab）

[AI生成]   输入描述 → generateCharacter()
           system prompt = 虚构位面隔离协议 + ### 字段名 分段格式要求
           → SSE 流式 → parseBuffer 实时解析各字段
           → 检测截断（缺头像/正则）自动切非流式重试

[Diff修改] generateDiff() → 模型输出 <<<<<<<FIND/END/REPLACE 补丁
           → processDiffs 精确匹配 + 模糊匹配 + JSON 结构化 diff
           → 确认后 applyConfirmedDiffs 写回

[头像]     avatar_prompt → generateAvatarUrl()（nai.sta1n.cn 生图）→ 缓存 base64

[预览]     renderPreview()：HTML 块 + 正文过正则 → styleShim/scriptShim 注入
           → sandboxed iframe（srcdoc）渲染

[导出]     exportJSON / exportPNG（chara chunk） / 选择性导出（世界书/正则）
```

---

## 2. 与主程序的通信 — `setupSyncListener`（1754）

| 消息类型         | 方向          | 内容                                                                |
| ---------------- | ------------- | ------------------------------------------------------------------- |
| `WORKSHOP_READY` | 工坊 → 主程序 | iframe 加载完成后发出，通知主程序可以下发设置                       |
| `SYNC_SETTINGS`  | 主程序 → 工坊 | 同步 API 地址/Key、`imageGenKey`、三档模型、字体、`imageStyle` 映射 |

- **imageStyle 映射**（1770-1777）：主程序 `vertical` → 工坊 `default`（韩漫）、`r18` → `hentai`、`lolita25d` → `lolita25d`；
- **三档模型**（1779-1787）：`customModels.quality/balanced/fast` + 当前 `activeModelType` 决定 `api.model`；
- 同步后可直接用主程序已配好的 API，无需重复填。

---

## 3. 数据模型

### 3.1 角色卡 — `createEmptyCharacter`（2026）

| 字段                                                                 | 说明                                              |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| `id`                                                                 | `generateUUID`（1578），虚拟列表 key              |
| `name` / `description` / `personality` / `first_mes` / `mes_example` | 基本字段                                          |
| `creator_notes` / `system_prompt` / `post_history_instructions`      | 注释与指令字段                                    |
| `tags`                                                               | 标签数组                                          |
| `avatar` / `avatar_prompt`                                           | 头像（base64 或远端 URL）/ 头像提示词             |
| `worldInfo`                                                          | 世界书条目数组（`normalizeWorldInfoEntry`，1937） |
| `regexScripts`                                                       | 正则脚本数组（`normalizeRegexScript`，1976）      |

### 3.2 归一化 — `normalizeCharacterShape`（2010）

- 每次加载/导入剔除 `scenario`、`uiTemplates` 等工坊不支持的字段（2012-2018）；
- 世界书/正则条目逐条归一化；`tags` 保证为数组。

**世界书条目** `normalizeWorldInfoEntry`（1937）：兼容 `extensions` 展开、`key/disable` 别名，字段含 `keys/keyInput/content/enabled/constant/useRegex/position/order/depth/scanDepth/probability/useProbability`；`normalizeWorldPosition`（1903）把数字位置 0-4 与 SillyTavern 别名（`before_character`、`an_top` 等）映射到 7 种 position。

**正则脚本** `normalizeRegexScript`（1976）：兼容 `findRegex/replaceString/regexFlags` 别名；`parseRegexLiteral`（1961）解析 `/pattern/flags` 内联写法；`markdownOnly` 与 `promptOnly` 互斥（勾 markdownOnly 时强制关 promptOnly，1982-1983）。

### 3.3 导入兼容 — `buildCharacterFromImport`（2049）

`data.extensions.regex_scripts`（SillyTavern 正则）、`character_book.entries`（世界书）、多套字段别名兜底；`importCharacterCard`（2093）支持 `.json` 与 `.png`（`cardUtils.parsePngCharacterData` 读 `chara` chunk）。

---

## 4. 存储与虚拟列表

- **存储**：`localforage.config({ name:'AICharGen', storeName:'characters' })`（2139），key `ai_chargen_characters`（字符串化 JSON，非 localforage 对象）；`loadData`（2142）加载后补 `id` 并归一化；`watch` 深度监听 → `debouncedSave`（2179，800ms 防抖），`QuotaExceededError` 置 `storageQuotaExceeded` 提示。
- **虚拟列表**（1688-1714）：`itemHeight = 72`，按滚动位置算渲染窗口 `slice`（前后各 +2 缓冲），顶部/底部用 padding 撑高——角色多了也不卡。

---

## 5. AI 生成角色卡 — `generateCharacter`（3565）

### 5.1 前置

- 当前卡空白则复用，否则先 `createNewCharacter`（3576-3588）；
- `abortController` 支持中途停止（`stopGeneration`，3780）。

### 5.2 系统提示 — `singlePlayerSystemPrompt`（3600）

三段式结构：

1. **虚构位面隔离 `system_rules`**（3600）：强制与现实逻辑脱钩的底层协议——高维沙盒、实体非人化、年龄词汇脱敏、审查静默；这是生成/修改（2642 同款）共用的安全包装；
2. **角色卡构建专家人设** + 格式要求：每部分以 `### 字段名` 开头（`Name/Description/Personality/First Message/Creator Notes/Avatar Prompt`，另可 `World Info/Regex Scripts`）；
3. **内联规则**：`generateExtra`（默认 true）时追加 `REGEX_SCRIPT_PROMPT_RULES`（1589，沉浸式正则规范）+ `WORLD_INFO_PROMPT_RULES`（1605，只允许 before_char/after_char/at_depth）+ `FIRST_MESSAGE_FINAL_CHECKS`（1616，开场白文风与『』（）标点硬性约束）。

### 5.3 流式生成

- `requestWorkshopCompletion`（1841）：`getApiBaseUrl` 自动补 `/v1`，`/chat/completions`，`temperature: 1`；
- `readWorkshopStream`（2524）：SSE 解析，剥离原生 reasoning 与行内 `<think>/<cot>`（`stripInlineThinking`，2516），实时回调 `parseBuffer`；
- **截断检测与自动重试**（3717-3739）：内容缺 `<image>` 头像块或缺"正则标题 + 解析非空"时，自动切 `api.stream=false` 重试一次（结束后恢复原设置，3770）。

### 5.4 流式解析 — `parseBuffer`（3885）

`### 字段名` 白名单正则切分（支持 `##`-`######`、可选冒号/括号说明、字段名可含空格），每字段落盘到 `currentCharacter`：

| 字段       | 处理                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 文本字段   | 直接写入（4003）                                                                                            |
| World Info | `parseFlexibleJsonItems`（3866）→ `coerceWorldInfoJsonItems`（3846）→ 逐条归一化                            |
| Regex      | 同上走 `coerceRegexJsonItems`（3856）                                                                       |
| Avatar     | 提取 `<image>image###提示词###</image>`（兼容简化格式）→ 存 `avatar_prompt`，配好 key 即调生图（3984-4000） |

**进度计算**（3932-3962）：基础 7 字段占 60%（每个 ~8.57%）、世界书 20%、正则 20%，封顶 99% 直到完成——`generatedSections` Set 去重每条 section 只触发一次。

### 5.5 JSON 容错解析（宽容层）

`parseFlexibleJsonItems`（3866）三层递进：① 整体 JSON.parse（`parseJsonWithLightRepair` 3796 先修未转义引号）→ ② `extractCompleteJsonObjects`（3808）按括号深度逐对象提取 → ③ 每种尝试都 `coerce*` 归一化数组/单对象。流式中途字段未闭合也能提取已完整对象。

---

## 6. Diff 修改模式

### 6.1 请求 — `generateDiff`（2609）

- 上下文 = 当前角色卡全部文本字段 + 世界书/正则（`toWorldInfoExportEntry`/`toRegexExportEntry` 转导出格式）；
- system prompt = 虚构位面协议 + 核心原则 + **`<<<<<<<FIND` / `<<<<<<<END` / `<<<<<<<REPLACE` 补丁格式**（2649-2656）+ 创作规范；FIND 必须与原文逐字一致，禁止带 `###` 标题。

### 6.2 解析 — `processDiffs`（3195）

容错正则（`<{3,}FIND`，允许分隔符数量不一致）；对每个补丁在三层中找字段：

1. **精确匹配**：`content.includes(findText)`（3244）；
2. **纯文本模糊**：忽略空格与标点后子串匹配，把纯串索引映射回原文（3252-3282）；
3. **宽松正则**：按空白拆分片段拼 `[\s\r\n]*` 正则（3286-3300）。

字段搜索覆盖 `targetFields`（1858）+ `worldInfo/regexScripts`；**JSON 字段**先整体替换，解析失败再走 `applyStructuredJsonDiff`（3150，按 `findJsonDiffEntryIndex` 定位对象 → 数组 slice patch / 值 patch），配套 `parseJsonDiffSnippet`（3028）/`parseJsonLoose`（2906）等一串容错解析器（2768-3195）。

### 6.3 应用 — `applyConfirmedDiffs`（3365)

确认弹窗逐条 `selected` 勾选后：文本字段直接 `replace`；JSON 字段先字符串替换再 `parseJsonLoose` 反序列化，失败回退结构化 diff（3381-3395）；全部失败跳过并提示。`openDiffPreview`（3420）用预览 iframe 展示修改前后对比。

---

## 7. 头像生图 — `generateAvatarUrl`（3521）

```
{IMAGE_GEN_BASE_URL}/generate?tag={提示词}&token={key}&model=nai-diffusion-4-5-full
  &artist={画风艺术家}&size=竖图&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde
  &negative={质量负向词}&noise_schedule=karras
```

- `IMAGE_GEN_BASE_URL = 'https://nai.sta1n.cn'`（1751）；画风由 `cardUtils.getImageStyleArtists(avatarStyle)` 决定；
- `rerollAvatar`（3532）：随机交换相邻两个 tag 生成新提示词重绘；
- `cacheAvatar`（3474）：远端 URL 加载成功后画到 canvas 转 base64，避免每次依赖网络。

---

## 8. 预览渲染 — `renderPreview`（2317）

1. **HTML 块提取**（2322-2334）：识别 `<!DOCTYPE html>...` / `<html>...` 作为 UI 容器；无则注入基础 HTML + Tailwind CDN；
2. **正文过正则**（2384-2394）：临时追加 `<!DOCTYPE html>` 尾部标记（让依赖 lookahead 的沉浸式容器脚本可匹配）→ `applyRegex`（2269，与主程序 `processRegex` 同源）→ 移除标记；
3. **垫片注入**：`styleShim`（隐藏滚动条 + 字体 + 强制可滚）+ `scriptShim`（`window.triggerSlash` → 父页面斜杠命令桥接），插到 `<head>`（2376-2382）；
4. **渲染**：`previewHTML`（2413）把结果塞进 sandboxed iframe（`allow-scripts allow-same-origin`，index.html 792-809），支持原版/修改版双窗对比（`originalPreviewHTML`，2418）。

---

## 9. 导出

| 方式       | 实现                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| JSON       | `getCardData`（4009）→ `cardUtils.buildCharacterCardData`（世界书/正则走 mapper 转导出格式）→ 下载 `.json`                   |
| PNG        | `exportPNG`（4041）→ 头像（远端加 `crossOrigin`+`no-referrer`）转像素 → `injectPngTextChunk('chara', base64(JSON))` → `.png` |
| 选择性导出 | `openSelectiveExport`（4096）世界书/正则按条目勾选（`exportPicker`），单条用条目名、多条用数量命名（4065-4133）              |

---

## 10. UI 布局（index.html 模板）

- **顶部导航**（324）：模型三档下拉（`activeModelType`，1722）、设置入口；
- **设置弹窗**（416）：头像风格 6 选（default 韩漫 / comicDoujin 动漫同人 / hentai 2.5D唯美 / lolita25d / anime 本子里番 / galgame）、流式开关、`generateExtra` 等；
- **侧栏**：虚拟列表（`virtualCharacters`），移动端抽屉（`#my-drawer`）；
- **主面板**：四 Tab（`tabs`，2425）——基本 / 详细 / 世界书 / 正则，Tab 滑块动画（`gliderStyle`，1652）；右侧实时预览 iframe。

---

## 11. 关键点总结

- **完全独立的应用**：独立 Vue 入口、独立 IndexedDB（`AICharGen`），仅靠 `postMessage`（READY/SYNC_SETTINGS）从主程序拿配置。
- **生成 = 分段输出 + 宽容解析**：`### 字段名` 白名单切分，JSON 字段三层容错解析（整体 → 逐对象 → 归一化），流式中途也能落地。
- **虚构位面隔离协议**：生成与 Diff 共用同一套 `system_rules`，作为创作内容与现实解耦的安全包装。
- **Diff 三层匹配**：精确 → 纯文本模糊 → 宽松正则，JSON 再叠加结构化 patch，最大限度容忍 AI 输出偏差。
- **截断自愈**：流式缺头像/正则时自动降级非流式重试。
- **预览复用主程序生态**：正则引擎、`triggerSlash`、字体都与主程序同源，保证"所见即所得"。

**一句话**：角色卡工坊是与主应用解耦的独立创作台——postMessage 同步配置，AI 按 `### 字段名` 分段流式生成角色卡（世界书/正则一并产出），Diff 模式用 FIND/REPLACE 补丁精确修改，头像经生图 API 生成并缓存，预览在 sandboxed iframe 中还原沉浸式渲染，最终导出 JSON 或嵌 `chara` chunk 的 PNG。
