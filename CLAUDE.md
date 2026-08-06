# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

此项目继承 [全局 CLAUDE.md](/.claude/CLAUDE.md) 的所有配置（个人偏好、安全规则、工具偏好、错误处理、终端使用、工作流、仓库规范），以下内容为项目特有配置，与全局配置共同生效。全局配置优先，项目配置补充/覆盖。

## 项目概述

**Roleplay Hub（RP-Hub）**：一款本地角色扮演（Roleplay）对话 + 角色卡生成工具。数据经轻量服务器（`server.py`，零依赖 Python 标准库）落盘 SQLite，支持局域网跨设备共享、聊天图片持久化与 ComfyUI 同源反代。功能包括 OpenAI 兼容 API 的流式对话、向量/经典双模式记忆、世界书、正则脚本、UI 模板、主动工具调用、剧情分支、角色卡（PNG/JSON）导入导出与 AI 生成角色卡。版本 1.9.0。

**许可证：CC BY-NC 4.0**（知识共享-署名-非商业性使用），**明确禁止任何商业化使用**。详见 `LICENSE`。

## 运行与验证

- **启动**：`python3 server.py`（默认 `0.0.0.0:8000`，参数 `--port` / `--bind` / `--db`），浏览器访问 `http://127.0.0.1:8000`；局域网设备访问 `http://<本机IP>:8000`（服务器启动时会打印局域网 IP）。
- **必须通过 server.py 访问**：数据与图片全部经服务器 API 读写，`file://` 双击 `index.html` 无法工作（无后端、无存储）。服务器职责：KV 数据 API（SQLite 落盘，替代原 IndexedDB）、聊天图片落盘（`images/generated/`）、ComfyUI 同源反代（`/comfy_api/*` → `127.0.0.1:8188`）、静态文件服务。
- 本项目**没有** lint / test / build 命令，也没有自动化测试框架。修改代码后验证方式为启动 `server.py` 后在浏览器中打开检查功能，并查看浏览器控制台无报错。
- 脚本通过 `document.write` + `?v=` 参数加载（`index.html` 末尾约 10120-10140 行）；`?v=` 用 `new Date().getTime()` **自动生成**，改 JS 后刷新即自动避开浏览器缓存，**无需手动递增版本号**。

## 架构

前端单页应用（**Vue 3** Options API + **Tailwind CSS** + **DaisyUI**，CDN 引入，无构建层）+ **单文件后端 `server.py`**（Python 标准库，零第三方依赖）。前端业务数据只通过 `window.RPHubServerApi` 读写服务器，**不再使用 IndexedDB/localforage**（localStorage 仅存少量 UI 偏好与 ComfyUI 自定义工作流）。辅助库：marked（`breaks:true`，禁缩进代码块）、DOMPurify、Sortable。

### 文件布局

- `server.py` — 数据服务器（零依赖 Python 标准库）：KV 数据 API（SQLite `rp_hub_data.db`）、图片落盘与读取（`images/generated/`）、ComfyUI 反向代理（`/comfy_api/*`）、静态文件服务
- `assets/js/server-api.js` — `window.RPHubServerApi`：`kvGet/kvSet/kvDelete/kvList/imageSave`，前端唯一数据读写入口
- `index.html` — 主应用（界面模板 + Vue 应用）
- `assets/js/app.js` — 核心业务逻辑（约 16.8k 行，单个大型 setup 函数）
- `assets/js/card-utils.js` — `window.RPHubCardUtils`：角色卡 PNG chunk（tEXt `chara`）解析、`transformUnprotectedText`、导出辅助
- `assets/js/image-gen.js` — `window.RPHubImageGen`：生图多 provider（sta1n / OpenAI 兼容 / ComfyUI）生成函数、任务队列、占位 HTML、ComfyUI `/object_info` 拉取、graph→API workflow 转换、关键节点识别与占位符注入
- `assets/js/ui-select.js` — `window.RPHubCustomSelect`：全局自定义下拉组件（teleport 到 body、动态定位、分组）
- `assets/js/utils.js` — `generateUUID`、`parseCot`（CoT 解析）
- `assets/css/styles.css` — 核心样式（滚动条、markdown、CoT UI、剧情路线图、UI 模板样式等）
- `character/index.html` — 角色卡工坊（独立 Vue 应用）
- `docs/*.md` — 各子系统实现文档（对话/记忆/世界书/正则/生图设置/UI模板/主动工具/剧情分支/角色卡工坊），含行号定位（基于 1.8.0；服务器化改造后行号有偏移，以实际代码为准）；改动相应子系统前先读对应文档

### 数据持久化

- **存储后端**：服务器 SQLite `rp_hub_data.db`（`kv(key, value, updated_at)` 表），键沿用 `rp_hub_` 前缀语义，经 `GET/PUT/DELETE /api/kv/<key>` 读写；`loadData` 时 `kvList()` 批量预热内存缓存 `serverKvCache`。
- **契约**：缺失键返回 `200 + null`（`kvGet` 映射为 undefined，避免首次加载 404 噪音）；last-write-wins；**无认证**，仅限家庭局域网（风险见 README）。
- 角色级数据键：`rp_hub_chat_<uuid>`、`rp_hub_memories_<uuid>`、`rp_hub_classic_memories_<uuid>`、`rp_hub_branches_<uuid>`；故事分支通过 `getStoryBranchScopeId(charUuid, branchId)` 做作用域隔离。
- **聊天图片**：生成后异步经 `POST /api/images` 落盘 `images/generated/`，消息 `msg.images[taskid]` 记录服务器 URL；刷新重渲染命中已完成形态（`data-resolved="1"`），不再重新生成。
- 角色卡工坊：改存服务器 KV 键 `ai_chargen_characters`（防抖自动保存），通过 `postMessage` 与主程序同步（`WORKSHOP_READY` → `SYNC_SETTINGS`）。
- ComfyUI 自定义工作流存 `localStorage['rp_hub_comfy_workflows']`（`{default:null, 自定义名:…}`）；服务端已保存工作流运行时从 ComfyUI `/api/userdata` 拉取，不持久化。

### 核心子系统（均在 app.js 中）

- **对话生成**：SSE 流式调用 `/v1/chat/completions`（`getApiEndpoint(path)` 自动拼 `/v1`），多 API 提供商（sta1n 默认 / deepseek / openrouter / siliconflow / 自定义）。`processMainContent` 在生成期间对正文做截断渲染。
- **记忆系统**：向量模式（embedding API，int8 量化 `embeddingQ`/`embeddingScale`，余弦相似度 top-K 10-20，阈值 40-70%）；经典模式（LLM 每轮摘要，三档长度 50-80 / 100-130 / 200-250 字，`buildClassicSummaryJob`）。
- **世界书 World Info**：触发词/正则、插入位置（system_top / global_note / before_char / after_char / at_depth / user_top / assistant_top）、概率、常驻条目、scanDepth。`normalizeWorldInfoEntry` 兼容 SillyTavern 位置映射（posNameMap、数字位置 0-4）。
- **正则脚本**：`processRegex` 用 `transformUnprotectedText` 保护 HTML/代码块；内置 NAI画图正则 + `Auto Replace {{user}}` 默认脚本；`enforceSpecialRules()` 全局注入。
- **生图服务**：三后端（`settings.imageProvider`）——sta1n 直链 / OpenAI 兼容 `/v1/images/generations` / ComfyUI（经服务器同源反代 `/comfy_api/*` → `127.0.0.1:8188`，`DEFAULT_COMFY_BASE_URL="/comfy_api"`，手机免配置免 CORS）。对话内 `image###提示词###` 走"占位 + 异步填图"（MutationObserver 扫描 + 并发 3 任务队列 + 失败重试），生成结果经 `POST /api/images` 落盘持久化。**ComfyUI 工作流（跨 image-gen.js + app.js + index.html）**：`fetchComfyObjectInfo` 从 `/object_info` 拉取模型/sampler/scheduler/lora 列表；`fetchComfyServerWorkflows` 从 `/api/userdata` 拉服务端已保存工作流（LiteGraph graph→API 转换）；`detectComfyNodes` 识别采样器/分辨率/Lora 节点，`injectComfyPlaceholders` 按节点三态选择（auto/具体id/none）克隆注入 `%model%/%prompt%/%steps%/%scale%/%width%/%lora%` 等占位符，生成前 `fillComfyWorkflow` 用全局 settings 值填充；UI 含集中式 KSampler 参数区块、Lora 加载器（含强度）、工作流 JSON 导入（LiteGraph/API 自动检测）。详见 `docs/settings-and-api.md` 8.3。
- **UI 模板**：HTML 模板 + 变量状态（`variableSchema`/`changeLog`），sandboxed iframe 渲染，`<ui_template_updates>` 由 AI 更新变量，每个角色独立运行时状态。
- **Active Tools**：XML 标签驱动工具调用（`<tool_memory_add:...>`、`<tool_grep_...>`、`<tool_web_...>`），Tavily 网页搜索，攻击性分级 force/active/adaptive，检测/晋升/执行后以 `<active_tool_result>` 回填。
- **剧情分支**：`createStoryBranch` 分叉聊天/记忆/UI 模板运行时状态，`storyRouteMap` SVG 路线图，级联删除，NDJSON 导出。
- **CoT 解析**：`parseCot` 提取 `<think>`/`<cot>`（转义正文 `<` 但保留代码块），解析 `[系统指令: ...]`。
- **内建强制预设**（onMounted 注入）：破限、NSFW增强、防抢话、防神化、防重复、人格内核、文风（抗八股）、时间戳、第二/第三人称（互斥，同步 `user.person`）、禁止规则、COT（内容由 `buildCotPresetContent` 动态重建）。
- **Markdown 渲染**：`renderMarkdown` + DOMPurify + iframe 检测，缓存带 2000 条上限。

### 角色卡工坊（character/index.html）

独立应用，虚拟列表侧栏（itemHeight=72），多页编辑（基础/详情/世界书/正则），AI 生成角色卡（`singlePlayerSystemPrompt`，含虚构位面隔离 system_rules，输出 `### 字段名` 分段 + `<image>` 头像提示词 + 世界书/正则 JSON），Diff 模式（FIND/END/REPLACE 精确匹配 + 模糊匹配，JSON 结构化 diff），头像经 `https://nai.sta1n.cn` 生图 API，`renderPreview` 注入 styleShim/scriptShim（triggerSlash 桥接）在 iframe 中渲染。

## 开发约定

- **全局命名空间**：公共组件/工具挂到 `window`（如 `window.RPHubServerApi`、`window.RPHubCardUtils`、`window.RPHubCustomSelect`、`window.RPHubImageGen`、`window.triggerSlash`），跨文件访问一律走 window。
- **解析容忍度**：AI 输出解析层（JSON、diff、章节分割）刻意做得很宽容（多种候选解析 + 降级），改动解析逻辑时保留这种容错能力。
- **安全**：用户/AI 生成内容渲染前必须经 DOMPurify 净化；UI 模板与正则渲染在 sandboxed iframe 中执行；改动 `transformUnprotectedText` / DOMPurify 配置时注意 XSS 影响面。
- **缓存键**：字符串内容哈希缓存（如 `renderMarkdownCache`、`parseCotCache`）需保持 2000 条上限，防长会话内存泄漏。
