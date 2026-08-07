# Issues：AI 生图 tag 调用增强与 img2img 外观保护

> 来源：[docs/prd-image-gen-tags.md](./prd-image-gen-tags.md)
> 日期：2026-08-07
> 约定：无自动化测试框架,验证方式为浏览器端到端 + 浏览器控制台。每片独立可 demo/验证。
> 依赖图：IS-1 ← IS-4 ← IS-5;IS-2、IS-3 独立可并行。

---

## IS-1:buildFinalGenPrompt 纯函数(公式收敛,行为不变)

### What to build

先落地"最终正向 prompt 决策"的全部规则为一个可独立调用的纯函数,此片**只重构不改行为**(现有占位/直出图仍走原逻辑)。函数收敛文生图公式、图生图公式(去角色 tag)、img2img 外观词剥离、直出图兜底。这是后续公式接线与外观保护的地基(seam)。

决策精化后的函数签名(来自 PRD seam):

```
buildFinalGenPrompt({
  character: { imageTag, tagAssist, refImage, imageGenMode },
  settings: { provider, imageGenDefaultTags },
  aiPrompt,            // image### 内容,可选
  stripAppearance,     // 图生图外观剥离开关(IS-5 启用,此片先置 false)
})
→ { mode: 'ref'|'tag', finalPrompt, refImage }
```

### Acceptance criteria

- [ ] 纯函数独立可用:浏览器控制台调用,输出不含副作用、不依赖 Vue 实例
- [ ] 文生图公式:`finalPrompt = 角色tag(含tag_assist) + aiPrompt + 默认提示词tag`,角色 tag 在最前、AI 在默认 tag 前(2026-08-07 评审裁决:AI 在前)
- [ ] 图生图公式:`finalPrompt = aiPrompt + 默认提示词tag`(无角色 tag),`refImage` 返回角色参考图
- [ ] 直出图兜底:aiPrompt 缺省时 ref→`portrait, best quality`、tag→`角色tag, portrait, best quality`
- [ ] 模式判定与现有 `determineImageGenMode` 一致(ref=角色有参考图且 provider=comfy)
- [ ] 现有 `buildImageGenPlaceholder` / 直出图行为**未变**(回归:txt2img 仍拼角色 tag+默认 tag+AI)

### Blocked by

- None - can start immediately

---

## IS-2:view_tags + poses 世界书注入

### What to build

把 `view_tags`(角度/镜头/背景/风格 4 类)+ `poses` 硬编码为前端 JS 常量(同步可用,世界书构建不依赖异步 fetch),拼接进自动生图世界书末尾作为「可选 tag 池」段落,分类分组,注明按需挑选勿全加。仅 tag 模式(sta1n/comfy)注入;openai 自然语言版世界书不注入。

### Acceptance criteria

- [ ] 常量同步可用:角色卡/世界书构建时无需等待 fetch 即可读到 4 类 view_tags + poses
- [ ] 自动生图世界书(sta1n/comfy)末尾含分类分组的 tag 池,含「按需挑选,勿全加」说明
- [ ] openai provider 世界书为自然语言版,不含 view_tags/poses 段落
- [ ] 世界书重建(enforceSpecialRules 触发)后 tag 池仍存在且不重复

### Blocked by

- None - can start immediately

---

## IS-3:tool_char 角色库主动工具

### What to build

新增第 4 个内置主动工具 `tool_char`(角色 tag 检索)。AI 在对话中输出 `<tool_char_add:角色名>` 或 `<tool_char_cover:角色名>`,前端懒加载 `characters.json` 后做中英文模糊搜索,返回 top 5 结果 XML `<character_tag cn=... en=... assist=.../>` 回填 `<active_tool_results>`,AI 续写把 en tag 拼进 `image###`。常驻工具列表、受攻击性分级约束;工具描述限定调用场景(将输出 image### 且需精确角色 tag 时,支持任意角色);自动生图世界书加调用提醒;时间线展示调用模式文本。搜不到返回 empty 提示换词重查。

### Acceptance criteria

- [ ] 工具定义可见:第 4 个内置工具,派生 add/cover 双调用标签,描述限定"生图需精确角色 tag 时"
- [ ] 执行闭环:AI 输出 `<tool_char_add:2B>` → 时间线显示结果 → AI 续写把 `2b (nier automata), male` 拼进 `image###` → 生成请求体含该 tag
- [ ] 懒加载:未加载过 `characters.json` 时首次调用先加载再搜
- [ ] 任意角色:搜非当前角色(如 cos 场景 `emilia re:zero`)也能返回结果
- [ ] 空结果:搜不到返回 `status="empty"`,AI 换词重查或自行编 tag
- [ ] 触发约束:非生图对话(攻击性 adaptive)不误调用;调用遵循两行式规则与深度限制
- [ ] 自动生图世界书含「已知角色需精确 tag 时先 tool_char 查询」提醒

### Blocked by

- None - can start immediately

---

## IS-4:公式接线(文生图·图生图·直出图·回退)

### What to build

把 `buildImageGenPlaceholder`、角色卡直出图、ComfyUI 回退路径统一切到 IS-1 的 `buildFinalGenPrompt`,启用新公式。文生图=`角色tag+AI+默认tag`;图生图=`AI+默认tag`(去角色 tag)+参考图底图;直出图 ref 模式兜底质量词、tag 模式带角色 tag;图生图工作流无 LoadImage 回退文生图时执行层把角色 tag 临时补回 prompt。负面提示词与 KSampler 参数不变。

### Acceptance criteria

- [ ] 对话内文生图:最终请求体 prompt = `角色tag+AI内容+默认tag`,角色 tag 在最前、AI 在默认 tag 前
- [ ] 对话内图生图:最终请求体 prompt = `AI内容+默认tag`(不含角色 imageTag/tag_assist),refImage 上传注入 LoadImage
- [ ] 直出图:ref 模式请求 prompt=`portrait, best quality`;tag 模式=`角色tag, portrait, best quality`
- [ ] 回退:选无 LoadImage 工作流做图生图 → 回退文生图提示 + 请求体 prompt 含角色 tag
- [ ] 负面提示词、denoise/steps/cfg 等工作流参数与改动前一致
- [ ] 旧消息持久化反查(image### 占位 taskid)不受影响

### Blocked by

- IS-1

---

## IS-5:img2img 外观保护(世界书分支 + 前端词剥离)

### What to build

双保险防止角色卡设定外观反噬参考图。① 自动生图世界书按当前角色模式分支:角色有参考图且 provider=comfy 时,注入「图生图指令块」——告知 AI 外观以参考图为准,严禁发型/发色/瞳色/服装/体型等外观 tag,只描述动作/姿态/镜头/场景/环境/光影/表情/道具;文生图模式维持原指令(保留外观一致性)。② 前端在 `buildFinalGenPrompt` 启用外观词级剥离:图生图时按逗号切分 AI 内容,命中外观词表(内置发色/瞳色/服装/发型/体型/种族/年龄等 Danbooru 词)的 tag 丢弃,保留动作/镜头/场景/环境/风格。词表内置 + 预留用户扩展入口。

### Acceptance criteria

- [ ] 世界书分支:角色有参考图+comfy 时世界书含「图生图指令块」(禁外观 tag、外观以参考图为准);否则为文生图版(含外观一致性规则)
- [ ] 词剥离生效:img2img 时 AI 内容含 `white dress` 等外观词 → 最终请求体 prompt 不含该词,动作/镜头词保留
- [ ] 剥离不改变 AI 原文的持久化与显示(仅影响提交给生成器的 prompt)
- [ ] 文生图不受影响:txt2img 模式外观词保留
- [ ] 词表可扩展:内置词表 + 设置入口可追加自定义词
- [ ] 回归:openai provider 无图生图指令块、无剥离

### Blocked by

- IS-1
- IS-4
