/**
 * server-api.js — RP-Hub 服务器 API 客户端（被 app.js 与角色卡工坊共用）
 *
 * 挂载到 window.RPHubServerApi。所有请求与页面同源（server.py 提供），无需 CORS。
 * 依赖：无
 * 被引用：assets/js/app.js、character/index.html
 */
(function () {
  "use strict";

  const kvUrl = (key) => "/api/kv/" + encodeURIComponent(key);

  /**
   * 读取 KV 值。key 不存在返回 undefined（与"无数据用默认值"的降级语义一致）。
   * 服务器缺失键返回 200 + null（兼容旧 404）。
   * @param {string} key
   * @returns {Promise<*>}
   */
  const kvGet = async (key) => {
    const res = await fetch(kvUrl(key));
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`kvGet ${key} 失败: HTTP ${res.status}`);
    const value = await res.json();
    return value === null || value === undefined ? undefined : value;
  };

  /**
   * 写入 KV 值（内部 JSON.stringify 后以 PUT 原文发送，服务器存 JSON 文本）。
   * @param {string} key
   * @param {*} value
   * @returns {Promise<{ok:boolean}>}
   */
  const kvSet = async (key, value) => {
    const res = await fetch(kvUrl(key), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`kvSet ${key} 失败: HTTP ${res.status}`);
    return res.json();
  };

  /**
   * 删除 KV 值（不存在也视为成功）。
   * @param {string} key
   * @returns {Promise<{ok:boolean}>}
   */
  const kvDelete = async (key) => {
    const res = await fetch(kvUrl(key), { method: "DELETE" });
    if (!res.ok) throw new Error(`kvDelete ${key} 失败: HTTP ${res.status}`);
    return res.json();
  };

  /**
   * 全量 KV 列表（loadData 批量预热缓存 + 存储统计用）。
   * @returns {Promise<{keys:Array<{key:string,value:*}> , count:number}>}
   */
  const kvList = async () => {
    const res = await fetch("/api/kv/list");
    if (!res.ok) throw new Error(`kvList 失败: HTTP ${res.status}`);
    return res.json();
  };

  /**
   * 保存图片到服务器。
   * @param {{url?:string, data?:string, category?:string}} payload
   *        url  服务器抓取（含 /comfy_api/... 改写为本机 ComfyUI）
   *        data base64 data URL
   *        category 默认 "generated"，白名单 {generated, library}
   * @returns {Promise<{url:string}>} 形如 /images/generated/<uuid>.png
   */
  const imageSave = async (payload) => {
    const res = await fetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error || "";
      } catch (e) {
        /* 忽略解析失败 */
      }
      throw new Error(`图片保存失败: HTTP ${res.status} ${detail}`);
    }
    return res.json();
  };

  /**
   * 删除服务器图片文件（清理对话等场景回收磁盘）。
   * @param {string} url 形如 /images/generated/<uuid>.png（msg.images 存的值）；
   *                      非本服务器图片地址（外部直链/data URL）无磁盘文件，静默跳过
   * @returns {Promise<{ok:boolean}>}
   */
  const imageDelete = async (url) => {
    const m = String(url || "").match(
      /^\/images\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/,
    );
    if (!m) return { ok: false };
    const res = await fetch(`/api/images/${m[1]}/${m[2]}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error || "";
      } catch (e) {
        /* 忽略解析失败 */
      }
      throw new Error(`图片删除失败: HTTP ${res.status} ${detail}`);
    }
    return res.json();
  };

  window.RPHubServerApi = {
    kvGet,
    kvSet,
    kvDelete,
    kvList,
    imageSave,
    imageDelete,
  };
})();
