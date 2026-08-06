# 剧情分支（Story Branch）实现文档

> 本文件说明 RP-Hub 剧情分支系统的实现：作用域隔离的数据模型、分支创建/切换/删除、SVG 路线图渲染与 NDJSON 导入导出。
> 源码位置：`assets/js/app.js` 与 `index.html`。行号基于当前 main 分支版本 1.7.9。

---

## 1. 整体流程

```
[建模]   main(主线) 是固定根节点，任意分支 parentId 指向父分支，形成树
         scopeId = 角色uuid（主线） | 角色uuid__branch__分支uuid（子分支）

[创建]   createStoryBranch(forkMessageIndex?)
         ├─ 从选中分支整体分叉 → 克隆父分支全部数据
         └─ 从某条 AI 消息分叉 → 截断到该消息，记忆/UI状态重建到分叉轮次
         → 保存当前分支 → 把数据写入新分支 scopeId 存储
         → 切换 activeStoryBranchId → 渲染新分支聊天

[切换]   switchStoryBranch(id)
         保存当前分支 → 读取目标分支 scopeId 数据 → 替换聊天/记忆/UI 运行时状态

[删除]   deleteSelectedStoryBranch()
         主线/当前路径禁删 → BFS 收集子树分支 → 级联删除各 scopeId 的聊天/记忆/UI 状态

[展示]   storyRouteMap computed：树形自动布局 + 贝塞尔连线 + 当前/选中/路径高亮
         模态框 SVG 渲染 + 拖拽平移 + 进入/新建/删除操作

[迁移]   导出全部分支 → NDJSON(manifest + 每分支一行)；导入按分支写入 scopeId
```

---

## 2. 数据模型与作用域隔离

### 2.1 常量（1816-1819）

| 常量                               | 值                     | 说明                             |
| ---------------------------------- | ---------------------- | -------------------------------- |
| `STORY_BRANCH_MAIN_ID`             | `'main'`               | 主线固定 id，无 parentId         |
| `STORY_BRANCH_SCOPE_SEPARATOR`     | `'__branch__'`         | scopeId 中角色与分支的分隔符     |
| `STORY_BRANCH_CHAT_EXPORT_TYPE`    | `'rp-hub-branch-chat'` | 分支聊天 NDJSON 的 manifest 类型 |
| `STORY_BRANCH_CHAT_EXPORT_VERSION` | `1`                    | 导出格式版本，导入时校验         |

### 2.2 作用域机制（核心设计，1910-1915）

```js
getStoryBranchScopeId(charId, branchId) =
    branchId === 'main' ? charId
                        : `${charId}__branch__${branchId}`   // 分支专属存储键
getStoryBranchOwnerId(scopeId) = scopeId 按 '__branch__' 拆分的 [0]  // 反查角色
```

**每个分支拥有独立的存储作用域**，按角色 uuid 前缀 + 分支隔离。作用域存储键由 `scopedStorageKey`（1908）构造：

| 存储键                              | 内容                           |
| ----------------------------------- | ------------------------------ |
| `rp_hub_chat_<scopeId>`             | 该分支的聊天历史               |
| `rp_hub_memories_<scopeId>`         | 该分支的向量记忆               |
| `rp_hub_classic_memories_<scopeId>` | 该分支的经典摘要记忆           |
| `rp_hub_branches_<charUuid>`        | 分支元数据（按角色，不按分支） |

- `CHARACTER_SCOPED_STORAGE_NAMES`（1815）= `['chat','memories','classic_memories','branches']`，删除角色时全量清理。
- `getScopedStorageInfo`（2308）/ `getStorageLogicalKey`（2301）反向识别某存储键属于哪个角色、哪个分支，供全库清理扫描（9494-9511）。

### 2.3 分支元数据 — `normalizeStoryBranches`（9869）

每条分支字段：`id / name / parentId / createdAt / updatedAt / forkFloor / floorCount / messageCount / wordCount`。

- 去重（重复 id 丢弃）；缺主线自动补 `createMainStoryBranch`（9857）；
- 孤儿分支（parentId 不存在）→ 重挂到主线（9893-9895）；
- 名称清洗：旧 `路线N` → `分支N`，超 30 字截断（9877-9880）；
- 元数据存 `rp_hub_branches_<charUuid>`，含 `{version, activeBranchId, branches}`（`saveStoryBranchesForCharacter`，9900）；加载时校验 `activeBranchId` 有效性（`loadStoryBranchesForCharacter`，9910）。

---

## 3. 创建 — `createStoryBranch`（10035）

### 3.1 两种入口

| 入口         | `forkMessageIndex` | 行为                                                             |
| ------------ | ------------------ | ---------------------------------------------------------------- |
| 模态框"新建" | `null`             | 从**选中分支**（无则当前分支）整体分叉，克隆父分支全部数据       |
| 消息气泡按钮 | 消息 index         | 仅 assistant 消息可分支（10040）；从该消息处截断，重建到分叉轮次 |

### 3.2 分叉流程

1. **前置保全**：`saveCurrentStoryBranchState`（9937）保存当前分支——停生成、abort 各提取任务、flush 聊天/记忆/UI 模板运行时（9939-9966），失败即中止；
2. **读取父分支数据**：`Promise.all` 并行读 `chat`（`loadStoredChatHistory`，9840）/ `memories` / `classic_memories`（10065-10069）；
3. **从消息分叉**（10076-10087）：按消息 id 定位源索引（兜底 index），校验仍是 assistant；`sourceChatHistory = 截断到该消息`；`forkTurn = 该轮回合数`；记忆过滤 `turn <= forkTurn`；
4. **写入新分支**：三条 `setScopedStoredValue(..., branchScopeId, ...)`（10091-10093）；
5. **衍生数据复制**：
   - `emptyTurns`（向量记忆空轮记录）克隆，从消息分叉时只留 `<= forkTurn`（10095-10099）；
   - UI 模板运行时（10101-10118）：整体分叉 → 克隆父分支 `runtimeByCharacter[parentScopeId]`；从消息分叉 → `buildUiTemplateStateAtTurn` 重放到分叉轮次 + changeLog 只留 `<= forkTurn`；
6. **切分支**：推入 `storyBranches`，`activeStoryBranchId = branchId`，替换聊天/记忆渲染（10120-10148），`_isApplyingCharacterScopedData` 标志抑制保存回写（10139-10147）。

### 3.3 失败回滚（10150-10172）

catch 中删除已建分支的存储与衍生状态、恢复 `previousState`（activeId/chat/memories/classicMemories），`Promise.allSettled` 兜底清理，保证半途失败不留脏数据。

---

## 4. 切换 — `switchStoryBranch`（10180）

1. 校验：目标存在、非当前分支、非切换中；
2. `saveCurrentStoryBranchState` 保存当前分支；
3. `Promise.all` 读目标 scopeId 的 chat / memories / classic_memories（10188-10192）；
4. 替换运行时状态，`loadGlobalUiTemplateRuntimeForCharacter` 还原该分支的 UI 模板变量（10202）；
5. 刷新渲染窗口、滚到底部、回到聊天视图（10196-10208）。

---

## 5. 删除 — `deleteSelectedStoryBranch`（9974）

**可删性校验** `selectedStoryRouteCanDelete`（3997）：主线不可删；当前分支所在路径（沿 parentId 回溯）上的节点不可删——保证当前分支始终可达。

删除流程：

1. `confirmAction` 二次确认（9997）；
2. **BFS 收集子树**：以选中分支为根，沿 childrenByParent 栈式遍历收集全部后代（9987-9994）；
3. **级联清除**：对每个分支 scopeId 删除 `chat / memories / classic_memories`（10003-10008）+ `emptyTurns` + 所有 UI 模板的 `runtimeByCharacter[scopeId]`（10009-10015）；
4. 移除分支记录、重置选中态、保存（10016-10023）。

---

## 6. 路线图（SVG）— `storyRouteMap`（3883）

### 6.1 树形自动布局

- 由 `parentId` 建 children 表（children 按 createdAt 排序，3890-3897）；
- 递归 `placeBranch`（3903-3924）：**叶子节点从左到右排成一行，父节点 X = 子节点中心均值，Y = 深度 × 层高**；访问检测防环；
- 孤立/悬空分支兜底从根部摆放（3929-3931）；
- 画布宽高按叶子列数与最大深度计算，居中偏移（3944-3950）。

### 6.2 节点与连线

| 维度     | 逻辑                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 高亮     | `collectRouteIds`（3933）沿 parentId 回溯当前/选中分支整条路径；`isActive / isSelected / isOnActiveRoute / isOnSelectedRoute` 分别高亮（3951-3970） |
| 节点信息 | 名称、`floorCount` 楼数、`wordCountText`（`formatStoryBranchWordCount` 3870 转 `N.NW`）；当前分支实时统计，其余用存档值（3953-3954）                |
| 连线     | 父节点底部到子节点顶部的三次贝塞尔曲线 path（`M..C..`，3971-3984）                                                                                  |

### 6.3 交互

- **拖拽平移**：`start/move/endStoryRouteDrag`（4009-4048）pointer capture + scrollLeft/Top 差值平移；拖动后 1 tick 抑制节点点击（`suppressStoryRouteNodeClick`）；
- **节点选择**：`handleStoryRouteNodeClick`（4049）→ `selectStoryBranchNode`（9969）；
- **按钮**：进入（`switchStoryBranch`）/ 新建（`createStoryBranch`）/ 删除（`deleteSelectedStoryBranch`，禁用于不可删节点，3997）。

---

## 7. UI 呈现（index.html）

| 位置                 | 行号      | 说明                                                                           |
| -------------------- | --------- | ------------------------------------------------------------------------------ |
| 消息气泡"从这里分支" | 909       | assistant 消息悬浮操作按钮 → `createStoryBranch(index)`                        |
| 顶栏入口             | 1048      | 显示当前分支名，点击开模态框                                                   |
| 分支模态框           | 5090-5175 | 头部"当前分支" + SVG 路线图画布（`.story-route-canvas`）+ 进入/新建/删除操作条 |

路线图 CSS（`.story-route-*`：节点卡、贝塞尔连线、当前/选中/路径态配色）位于 `styles.css`。

---

## 8. 导入导出（NDJSON）

### 8.1 导出全部分支（10980-11031）

```
第 1 行：manifest
  { type:'rp-hub-branch-chat', version:1, characterName, exportedAt,
    activeBranchId, branches:[{...branch 元数据, floorCount, messageCount, wordCount}] }
第 N 行：{ branchId, messages:[...] }   // 每分支一行
```

- 当前分支用内存中的 `chatHistory`，其余从 scopeId 存储读取（10982-10996）；
- 文件 `{角色名}_全部分支_chat.jsonl`。

### 8.2 导入分支聊天（10802-10870）

1. 校验 manifest 类型/版本、分支完整性、无重复、消息结构合法（10819-10839）；
2. `normalizeStoryBranches` 归一化 + 校验每个分支都有对应聊天记录（10841-10848）；
3. 校验无未知分支、`activeBranchId` 有效（10849-10855）；
4. 停当前生成后，逐分支 `setScopedStoredValue('chat', scopeId, ...)` 写入 + 写回 branches 元数据（10857-10870）。

---

## 9. 分支状态保全与清理

| 场景               | 逻辑                                                                                                        | 行号      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------- |
| 每次切/建分支前    | `saveCurrentStoryBranchState`：停生成 → abort 记忆/UI 提取 → flush 聊天/记忆/UI 运行时 → 更新分支统计并保存 | 9937-9967 |
| 当前分支统计       | `updateCurrentStoryBranchSummary`：floorCount / messageCount / wordCount（`getConversationBodyLength`）     | 9922-9929 |
| 切换角色           | 清空 `storyBranches`、重置 active/selected 为 `'main'`                                                      | 9559-9565 |
| 删除角色卡         | 遍历 `branches` 全部分支 + 全库扫描 scopeId，级联删聊天/记忆/emptyTurns/UI 模板运行时                       | 9489-9524 |
| 切换后清瞬态上下文 | `clearStoryBranchTransientContext`：清 lastContextMessages / lastTriggeredWorldInfos / active 工具结果      | 9931-9935 |

---

## 10. 关键点总结

- **作用域即分支**：每个分支一个独立存储 scope（`角色__branch__分支`），聊天/向量记忆/经典记忆/UI 模板运行时全部隔离，主线就是角色本身。
- **树形血缘**：`parentId` 建树；删除走子树 BFS 级联；当前分支所在路径（回溯到主线）不可删。
- **从消息分叉**：截断到目标 AI 消息，记忆按 turn 过滤、UI 模板 changeLog 重放到分叉轮次，分叉点严格一致。
- **失败回滚**：创建半途失败自动清理新分支数据并恢复原状态。
- **自动布局路线图**：叶子横排 + 父居中的树形 SVG，当前/选中/路径三级高亮，可拖拽平移。
- **全量导出**：NDJSON 一文件带全部血缘分支与激活分支，导入逐分支写回。

**一句话**：剧情分支 = 以"主线"为根、`parentId` 为血缘的**树状分支集合**，每个分支靠独立存储作用域隔离聊天/记忆/UI 状态，通过树形 SVG 路线图可视化并支持创建、切换、级联删除与 NDJSON 整体迁移。
