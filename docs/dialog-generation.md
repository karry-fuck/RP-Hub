# 对话生成管线（Dialog Generation）实现文档

> 本文件说明 RP-Hub 对话生成管线的实现：从用户发送到 AI 回复的完整链路——世界书检索、系统提示与消息上下文组装、记忆压缩与注入、主动工具、流式接收与生成后处理。
> 源码位置：`assets/js/app.js`。行号基于当前 main 分支版本 1.8.0。

---

## 1. 整体流程

```
[入口]    sendMessage() 追加用户消息（含 [系统指令: ...]）→ generateResponse()

[上下文]  世界书检索：触发词/概率/位置 → 7 桶分组
         → 预设处理（破限 / COT / systemPresets / messagePresets）
         → 系统提示组装（逐段拼接，含角色设定 / 文风 / 主动工具 / UI模板 / COT）
         → 消息数组构建（system + messagePresets + 角色开场 + 历史，带 _contextFloor）
         → 记忆压缩（向量移除旧轮 / 经典原地替换摘要）
         → 消息清洗（parseCot 剥离 CoT、剥 UI 模板块、贴 [系统指令]）
         → 向量记忆召回（余弦 top-K）
         → processMessageInjections：at_depth 插入 / <memory_fragment> 注入 / user_top / assistant_top
         → 主动工具提醒 + <active_tool_results> 注入
         → 正则后处理（isPrompt）→ floorInfo 楼层标记

[请求]    POST /v1/chat/completions（Bearer key，stream 或非流式）
         流式：SSE 逐 delta 解析 → ensureAssistantMessage + appendAssistantText
               reasoning 走 rAF 节流 → 截断渲染（processMainContent）
         非流式：先 JSON 解析，失败再按 SSE 文本二次解析（兼容强制流式 API）

[生成后]  applyMainModelUiTemplateUpdates（主模型 UI 模板）
         → recordApiUsage（usage 记账）
         → 主动工具续写（handleActiveToolCallFromAssistant，最多 4 层）
         → 副模型 UI 模板分析（updateUiTemplatesFromChat）
         → 记忆提取（extractMemoryFromChat → startAutomaticMemoryPatrol）
```

---

## 2. 入口与框架

### 2.1 发送 — `sendMessage`（4829）

1. `userInput` 非空且不在对话中（`isConversationBusy`）才继续；
2. 有 `sysInstruction` 时追加 `\n\n[系统指令: ...]` 并自动清空；
3. 推入用户消息：`{ role:'user', name:user.name, content, shouldAnimate, skipReveal, isSelf, avatar }`（4836-4851）；
4. `generateResponse(startTime)`（4855）进入生成。

### 2.2 生成框架 — `generateResponse`（5530）

**options**（5531-5535）：

| 选项                         | 含义                                       |
| ---------------------------- | ------------------------------------------ |
| `reuseGeneratingState`       | 续写时复用 `isGenerating` 状态，不重复进入 |
| `activeToolDepth`            | 主动工具续写层级（0 起，上限 4）           |
| `continueAssistantMessageId` | 续写目标消息 id（工具回填旧气泡时用）      |
| `continuationToolCallId`     | 续写对应的工具调用 id                      |

关键状态（5550-5558）：

- `continuationTargetMessage` 存在 → `isReceiving=true`，占住"接收中"，不冒新 typing 气泡；
- `abortController.value = new AbortController()` 支持中途停止；
- `startTimer()`（5562）每 100ms 更新 `currentWaitTime` 显示等待秒数。

**工具续写目标解析**（6261-6264）：`continuationToolCall` 从 `continuationTargetMessage.toolCalls` 中按 id 找到，保证续写内容回填到对应工具调用所属气泡。

---

## 3. 世界书检索（5575-5727）

### 3.1 概率与触发

| 函数                         | 行号  | 作用                                         |
| ---------------------------- | ----- | -------------------------------------------- |
| `toNonNegativeNumber`        | 5577  | 数字兜底为 0                                 |
| `evaluatedProbability`       | 5575  | Map 缓存已掷概率，同一轮不重复掷             |
| `createWorldInfoRegex`       | 5577+ | 由 keys 构造触发正则（含模式匹配）           |
| `worldInfoKeyMatchesText`    | —     | 文本是否命中条目关键词                       |
| `passesWorldInfoProbability` | —     | 按 `probability/useProbability` 掷随机数判定 |
| `checkEntryTrigger`          | —     | 组合触发/概率/深度判断                       |

- `triggeredEntries` Map 扫描 `activeWorldInfo`：`constant` 常驻条目直接触发（score=Infinity）；
- 排序：**常驻优先，然后 `order` 降序**；
- 结果分桶到 `wiGroups`（7 个 position 桶），组内按 `order` 升序。

### 3.2 位置分桶（7 桶）

| 桶              | 语义                          |
| --------------- | ----------------------------- |
| `system_top`    | 系统提示最前                  |
| `global_note`   | 全局备注（紧随破限）          |
| `before_char`   | 角色设定前                    |
| `after_char`    | 角色设定后                    |
| `at_depth`      | 深度插入（消息流中）          |
| `user_top`      | 最后用户消息开头              |
| `assistant_top` | 末尾 assistant 前 system 消息 |

### 3.3 概率缓存防抖动

`evaluatedProbability` 保证**每轮生成只掷一次概率**：同一轮内多次引用同一条目不重新掷，避免同一条目因多次判定而时灵时不灵。

---

## 4. 预设处理与系统提示组装（5730-5801）

### 4.1 预设分流

`enabledPresets` 按 name 分流：

| 分流                 | 取法                                 | 用途                                           |
| -------------------- | ------------------------------------ | ---------------------------------------------- |
| `cotPresets`         | `name === 'COT'`                     | 思维链预设（`buildCotPresetContent` 动态重建） |
| `systemPresets`      | 其余全部 system 角色                 | 注入系统提示段                                 |
| `messagePresets`     | 其余 role 为 `user` / `assistant` 的 | 作为独立消息插入 messages                      |
| `systemPresetPrompt` | 仅取 `name === '破限'`               | 破限提示词                                     |

### 4.2 系统提示拼接顺序（5751-5801）

```
1. 破限（systemPresetPrompt）
2. system_top WI
3. global_note WI
4. otherPresets（其余 system 预设）
5. [Style Priority] 硬编码提示（开场白与历史消息不作为文风模板）
6. characterPrelude：
     before_char WI
   + [Character] charPrompt（角色卡设定）
   + mesExample（示例对话）
   + after_char WI
7. userPrompt（当前用户设定）
8. activeToolPrompt（<active_tools> 块，见 active-tools.md）
9. uiTemplateContextPrompt（UI 模板变量快照，副模型分析模式下）
10. mainModelUiTemplatePrompt（主模型 UI 模板更新指令）
11. COT（思维链内容）
```

---

## 5. 消息数组构建（5808-5855）

顺序：`system` 消息 → `messagePresets`（数量计入 `safeTargetLimit`）→ `characterPrelude`（以 user 角色呈现，`safeTargetLimit++`）→ 开场白强制补录检查 → `chatHistoryForContext`（每条带 `_contextFloor: index+1` 楼层标记）。

- **safeTargetLimit**：后续 at_depth 插入与记忆替换的"保护楼层"——之前注入的角色设定/开场白不参与深度插入与压缩；
- **开场白强制补录**：若 `chatHistoryForContext` 中没有第一条 AI 开场白，则从 `char.first_mes` 补录，保证模型永远看得到角色开场；
- 每条历史消息记录 `_contextFloor`，供 floorInfo 触发词楼层计算使用。

---

## 6. 记忆压缩与消息清洗（5859-5955）

### 6.1 向量模式（5859-5872）

`MEMORY_MODE_VECTOR`：用 `removableIndices` Set 移除已被记忆覆盖的旧轮次（`keepCount = vectorKeepFloors`），减少送入请求的历史长度。

### 6.2 经典模式（5874-5922）

`MEMORY_MODE_CLASSIC`：`buildClassicMemoryLookup` + `findClassicMemoryForTurn`，对 `candidateCount = 总消息数 - summaryKeepFloors` 之前的每一轮，**原地替换 assistant 原文为 `memory.summary`**（用户原文保留）。详见 [`memory-system-classic.md`](./memory-system-classic.md)。

### 6.3 消息清洗（5925-5955）

| 函数                              | 作用                                           |
| --------------------------------- | ---------------------------------------------- |
| `parseCot(source.content).main`   | 剥离 `<think>/<cot>` 与 `[系统指令: ...]` 标记 |
| `stripDisabledImageGenContext`    | 剔除已停用的画图上下文块                       |
| `stripUiTemplateContextInjection` | 剔除 `<ui_template_state_context>` 历史残留    |
| `[系统指令: ...]` 追加            | user 消息把 sysInstruction 一并带上上下文      |

---

## 7. 消息注入 — `processMessageInjections`（5968-6087）

1. **at_depth 深度插入**：倒序数 user/assistant 消息计数，命中深度位置插入条目；`targetIndex < safeTargetLimit` 时跳过保护；
2. **向量记忆召回**：`selectVectorMemoriesForContext`（7734）按余弦 top-K，注入 `<role_memory_vector_recall>` 块 + 逐条 `<memory_fragment turn= similarity= story_time=>`（格式见 memory-system.md）；
3. **user_top**：拼接到最后一条用户消息开头；
4. **assistant_top**：作为末尾 system 消息（`[Instructions for next message]`）插入。

---

## 8. 主动工具与正则后处理（6090-6106）

1. **主动工具提醒**（6090-6093）：`appendActiveToolReminderToLatestUserMessage`（5435）把当前策略提醒拼到最后一条用户消息结尾；
2. **结果回填**（6094-6098）：`pendingActiveToolContext` 非空时，`buildActiveToolResultPayload`（8128）生成 `<active_tool_results>` 块作为一条 user 消息 push 进上下文——这是工具续写的入口（见 active-tools.md）；
3. **正则后处理**（6099-6106）：`postprocessContextMessages`（1043，合并连续同 role 消息）+ `processRegex(content, { isPrompt:true, role, depth: array.length-1-index })` 对每条上下文消息做提示词级正则（如把 `{{user}}` 自动替换）。

---

## 9. 上下文楼层标记（6120-6239）

生成完 `apiMessages` 前，为 UI 高亮计算信息：

- **floorInfo**：遍历上下文消息，计算世界书触发词楼层、记忆注入楼层；
- `injectedWIsMap` / `globalInjectedWIs`：记录每条消息实际注入的世界书条目与触发词，存到 `lastTriggeredWorldInfos`；
- 每条消息返回 `{ role, name, content, renderedContent, floor, isMemory, wiTriggers }`，供前端"触发词高亮 mark"渲染；
- 最终 `apiMessages` = 仅 `{ role, name, content }` 三元组（6241-6245）；
- **控制台日志**（6248）：`printAIRequestLogs`（5388）分组打印系统提示词、消息列表表与完整对象，便于调试。

---

## 10. API 请求构造与发送（6352-6394）

```js
const url = getApiEndpoint("chat/completions"); // 4661：自动拼 /v1
fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  },
  body: JSON.stringify({
    model: requestModel, // settings.model（5536）
    messages: apiMessages,
    temperature: settings.temperature,
    stream: settings.stream,
    ...(settings.stream ? { stream_options: { include_usage: true } } : {}),
  }),
  signal: abortController.value.signal,
});
```

**错误处理**（6370-6389）：

- `response.ok` 为假 → 尝试 JSON 解析 `extractApiErrorMessage`（4425），非 JSON 则用原文；
- `throwApiError`（4439）抛出带 `isApiError` 标记的错误，保证上层 catch 不再二次包装；
- `formatApiErrorMessage`（4415）组装状态码 + 错误详情。

**流式判定**（6391-6393）：`settings.stream && content-type 含 text/event-stream` 才走 SSE 分支。

---

## 11. 流式接收（6395-6493）

### 11.1 SSE 解析

`reader.read()` 循环 → `TextDecoder({ stream:true })` 缓冲 → 按 `\n` 拆行 → `data: ` 前缀剥离 → `[DONE]` 跳过 → `JSON.parse`：

- 每 chunk 先 `extractApiErrorMessage` 检查错误；
- `responseUsage = getApiUsagePayload(data) || responseUsage`（1982）累计 usage；
- `delta = choice.delta || choice.message`（兼容两种格式）；
- `extractNativeReasoning(delta) || extractNativeReasoning(choice)`（4383 → card-utils.js:46）提取原生推理内容。

### 11.2 reasoning 节流（6401-6420）

原生推理不逐 delta 刷新 UI，累积进 `pendingNativeReasoning`，用 `requestAnimationFrame` 调度 `applyPendingNativeReasoning`（**每帧最多 flush 一次**），流结束前 `flushNativeReasoning` 兜底。

### 11.3 消息落地 — `ensureAssistantMessage`（6335）

| 场景                    | 行为                                                     |
| ----------------------- | -------------------------------------------------------- |
| 已有 `assistantMessage` | 直接返回（复用同一气泡）                                 |
| 工具续写                | `prepareAssistantMessageForAppend` 补字段 → 回填旧气泡   |
| 首条                    | `createAssistantMessage` 新建并 push，`isReceiving=true` |

### 11.4 追加 — `appendAssistantText`（6279）

- **active tool 捕获态**（6285-6293）：正文转入 `_activeToolPendingText`，交给 `promoteActiveToolCallsFromAssistant` 处理，不再直接追加（见 active-tools.md 第 4 节）；
- 续写首片段：去掉尾部空白后 `+ '\n\n' + text` 拼接（6277-6281），避免与旧内容粘在一起；
- 内容追加后再次 `promoteActiveToolCallsFromAssistant`（6308）实时检测工具标签；
- 首个 content/reasoning 种子片段（6455-6482）：`ensureAssistantMessage(content, reasoning)` 同时种入首段，reasoning 未先到则 `isThinking=true`，首 content 到达后 `isThinking=false` 并 `collapseNativeReasoning`（自动收起未读完的推理面板）。

### 11.5 生成期间截断渲染

`processMainContent`（11752）在生成中应用（stream 渲染路径）：

- 先 `stripUiTemplateUpdateBlock`（11753）剔除 `<ui_template_updates>` 块，避免主模型更新指令显示给用户；
- 匹配 `['```html','```vue','<!DOCTYPE','<div','<style']`（11755）任一即视为"即将输出 UI 模板/代码"，截断到最早出现处并显示 spinner（11763-11765）；
- 非生成态原样返回。

---

## 12. 非流式接收（6494-6581）

**两层解析**（兼容"stream=false 但仍返回 SSE 格式"的 API）：

1. **JSON**（6501-6528）：标准解析 `choices[0].message.content` + reasoning，一次性落地；
2. **SSE 文本**（6533-6580）：JSON 失败后按 `data:` 行逐条累加 content/reasoning（6329 兼容 `data:{...}` 无空格前缀），最后统一落地。

两种路径结束后都设置 `assistantMessage.isReasoningOpen / isReasoningAutoCollapsed`（内容+推理并存时默认折叠推理）。

---

## 13. 生成后处理（6583-6694）

| 步骤              | 行号      | 说明                                                                             |
| ----------------- | --------- | -------------------------------------------------------------------------------- |
| `recordApiUsage`  | 6583-6587 | usage 记账：`type='chat'` 或 `'tool_continuation'`（第 N 次续写）                |
| 响应日志          | 6589-6596 | 分组打印完整内容 + reasoning                                                     |
| UI 模板（主模型） | 6598-6600 | `applyMainModelUiTemplateUpdates`（3483）解析 `<ui_template_updates>`            |
| 生成耗时记录      | 6602-6610 | 推入 `recentGenerationTimes`（保留最近 5 条）                                    |
| **错误分支**      | 6615-6648 | AbortError → 中止标记或回退删除气泡；其他错误 → 系统消息提示                     |
| **finally 收尾**  | 6649-6669 | 状态复位、`saveChatHistoryNow`、清 waitTimer、重置续写标记                       |
| **主动工具续写**  | 6674-6676 | `handleActiveToolCallFromAssistant` 返回 true → 递归 `generateResponse(depth+1)` |
| UI 模板（副模型） | 6682-6686 | `updateUiTemplatesFromChat` 异步分析最近 N 层对话                                |
| **记忆提取**      | 6689-6693 | `extractMemoryFromChat`（7061）→ `startAutomaticMemoryPatrol`（9273）            |

**错误分支细节**（6615-6648）：

- `AbortError`（用户取消）：`_wasCancelled=true`，已有内容则追加 `*-- 生成已中止 --*`，否则回退删除气泡、推一条 `role:'system'` 的"生成已中止"；
- 工具续写出错：`appendAssistantResponseError`（4458）在旧气泡末尾追加 `<div class="response-error-text">` 错误块；
- 普通错误：push 一条 system 消息显示 `error.message`。

**取消抑制**（6671-6680）：`wasCancelled` 为真时不触发 UI 模板分析 / 主动工具续写 / 记忆提取，避免取消后还产生副请求。

---

## 14. 关键点总结

- **单函数全链路**：`generateResponse`（5530-6695）承载世界书、预设、记忆、注入、请求、流式、后处理全部逻辑，靠 options 区分主生成与工具续写。
- **上下文三层保护**：`safeTargetLimit`（保护角色设定/开场白）→ 记忆 `keepFloors`（保护近期轮次）→ at_depth 深度插入（在历史中定位插入点）。
- **记忆双模式**：向量移除旧轮 + 召回注入；经典原地替换摘要（见 memory 系列文档）。
- **流式双缓冲**：content 直接追加、reasoning rAF 节流；active tool 捕获态把正文改道 pending，防标签半截显示。
- **容错三连**：错误 JSON 改 SSE 二次解析、`extractApiErrorMessage` 统一 API 错误、AbortError 优雅收尾。
- **截断渲染**：`processMainContent` 在生成中对 UI 模板/代码块提前截断并显示 spinner，避免半成品闪屏。
- **后处理解耦**：UI 模板（主/副模型）、主动工具续写、记忆提取全部在 finally 中异步触发，互不阻塞主气泡落地。

**一句话**：对话生成 = 一次上下文组装（世界书/预设/记忆/注入/正则）→ 一次 API 请求（流式优先）→ 流式落地（reasoning 节流 + 工具捕获 + 截断渲染）→ finally 异步触发 UI 模板更新、主动工具续写与记忆提取的完整闭环。
