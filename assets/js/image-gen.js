/**
 * image-gen.js — 生图服务多 provider（sta1n / OpenAI 兼容 / 本地 ComfyUI）
 *
 * 挂载到 window.RPHubImageGen，与 card-utils.js 同构（IIFE + window.X）。
 * 纯 provider 逻辑 + 通用任务队列，不依赖 Vue。
 *
 * 依赖：无（sta1n 的 artist 解析由调用方传入 cardUtils.getImageStyleArtists）
 * 被引用：assets/js/app.js（接线）、index.html（script 引入）
 */
(function () {
  "use strict";

  const DEFAULT_COMFY_BASE_URL = "http://127.0.0.1:8188";
  const DEFAULT_STA1N_BASE_URL = "https://nai.sta1n.cn";

  // 透明 GIF 占位，加载前不闪烁
  const TRANSPARENT_GIF =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  // ---- 占位符相关 ----

  /**
   * 确定性的 djb2 字符串哈希（32 位），用于 taskid 生成
   */
  const hashString = (str) => {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash;
  };

  /**
   * HTML 属性值转义 + 换行折叠为空格（提示词是逗号 tag，折叠不损语义）
   */
  const escapeHtmlAttr = (value) => {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\s*\n+\s*/g, " ");
  };

  /**
   * 生成随机 seed（32 位）
   */
  const randomSeed = () => Math.floor(Math.random() * 0x7fffffff);

  /**
   * 构建占位 HTML（纯函数，无副作用，不注册任务）
   *
   * @param {string} prompt   AI 输出的原始提示词（image###...### 的内容）
   * @param {number} offset   replace 回调的第 3 参，保证同文本同 taskid、同消息多图不同 id
   * @param {object} ctx      读 settings 组装：{ provider, defaultTags, size, steps, cfg, denoise, negative }
   * @returns {string}        占位 HTML 字符串（含 data-taskid/data-prompt 等）
   */
  const buildPlaceholderHtml = (prompt, offset, ctx) => {
    const provider = ctx.provider || "sta1n";
    const fullPrompt = [ctx.defaultTags, prompt].filter(Boolean).join(",");
    const seed = randomSeed();
    const taskid = `gen_${offset}_${hashString(prompt).toString(36)}`;

    const attrs = [
      'class="rphub-gen-wrap rphub-gen-pending"',
      "data-rphub-gen",
      `data-taskid="${escapeHtmlAttr(taskid)}"`,
      `data-provider="${escapeHtmlAttr(provider)}"`,
      `data-prompt="${escapeHtmlAttr(fullPrompt)}"`,
      `data-size="${escapeHtmlAttr(ctx.size || "")}"`,
      `data-seed="${seed}"`,
    ].join(" ");

    return (
      `<div ${attrs} style="display:inline-flex; flex-direction:column; align-items:center; gap:4px; padding:6px; border:1px solid rgba(255,255,255,0.4); background:rgba(255,255,255,0.25); border-radius:12px; max-width:100%; box-sizing:border-box; vertical-align:middle;">` +
      `<img class="rphub-gen-img" src="${TRANSPARENT_GIF}" alt="生成中..." style="max-width:100%; height:auto; border-radius:9px; display:block;">` +
      `<span class="rphub-gen-status" style="font-size:12px; color:#64748b;">生成中...</span>` +
      `<button type="button" class="rphub-gen-retry" data-rphub-gen-retry style="display:none; font-size:12px; padding:2px 10px; border-radius:8px; border:1px solid #fca5a5; color:#dc2626; background:#fff; cursor:pointer;">重试</button>` +
      `</div>`
    );
  };

  // ---- ComfyUI workflow ----

  /**
   * 内置默认 txt2img workflow（纯文生图，参照 SillyTavern Char_Avatar 默认 workflow
   * 去掉 ETN_LoadImageBase64 图生图支路）。占位符为 %token% 形式。
   */
  const DEFAULT_COMFY_WORKFLOW = {
    1: {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "%model%" },
    },
    3: {
      class_type: "EmptyLatentImage",
      inputs: { width: "%width%", height: "%height%", batch_size: 1 },
    },
    4: {
      class_type: "CLIPTextEncode",
      inputs: { text: "%prompt%", clip: ["1", 1] },
    },
    5: {
      class_type: "CLIPTextEncode",
      inputs: { text: "%negative_prompt%", clip: ["1", 1] },
    },
    6: {
      class_type: "KSampler",
      inputs: {
        seed: "%seed%",
        steps: "%steps%",
        cfg: "%scale%",
        sampler_name: "%sampler%",
        scheduler: "%scheduler%",
        denoise: "%denoise%",
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["3", 0],
      },
    },
    7: {
      class_type: "VAEDecode",
      inputs: { samples: ["6", 0], vae: ["1", 2] },
    },
    8: {
      class_type: "SaveImage",
      inputs: { images: ["7", 0], filename_prefix: "RPHub" },
    },
  };

  // 文本类占位符（值可能含引号/换行，需 JSON 字符串转义）与简单值占位符
  const TEXT_PLACEHOLDERS = ["prompt", "negative_prompt"];
  const SIMPLE_PLACEHOLDERS = [
    "model",
    "seed",
    "steps",
    "scale",
    "sampler",
    "scheduler",
    "width",
    "height",
    "denoise",
  ];

  /**
   * 用 split/join 等价 replaceAll 填充 workflow 占位符（避免 JSON 里正则特殊字符干扰）。
   * 文本类占位符优先替换其带引号形态 "%prompt%"，再用 JSON 转义后的无引号形态兜底。
   *
   * @param {object|string} template  workflow（对象或 JSON 字符串）
   * @param {object} vars             { prompt, negative_prompt, model, seed, steps, scale, sampler, scheduler, width, height, denoise }
   * @returns {object}                填充后的 workflow 对象
   */
  const fillComfyWorkflow = (template, vars) => {
    let result =
      typeof template === "string"
        ? template
        : JSON.stringify(template, null, 2);

    for (const key of TEXT_PLACEHOLDERS) {
      if (vars[key] === undefined || vars[key] === null) continue;
      const jsonValue = JSON.stringify(String(vars[key]));
      // 优先处理带引号形态（"%prompt%"），保留合法 JSON 字面量
      result = result.split(`"%${key}%"`).join(jsonValue);
      // 兼容无引号手写形态
      result = result.split(`%${key}%`).join(jsonValue.slice(1, -1));
    }
    for (const key of SIMPLE_PLACEHOLDERS) {
      if (vars[key] === undefined || vars[key] === null) continue;
      result = result.split(`%${key}%`).join(String(vars[key]));
    }

    return JSON.parse(result);
  };

  /**
   * 解析 "832x1216" 分辨率 → { width: 832, height: 1216 }
   */
  const parseResolution = (size) => {
    const match = /^(\d+)[xX×](\d+)$/.exec(String(size || "").trim());
    if (!match) return { width: 1024, height: 1024 };
    return { width: Number(match[1]), height: Number(match[2]) };
  };

  // ---- OpenAI 兼容生图 ----

  const OPENAI_SIZE_SETS = {
    "gpt-image-1": ["1024x1024", "1536x1024", "1024x1536"],
    "dall-e-3": ["1024x1024", "1792x1024", "1024x1792"],
    "dall-e-2": ["1024x1024", "512x512", "256x256"],
  };

  /**
   * 把分辨率归一化到模型支持的集合，避免 dall-e 系列白名单校验失败
   */
  const normalizeOpenAISize = (size, model) => {
    const set = OPENAI_SIZE_SETS[model] || OPENAI_SIZE_SETS["gpt-image-1"];
    return set.includes(String(size || "")) ? String(size) : "1024x1024";
  };

  /**
   * 拼接 OpenAI 兼容端点：自动补 /v1/images/generations
   */
  const buildOpenAIImageEndpoint = (base) => {
    const trimmed = String(base || "")
      .trim()
      .replace(/\/+$/, "");
    if (!trimmed) return "";
    return trimmed.endsWith("/v1")
      ? `${trimmed}/images/generations`
      : `${trimmed}/v1/images/generations`;
  };

  // ---- 错误处理 ----

  /**
   * 把 API 响应体/状态码提取为可读错误消息
   */
  const extractImageGenApiError = (json, status) => {
    let detail = "";
    if (json && typeof json === "object") {
      if (json.error && typeof json.error === "object") {
        detail =
          json.error.message || json.error.type || JSON.stringify(json.error);
      } else if (typeof json.error === "string") {
        detail = json.error;
      } else if (typeof json.message === "string") {
        detail = json.message;
      } else if (typeof json.detail === "string") {
        detail = json.detail;
      } else if (json.detail && typeof json.detail === "object") {
        detail = JSON.stringify(json.detail);
      }
    } else if (typeof json === "string") {
      detail = json;
    }
    return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  };

  /**
   * 统一错误文案：fetch 网络失败给出可操作提示
   */
  const normalizeImageGenError = (err) => {
    if (!err) return "未知错误";
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Failed to fetch")
      return "网络请求失败，请检查地址、网络与跨域配置";
    if (message.includes("AbortError")) return "生成超时已中止";
    return message;
  };

  // ---- 三 provider 生图函数 ----

  /**
   * sta1n：纯拼 URL 无网络请求，返回可直接作 img src 的 URL
   *
   * @param {object} task    { taskid, prompt, provider, size, seed }
   * @param {object} settings 全局 settings
   * @param {object} cardUtils window.RPHubCardUtils（getImageStyleArtists）
   * @returns {Promise<string>}
   */
  const generateImageWithSta1n = (task, settings, cardUtils) => {
    const token = String(settings.imageGenKey || "").trim();
    if (!token) return Promise.reject(new Error("未填写自动生图密钥"));

    const targetArtists = cardUtils.getImageStyleArtists(
      settings.imageStyle,
      settings.customImageArtists,
    );
    const negative =
      settings.imageGenNegativePrompt ||
      "{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,{shaka},{hang loose},{{rock on}},{shaka sign}";

    const query = [
      `tag=${encodeURIComponent(task.prompt)}`,
      `token=${encodeURIComponent(token)}`,
      "model=nai-diffusion-4-5-full",
      `artist=${encodeURIComponent(targetArtists)}`,
      `size=${encodeURIComponent(settings.imageSize || "竖图")}`,
      // steps/scale 为 sta1n 固定参数（设置 UI 已移除，仅 ComfyUI 分支可调）
      "steps=40",
      "scale=6",
      "cfg=0",
      "sampler=k_dpmpp_2m_sde",
      `negative=${encodeURIComponent(negative)}`,
      `seed=${task.seed}`,
      "nocache=0",
      "noise_schedule=karras",
    ].join("&");

    const base = String(settings.imageGenBaseUrl || DEFAULT_STA1N_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    return Promise.resolve(`${base}/generate?${query}`);
  };

  /**
   * OpenAI 兼容：POST /v1/images/generations，返回 data: URL 或远端 URL
   *
   * @param {object} task
   * @param {object} settings
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  const generateImageWithOpenAI = async (task, settings, signal) => {
    const base = settings.imageGenOpenaiBaseUrl || settings.apiUrl;
    const endpoint = buildOpenAIImageEndpoint(base);
    if (!endpoint) throw new Error("未配置 API 地址（apiUrl）");
    // 生图专用 Key 优先，留空回退对话 API Key
    const apiKey = String(
      settings.imageGenApiKey || settings.apiKey || "",
    ).trim();
    if (!apiKey)
      throw new Error("未配置生图 API Key（imageGenApiKey 或 apiKey）");

    const model = String(settings.imageGenModel || "gpt-image-1").trim();
    const body = {
      model,
      prompt: task.prompt,
      size: normalizeOpenAISize(task.size || "1024x1024", model),
      n: 1,
      response_format: "b64_json",
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      let json = null;
      try {
        json = await response.json();
      } catch (e) {
        /* 忽略解析失败 */
      }
      throw new Error(extractImageGenApiError(json, response.status));
    }

    const json = await response.json();
    // 宽容解析：标准 OpenAI 返回 data 数组；部分兼容端点直接返回数组或 data[0]
    const items = Array.isArray(json) ? json : json.data || json;
    const first = Array.isArray(items) ? items[0] : items;
    if (!first) throw new Error("生成响应为空");

    if (first.b64_json) return `data:image/png;base64,${first.b64_json}`;
    if (first.url) return first.url;
    throw new Error("生成响应缺少 b64_json 或 url 字段");
  };

  /**
   * ComfyUI：POST /prompt → 轮询 /history/{id} → 返回 /view 图片 URL
   *
   * @param {object} task
   * @param {object} settings
   * @param {object} workflows  workflow 映射（localStorage 载入 + 内置默认）
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  const generateImageWithComfy = async (task, settings, workflows, signal) => {
    const base = String(settings.comfyUrl || DEFAULT_COMFY_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    if (!base) throw new Error("未填写 ComfyUI 地址");

    const workflow =
      (workflows && workflows[settings.comfyWorkflow]) ||
      DEFAULT_COMFY_WORKFLOW;
    const resolution = parseResolution(task.size);
    const vars = {
      prompt: task.prompt,
      negative_prompt: settings.imageGenNegativePrompt || "",
      seed: task.seed,
      steps: Number(settings.imageGenSteps) || 40,
      scale: Number(settings.imageGenCfg) || 6,
      denoise: Number(settings.imageGenDenoise),
      sampler: settings.comfySampler || "euler",
      scheduler: settings.comfyScheduler || "normal",
      model: settings.comfyModel || "",
      width: resolution.width,
      height: resolution.height,
    };

    const filled = fillComfyWorkflow(workflow, vars);

    // 1. 提交 prompt
    const submitResponse = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: filled, client_id: crypto.randomUUID() }),
      signal,
    });
    if (!submitResponse.ok) {
      let json = null;
      try {
        json = await submitResponse.json();
      } catch (e) {
        /* 忽略解析失败 */
      }
      throw new Error(extractImageGenApiError(json, submitResponse.status));
    }
    const submitJson = await submitResponse.json();
    const promptId =
      submitJson && (submitJson.prompt_id || submitJson.promptId);
    if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");

    // 2. 轮询 history 直到有输出
    const timeoutMs = 120000;
    const startedAt = Date.now();
    const pollIntervalMs = 1500;
    // 等待首帧，保证 /history/{id} 至少有一次记录
    await new Promise((resolve) => setTimeout(resolve, 300));

    while (true) {
      if (signal && signal.aborted) throw new Error("生成已中止");
      if (Date.now() - startedAt > timeoutMs)
        throw new Error("ComfyUI 生成超时");

      const historyResponse = await fetch(`${base}/history/${promptId}`, {
        signal,
      });
      if (!historyResponse.ok) {
        throw new Error(`ComfyUI 查询历史失败: HTTP ${historyResponse.status}`);
      }
      const history = await historyResponse.json();
      const entry = history && history[promptId];

      if (entry) {
        const status = entry.status || {};
        if (status.completed === false) throw new Error("ComfyUI 生成任务失败");
        if (entry.error) {
          throw new Error(extractImageGenApiError(entry.error, "Comfy"));
        }
        const outputs = entry.outputs || {};
        const firstOutput = Object.values(outputs)[0];
        const image =
          firstOutput && firstOutput.images && firstOutput.images[0];
        if (image && image.filename) {
          const subfolder = encodeURIComponent(image.subfolder || "");
          const type = encodeURIComponent(image.type || "output");
          return `${base}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${subfolder}&type=${type}`;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };

  // ---- ComfyUI /object_info ----

  /**
   * 拉取 ComfyUI 模型/sampler/scheduler 列表
   *
   * @param {string} comfyUrl
   * @returns {Promise<{models: string[], samplers: string[], schedulers: string[]}>}
   */
  const fetchComfyObjectInfo = async (comfyUrl) => {
    const url = String(comfyUrl || "")
      .trim()
      .replace(/\/+$/, "");
    if (!url) throw new Error("请先填写 ComfyUI 地址");

    const response = await fetch(`${url}/object_info`);
    if (!response.ok)
      throw new Error(`无法连接 ComfyUI: HTTP ${response.status}`);
    const info = await response.json();

    const models =
      info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    const samplers = info?.KSampler?.input?.required?.sampler_name?.[0] || [];
    const schedulers = info?.KSampler?.input?.required?.scheduler?.[0] || [];

    if (!models.length)
      throw new Error("未找到可用模型（CheckpointLoaderSimple）");
    return { models, samplers, schedulers };
  };

  // ---- 服务端 workflow：LiteGraph 图格式 → ComfyUI API 格式 ----

  /**
   * 判断输入类型是否为 widget 型（值由 widgets_values 提供）。
   * 现代 ComfyUI 的 /object_info 类型表示：
   *  - 链接型：["MODEL",{tooltip}] / "MODEL" / ["MODEL"]
   *  - widget 型基元：["STRING",{...}] / ["INT",{...}] / ["FLOAT",{...}] / ["BOOLEAN",{...}] / ["SEED",{...}]
   *  - COMBO：新式为 [["选项1","选项2",...],{...}]（首元素是选项数组），旧式为 ["COMBO",[...]]
   * 链接型也带 tooltip 配置，故不能按"第二元素是对象"判断，需看首元素。
   */
  const WIDGET_PRIMITIVES = new Set([
    "STRING",
    "INT",
    "FLOAT",
    "COMBO",
    "BOOLEAN",
    "SEED",
  ]);
  const isWidgetInputType = (type) => {
    if (!Array.isArray(type) || type.length === 0) return false;
    const head = type[0];
    return Array.isArray(head) || WIDGET_PRIMITIVES.has(head);
  };

  /**
   * LiteGraph 图格式 → ComfyUI API prompt 格式
   * 参照 ComfyUI 前端 graphToPrompt：
   *  - 用 /object_info 判定 widget 型输入并按其顺序映射 widgets_values
   *  - PrimitiveNode 值内联为字符串
   *  - 必需链接型输入断连的残留节点直接跳过（避免 /prompt 校验失败）
   *
   * @param {object} graphData  { nodes, links, ... }
   * @param {object} objectInfo /object_info 响应
   * @returns {object} { nodeId: { class_type, inputs } }
   */
  const graphToPrompt = (graphData, objectInfo) => {
    const nodes = Array.isArray(graphData && graphData.nodes)
      ? graphData.nodes
      : [];
    const links = Array.isArray(graphData && graphData.links)
      ? graphData.links
      : [];
    const linkMap = new Map();
    for (const l of links) if (l && l[0] != null) linkMap.set(l[0], l);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const info = objectInfo || {};

    const out = {};
    for (const node of nodes) {
      if (!node || node.mode === 1) continue; // never execute 跳过
      const cls = info[node.type];
      // 无 object_info 定义的节点（PrimitiveNode/Note/Reroute 等前端专有节点）跳过
      if (!cls || !cls.input) continue;

      // 收集该 class 的全部输入定义（required 在前，保持顺序）
      const allDefs = [];
      if (cls && cls.input) {
        for (const name of Object.keys(cls.input.required || {}))
          allDefs.push([name, cls.input.required[name]]);
        for (const name of Object.keys(cls.input.optional || {}))
          allDefs.push([name, cls.input.optional[name]]);
      }
      const widgetNames = allDefs
        .filter(([, t]) => isWidgetInputType(t))
        .map(([name]) => name);

      const nodeInputs = {};
      for (const i of node.inputs || []) nodeInputs[i.name] = i;

      // 断连残留判定：required 链接型输入未连接 → 跳过该节点
      if (cls && cls.input && cls.input.required) {
        let orphan = false;
        for (const [name, t] of Object.entries(cls.input.required)) {
          if (isWidgetInputType(t)) continue; // widget 型无需链接
          const slot = nodeInputs[name];
          if (!slot || !slot.link) {
            orphan = true;
            break;
          }
        }
        if (orphan) continue;
      }

      const inputs = {};
      const wv = node.widgets_values || [];
      // widget 值按 object_info 顺序映射（已连接的输入不覆盖）
      widgetNames.forEach((name, idx) => {
        if (idx < wv.length && !(nodeInputs[name] && nodeInputs[name].link)) {
          inputs[name] = wv[idx];
        }
      });
      // 链接输入
      for (const i of node.inputs || []) {
        if (!i.link) continue;
        const link = linkMap.get(i.link);
        if (!link || link[1] == null) continue;
        const [, originId, originSlot] = link;
        const origin = nodeById.get(originId);
        if (origin && origin.type === "PrimitiveNode") {
          // PrimitiveNode（LiteGraph 常量）值内联，不引用节点
          const val = (origin.widgets_values || [])[0];
          if (val !== undefined) inputs[i.name] = val;
        } else {
          inputs[i.name] = [originId, originSlot];
        }
      }
      out[node.id] = { class_type: node.type, inputs };
    }

    // 清理指向已被过滤节点的引用（如断连残留节点的上游）
    const present = new Set(Object.keys(out));
    for (const p of Object.values(out)) {
      for (const [k, v] of Object.entries(p.inputs)) {
        if (Array.isArray(v) && !present.has(String(v[0]))) delete p.inputs[k];
      }
    }
    return out;
  };

  const K_SAMPLER_TYPES = new Set([
    "KSampler",
    "KSamplerAdvanced",
    "SamplerCustom",
    "SamplerCustomAdvanced",
  ]);

  /**
   * 在 API prompt 中注入动态占位符，使服务端 workflow 复用本应用参数
   *  - CheckpointLoaderSimple.ckpt_name → %model%
   *  - Empty*LatentImage 宽高 → %width%/%height%
   *  - KSampler* 采样参数 → %seed%/%steps%/%scale%/%sampler%/%scheduler%/%denoise%
   *  - CLIPTextEncode.text 按采样器正/负引用关系 → %prompt%/%negative_prompt%
   *
   * @param {object} apiPrompt graphToPrompt 产物
   * @returns {object} 注入后的 apiPrompt（原地修改）
   */
  const injectComfyPlaceholders = (apiPrompt) => {
    const encodeNodes = [];
    const samplers = [];
    for (const p of Object.values(apiPrompt)) {
      const cls = p && p.class_type;
      const inp = p && p.inputs;
      if (!cls || !inp) continue;
      if (cls === "CheckpointLoaderSimple") {
        if ("ckpt_name" in inp) inp.ckpt_name = "%model%";
      } else if (
        cls === "EmptyLatentImage" ||
        cls === "EmptySD3LatentImage" ||
        cls === "EmptyHDLatentImage"
      ) {
        if ("width" in inp) inp.width = "%width%";
        if ("height" in inp) inp.height = "%height%";
      } else if (K_SAMPLER_TYPES.has(cls)) {
        samplers.push(p);
        if ("seed" in inp) inp.seed = "%seed%";
        if ("steps" in inp) inp.steps = "%steps%";
        if ("cfg" in inp) inp.cfg = "%scale%";
        if ("sampler_name" in inp) inp.sampler_name = "%sampler%";
        if ("scheduler" in inp) inp.scheduler = "%scheduler%";
        if ("denoise" in inp) inp.denoise = "%denoise%";
      } else if (
        cls === "CLIPTextEncode" ||
        cls === "CLIPTextEncodeSDXL" ||
        cls === "CLIPTextEncodeFlux" ||
        cls === "CLIPTextEncodeAuraFlow"
      ) {
        encodeNodes.push(p);
      }
    }
    // 正负提示词按采样器引用判定（KSampler.positive / .negative 指向的 CLIPTextEncode）
    const posRefs = new Set();
    const negRefs = new Set();
    for (const s of samplers) {
      const pos = s.inputs && s.inputs.positive;
      const neg = s.inputs && s.inputs.negative;
      if (Array.isArray(pos)) posRefs.add(String(pos[0]));
      if (Array.isArray(neg)) negRefs.add(String(neg[0]));
    }
    for (const [id, p] of Object.entries(apiPrompt)) {
      if (!encodeNodes.includes(p)) continue;
      if (!("text" in p.inputs)) continue;
      if (posRefs.has(id)) p.inputs.text = "%prompt%";
      else if (negRefs.has(id)) p.inputs.text = "%negative_prompt%";
    }
    return apiPrompt;
  };

  /**
   * 拉取 ComfyUI 服务端保存的工作流（user/default/workflows/*.json）
   * 列目录 → 逐个读取 → 图格式转 API 格式 → 注入占位符
   *
   * @param {string} comfyUrl
   * @param {object} [objectInfo] 可选的原始 /object_info 响应（缺省时内部拉取）
   * @returns {Promise<Object<string, object>>} { 工作流名: apiPrompt }
   */
  const fetchComfyServerWorkflows = async (
    comfyUrl,
    objectInfo,
    { limit = 20 } = {},
  ) => {
    const url = String(comfyUrl || "")
      .trim()
      .replace(/\/+$/, "");
    if (!url) throw new Error("请先填写 ComfyUI 地址");

    // graphToPrompt 需要完整节点定义；若外部没给原始 /object_info 则内部拉取
    let info = objectInfo;
    if (!info || !info.CheckpointLoaderSimple) {
      try {
        const infoRes = await fetch(`${url}/object_info`);
        info = infoRes.ok ? await infoRes.json() : {};
      } catch (e) {
        info = {};
      }
    }

    const listRes = await fetch(`${url}/api/userdata?dir=workflows`);
    if (!listRes.ok) throw new Error(`无法列出工作流: HTTP ${listRes.status}`);
    let files = [];
    try {
      files = await listRes.json();
    } catch (e) {
      files = [];
    }
    if (!Array.isArray(files)) files = [];

    const result = {};
    let count = 0;
    for (const f of files) {
      if (!/\.json$/i.test(String(f || ""))) continue;
      if (count >= limit) break;
      count++;
      try {
        const encoded = encodeURIComponent(String(f));
        const fileRes = await fetch(
          `${url}/api/userdata/workflows%2F${encoded}`,
        );
        if (!fileRes.ok) continue;
        const data = await fileRes.json();
        // 用内部拉取的完整 object_info（外部可能未传 objectInfo，传空则节点全被跳过）
        const api = graphToPrompt(data, info);
        injectComfyPlaceholders(api);
        const name = String(f).replace(/\.json$/i, "");
        result[name] = api;
      } catch (e) {
        console.warn("解析服务端工作流失败:", f, e);
      }
    }
    return result;
  };

  // ---- 通用任务队列 ----

  /**
   * 创建生图任务队列：并发限制 + 超时 + 会话级 resolved 缓存
   *
   * @param {object} opts
   * @param {number} [opts.concurrency=3]    并发上限
   * @param {number} [opts.timeoutMs=120000] 单任务超时
   * @param {Function} [opts.generate]        (task, signal) => Promise<string>
   * @param {Function} [opts.onResolve]       (taskid, src) => void（app.js 注入 DOM 回调）
   * @param {Function} [opts.onReject]        (taskid, errMsg) => void
   */
  const createImageGenQueue = (opts = {}) => {
    const concurrency = Math.max(1, Number(opts.concurrency) || 3);
    const timeoutMs = Number(opts.timeoutMs) || 120000;
    const generate =
      opts.generate || (() => Promise.reject(new Error("未配置生图函数")));

    const queue = new Map(); // taskid -> task（排队中，有序）
    const active = new Map(); // taskid -> { controller }
    const resolved = new Map(); // taskid -> src（本会话完成缓存）

    const hasTask = (taskid) => queue.has(taskid) || active.has(taskid);

    const pump = () => {
      while (active.size < concurrency && queue.size > 0) {
        const firstKey = queue.keys().next().value;
        const task = queue.get(firstKey);
        queue.delete(firstKey);
        runTask(task);
      }
    };

    const runTask = (task) => {
      const controller = new AbortController();
      active.set(task.taskid, { controller });
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      generate(task, controller.signal)
        .then((src) => {
          resolved.set(task.taskid, src);
          if (opts.onResolve) opts.onResolve(task.taskid, src);
        })
        .catch((err) => {
          if (opts.onReject)
            opts.onReject(task.taskid, normalizeImageGenError(err));
        })
        .finally(() => {
          clearTimeout(timer);
          active.delete(task.taskid);
          pump();
        });
    };

    const enqueue = (task) => {
      if (!task || !task.taskid) return;
      if (resolved.has(task.taskid)) {
        if (opts.onResolve)
          opts.onResolve(task.taskid, resolved.get(task.taskid));
        return;
      }
      if (hasTask(task.taskid)) return; // 已在队列/运行中，幂等去重
      queue.set(task.taskid, task);
      pump();
    };

    const retry = (task) => {
      // 重试：清除旧的 resolved 记录，重新入队（app.js 已更新 seed）
      resolved.delete(task.taskid);
      enqueue(task);
    };

    const abort = (taskid) => {
      const running = active.get(taskid);
      if (running) {
        running.controller.abort();
        active.delete(taskid);
      }
      queue.delete(taskid);
    };

    return {
      enqueue,
      retry,
      abort,
      size: () => queue.size + active.size,
      hasTask,
      getResolved: (taskid) => resolved.get(taskid),
      getResolvedSize: () => resolved.size,
      onResolve: opts.onResolve,
      onReject: opts.onReject,
    };
  };

  // ---- 导出 ----

  window.RPHubImageGen = {
    DEFAULT_COMFY_BASE_URL,
    DEFAULT_STA1N_BASE_URL,
    DEFAULT_COMFY_WORKFLOW,
    TRANSPARENT_GIF,
    buildPlaceholderHtml,
    fillComfyWorkflow,
    parseResolution,
    normalizeOpenAISize,
    fetchComfyObjectInfo,
    fetchComfyServerWorkflows,
    graphToPrompt,
    injectComfyPlaceholders,
    normalizeImageGenError,
    createImageGenQueue,
    generateImageWithSta1n,
    generateImageWithOpenAI,
    generateImageWithComfy,
  };
})();
