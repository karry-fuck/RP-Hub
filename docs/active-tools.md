# 主动工具（Active Tools）实现文档

> 本文件说明 RP-Hub 主动工具系统的实现：XML 标签驱动的工具调用、检测/执行/结果回填闭环、Tavily 联网与自动续写。
> 源码位置：`assets/js/app.js` 与 `index.html`。行号基于当前 main 分支版本 1.8.0。

---

## 1. 整体流程

```
[定义]   三个内置工具：tool_memory(向量记忆) / tool_grep(关键词) / tool_web(Tavily)
         attackiveness: force / active / adaptive（决定调用积极性）

[注入]   系统提示追加 <active_tools> 块（工具定义 + 调用规则 + 当前策略）
         最后一条用户消息追加策略提醒（appendActiveToolReminderToLatestUserMessage）

[检测]   流式接收时逐片段 promoteActiveToolCallsFromAssistant
         完整 <tool_x_add:查询>  → 拆出正文 + 生成 toolCalls UI
         未闭合尾部标签         → 进入 _activeToolCaptureActive 接收参数

[执行]   handleActiveToolCallFromAssistant
         深度限制(4) → 逐工具执行（web 工具批量并发）
         结果格式化为 XML → updateActiveToolResultContext
         add=追加 / cover=覆盖

[回填]   自动续写 generateResponse(activeToolDepth+1)
         <active_tool_results> 注入最后用户消息结尾 → 模型基于结果继续正文
```

---

## 2. 内置工具与数据模型

### 2.1 三个默认工具（`getDefaultActiveToolDefinitions`，1291）

| 工具 id       | 类型               | 功能                           | 后端实现                                                                     |
| ------------- | ------------------ | ------------------------------ | ---------------------------------------------------------------------------- |
| `tool_memory` | `vector_memory`    | 检索长期向量记忆               | `searchVectorMemoriesForTool`（7862）                                        |
| `tool_grep`   | `keyword_dialogue` | 关键词抓取当前对话原文         | `searchDialogueByKeywordForTool`（7915）                                     |
| `tool_web`    | `web_search`       | Tavily 联网搜索 + 网页正文提取 | `searchWebByTavilyForTool`（8079）/ `extractWebPagesByTavilyForTool`（8036） |

每个工具派生两个调用标签（`getActiveToolCallLabels`，5456）：

```
tool_memory_add    → 追加模式（保留旧结果）
tool_memory_cover  → 覆盖模式（替换旧结果）
```

结果数量：5-10，默认 5（`ACTIVE_TOOL_*_RESULT_COUNT`，1203-1205）。

### 2.2 归一化 — `normalizeActiveTools`（1430）

- 去重（按 id 或 callName），缺省工具自动补回（1446-1449）；
- 旧版 web 工具字段（`web_search`/`tavily` 等）映射到 `tool_web`（1384-1388）；
- `tool_web` 额外带 `tavilyApiKey` 字段（1424-1425）；
- 内置三工具之外的 `type` 兜底为 `vector_memory`（1395）。

### 2.3 攻击性分级（aggressiveness）

| 分级   | 值                 | 提醒（`ACTIVE_TOOL_REMINDERS`，1217-1221）        |
| ------ | ------------------ | ------------------------------------------------- |
| 强制   | `force`            | 正式回复前必须调用至少 1 个工具，无结果不输出正文 |
| 积极   | `active`           | 信息不明确时主动调用                              |
| 自适应 | `adaptive`（默认） | 上下文足够时直接回复，工具能提升准确性时才调用    |

`normalizeActiveToolAggressivenessSettings`（1238）做版本迁移：v2 起旧 `active` 自动降为 `adaptive`。

---

## 3. 注入：系统提示 + 用户消息双提醒

- **系统提示**：`buildActiveToolSystemPrompt`（5464）拼 `<active_tools>` 块 → system prompt（5788-5789）：
  - `当前策略：{分级}。{提醒}`；
  - `<rules>` 公共规则（5470-5474）：**两行式调用**（首行 `<reason:理由>`，次行工具标签）、每行一个标签单次最多 5 个、工具阶段禁正文/COT、`call_add` vs `call_cover` 选择、一标签一信息点、结果不足换词重查；
  - 每个工具 `<tool name= call_add= call_cover= returns=>` 定义 + 说明 + 专属规则（如 web 工具的"读网页"规则）。
- **用户消息提醒**：`appendActiveToolReminderToLatestUserMessage`（5435）把当前策略提醒追加到最后一条用户消息（6090）；已有 `<active_tool_results>` 的消息跳过，避免重复。

---

## 4. 检测与捕获（流式）

### 4.1 调用标签解析 — `findActiveToolCallsInText`（8362）

- 对每个启用工具、每个 add/cover 标签，正则 `<callName:查询>` 匹配，查询最长 **30000 字符**；
- 检测前先 `parseCot` + `stripCodeBlocksForToolDetection`（8325）跳过代码块，防止把代码示例里的标签当调用；
- 每个调用记录 `{tool, mode, callLabel, query, raw, reason, index}`，按位置排序；
- `<reason:理由>` 前缀解析：`getActiveToolCallReasonMeta`（8335）提取调用前的 `<reason:...>` 作为调用理由，一并从正文剥离。

### 4.2 两段式捕获 — `promoteActiveToolCallsFromAssistant`（8778）

流式接收时每段文本 append 后触发（6285-6310）：

| 场景                     | 处理                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检测到**完整**调用       | `message.content` 保留调用前正文；生成 `toolCalls` UI 记录（`createActiveToolUi`，8468），状态 `queued`                                                                                       |
| 检测到**未闭合**尾部标签 | `findPendingActiveToolCallInText`（8420）用 `<\s*label\s*:\s*([\s\S]*)$` 匹配 → 进入 `_activeToolCaptureActive`：正文停止追加，参数累积进 `_activeToolPendingText`，UI 显示"正在接收工具参数" |
| 完整调用 + 未闭合并存    | 完整调用先落地，未闭合部分继续接收                                                                                                                                                            |

`appendActiveToolCallsToAssistant`（8705）把 UI 记录挂到消息；`skipReveal = true` 让捕获阶段不闪正文。

---

## 5. 执行 — `handleActiveToolCallFromAssistant`（8865）

对话主流程在每轮生成完成后调用（6674-6676）；返回 `true` 表示触发自动续写。

### 5.1 执行前检查

1. 深度限制：`activeToolDepth >= ACTIVE_TOOL_MAX_AUTO_CONTINUE(4)`（1207，8892）→ 标记 error 停止，防止死循环；
2. 向量工具要求记忆系统开启（8938）。

### 5.2 执行与格式化

```
逐工具（web 工具先攒批）：
  isVectorActiveTool  → searchVectorMemoriesForTool(query, resultCount)
  isKeywordActiveTool → searchDialogueByKeywordForTool(query, resultCount)
  isWebActiveTool     → searchWebByTavilyForTool(query, tool)   // 含 URL 自动转网页提取
  → formatActiveToolResultContext() 生成 XML 块
  → updateActiveToolResultContext(ctx, mode)   // add 追加 / cover 替换
```

**网页工具批量并发**（`flushWebToolBatch`，8989）：连续多个 web 调用在 `Promise.all` 中并发执行（标 `running` 后一起跑），避免逐个等待拖慢对话。

**结果 XML 格式**（`formatActiveToolResultContext`，8211）：

| 工具      | 结果标签                                                 | 说明                                               |
| --------- | -------------------------------------------------------- | -------------------------------------------------- |
| 向量      | `<memory_fragment turn= similarity= story_time=>`        | 按时间排序（8303）                                 |
| 关键词    | `<dialogue_fragment turn= role= speaker= matched=>`      | 原文片段（8275-8286）                              |
| web 搜索  | `<web_source index= title= url= score= published_date=>` | 标题/链接/摘要，截断 1800 字（8254）               |
| web 提取  | `<web_page>` + `<failed_page>`                           | 网页正文（截断 6000），失败页单独列出（8237-8251） |
| 空 / 错误 | `<active_tool_result ... status="empty/error">`          | `formatActiveToolNoticeContext`（8152）            |

每个结果块都带 `mode="add|cover"` 说明与"不要复述标签、不要编造"的指引。

### 5.3 结果上下文 — `updateActiveToolResultContext`（8139）

- `add`：追加到 `activeToolResultContexts`；
- `cover`：**整体替换**结果列表（清理旧结果、聚焦新查询）；
- 生成 `<active_tool_results>...</active_tool_results>` 块存入 `pendingActiveToolContext`。

### 5.4 自动续写（回填）

```
generateResponse(activeToolDepth+1, continueAssistantMessageId: 原消息id)
  续写请求把 <active_tool_results> 注入最后一条用户消息结尾（6091-6097）
  模型基于结果继续输出 → 内容回填到原 assistant 气泡
  本轮再次输出工具标签 → 再执行再续写（循环，最多 4 层）
```

用户消息拼接时 `<active_tool_results>` 由 `buildActiveToolResultPayload`（8128）生成，`stripUiTemplateContextInjection`/`stripVectorMemoryCode` 等会剔除历史残留结果，避免污染（7933）。

---

## 6. Tavily 联网实现

| 端点       | 用途     | 常量（1253-1254）                     |
| ---------- | -------- | ------------------------------------- |
| `/search`  | 搜索     | `ACTIVE_TOOL_TAVILY_ENDPOINT`         |
| `/extract` | 网页提取 | `ACTIVE_TOOL_TAVILY_EXTRACT_ENDPOINT` |

- **搜索**（8079）：`{query, search_depth:'advanced', max_results:5-10, topic:'general', include_favicon}`；每条结果正文截断 1800 字；
- **网页提取**（8036）：`extractWebUrlsFromToolQuery`（8020）从查询里抽 URL（`http(s)://` 或 `www.`，最多 `resultCount` 个）→ `{urls, extract_depth, format:'markdown', include_favicon, timeout:30}`；正文截断 6000 字，失败页进 `failed_results`；
- **API Key**：存在工具配置 `tavilyApiKey`，未填时报错"请先在工具设置里填写"；
- **错误分类** `buildTavilyErrorMessage`（7984）：401 Key 无效 / 429 频率或额度 / 432-433 账户额度权限不足。

---

## 7. UI 呈现

- **Thinking 时间线整合**：工具调用作为时间线 step（`getTimelineSteps`，8628），显示 `getToolCallModeText`（8515：向量/关键词/联网/读取网页 × 追加/覆盖）+ 参数 query + 执行输出/错误，可展开详情（index.html 704-792）；
- **工具调用状态机**：`queued → running → done` / `error` / `continuing`（续写中）；
- **等待态**：续写中消息显示 `active-tool-waiting` 打字指示（index.html 794-803）；
- **全局设置面板**：攻击性三档切换（index.html 2686-2704）；工具列表含启用开关、编辑、Tavily Key 缺失提醒（2706-2740）。

---

## 8. 关键点总结

- **标签即协议**：模型用 `<tool_x_add/cover:内容>` 文本标签触发，非 function call；`<reason:理由>` 前缀剥离为调用原因。
- **双模式**：`add` 追加结果、`cover` 覆盖旧结果，模型按需清理上下文冗余。
- **自动续写闭环**：检测 → 执行 → `<active_tool_results>` 回填 → 模型续写，最多 4 层防死循环。
- **web 批量并发**：连续网页调用 Promise.all 并行，避免串行拖慢。
- **攻击性三档**：force/active/adaptive 决定"是否先查再答"，通过系统提示 + 用户消息双提醒约束模型。
- **安全边界**：检测跳过代码块、查询限长、结果数 5-10、正文截断、abort 信号支持用户取消。

**一句话**：主动工具让模型以文本标签主动触发检索（记忆/原文/联网），前端执行并把结构化结果回填后自动续写，按 attackiveness 决定调用积极性。
