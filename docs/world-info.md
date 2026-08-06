# 世界书（World Info）实现文档

> 本文件说明 RP-Hub 世界书的检索与注入机制。世界书是纯**规则检索**（触发词/正则子串匹配），无向量参与。
> 源码位置：`assets/js/app.js`（以下行号基于当前 main 分支版本 1.7.9）。

---

## 1. 整体流程

```
每次生成请求构造上下文时：

[触发收集]
  activeWorldInfo.forEach(条目)
    ├─ 常驻条目 → 无条件触发（score = ∞）
    └─ 非常驻条目
        ├─ passesWorldInfoProbability()   概率判定（每轮只掷一次）
        ├─ 计算扫描深度 scanDepth（受全局 maxDepth 上限约束）
        ├─ 最近 N 条消息拼成 scanText
        └─ checkEntryTrigger()
             └─ worldInfoKeyMatchesText()
                  ├─ useRegex → 正则 .test()
                  └─ 普通触发词 → 子串 includes()
    → 至少一个 key 命中即触发，score = 命中 key 数

[排序]   常驻优先 → 按 order 降序（预算紧张时保高优先级）

[分组]   按 position 分 7 桶 → 组内按 order 升序

[注入]   各 position 插入到 prompt 不同位置（见 3.3）
```

---

## 2. 触发阶段（检索）

### 2.1 入口

每次生成请求时，对启用条目逐个扫描（5657-5680）：

```js
const activeWorldInfo = worldInfo.value.filter(e => e.enabled !== false);
const postprocessedChatHistory = getPostprocessedChatMessages(chatHistory.value, { includeSystem: false });

activeWorldInfo.forEach(entry => {
    if (entry.constant) {                       // 常驻：无条件触发
        triggeredEntries.set(entry, { score: Infinity, matchedKeys: ['常驻 (Constant)'] });
        return;
    }
    const entryScanDepth = min(entry.scanDepth ?? 全局scanDepth, 全局maxDepth);
    if (entryScanDepth === 0 || 无 keys) return;
    const scanText = postprocessedChatHistory.slice(-entryScanDepth).map(m => m.content).join('\n');
    const result = checkEntryTrigger(entry, scanText);
    if (result.triggered) triggeredEntries.set(entry, { score: result.score, matchedKeys: result.matchedKeys });
});
```

### 2.2 概率判定 — `passesWorldInfoProbability`（5616）

- 仅当 `useProbability !== false` 且 `probability < 100` 时才掷。
- `Math.random() * 100 < probability`；判定结果缓存进 `evaluatedProbability` Map，**每轮生成只掷一次**（5755），同轮不重复随机。

### 2.3 扫描深度

```
entryScanDepth = min(entry.scanDepth ?? worldInfoSettings.scanDepth, 全局 maxDepth)
```

- 全局 `scanDepth` 默认 2，条目可单独覆盖；`maxDepth` 为全局上限。
- `scanText` = 最近 `entryScanDepth` 条后处理消息的内容拼接。

### 2.4 触发词匹配 — `worldInfoKeyMatchesText`（5599）

| 模式              | 逻辑                                                                                                   | 行号 |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| `useRegex = true` | `createWorldInfoRegex` 解析 `/pattern/flags` → 默认强制 `i`，检测到 `\p{P}` 自动补 `u` → `.test(text)` | 5582 |
| 普通触发词        | `rawText.toLowerCase().includes(rawKey.toLowerCase())` — 大小写不敏感子串匹配                          | 5613 |

`checkEntryTrigger`（5628）对 `entry.keys` 全部扫描，**至少一个 key 命中即触发**；`score = 命中 key 数`，`matchedKeys` 记录命中词供前端高亮。

---

## 3. 排序与注入

### 3.1 排序（5684）

1. **常驻优先**（`a.constant && !b.constant → -1`）
2. 其余按 `order` **降序**（order 越大越重要，预算紧张时先保留）

随后 `console.groupCollapsed('📚 World Info Trigger Log')` 输出触发日志（5695）。

### 3.2 分组（5709-5727）

按 `position` 分进 7 个桶；未知/缺省 position 兜底到 `at_depth`。**组内按 `order` 升序**排列。

```js
const wiGroups = {
  system_top: [],
  global_note: [],
  before_char: [],
  after_char: [],
  user_top: [],
  assistant_top: [],
  at_depth: [],
};
```

### 3.3 注入（每条格式 `[comment]\n{content}`，`joinContent` 5748）

| 位置            | 注入方式                                                   | 行号 |
| --------------- | ---------------------------------------------------------- | ---- |
| `system_top`    | 拼进 system prompt（预设之后）                             | 5758 |
| `global_note`   | 拼进 system prompt（system_top 之后）                      | 5761 |
| `before_char`   | 角色卡设定之前                                             | 5772 |
| `after_char`    | 角色卡设定之后                                             | 5780 |
| `user_top`      | 拼接到最后一条用户消息开头                                 | 6062 |
| `assistant_top` | 消息末尾追加 `[Instructions for next message]` system 消息 | 6075 |
| `at_depth`      | 深度插入（见下）                                           | 5976 |

**at_depth 深度插入**（5976-6001）：

- 倒序从消息末尾数 `depth` 个 user/assistant 消息（默认 depth=4），插在倒数第 depth 轮之后，作为一条 user 消息插入。
- 位置越靠前离当前对话越近，越易被模型注意。
- 若计算位置破坏安全区（`safeTargetLimit`）则向上修正保护顺序。

---

## 4. 后续处理

- 注入完成的每条消息统一再过 `processRegex`（6099-6106），世界书内容同样会被正则脚本美化/替换。
- `floorInfo` Map（6119-6131）预计算每个命中触发词所在的对话楼层（`entryStart` = 最近 `entryScanDepth` 条的起点），供 UI 把命中词在历史消息里高亮标注。
- 匹配只在**后处理后的聊天历史**上扫描（排除 system、已剥离 CoT 等）。

---

## 5. 关键点总结

- **纯规则检索**：子串/正则匹配，无向量参与。
- **检索质量由三要素决定**：触发词写得准不准 + 扫描深度（scanDepth）+ 注入位置（position 体感强度）。
- **常驻条目**（constant=true）不受扫描深度限制，恒定注入。
- **概率**（probability）只在非常驻条目上生效，且每轮掷一次。
- 数据模型由 `normalizeWorldInfoEntry` 归一化，兼容 SillyTavern 位置映射（`posNameMap`、数字位置 0-4）。
