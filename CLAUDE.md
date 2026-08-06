# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

此项目继承 [全局 CLAUDE.md](/.claude/CLAUDE.md) 的所有配置（个人偏好、安全规则、工具偏好、错误处理、终端使用、工作流、仓库规范），以下内容为项目特有配置，与全局配置共同生效。全局配置优先，项目配置补充/覆盖。

## 项目概述

**Roleplay Hub（RP-Hub）**：一款纯前端运行的本地角色扮演（Roleplay）对话 + 角色卡生成工具。支持 OpenAI 兼容 API 的流式对话、向量/经典双模式记忆、世界书、正则脚本、UI 模板、主动工具调用、剧情分支、角色卡（PNG/JSON）导入导出与 AI 生成角色卡。版本 1.8.0。

**许可证：CC BY-NC 4.0**（知识共享-署名-非商业性使用），**明确禁止任何商业化使用**。详见 `LICENSE`。

## 运行与验证

- **无 Node 环境、无构建步骤、无依赖安装**：直接双击打开 `index.html` 即可运行全部核心功能（README 明确说明）。
- 少数功能（角色卡工坊预览、正则沉浸式渲染等）在 `file://` 协议下可能受跨域限制，此时用本地静态服务器运行目录，例如 `python3 -m http.server`。
- 本项目**没有** lint / test / build 命令，也没有自动化测试框架。修改代码后验证方式为在浏览器中手动打开 `index.html` 检查功能，并查看浏览器控制台无报错。
- 脚本通过 `document.write` + `?v=` 参数加载（`index.html` 末尾约 10120-10140 行）；`?v=` 用 `new Date().getTime()` **自动生成**，改 JS 后刷新即自动避开浏览器缓存，**无需手动递增版本号**。

## 架构

单页前端应用，无框架构建层。技术栈：**Vue 3**（Options API，`createApp({ setup() {...}}).mount('#app')`）+ **Tailwind CSS**（CDN + 内联 tailwind.config）+ **DaisyUI**，全部通过 CDN 引入。辅助库：localforage（IndexedDB）、marked（`breaks:true`，禁缩进代码块）、DOMPurify、Sortable。

### 文件布局

- `index.html` — 主应用（界面模板 + Vue 应用）
- `assets/js/app.js` — 核心业务逻辑（约 16.8k 行，单个大型 setup 函数）
- `assets/js/card-utils.js` — `window.RPHubCardUtils`：角色卡 PNG chunk（tEXt `chara`）解析、`transformUnprotectedText`、导出辅助
- `assets/js/image-gen.js` — `window.RPHubImageGen`：生图多 provider（sta1n / OpenAI 兼容 / ComfyUI）生成函数、任务队列、占位 HTML、ComfyUI `/object_info` 拉取、graph→API workflow 转换、关键节点识别与占位符注入
- `assets/js/ui-select.js` — `window.RPHubCustomSelect`：全局自定义下拉组件（teleport 到 body、动态定位、分组）
- `assets/js/utils.js` — `generateUUID`、`parseCot`（CoT 解析）
- `assets/css/styles.css` — 核心样式（滚动条、markdown、CoT UI、剧情路线图、UI 模板样式等）
- `character/index.html` — 角色卡工坊（独立 Vue 应用）
- `docs/*.md` — 各子系统实现文档（对话/记忆/世界书/正则/生图设置/UI模板/主动工具/剧情分支/角色卡工坊），含行号定位（基于 1.8.0）；改动相应子系统前先读对应文档

### 数据持久化

- 主应用：IndexedDB `RPHubDB`（单个 `store` object store）；键带 `rp_hub_` 前缀；角色级数据用 `rp_hub_chat_<uuid>`、`rp_hub_memories_<uuid>`、`rp_hub_classic_memories_<uuid>`、`rp_hub_branches_<uuid>` 等键；故事分支通过 `getStoryBranchScopeId(charUuid, branchId)` 做作用域隔离。
- 角色卡工坊：独立 IndexedDB `AICharGen`（localforage，storeName `characters`），通过 `postMessage` 与主程序同步（`WORKSHOP_READY` → `SYNC_SETTINGS`）。
- 兼容旧版 SillyTavern 数据（`SillyTavernDB`）。
- ComfyUI 自定义工作流存 `localStorage['rp_hub_comfy_workflows']`（`{default:null, 自定义名:…}`）；服务端已保存工作流运行时从 ComfyUI `/api/userdata` 拉取，不持久化。

### 核心子系统（均在 app.js 中）

- **对话生成**：SSE 流式调用 `/v1/chat/completions`（`getApiEndpoint(path)` 自动拼 `/v1`），多 API 提供商（sta1n 默认 / deepseek / openrouter / siliconflow / 自定义）。`processMainContent` 在生成期间对正文做截断渲染。
- **记忆系统**：向量模式（embedding API，int8 量化 `embeddingQ`/`embeddingScale`，余弦相似度 top-K 10-20，阈值 40-70%）；经典模式（LLM 每轮摘要，三档长度 50-80 / 100-130 / 200-250 字，`buildClassicSummaryJob`）。
- **世界书 World Info**：触发词/正则、插入位置（system_top / global_note / before_char / after_char / at_depth / user_top / assistant_top）、概率、常驻条目、scanDepth。`normalizeWorldInfoEntry` 兼容 SillyTavern 位置映射（posNameMap、数字位置 0-4）。
- **正则脚本**：`processRegex` 用 `transformUnprotectedText` 保护 HTML/代码块；内置 NAI画图正则 + `Auto Replace {{user}}` 默认脚本；`enforceSpecialRules()` 全局注入。
- **生图服务**：三后端（`settings.imageProvider`）——sta1n 直链 / OpenAI 兼容 `/v1/images/generations` / ComfyUI 浏览器直连。对话内 `image###提示词###` 走"占位 + 异步填图"（MutationObserver 扫描 + 并发 3 任务队列 + 失败重试）。**ComfyUI 工作流（跨 image-gen.js + app.js + index.html）**：`fetchComfyObjectInfo` 从 `/object_info` 拉取模型/sampler/scheduler/lora 列表；`fetchComfyServerWorkflows` 从 `/api/userdata` 拉服务端已保存工作流（LiteGraph graph→API 转换）；`detectComfyNodes` 识别采样器/分辨率/Lora 节点，`injectComfyPlaceholders` 按节点三态选择（auto/具体id/none）克隆注入 `%model%/%prompt%/%steps%/%scale%/%width%/%lora%` 等占位符，生成前 `fillComfyWorkflow` 用全局 settings 值填充；UI 含集中式 KSampler 参数区块、Lora 加载器（含强度）、工作流 JSON 导入（LiteGraph/API 自动检测）。详见 `docs/settings-and-api.md` 8.3。
- **UI 模板**：HTML 模板 + 变量状态（`variableSchema`/`changeLog`），sandboxed iframe 渲染，`<ui_template_updates>` 由 AI 更新变量，每个角色独立运行时状态。
- **Active Tools**：XML 标签驱动工具调用（`<tool_memory_add:...>`、`<tool_grep_...>`、`<tool_web_...>`），Tavily 网页搜索，攻击性分级 force/active/adaptive，检测/晋升/执行后以 `<active_tool_result>` 回填。
- **剧情分支**：`createStoryBranch` 分叉聊天/记忆/UI 模板运行时状态，`storyRouteMap` SVG 路线图，级联删除，NDJSON 导出。
- **CoT 解析**：`parseCot` 提取 `<think>`/`<cot>`（转义正文 `<` 但保留代码块），解析 `[系统指令: ...]`。
- **内建强制预设**（onMounted 注入）：破限、NSFW增强、防抢话、防神化、防重复、人格内核、文风（抗八股）、时间戳、第二/第三人称（互斥，同步 `user.person`）、禁止规则、COT（内容由 `buildCotPresetContent` 动态重建）。
- **Markdown 渲染**：`renderMarkdown` + DOMPurify + iframe 检测，缓存带 2000 条上限。

### 角色卡工坊（character/index.html）

独立应用，虚拟列表侧栏（itemHeight=72），多页编辑（基础/详情/世界书/正则），AI 生成角色卡（`singlePlayerSystemPrompt`，含虚构位面隔离 system_rules，输出 `### 字段名` 分段 + `<image>` 头像提示词 + 世界书/正则 JSON），Diff 模式（FIND/END/REPLACE 精确匹配 + 模糊匹配，JSON 结构化 diff），头像经 `https://nai.sta1n.cn` 生图 API，`renderPreview` 注入 styleShim/scriptShim（triggerSlash 桥接）在 iframe 中渲染。

## 开发约定

- **全局命名空间**：公共组件/工具挂到 `window`（如 `window.RPHubCardUtils`、`window.RPHubCustomSelect`、`window.RPHubImageGen`、`window.triggerSlash`），跨文件访问一律走 window。
- **解析容忍度**：AI 输出解析层（JSON、diff、章节分割）刻意做得很宽容（多种候选解析 + 降级），改动解析逻辑时保留这种容错能力。
- **安全**：用户/AI 生成内容渲染前必须经 DOMPurify 净化；UI 模板与正则渲染在 sandboxed iframe 中执行；改动 `transformUnprotectedText` / DOMPurify 配置时注意 XSS 影响面。
- **缓存键**：字符串内容哈希缓存（如 `renderMarkdownCache`、`parseCotCache`）需保持 2000 条上限，防长会话内存泄漏。
