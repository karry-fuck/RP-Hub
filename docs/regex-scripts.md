# 正则脚本（Regex Scripts）实现文档

> 本文件说明 RP-Hub 正则脚本的执行引擎与调用场景。
> 源码位置：`assets/js/app.js`（`processRegex` 等）与 `assets/js/card-utils.js`（`transformUnprotectedText`）。行号基于当前 main 分支版本 1.8.0。

---

## 1. 整体流程

```
[加载]  normalizeRegexScript()            字段归一化（兼容 SillyTavern 别名）
        combineRegexScriptsForCharacter()  生效集合 = 全局脚本 + 当前角色脚本

[执行]  processRegex(text, { isDisplay|isPrompt, role, depth })
        过滤 1: system 消息不处理
        过滤 2: placement（1=User / 2=AI）
        过滤 3: 可见性（markdownOnly / promptOnly 互斥）
        过滤 4: 深度（minDepth / maxDepth）
        → 构造 RegExp（支持 /pattern/flags 内联 + (?s)(?i)(?m) 修饰符提取）
        → HTML/代码块保护：transformUnprotectedText 或直接 replace
        → 单脚本异常 catch，不影响后续脚本

[场景]  界面显示 → { isDisplay:true }      markdownOnly 生效
        发给 AI  → { isPrompt:true, depth }  promptOnly 生效
```

---

## 2. 数据模型归一化 — `normalizeRegexScript`（2884）

每次从存储/角色卡加载脚本时统一字段：

| 字段                                       | 说明                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `name` / `regex` / `replacement` / `flags` | 兼容 SillyTavern 别名 `scriptName` / `findRegex` / `replaceString` / `regexFlags`（2891-2894） |
| `enabled`                                  | 默认 `true`；兼容 `disabled` 反字段（`disabled` → `enabled = !disabled`）                      |
| `placement`                                | 默认 `[1, 2]`：**1 = 用户消息，2 = AI 消息**                                                   |
| `markdownOnly` / `promptOnly`              | 可见性开关，**二者互斥**（同时勾选时强制 `promptOnly=false`，2899）                            |
| `minDepth` / `maxDepth`                    | 生效深度区间，默认 `null`（不限）                                                              |
| `scope`                                    | `global`（全局）或 `character`（角色）；系统脚本（`systemRegexNames`）强制 `global`（2903）    |

生效集合 = **全局脚本 + 当前角色脚本** 合并（`combineRegexScriptsForCharacter`，2914-2921），角色脚本排除 `scope === 'global'` 的项避免重复。

---

## 3. 执行引擎 — `processRegex`（4221）

### 3.1 过滤条件（按顺序）

| 顺序 | 条件                                                                                                          | 行号      |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------- |
| 0    | `role === 'system'` → 直接返回原文                                                                            | 4225      |
| 1    | `enabled === false` → 跳过                                                                                    | 4236      |
| 2    | placement：`role==='user' && !placement.includes(1)` 或 `role==='assistant' && !placement.includes(2)` → 跳过 | 4241-4242 |
| 3    | 可见性：`isDisplay && promptOnly` → 跳过；`isPrompt && (markdownOnly                                          |           | 两项都没勾)` → 跳过 | 4245-4247 |
| 4    | 深度：`depth < minDepth` 或 `depth > maxDepth` → 跳过                                                         | 4250-4251 |

> 注意 `NAI画图正则` 在排序时被强制排到最后（4228-4232），避免影响其他脚本。

### 3.2 正则构造

1. 兼容字段：`regex || findRegex`、`flags || regexFlags`，缺省 flags `'g'`。
2. 解析 `/pattern/flags` 内联写法（4264-4272），校验 flags 合法性后拆分。
3. `normalizeRegexModifiers`（card-utils:68）把内联 `(?s)(?i)(?m)` 修饰符提取到 flags。
4. `new RegExp(pattern, flags)` 执行。

### 3.3 HTML/代码块保护（关键设计）

普通正则通常带 `g` 全局替换，会**破坏 iframe/HTML 渲染**。逻辑（4283-4293）：

````js
if (
  !/[<>]/.test(regexPattern) &&
  !regexPattern.includes("```") &&
  script.name !== "Auto Replace {{user}}"
) {
  result = cardUtils.transformUnprotectedText(result, (part) =>
    part.replace(re, replacement),
  );
} else {
  result = result.replace(re, replacement); // 用户明确操作 HTML/代码块 → 不保护
}
````

**判定规则**：正则不含 `<`、`>`、` ``` ` 且不是 `Auto Replace {{user}}` → 启用保护；否则说明用户意图直接操作 HTML/代码块 → 直接替换。

**保护机制** `transformUnprotectedText`（card-utils:83）：

- `protectedContentPattern`（card-utils:80）把文本按受保护块 split 开：

````
<!DOCTYPE html>... </html>
<html>...</html>
<script>...</script> / <style>...</style>
<cot>...</cot> / <think>...</think>
``` 代码块 ``` / 行内代码 `
HTML 标签 </?[a-zA-Z]...>
````

- 只对**未受保护的部分**执行 `transform`（`replace`），受保护块原样保留。

> 这就是 NAI画图正则能安全地把 `image###提示词###` 替换成 `<img>` HTML 的原因——它匹配的是裸文本，替换出的 HTML 标签不会被自身误伤。

### 3.4 错误隔离

单条脚本异常 `catch` 后 `console.error`（4296-4298），不影响其他脚本继续执行。

---

## 4. 调用场景

| 场景                     | 调用位置                                                                 | 参数                              | 生效的脚本     |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------------- | -------------- |
| 界面显示（美化正文）     | 渲染管线 `contentUsesHtmlFrame`（4325）/ `processMainContent` 等（4481） | `{ isDisplay: true, role }`       | `markdownOnly` |
| 发给 AI 前（改写上下文） | 上下文组装后逐条消息（6101）                                             | `{ isPrompt: true, role, depth }` | `promptOnly`   |

`depth` 从消息末尾数（末尾 = 0），离当前越近越小。

---

## 5. 内置系统脚本 — `enforceSpecialRules`（9663）

onMounted / 设置变化（imageProvider、imageStyle、imageSize 等）时注入两条全局脚本：

| 脚本               | 正则                       | 行为                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **NAI画图正则**    | `/image###([\s\S]*?)###/g` | 替换成**占位卡片** `<div class="rphub-gen-wrap" data-rphub-gen data-taskid data-provider data-prompt data-size data-seed>`（灰色 gif + "生成中…" + 重试按钮），由异步任务队列按 provider 填图（见 settings-and-api.md §8.2）。`placement:[2]`（仅 AI）、`markdownOnly:true`（仅显示时）、默认 `enabled:false`（用户手动开）。提示词/画风/尺寸在占位构建时读当前 settings |
| **自动生图世界书** | —                          | 注入"每次回复必须穿插 `image###提示词###` 并生成 N 张图"的指令                                                                                                                                                                                                                                                                                                           |

---

## 6. 关键点总结

- **多道过滤**：placement（User/AI）→ 可见性（markdownOnly/promptOnly）→ 深度区间。
- **双用途**：`markdownOnly` 做显示美化，`promptOnly` 做 AI 上下文改写，二者互斥。
- **保护替换**：默认带 HTML/代码块保护，正则显式含 `<`/` ``` ` 时才放行直改。
- **字段兼容**：完整兼容 SillyTavern 的正则脚本字段别名。
- **作用域**：全局脚本 + 角色脚本合并生效，系统脚本固定 `scope: 'global'`。
