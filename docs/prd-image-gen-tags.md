# PRD：AI 生图 tag 调用增强与 img2img 外观保护

> 状态：设计定稿 · 待实现
> 日期：2026-08-07
> 关联：docs/settings-and-api.md 8.3（生图设置与 ComfyUI 工作流）、docs/prd-character-img2img.md（角色卡 img2img/tag 基础）、docs/active-tools.md（主动工具）
> 关联数据：data/characters.json（5091 角色 + tag_assist + viewTags + poses，由 scripts/build_characters_json.py 构建）

## Problem Statement

当前角色卡生图有四个问题：

1. **AI 编 tag 用的是世界书里写死的示例词**,无法调用 `data/` 里适配 WAI-illustrious 工作流的通用画面 tag(view_tags 角度/镜头/背景/风格、poses 姿势)。AI 对构图/镜头/背景/风格的选择没有可用的 tag 池。
2. **AI 拿不到精确角色 tag**。`characters.json`(5091 角色)只在角色卡工坊里被手动搜索选中,对话中的 AI 完全看不到它。已知角色(2B 等)还原靠 AI 记忆,经常给错 tag。
3. **img2img 时角色卡设定反噬参考图**。自动生图世界书强制 AI「精准提取并保留角色当前的外貌、着装状态」「同人角色 tag 放最前带专属特征」。但 AI 是纯文本,**看不到参考图**,编 tag 的唯一依据是角色卡/世界书文本设定。当参考图服装与角色卡设定不一致(如上传紫色 cos 服、角色卡设定白裙子)时,AI 编出的外观 tag 进正向节点后会把参考图往角色卡设定方向重绘,破坏参考图。
4. **img2img 会把角色 tag 机械拼进 prompt**。`buildImageGenPlaceholder` 对所有模式都拼「角色 tag + 默认提示词 tag + AI 内容」,img2img 时角色 tag 与参考图身份重复/冲突。

## Solution

- 把 `view_tags`(角度/镜头/背景/风格)+ `poses` 拼进自动生图世界书末尾作「可选 tag 池」,AI 编 tag 时按需挑选。
- 新增第 4 个内置主动工具 `tool_char`:AI 在对话中主动 `<tool_char_add:角色名>` 搜索 `characters.json`(本地内存模糊匹配),拿到精确英文 Danbooru tag + tag_assist 追加词,拼进 `image###`。支持搜任意角色(不限于当前角色,可实现 cos 其他角色服装)。
- 最终正向提示词公式按模式区分:
  - **文生图** = 角色 tag + AI 编的 tag + 默认提示词 tag
  - **图生图** = AI 编的 tag + 默认提示词 tag(**去掉角色 tag**)+ 参考图底图
- **img2img 外观保护(双保险)**:① 自动生图世界书按当前角色模式分支——图生图时注入「图生图指令」,告知 AI 外观以参考图为准、严禁外观 tag;② 前端对 AI 的 prompt 做**外观词级剥离**兜底,命中外观词表(发色/瞳色/服装/发型/体型等)的 tag 丢弃。

## User Stories

1. 作为用户,我希望自动生图世界书末尾带 view_tags + poses 可选 tag 池,以便 AI 编 tag 时能挑到工作流认识的构图/镜头/背景/风格词。
2. 作为用户,我希望 view_tags + poses 只注入 tag 模式(sta1n/comfy),以便 openai 自然语言模式下不被 Danbooru tag 干扰。
3. 作为用户,我希望 AI 在对话中能主动搜索角色库拿到精确 en tag,以便不再靠记忆猜角色 tag。
4. 作为用户,我希望 tool_char 支持搜索任意角色(不限于当前角色),以便实现 cos 其他角色服装/混搭。
5. 作为用户,我希望 tool_char 常驻主动工具列表、受攻击性分级约束,以便非生图对话不误调用。
6. 作为用户,我希望 tool_char 搜索结果带 cn/en/assist 三元信息,以便 AI 直接拼 en tag + 性别补充词。
7. 作为用户,我希望 tool_char 搜不到时返回 empty 状态提示,以便 AI 换词重查或自行编 tag。
8. 作为用户,我希望文生图最终 prompt = 角色 tag → AI 编的 tag → 默认提示词 tag,以便身份、场景、风格三者齐全且权重排序合理。
9. 作为用户,我希望图生图最终 prompt = AI 编的 tag → 默认提示词 tag(去掉角色 tag),以便参考图身份不被文字重复/冲突。
10. 作为用户,我希望角色卡直出图在 ref 模式用兜底质量词,以便无 AI 触发也能生成角色图。
11. 作为用户,我希望图生图回退文生图(工作流无 LoadImage)时补回角色 tag,以便回退后仍保持角色身份。
12. 作为用户,我希望图生图时 AI 能感知模式且被明确禁止外观 tag,以便角色卡设定(如白裙子)不会破坏参考图(如紫色 cos 服)。
13. 作为用户,我希望图生图时前端对 AI 的 prompt 做外观词级剥离兜底,以便即使 AI 偶发不守规矩也不会破坏参考图。
14. 作为用户,我希望外观词表可扩展,以便补充漏网的外观词。
15. 作为用户,我希望现有文生图行为(txt2img 仍拼角色 tag + 默认 tag)保持不变,以便不破坏已有生成效果。
16. 作为用户,我希望负面提示词与 KSampler 参数保持不变,以便安全基线不受影响。
17. 作为用户,我希望 tool_char 的执行/结果展示复用现有主动工具时间线 UI,以便能看到 AI 搜了什么角色、拿回什么 tag。

## Implementation Decisions

### 1. 生图模式感知与世界书分支

- 自动生图世界书的构建(`enforceSpecialRules` 逻辑)按**当前角色的图生图模式**分支。判定条件与现有 `determineImageGenMode` 一致:**角色有参考图且 provider=comfy** → 图生图模式;否则文生图模式。
- **图生图指令块**(仅图生图模式注入世界书)：
  - 告知 AI「当前角色配有参考图,角色外观(发型/发色/瞳色/服装/体型/种族/年龄等)以参考图为准」;
  - 严禁在 `image###` 中描述任何外观/服装特征,尤其不得引用角色卡、世界书设定中的外貌服装;
  - 只允许描述:动作、姿态、表情、镜头角度、构图、场景、环境、光影、时间、风格、道具等非外观元素;
  - 涉及 NSFW/POV 的既有规则保留。
- **文生图模式**维持现有世界书指令(保留「精准提取角色外貌/着装一致性」「同人角色 tag 放最前」等),只在末尾追加 view_tags/poses 可选 tag 池。
- openai provider 使用自然语言版世界书(`buildAutoImageGenNaturalContent` 路径),**不注入** view_tags/poses,也不注入图生图指令块。

### 2. view_tags + poses 数据与注入

- `view_tags.json` 的 4 类(angle/camera/background/style)与 `wildcardPoses.txt` 硬编码为**前端 JS 常量**(同步可用)。理由:世界书构建是同步过程,不能依赖 `characters.json` 的异步 fetch;该数据基本固定、体积约 2KB。
- 注入为世界书末尾「可选 tag 池」段落,格式为分类分组(如 `[角度] from above, from behind, ...`),并注明「按需挑选匹配场景的词,勿全加」。

### 3. 新增主动工具 tool_char

- 作为第 4 个内置工具加入 `getDefaultActiveToolDefinitions`:type 为角色 tag 检索(`char_tag_search`),callName 派生 `tool_char_add` / `tool_char_cover`(复用现有 add/cover 双模式)。
- **触发约束**(三层,不动现有框架)：
  - 工具描述:「仅当本回复将输出 `image###` 生图、且场景涉及 waiIllustrious 已知角色、需要精确 Danbooru tag 时调用;支持搜索任意角色(cos 场景)」;
  - 自动生图世界书加提醒:「场景涉及已知角色需精确 tag 时,先 `<tool_char_add:角色名>` 查询,再拼进 image###」;
  - 攻击性分级沿用全局设置。
- **执行**：懒加载 `characters.json`(未加载则先加载)→ 复用中英文模糊搜索 → 返回 top 5 → 格式化结果 XML `<character_tag cn=... en=... assist=.../>`;搜不到返回 `status="empty"` 提示换词重查。
- 结果回填、自动续写、时间线展示复用现有主动工具闭环(`<active_tool_results>` 注入 → AI 续写把 en tag 拼进 `image###`);工具调用模式文本增加角色检索的展示文案。

### 4. 前端外观词级剥离(图生图兜底)

- 图生图模式下,前端对 AI 的 `image###` 内容做**词级剥离**:按逗号切分 tag,正则命中外观词表(发色/瞳色/服装/发型/体型/种族/年龄等 Danbooru 常见外观词)的 tag 丢弃,保留动作/姿态/镜头/场景/环境/光影/表情/道具/风格。
- 外观词表:内置一组常见词 + 预留用户自定义扩展入口(生图设置可选)。
- 剥离发生在最终 prompt 组装环节,不改变 AI 原文的持久化与显示。

### 5. 最终 prompt 决策 seam:纯函数

- 新增可独立调用的纯函数,收敛「最终正向 prompt 决策」全部规则(单一测试 seam):
  - 输入:`{ character(imageTag/tagAssist/refImage/imageGenMode), settings(provider/imageGenDefaultTags), aiPrompt(image### 内容,可选) }`
  - 输出:`{ mode: 'ref'|'tag', finalPrompt, refImage }`
  - 规则覆盖:文生图公式、图生图公式(去角色 tag)、img2img 外观词剥离、直出图兜底(aiPrompt 缺省时 ref→质量词 / tag→角色 tag+质量词)。
- 现有 `buildImageGenPlaceholder`、角色卡直出图统一改走该函数,避免公式散落多处。

### 6. 回退与执行层

- 图生图工作流无 LoadImage 节点回退文生图时(`generateImageWithComfy` 回退路径),若原任务来自 ref 模式,执行层把角色 tag 临时补回 prompt(回退后已是文生图,按文生图规则拼角色 tag,保证图仍有角色身份)。
- 负面提示词(`imageGenNegativePrompt`)、KSampler 参数(steps/cfg/denoise/sampler/scheduler)、工作流位选择逻辑**保持不变**。

## Testing Decisions

项目**无自动化测试框架**(CLAUDE.md 约定),验证方式为手动浏览器端到端 + 浏览器控制台。好的测试 = 验证外部行为(最终提交给正向节点的 prompt、模式判定、回退、剥离),不测实现细节。

验证清单:

1. **seam 纯函数**:浏览器控制台直接调用 `buildFinalGenPrompt`,断言各模式公式——文生图=`角色tag+AI+默认tag`;图生图=`AI+默认tag`(去角色 tag)+ refImage;直出图 ref 兜底质量词、tag 模式带角色 tag;img2img 剥离外观词生效。
2. **世界书分支**:开启自动生图 → 查看世界书文本——角色有参考图+comfy 时含「图生图指令块」+ view_tags/poses tag 池;否则为文生图版世界书(含 tag 池、不含图生图指令)。
3. **tool_char 闭环**:对话中 AI 输出 `<tool_char_add:2B>` → 时间线显示结果 → AI 续写把 `2b (nier automata), male` 拼进 `image###` → 生成请求体 prompt 含该 tag;搜不到时返回 empty 且 AI 换词重查。
4. **img2img 外观保护**:角色卡设定「白裙子」、参考图为紫色 cos 服 → 生成 → 断言最终请求体 prompt **不含** `white dress` 等外观词、参考图出图未被拉向白裙子。
5. **图生图去角色 tag**:ref 模式生成 → 断言最终请求体 prompt 不含角色 imageTag/tag_assist。
6. **回退补 tag**:选无 LoadImage 的自定义工作流做图生图 → 回退文生图提示 + 请求体 prompt 含角色 tag。
7. **view_tags 注入范围**:openai provider 下世界书为自然语言版、不含 view_tags/poses 与图生图指令。
8. **回归**:txt2img 模式最终 prompt 仍 = 角色 tag + AI + 默认 tag;负面提示词不变。

## Out of Scope

- 真·RAG / 向量检索:角色库为本地内存模糊搜索(`characters.json` 5091 条),不引入 embedding/向量库。
- openai provider 的 tag 注入与 tool_char 使用:自然语言模式不适用 Danbooru tag。
- 外观词表的 100% 穷尽:内置词表 + 可扩展,接受漏网(双保险已降低影响)。
- imageStyle 画风对 ComfyUI 生效:保持仅 sta1n 的 `artist=` 参数,ComfyUI 画风由「默认提示词 tag」或工作流节点表达。
- 多模态参考图理解:AI 仍为纯文本,不引入视觉模型;外观一致性靠「指令 + 剥离」而非 AI 看图。
- 5091 角色库全量注入上下文:仅按需搜索,不整体注入。
- 参考图分辨率处理、图生图内置缩放节点等:沿用 prd-character-img2img 的延后项。

## Further Notes

- **v160/v170 tag 兼容**:`characters.json` 数据对 v160/v170 工作流通用(沿用 img2img PRD 确认)。
- **语义自洽**:图生图的 cos 由参考图承担(上传对应服装的参考图),文生图的 cos 由 AI 文字实现(可 `tool_char` 搜任意角色 tag)——两种模式分工明确。
- **tool_char 与 tool_web 区分**:本地角色库用 `tool_char`,联网查同人资料仍用 `tool_web`,工具描述中说明边界避免误调。
- **回退是罕见路径**:需要用户显式选择无 LoadImage 的图生图工作流,补 tag 是为避免回退后出无身份图,与「图生图去角色 tag」不冲突(严格模式只在真正走图生图时生效)。
