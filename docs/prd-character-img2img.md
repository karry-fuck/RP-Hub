# PRD：角色卡图生图（img2img）与角色 tag 文生图

> 状态：设计定稿 · 待实现
> 日期：2026-08-07
> 关联：docs/settings-and-api.md 8.3（生图设置与 ComfyUI 工作流）、docs/character-workshop.md（角色卡）

## Problem Statement

当前 RP-Hub 只能在对话内用 `image###提示词###` 生成纯文生图（txt2img），**无法生成"长得像当前角色"的图**：

- 已知角色（动漫/游戏角色）想要靠文字描述还原外貌非常困难，而用户使用的工作流模型 `waiIllustriousSDXL_v170`（与 `v160` 角色 tag 兼容）**本身支持直接用角色 Danbooru tag 画出 5000+ 已知角色**，但角色卡里没有承载这个 tag 的字段。
- 原创角色（OC）无法用 tag 表达，需要**参考图**做图生图（img2img），但角色卡现有的 `avatar` 只是 400px 展示图，与生图链路完全无关。
- 对话内触发本身不可靠：AI 经常不输出 `image###` 标签，或给出的提示词过长、格式错误，导致漏图。

## Solution

角色卡新增"生图"页签，承载**角色参考图**（图生图底图）与**角色 tag**（waiIllustrious 角色库，中文名搜索英文 tag）。生成时自动按模式判定：有参考图且用 ComfyUI → 图生图（参考图经服务器反代上传到 ComfyUI 并注入工作流 LoadImage 节点）；否则文生图（角色 tag 始终拼进 prompt）。对话内触发加固：宽容解析 + 助手消息"配图"按钮。工作流改为"文生图/图生图"两个位，选工作流时自动回填其参数作为默认值。

## User Stories

1. 作为 RP-Hub 用户，我可以在角色卡的"生图"页签上传一张角色参考图，以便后续生成时以它为底图做图生图。
2. 作为 RP-Hub 用户，我可以在角色卡的"生图"页签搜索中文角色名并从 waiIllustrious 角色库选中英文 tag，以便文生图能直接还原该角色。
3. 作为 RP-Hub 用户，我可以为每个角色设置生图模式偏好（自动 / 用参考图 / 用 tag），以便控制该角色默认的生成方式。
4. 作为 RP-Hub 用户，当角色有参考图且生图服务为 ComfyUI 时，我在对话内 `image###场景###` 生成会自动走图生图，以便场景图保持角色身份。
5. 作为 RP-Hub 用户，当角色只有 tag 时，我在对话内生成会自动走文生图并把角色 tag 拼进提示词，以便已知角色被准确还原。
6. 作为 RP-Hub 用户，即使角色设置了参考图，我也可以把该角色模式改为"用 tag"来强制文生图，以便偶尔生成不带参考图约束的图。
7. 作为 RP-Hub 用户，我可以在角色卡点击"生成角色图"按钮直接出图，以便不依赖 AI 触发也能生成角色图。
8. 作为 RP-Hub 用户，我可以在助手回复右上角点击"配图"按钮，用该条回复正文当提示词生成图片，以便 AI 漏掉 `image###` 时手动补图。
9. 作为 RP-Hub 用户，AI 输出的 `image###描述` 即使缺闭合 `###` 也能被识别，以便格式不规范的标签也能触发。
10. 作为 RP-Hub 用户，AI 输出过长的提示词会被自动截断到合理长度，以便生图效果不因提示词堆砌而劣化。
11. 作为 RP-Hub 用户，我可以在生图设置里分别指定"文生图工作流"和"图生图工作流"，以便模式切换时自动用对应工作流。
12. 作为 RP-Hub 用户，选中一个工作流后，其采样参数（denoise/steps/cfg/sampler/scheduler）、模型、Lora、分辨率会自动回填到设置面板，以便工作流里调好的原值（如图生图 denoise=0.66）天然生效，我只需在需要时改动。
13. 作为 RP-Hub 用户，如果当前工作流没有 LoadImage 节点，图生图会回退为文生图并提示，以便生成不中断。
14. 作为 RP-Hub 用户，当"图生图工作流"位选择"默认"时使用内置的图生图模板，以便无自定义图生图工作流也能开箱即用。
15. 作为 RP-Hub 用户，我在移动端/局域网设备上也能完成参考图上传与图生图，因为全程走服务器同源反代，无需配置 ComfyUI 地址与 CORS。
16. 作为 RP-Hub 用户，参考图与聊天生成图一样落盘服务器并可持久化，以便跨设备一致、刷新不丢。

## Implementation Decisions

### 数据模型（角色卡 KV）

- 新增字段：
  - `refImage`（string）— 角色参考图服务器 URL（`/images/refs/<uuid>.png`），与 `avatar` 职责分离。
  - `imageTag`（string）— waiIllustrious 英文角色 tag（如 `2b (nier automata)`）。
  - `imageGenMode`（`auto` 默认 / `ref` / `tag`）— 角色生图模式偏好。

### 服务器（server.py）

- `CATEGORIES` 新增 `refs` 分类，复用 `POST /api/images` 的 base64 落盘逻辑，参考图存 `images/refs/`。
- 静态提供角色数据文件（`characters.json`，由 `characters.csv` + `tag_assist.json` + `view_tags.json` + poses wildcard 转换而来），供前端一次 fetch + 本地缓存。
- ComfyUI 反代 `/comfy_api/*` 已支持 POST body 透传（multipart 的 boundary 在 Content-Type 头中），可直接复用上传参考图。

### 参考图进 ComfyUI 的链路

```
fetch(/images/refs/xxx.png) → Blob
  → FormData 带上 → POST /comfy_api/upload/image（服务器反代）
  → ComfyUI 返回 { name: "<filename>" }
  → 注入图生图工作流的 LoadImage 节点（image 字段 = <filename>）
  → 提交 /prompt → 轮询 /history → 出图落盘 images/generated/
```

采用 ComfyUI **标准 `LoadImage` 节点**（非 ETN_LoadImageBase64 自定义节点），兼容性最好。

### 工作流（image-gen.js）

- 新增 `DEFAULT_COMFY_IMG2IMG_WORKFLOW`：镜像用户 WAI-illustrious 图生图工作流结构 —— `CheckpointLoaderSimple(%model%) → LoraLoader(%lora%) → CLIPTextEncode(%prompt%/%negative_prompt%)` + `LoadImage → VAEEncode → KSampler(denoise=%denoise%) → VAEDecode → SaveImage`。
- 新增 `settings.comfyWorkflowImg2img`（图生图工作流位，含"默认"选项），与现有 `settings.comfyWorkflow`（文生图位）并列；模式判定后自动选对应工作流。
- 自定义工作流图生图：检测 `LoadImage` 节点并替换其 `image` 输入；无 LoadImage 节点 → 回退文生图（不中断）。
- 参数自动回填：选中工作流时解析其目标采样器/分辨率/模型/Lora 原值回填设置面板（denoise/steps/cfg/sampler/scheduler/width/height/model/lora）。工作流原值为基准，用户显式改动才覆盖。这解决了图生图 denoise（工作流 0.66）不被全局默认 1.0 覆盖的问题，无需单独的图生图 denoise 设置。

### 模式判定（app.js，对话内与角色卡出图共用）

三层优先级：
1. 角色 `imageGenMode`：`ref` → 强制图生图（无参考图则回退文生图）；`tag` → 强制文生图（忽略参考图）。
2. `auto` 自动判定：有参考图 **且** provider=ComfyUI → 图生图；否则文生图。
3. provider ≠ ComfyUI → 一律文生图（sta1n / OpenAI 无图输入能力）。

角色 tag 与 tag_assist **始终拼进 prompt**（img2img 时作身份强化，txt2img 时作主角），后接 `image###` 消息提示词。

### 角色卡 UI（index.html + app.js）

- 角色编辑器新增"生图"页签：参考图上传/预览/清除区 + tag 中文名搜索区（模糊匹配下拉，选中填英文 tag，展示 tag_assist 追加词）+ 模式偏好选择。
- 参考图上传复用 canvas 缩放能力（`compressImage`），但使用更高分辨率，不压到 400px。

### 对话内触发加固（app.js）

- 解析宽容化：`image###xxx` 缺闭合 `###` 时在行尾/消息尾兜底识别；超长提示词自动截断。
- 助手消息新增"配图"按钮：以该条消息正文为 prompt 触发生成，走同一模式判定链路。

### 角色 tag 数据

- 只内嵌 `waiIllustriousSDXL_v160_characters.csv`（5090 角色，v160/v170 通用）+ `tag_assist.json` + `view_tags.json` + poses wildcard。
- **不内嵌** `thumbs.json`（129MB 缩略图）与 `danbooru_e621_merged.csv`（22 万通用 tag）。
- 转 JSON 后放服务器静态目录，前端 fetch 一次 + 中文名模糊搜索。

## Testing Decisions

项目**无自动化测试框架**（CLAUDE.md 明确约定），验证方式为手动浏览器端到端 + 服务器 API 层检查。好的测试 = 验证外部行为（生成结果、模式判定、回退逻辑），不测实现细节。

验证清单（手动）：

1. **参考图存储**：角色卡上传参考图 → 服务器 `images/refs/` 出现文件、`/api/images` 返回 URL、角色卡 KV 记下 `refImage`。
2. **图生图链路（ComfyUI）**：角色带参考图 → 对话 `image###场景###` → 观察请求先 `POST /comfy_api/upload/image` 再 `/prompt`，工作流 LoadImage 填入上传文件名，出图人物与原参考图一致（denoise 生效）。
3. **文生图链路**：角色仅带 tag → 生成 → prompt 含角色 tag，出图为该角色。
4. **模式判定**：三种 `imageGenMode` 分别验证；sta1n/OpenAI 下即使有参考图也走文生图。
5. **工作流位**：文生图/图生图分别指定不同工作流文件，模式切换后选中项正确。
6. **自动回填**：选中图生图工作流后设置面板 denoise=0.66 等值正确显示；改动后覆盖生效。
7. **回退**：选中无 LoadImage 的自定义工作流做图生图 → 回退文生图且不报错。
8. **对话加固**：AI 输出 `image###xxx`（无闭合）能识别；助手消息"配图"按钮能出图。
9. **持久化**：刷新后已生成图命中已完成形态，不重复生成；局域网设备可访问参考图与生成图。

## Out of Scope

- 参考图分辨率处理（用户将自行继续修改工作流，是否加缩放节点由其工作流决定，延后）。
- `thumbs.json` 看图选角色、`danbooru` 22 万通用 tag 自动补全。
- waiANIMA / waiNSFW 等其他模型角色库。
- OpenAI / sta1n 的图生图能力（二者均仅文生图）。
- 对话内按次覆盖模式的自定义语法（如 `image:txt2img###`），模式仅由角色偏好 + 自动判定决定。
- 图生图工作流内置模板内置分辨率缩放节点（`ImageScale`）——延后，待分辨率处理方案确定后一并决定。

## Further Notes

- **v160/v170 tag 兼容性**：用户确认两个版本支持的角色 tag 一致，`v160_characters.csv` 数据对 v170 工作流完全适用。
- **denoise 处理**：以工作流内原值为基准（自动回填），用户显式改动才覆盖；图生图工作流内置 denoise=0.66 不被全局默认 1.0 覆盖。
- **内置图生图模板**结构参照用户现有的 `WAI-illustrious图生图工作流.json`（LoadImage→VAEEncode→KSampler，闲置 EmptyLatentImage 不参与）。
- **数据来源**：全部数据文件可在 HuggingFace `flagrantia/character_select_stand_alone_app` 仓库下载，后续如需更新角色库可复用其 URL。
