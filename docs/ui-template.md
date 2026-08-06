# UI 模板实现文档

> 本文件说明 RP-Hub UI 模板的实现：模板渲染引擎、AI 变量更新、运行时状态与沙箱 iframe 安全机制。
> 源码位置：`assets/js/app.js` 与 `index.html`。行号基于当前 main 分支版本 1.8.0。

---

## 1. 整体流程

```
[定义]   编辑器创建模板
         → HTML 模板（{{变量}} / {{#each}} 插值）
         → 变量 JSON（初始状态）+ 变量说明 schema（给 AI 参考）
         → placement: top / bottom、scope: global / character、order

[渲染]   renderUiTemplateString()    模板插值（{{表达式}} + #each 循环）
         → buildExecutableHtmlDocument()  组装完整 HTML 文档（注入 jQuery + 高度自适应脚本）
         → createExecutableHtmlIframe()   sandboxed iframe 渲染（srcdoc）
         → 挂到 AI 消息 uiTemplateBlocks.top / .bottom

[更新]   主模型模式：正文末尾 <ui_template_updates>{JSON}</ui_template_updates>
              → applyMainModelUiTemplateUpdates() 解析并应用
         副模型模式：updateUiTemplatesFromChat() 逐模板分析最近 N 层对话 → 返回 JSON 更新

[持久化] applyUiTemplateUpdateListToTemplate() 写 changeLog（最多 50 条）
         saveGlobalUiTemplateRuntimeForCharacter() 存 runtimeByCharacter[角色+分支]
```

---

## 2. 数据模型 — `normalizeUiTemplate`（2964）

每次从存储/角色卡加载时统一字段：

| 字段                   | 说明                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `id` / `name`          | 模板唯一标识 / 显示名（默认"UI模板"）                                            |
| `enabled`              | 默认 `true`                                                                      |
| `scope`                | `global`（全局，存 `globalUiTemplates`）或 `character`（存 `char.uiTemplates`）  |
| `order`                | 排序权重，默认 100；合并列表按 **order 降序** 排（3020-3025）                    |
| `placement`            | `'top'` / `'bottom'`：插入 AI 消息正文**上方**还是**下方**                       |
| `htmlTemplate`         | HTML 模板文本，自动剥 ` ```html ` 围栏（`stripUiTemplateCodeFence`，2936）       |
| `initialVariableState` | 初始变量（`inferInitialUiTemplateState`，2942，可从 changeLog 首条 `from` 推断） |
| `variableState`        | **运行时当前变量**，渲染与 AI 更新都写它                                         |
| `variableSchema`       | 变量说明（JSON 或纯文本），注入给 AI 参考字段含义                                |
| `changeLog`            | 变更记录，unshift 头部、**最多 50 条**                                           |
| `runtimeByCharacter`   | 按 `角色uuid+分支scope` 存运行时快照，实现角色/分支隔离                          |
| `updateMode`           | 预留字段，默认 `'merge'`                                                         |

生效集合：`currentUiTemplates` = 全局模板 + 当前角色模板合并、按 order 降序（3020-3025）；`activeUiTemplates` = 其中 `enabled !== false` 的（3026）。

---

## 3. 渲染引擎

### 3.1 模板插值 — `renderUiTemplateString`（3145）

`{{表达式}}` → `escapeUiValue(getUiTemplateValue(variables, 表达式))`，值做 **HTML 转义**（`escapeUiValue`，3127：`& < > " '`）。

**路径解析**（`splitUiTemplatePath` 3030 / `readUiTemplatePath` 3037 / `getUiTemplateValue` 3048）：

| 表达式                               | 含义                            |
| ------------------------------------ | ------------------------------- |
| `{{status}}`                         | 顶层变量                        |
| `{{equipment.0.name}}`               | 点路径（支持数组索引）          |
| `{{equipment[0].name}}`              | 方括号路径                      |
| `{{this}}` / `{{.}}`                 | 当前项（#each 内）              |
| `{{root.xxx}}`                       | 从根对象取值                    |
| `{{../parent}}`                      | 上一层循环的项                  |
| `{{@index}}` `{{@number}}`           | 循环索引（0 起 / 1 起）         |
| `{{@first}}` `{{@last}}`             | 首/尾项判断                     |
| `{{@key}}`                           | 对象循环时的 key                |
| `{{#each list as item}}...{{/each}}` | 循环，`item.xxx` 取子项（别名） |

**#each 循环**（`renderUiTemplateEachBlocks`，3155）：支持数组与对象；支持 `{{else}}` 空态；嵌套循环最多 **50 层**防死循环。

### 3.2 值写入 — `setUiTemplateValue`（3083）

`$root` → 整体替换；`a.b.c` / `a[0].b` 按路径写入，自动建中间对象/数组。

### 3.3 沙箱 iframe 渲染（关键设计）

| 函数                          | 行号 | 作用                                                                                                                                                                                       |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `htmlIframeSandbox`           | 3186 | sandbox 许可：`allow-scripts allow-forms allow-popups allow-same-origin allow-modals allow-downloads allow-pointer-lock allow-presentation allow-top-navigation-by-user-activation`        |
| `buildExecutableHtmlDocument` | 3188 | 组装完整 HTML 文档：viewport meta + 重置样式（含内置 `.sinan-hud` HUD CSS）+ jQuery CDN + `scriptShim`                                                                                     |
| `scriptShim`                  | 3193 | **`window.triggerSlash` 桥接**（iframe 内 `[data-slash]` 点击 → 父页面斜杠命令）+ **高度自适应**（计算 body 子元素 maxBottom → 设置 iframe 高度，load/resize/click + ResizeObserver 触发） |
| `createExecutableHtmlIframe`  | 3299 | 创建 iframe，`srcdoc` 渲染，`onload` 后按 `scrollHeight` 调整高度                                                                                                                          |
| `renderExecutableHtmlFrame`   | 3326 | 包裹 `.html-card-container`，返回 HTML 字符串                                                                                                                                              |
| `renderUiTemplateHtml`        | 3336 | 模板插值 → 沙箱 iframe HTML（主入口）                                                                                                                                                      |
| `handleUiTemplateClick`       | 3343 | 点击 `[data-slash]` 元素 → `window.triggerSlash(command)`                                                                                                                                  |

> 模板里放 `<button data-slash="/命令">` 即可在沙箱内触发父页面的斜杠命令，这是模板与角色互动的入口。

---

## 4. AI 变量更新（双模式）

### 4.1 主模型模式（`uiTemplateMainModelAnalysis: true`，默认）

- **系统提示注入** `buildMainModelUiTemplateUpdatePrompt`（3384）：要求主模型在正文结束后追加隐藏块：

  ```
  <ui_template_updates>{"updates":[{"id":"模板id","variables":{"路径":"新值"},"reason":"原因"}]}</ui_template_updates>
  ```

  无变化也必须输出 `<ui_template_updates>{"updates":[]}</ui_template_updates>`；只更新模板已定义的变量，不修改 HTML。

- **生成后应用** `applyMainModelUiTemplateUpdates`（3483，对话主流程 6598 调用）：
  1. 从 assistant 消息 content 提取 `<ui_template_updates>` 块（正则 3375）；
  2. `parseUiTemplateUpdateJson`（3412）解析（兼容 ` ```json ` 围栏 + 自动提取首尾 `{}`/`[]` 区间）；
  3. `normalizeUiTemplateUpdateList`（3435）归一化数组/legacy 格式；
  4. 逐 update 匹配模板（按 `id` → `name` → 唯一模板，3512-3517）；
  5. 应用后 `attachUiTemplateBlocksToLastAssistant` 重渲染模板块并保存。
- 零额外请求，但依赖主模型的指令遵循能力。

### 4.2 副模型模式（`uiTemplateMainModelAnalysis: false`）

- **生成后异步分析** `updateUiTemplatesFromChat`（5028，对话主流程 6682-6686 调用）：
  1. 取最近 `uiTemplateAnalysisDepth`（**4-10 层**，默认 4，5060-5069）的对话消息；
  2. **每个启用模板独立请求一次**副模型（`uiTemplateModel`）：
     - system prompt：UI 变量更新器，严格返回 `{"variables":{"路径":"新值"},"reason":"..."}`，附当前变量 JSON + `variableSchema` 说明 + 用户信息；
     - user 消息：最近对话 JSON；
  3. `Promise.all` 并发（5129），**单模板失败不影响其他**（`failedTemplateIds` 收集，5215 排除）；
  4. 统一应用更新 → `attachUiTemplateBlocksToLastAssistant`（排除失败模板）→ 有变化则保存；
  5. 失败计数通过 `uiTemplateUpdateStatus` 在 UI 展示。
- 可配 `uiTemplateInjectContext`：`buildUiTemplateContextSystemPrompt`（3590）把每个模板的**当前变量状态**包进 `<ui_template_state_context>` 快照注入 system prompt，让模型理解角色状态（只在该模式下生效，5791-5792 组装）。

### 4.3 变量应用 — `applyUiTemplateUpdateListToTemplate`（3443）

- 按 `id`（必要时 `name`）匹配模板；
- 逐变量 `JSON.stringify` 比较新旧值，**无变化不写日志**；
- 有变化的写入 `template.variableState` 并 unshift 一条 changeLog：`{id, time, source, model, turn, changes:{key:{from,to}}, reason}`；
- changeLog 截断到 **50 条**。

### 4.4 待渲染占位

分析进行中，目标消息显示 `<ui-template-pending>` 占位卡片（`UiTemplatePending` 组件，app.js:15；index.html 811-814/868-871），根据 `uiTemplateUpdateStatus.state === 'running'` 判断。

---

## 5. 变更记录与状态重建

| 函数                             | 行号 | 作用                                                                                  |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `buildUiTemplateStateAtTurn`     | 3566 | 从 initialVariableState 重放 `turn <= N` 的 changeLog，重建**任意轮次**的变量状态     |
| `rebuildUiTemplateStateFromLogs` | 3618 | 从剩余 changeLog 重建（删分支/回滚后状态还原）                                        |
| `pruneUiTemplateChangesFromTurn` | 3632 | 删除某轮**之后**的 changeLog 与消息上的 `uiTemplateBlocks`（编辑历史/切换分支时回滚） |
| `inferInitialUiTemplateState`    | 2942 | 从 changeLog 首条 `from` 值推断初始状态                                               |
| `resetUiTemplateRuntimeState`    | 3670 | 重置所有模板为 initialVariableState，清空 changeLog 与已挂模板块                      |

---

## 6. 运行时状态存储（角色/分支隔离）

- key = `getStoryBranchScopeId(charUuid, branchId)`（`getUiTemplateRuntimeKey`，3683）；
- `saveGlobalUiTemplateRuntimeForCharacter`（3692）：把当前 `variableState + changeLog` 快照写入 `runtimeByCharacter[key]`；
- `loadGlobalUiTemplateRuntimeForCharacter`（3706）：切换角色/分支时还原；
- **故事分支分叉**（10101-10118）：每个模板从父分支复制运行时状态；`forkFromMessage` 分叉时用 `buildUiTemplateStateAtTurn(template, forkTurn)` 重建到分叉点，只保留 `turn <= forkTurn` 的 changeLog；
- 全局模板的 `runtimeByCharacter` 存 `global_ui_templates`，角色模板的随 `characters` 一起 `saveData()` 持久化。

---

## 7. 消息渲染（index.html）

- AI 消息 `uiTemplateBlocks.top` / `.bottom`（804-872）：`placement='top'` 渲染在正文**前**，`'bottom'` 在正文**后**；每个块用 `v-html` 注入 iframe 字符串，点击绑定 `handleUiTemplateClick`；
- `messageHasUiTemplateBlocks`（4356）/ `messageHasPendingUiTemplate`（4363）参与消息**宽布局**判定（`messageUsesWideLayout`，4370）。

---

## 8. 编辑器（index.html 4101-4271）

- 双 Tab：**变更记录**（逐条显示轮次、reason、`前/后` diff）/ **编辑内容**；
- 编辑字段：名称、作用范围、插入位置、排序、HTML 模板、变量 JSON、变量说明（schema）；
- **实时预览** `renderEditingUiTemplatePreview`（3353）：解析变量 JSON → `renderUiTemplateHtml` 沙箱渲染；
- 保存 `saveUiTemplate`（9384）：解析变量 JSON 作 initialVariableState；schema 优先 JSON 解析失败留文本；**保留现有运行时变量**（编辑不重置对话中已演变的状态）；
- 导入 `importUiTemplates`（9470）：`sanitizeUiTemplateImportEntry` 剥离 changeLog/runtimeByCharacter/variableState，重新生成 id，按 scope 分流到全局/角色。

---

## 9. 关键点总结

- **双模型分析**：主模型模式正文夹带 `<ui_template_updates>` 块（零额外请求）；副模型模式逐模板独立分析最近 4-10 层对话（更准但额外消耗）。
- **沙箱安全**：模板在 sandboxed iframe 内执行（含 `allow-same-origin` 的受控许可），变量插值全部 HTML 转义，`<ui_template_updates>` / `<ui_template_state_context>` 块在复制、编辑、发往记忆检索前一律剥离（3379/3586/4926/4945/5934/6731/7898）。
- **模板即状态机**：变量由 AI 逐轮维护，changeLog 记录全部 `from → to` 与轮次，可精确重建任意轮次状态、支持故事分支回滚。
- **与角色绑定**：`runtimeByCharacter[角色+分支]` 让同一个模板在多个角色/分支间互不干扰。
- **交互入口**：`data-slash` + `triggerSlash` 桥接让模板按钮直接触发父页面斜杠命令。

**一句话**：UI 模板 = 沙箱 iframe 里的动态 HTML 状态栏，用 AI（主模型或副模型）维护一组可追踪历史的 JSON 变量，按角色与故事分支隔离运行时状态。
