# 记忆系统实现文档

> 本文件说明 RP-Hub 的记忆系统实现：RAG 向量记忆与关键词检索的完整数据流。
> 源码位置：`assets/js/app.js`（以下行号基于当前 main 分支版本 1.7.9）。

---

## 1. RAG 向量记忆

### 1.1 整体流程

```
[对话写入]
  每轮对话
    → buildVectorMemoryFragments()    切碎片（段落级）
    → requestMemoryEmbeddings()       批量调 embedding API（批次 16）
    → quantizeEmbeddingForStorage()   Int8 量化压缩
    → prepareMemoryForRuntime()       运行时反量化
    → IndexedDB (rp_hub_memories_<uuid>)

[对话读取 / 主动工具检索]
  用户输入
    → buildVectorMemoryQueryText()    组装多轮查询文本
    → extractVectorQueryTerms()       抽取查询词（供词法 boost）
    → requestMemoryEmbeddings()       查询向量化
    → cosineSimilarity()              逐条余弦相似度
    → passesMemorySimilarityThreshold()  阈值过滤（默认 50%）
    → getVectorLexicalMatch()         词法命中 boost（封顶 +0.08）
    → 排序 → 指纹去重 → top-K（默认 10）
    → 排除近期轮次 → 注入 <memory_fragment>
```

### 1.2 写入链路（索引构建）

| 步骤          | 函数                                   | 行号        | 说明                                                                                                                                                                                                    |
| ------------- | -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 切碎片        | `buildVectorMemoryFragments`           | 7141        | 只取 user/assistant 消息；按自然段拆分，超长段按 400 字截断（`splitLongMemoryParagraph`），过短段再合并（`mergeSmallMemoryParagraphs`）；角色块加 `角色卡：` 前缀，用户消息汇总成 `用户：{全部}` 一整行 |
| 生成 fragment | 同上                                   | 7188        | 每个 fragment = `用户行 + 剧情时间 + 角色段落`；`sourceText` = `"第 N 轮\n" + paragraph`；`vectorChunkId` = `轮次 + messageIndex + role + 段落范围` 作为 chunk 唯一标识                                 |
| 批量嵌入      | `requestMemoryEmbeddings`              | 7241        | POST `/v1/embeddings`，`Authorization: Bearer {apiKey}`，body `{model, input}`；返回向量经 `normalizeEmbedding` 清洗；`MEMORY_VECTOR_BATCH_SIZE = 16`（1138 行）                                        |
| 量化压缩      | `quantizeEmbeddingForStorage`          | 1533        | 取向量绝对值最大 `maxAbs`，每元素 `/maxAbs*127` 取整为 Int8，存 `embeddingQ`(base64) + `embeddingScale`(=maxAbs/127) + `embeddingDims` + 编码 `int8:maxabs:v1`，减小存储体积                            |
| 运行时反量化  | `prepareMemoryForRuntime`              | 1556        | 从 `embeddingQ` 反量化回 Int8Array 参与计算，省约 4 倍内存                                                                                                                                              |
| 去重          | `contentFingerprint` / `vectorChunkId` | 7297 / 7302 | 去空白标点后取前 1000 字的文本指纹 + chunk id 双重判重，避免重复嵌入                                                                                                                                    |
| 持久化        | `saveMemoriesNow`                      | —           | 写入 IndexedDB `rp_hub_memories_<uuid>`                                                                                                                                                                 |

### 1.3 检索链路（RAG 查询）

**入口：`selectVectorMemoriesForContext`（7734）**，在每次生成请求上下文时调用。

1. **构造查询文本** — `buildVectorMemoryQueryText`（7484）
   把最近几条用户输入组装成带层级标签的查询：

   ```
   当前问题：用户：{最新用户输入}

   上一轮用户输入：用户：{前一轮}
   前2轮用户输入：用户：{再前}
   ```

2. **抽取查询词** — `extractVectorQueryTerms`（7501）
   英文/数字词（≥2 字符）、中文按 **2~4 字 n-gram** 扫描，去停用词（"是不是/为什么/我/你"等），最多 20 个按长度降序。**仅用于词法 boost，不参与召回。**

3. **查询向量化** — `requestMemoryEmbeddings`（7241）
   把组装文本送入同一个 embedding API，得到 `queryVector`。

4. **全量扫描 + 余弦相似度** — `scoreVectorMemories`（7701）
   `cosineSimilarity(queryVector, memory.embedding)`（7224）= 点积 / (|a||b|)，维度取 `min` 容忍差异。每 512 条 `yieldToBrowser()` 让出主线程。

5. **阈值过滤** — `passesMemorySimilarityThreshold`（7466）
   `score >= similarityThreshold / 100`，默认 **50%**，配置区间 40–70%。

6. **混合排序（关键点）** — `getVectorLexicalMatch`（7538）
   用查询词对 `sourceText + summary` 做子串匹配，命中数 × 0.015、封顶 **+0.08**，得到：

   ```
   vectorScore = 余弦相似度 + 词法 boost
   ```

   向量相关且词面也对得上的记忆排得更靠前，是对纯 RAG 的召回修正。

7. **top-K + 去重** — 分数降序（差异 > 0.0001 按分，否则更新轮次优先），按内容指纹去重，取默认 **10** 条（范围 10–20，`getVectorMemoryTopK` 7461）。

8. **排除近期轮次** — `getCurrentRetainedVectorMemoryTurns`（7695）
   计算最近 `vectorKeepFloors` 条消息涉及的 turn，这些 turn 的记忆**不注入**——上下文里已有，避免重复灌入。

9. **注入上下文** — 命中的 `<memory_fragment>` 作为向量召回块进入系统提示（约 6030 行）。

### 1.4 主动工具检索（tool_memory）

- AI 可输出 `<tool_memory_add:检索内容>` / `<tool_memory_cover:检索内容>` 主动检索向量记忆。
- 执行入口：`searchVectorMemoriesForTool`（7862），查询加 `"工具检索："` 前缀，结果数 5–10。
- add/cover 语义：add 保留旧结果追加；cover 清理上下文冗余后替换。

### 1.5 提取触发时机

| 场景             | 函数                               | 行号 | 说明                                                           |
| ---------------- | ---------------------------------- | ---- | -------------------------------------------------------------- |
| 对话生成后自动   | `extractMemoryFromChat`            | 7061 | 生成 finally 中 nextTick 触发（见 dialog-generation.md 13 节） |
| 自动 Patrol 入口 | `startAutomaticMemoryPatrol`       | 9273 | 按 mode 分流；运行中置 `_vectorBatchRescanRequested` 待续扫    |
| 手动补录按钮     | `startVectorBatchMemoryExtraction` | 9093 | `manual=true`；未选 embedding 模型时提示                       |
| 统一入口         | `startBatchMemoryExtraction`       | 9293 | 按 mode 分流                                                   |
| 中止             | `abortVectorBatchExtraction`       | 6705 | 中止在途批处理，重置状态                                       |

`startAutomaticMemoryPatrol`（9273）向量分支：`_memoriesLoaded` 校验后启动**非交互式**补录（`manual=false`）；若已有补录在跑，则置 `_vectorBatchRescanRequested=true`，当前批结束后自动续扫。

### 1.6 批量嵌入核心 — `_doBatchEmbedMemoryChunks`（7335）

向量补录主循环，按轮次分块、每批 `MEMORY_VECTOR_BATCH_SIZE=16`（1138）调 embedding：

1. **去重预筛**（7338-7345）：`existingChunkIds`（已存 `vectorChunkId`）+ `existingFingerprints`（内容指纹）+ `pendingFingerprints`（本批计划新增，防批内重复）；
2. **空轮日志（emptyTurns）**（7360-7362 / 7411-7420）：某轮无任何可嵌入片段 → 记入 `emptyLog`（key = `角色uuid:vector`，`getMemoryEmptyTurnsKey` 1456），下次补录直接跳过；该轮成功新增 → 从 emptyLog 移除；
3. **批嵌入**（7382-7404）：`requestMemoryEmbeddings` 批量向量化，逐片段再校验 `vectorChunkId`/指纹后 `createVectorMemoryFromFragment` push 到 `memories`；
4. **周期保存**（7423-7428）：`MEMORY_VECTOR_SAVE_EVERY_BATCHES=4`（1139）批或最后一批触发 `flushBatchMemorySave`（`saveMemoriesNow` + `saveMemorySettingsNow`）；
5. **错误交互**（7429-7453）：非交互模式（自动 patrol）失败直接抛；交互模式弹 `showVueConfirmModal` 询问重试，用户取消则中止并保存已处理部分。

### 1.7 碎片构建与数据结构

**`buildVectorMemoryFragments`（7141）**：

- 只取 user/assistant 消息（7147），正文先经 `getCleanMemoryMessageText`（6783）清洗；
- assistant 消息提取 `storyTime`（`extractStoryTime` 1480，匹配 `【N年M月D日 H时】` 行首），单独作 `剧情时间：` 行（7192）；
- 段落切分：`splitMemoryParagraphs`（7089）→ `splitLongMemoryParagraph`（7063，超 1800 字截断）→ `mergeSmallMemoryParagraphs`（7104，合并 ≤400 字碎片）；
- **用户消息汇总**：该轮全部 user 段落拼成 `用户：{全部}` 一整行（7177-7178）；
- 每个角色片段 = `用户行 + 剧情时间行 + 角色段落`（7190-7194）；
- **vectorChunkId 组成**（7208）：`{turn}:{messageIndex}:{role}:{段落范围}(+...)`，chunk 唯一标识；
- 返回值含 `turn / sequence / speaker / role / paragraph / sourceText / vectorChunkId`。

**数据结构 — `createVectorMemoryFromFragment`（7311）**：

```
{ id: UUID, timestamp, turn, summary: 段落截断900字, enabled: true,
  vectorMemory: true, chunkMode: 'paragraph', vectorChunkId,
  sourceRole, sourceName, paragraph, paragraphIndex, paragraphEndIndex,
  sequence, contentFingerprint, embeddingModel, embedding, sourceText,
  ...(storyTime ? { storyTime } : {}) }
```

- 经 `prepareMemoryForRuntime`（1556）反量化：`embedding` 从 `embeddingQ`(base64) + `embeddingScale` + `embeddingDims` 解回（见 1.2）；
- 运行时判定 `isVectorMemory`（1497）= `vectorMemory===true && chunkMode==='paragraph' && hasVectorEmbedding`。

---

## 2. 关键词检索

两处实现，都是**子串匹配**而非向量检索。

### 2.1 对话历史关键词检索（tool_grep 主动工具）

**入口：`searchDialogueByKeywordForTool`（7915）**

| 步骤     | 函数                        | 行号 | 说明                                                                                                                                    |
| -------- | --------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 切词表   | `extractKeywordToolTerms`   | 7883 | 按 `空格/逗号/顿号/分号/竖线/斜杠` 切分查询，保留"完整查询 + 各切分片段"，去重，最多 12 个                                              |
| 清洗消息 | `getKeywordToolMessageText` | 7895 | `parseCot` 去思维链 → 剥离 UI 模板/向量记忆/禁图注入上下文，限长 5000；跳过 system 消息、角色记忆上下文块、`<active_tool_results>` 残留 |
| 子串匹配 | —                           | 7936 | `lowerText.includes(term)` 大小写不敏感匹配，统计命中词数                                                                               |
| 打分排序 | —                           | 7947 | 完整查询命中 +100，每个词 +1；分数降序，同分取消息索引更靠后的（更新的），截取 **5–10** 条                                              |
| 片段截取 | `buildKeywordToolSnippet`   | 7902 | 正文超 1400 字时定位第一个命中词，**向前 420 字、向后 900 字**加省略号，保证命中上下文可见                                              |
| 输出     | —                           | 7949 | 按消息顺序正序，带 `用户：/角色卡：` 前缀、turn 号、speaker                                                                             |

### 2.2 世界书（World Info）触发词

- `worldInfoKeyMatchesText`（5613）：`useRegex` 时用 `createWorldInfoRegex` 正则测试；否则 `rawText.toLowerCase().includes(rawKey)` 子串匹配。
- 在**最近 scanDepth 条消息**拼成的 `scanText` 上匹配（5672），受全局 maxDepth 上限约束；每轮先掷一次概率（`passesWorldInfoProbability`，5616）。
- 命中数记入 score、`matchedKeys` 记录命中词；常驻条目恒触发（+∞）。

---

## 3. 两种检索的对比

| 维度     | 向量记忆（RAG）                      | 关键词检索（tool_grep）            |
| -------- | ------------------------------------ | ---------------------------------- |
| 匹配原理 | embedding + 余弦相似度               | 子串 `includes` 匹配               |
| 适用场景 | 语义相关、旧剧情、人物关系、暗指内容 | 原文/台词/名称/物品/地点等精确抓取 |
| 排序     | 余弦 + 词法 boost 混合               | 完整查询命中优先 + 词数 + 消息新旧 |
| 数据范围 | 长期向量记忆（IndexedDB）            | 当前对话历史                       |
| 结果数量 | top-K 默认 10（范围 10–20）          | 5–10 条                            |
| 前置清洗 | 排除近期轮次                         | 去 CoT / 去注入残留 / 去 system    |

**选型建议**：找语义相关内容用 `tool_memory`，找原文/台词用 `tool_grep`，两者互补。

---

## 4. 记忆管理与手动检索

### 4.1 手动检索 — `searchVectorMemories`（7773）

1. 查询清洗：`trimMemoryText(stripVectorMemoryCode(query), 800)`；
2. 排除近期轮次（`getCurrentRetainedVectorMemoryTurns`），结果上限 **20** 条；
3. `requestMemoryEmbeddings(['用户：' + query])` → 逐条 `cosineSimilarity` + 阈值 → 排序（分数降序，同分按 turn 新旧）→ 取前 20 → 再按 turn/sequence 正序展示（7820-7834）；
4. abort 支持（`_vectorMemorySearchAbort`），每 512 条 `yieldToBrowser`（7817）。

### 4.2 记忆统计 — `memoryStats`（12025）

| 字段          | 含义                                       |
| ------------- | ------------------------------------------ |
| `vector`      | 向量分片总数                               |
| `vectorTurns` | 向量分片覆盖的轮次数                       |
| `classic`     | 经典摘要条数                               |
| `activeTotal` | 当前模式下生效的记忆数（用于清空按钮显隐） |

### 4.3 清空 — `clearAllMemories`（12038）

按当前模式：abort 在途批处理 → 清空数组 → 保存对应存储；`confirmAction` 二次确认。

### 4.4 导出 — `exportMemories`（12054）

- 向量模式：`compactMemoriesForStorageAsync`（1629）压缩 embedding 后导出 `vector_memories_{角色名}.json`；
- 经典模式：按 turn 排序导出 `{type:'rp-hub-summary-memories', version:1, memories:[{turn, user:{content,messageIds}, assistant:{content,messageIds}, summary}]}`。

### 4.5 导入 — `importMemories`（12093）

- 向量模式：过滤 `vectorMemory===true && hasVectorEmbedding`，剥 `importance`，按 `id/timestamp/turn/summary` 归一化后 `prepareMemoriesForRuntime`（1584）追加；
- 经典模式：校验 manifest `type/version`，`getClassicMemoryKey` 去重后追加；
- 入口在设置页"记忆系统"顶部（index.html 2975-2986 导出/导入/清空图标）。

### 4.6 空轮日志隔离

`getMemoryEmptyTurnsKey(uuid)`（1456）= `${uuid}:vector`，按角色+分支作用域隔离（`getCurrentStoryBranchScopeId`），随 `memorySettings.emptyTurns` 持久化；删除角色/分支时级联清理（9520 / 10010 / 10158）。

---

## 5. 设置项（memorySettings 相关字段）

| 字段                  | 默认 | 常量区间 / 约束               | 说明                                           |
| --------------------- | ---- | ----------------------------- | ---------------------------------------------- |
| `embeddingModel`      | —    | `getMemoryEmbeddingModel`     | 向量嵌入模型（6714），未选时补录/检索直接提示  |
| `vectorTopK`          | 10   | 10-20（1142-1144）            | 每次最多召回多少条记忆分片                     |
| `similarityThreshold` | 50   | 40-70（1145-1147）            | 最低余弦相似度阈值（%）                        |
| `vectorKeepFloors`    | 50   | 30-80（1154-1156）            | 最近 N 条消息涉及的 turn 不参与记忆召回        |
| `emptyTurns`          | {}   | 按 `角色uuid:vector` 分键     | 无记忆轮次日志，避免重复扫描（4.6）            |
| `vectorDepth`         | 1    | `MEMORY_VECTOR_DEFAULT_DEPTH` | 记忆查询回溯轮数（buildVectorMemoryQueryText） |

UI 位置：设置页"记忆引擎设置"折叠面板（index.html 3006 起），向量模式分支含嵌入模型选择（3130）、记忆召回分片数（3139）、相似度阈值（3177）；"向量记忆检索"面板（3333）与"记忆浏览"面板（3417）位于同页下半区。

---

## 6. 关键点总结

- **两条链路分离**：写入（对话切分 → 嵌入 → Int8 量化落库）与读取（查询嵌入 → 全量余弦 → 词法 boost → top-K）完全独立，只在 embedding 模型处交汇。
- **量化省存储**：embedding 以 `embeddingQ`(base64 Int8) + `embeddingScale` + `embeddingDims` 存库，运行时反量化，省约 4 倍内存。
- **混合排序**：余弦相似度 + 词法命中 boost（×0.015、封顶 +0.08），语义与字面双重加权。
- **去重三防线**：`vectorChunkId`（结构）→ 内容指纹（语义）→ pending 指纹（批内），补录绝不重复。
- **空轮日志**：无记忆轮次进 `emptyTurns` 免重复扫描，按角色+分支隔离。
- **排除近期轮次**：`vectorKeepFloors` 保护最近对话，避免刚发生的剧情被旧记忆反复灌回。
- **手动检索与导入导出**：`searchVectorMemories` 独立于对话流程做语义搜索；JSON 导入导出支持换设备/备份迁移。

**一句话**：向量记忆 = 对话按段落切分成"角色片段"（Int8 量化嵌入落库），每次生成按最近用户输入做语义召回（余弦 + 词法 boost 混合排序 + top-K），靠 chunkId/指纹去重与空轮日志保障补录不重不漏，并提供独立的手动检索、统计、导入导出能力。
