# -*- coding: utf-8 -*-
"""
server.py — RP-Hub 数据服务器化后端（零依赖，仅 Python 标准库）

职责：
  1. KV 数据 API（SQLite 持久化，替代浏览器 IndexedDB，跨设备共享）
  2. 聊天生成图片落盘（images/generated/）与读取
  3. ComfyUI 反向代理（/comfy_api/* → http://127.0.0.1:8188/*），手机免配置免 CORS
  4. 静态文件服务（替代 python3 -m http.server，自动处理 / → index.html）

启动：python3 server.py
参数：--port 8000 --bind 0.0.0.0 --db rp_hub_data.db
"""
import argparse
import base64
import json
import mimetypes
import os
import re
import socket
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# ---- 常量 ----
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGES_DIR = os.path.join(ROOT_DIR, "images")
CATEGORIES = ("generated", "library", "refs")  # 图片分类白名单（refs=角色卡参考图）
COMFY_TARGET = "http://127.0.0.1:8188"
COMFY_PROXY_PREFIX = "/comfy_api"
MAX_BODY_BYTES = 64 * 1024 * 1024  # PUT/POST body 上限 64MB
PROXY_TIMEOUT = 120  # ComfyUI 单次请求超时（秒）

# 串行化 SQLite 访问（ThreadingHTTPServer 并发下的写锁）
_db_lock = threading.Lock()
DB_PATH = os.path.join(ROOT_DIR, "rp_hub_data.db")

# 图片 MIME → 扩展名映射（base64 data URL / Content-Type 解析用）
IMAGE_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
}


# ---- SQLite 基础 ----
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db():
    """建表（幂等）。images 表为将来图库清理服务预留。"""
    with _db_lock:
        conn = get_conn()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS kv (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS images (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT NOT NULL,
                    category TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                """
            )
            conn.commit()
        finally:
            conn.close()


def kv_get_raw(key):
    """返回存储的原文（JSON 文本），不存在返回 None。"""
    with _db_lock:
        conn = get_conn()
        try:
            row = conn.execute(
                "SELECT value FROM kv WHERE key=?", (key,)
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()


def kv_put(key, value):
    """写入或覆盖（last-write-wins，符合无认证局域网场景）。"""
    with _db_lock:
        conn = get_conn()
        try:
            conn.execute(
                "INSERT INTO kv(key, value, updated_at) VALUES(?,?,datetime('now')) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')",
                (key, value),
            )
            conn.commit()
        finally:
            conn.close()


def kv_delete(key):
    with _db_lock:
        conn = get_conn()
        try:
            conn.execute("DELETE FROM kv WHERE key=?", (key,))
            conn.commit()
        finally:
            conn.close()


def kv_list():
    """全量 KV 列表，value 已尝试 JSON.parse（供前端一次性预热缓存）。"""
    with _db_lock:
        conn = get_conn()
        try:
            rows = conn.execute(
                "SELECT key, value FROM kv ORDER BY key"
            ).fetchall()
        finally:
            conn.close()
    keys = []
    for key, value in rows:
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            parsed = value  # 容忍非 JSON 残留
        keys.append({"key": key, "value": parsed})
    return {"keys": keys, "count": len(keys)}


# ---- 图片处理 ----
def sniff_image_ext(data):
    """按魔数嗅探图片扩展名（不含点），兜底 .png。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"avif", b"avis"):
        return ".avif"
    return ".png"


def handle_images_post(payload):
    """
    POST /api/images 逻辑。
    payload: { url }（服务器抓取）或 { data }（base64 data URL），可选 category
    返回 (status, json_obj)。
    """
    category = payload.get("category") or "generated"
    if category not in CATEGORIES:
        return 400, {"error": "category 必须是 %s" % "/".join(CATEGORIES)}

    raw = None
    ext = None

    if payload.get("data"):
        m = re.match(r"^data:([^;,]+)?(;base64)?,", payload["data"])
        if not m:
            return 400, {"error": "data 必须是 base64 data URL"}
        mime = (m.group(1) or "").lower()
        b64 = payload["data"][m.end():]
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return 400, {"error": "data base64 解码失败"}
        ext = IMAGE_EXT_BY_MIME.get(mime) or sniff_image_ext(raw)
    elif payload.get("url"):
        url = str(payload["url"]).strip()
        # 浏览器同源 /comfy_api/* 地址 → 改写为本机 ComfyUI，服务器直接抓取
        if url.startswith(COMFY_PROXY_PREFIX + "/"):
            url = COMFY_TARGET + url[len(COMFY_PROXY_PREFIX):]
        elif url.startswith("/images/"):
            # 已是本服务器图片，原样返回
            return 200, {"url": url}
        elif not url.startswith(("http://", "https://")):
            return 400, {"error": "url 必须是 http(s) 或 /comfy_api 地址"}
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "RP-Hub-server/1.0"}
            )
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as resp:
                raw = resp.read()
                ctype = (
                    (resp.headers.get("Content-Type") or "")
                    .split(";")[0]
                    .strip()
                    .lower()
                )
            ext = IMAGE_EXT_BY_MIME.get(ctype) or sniff_image_ext(raw)
        except Exception as e:
            return 502, {"error": "抓取图片失败: %s" % e}
    else:
        return 400, {"error": "body 需要 url 或 data 字段"}

    if not raw:
        return 400, {"error": "未获取到图片内容"}

    filename = str(uuid.uuid4()) + (ext or ".png")
    target_dir = os.path.join(IMAGES_DIR, category)
    os.makedirs(target_dir, exist_ok=True)
    with open(os.path.join(target_dir, filename), "wb") as f:
        f.write(raw)

    # 记录到 images 表（为将来图库清理服务）
    try:
        with _db_lock:
            conn = get_conn()
            try:
                conn.execute(
                    "INSERT INTO images(filename, category) VALUES(?,?)",
                    (filename, category),
                )
                conn.commit()
            finally:
                conn.close()
    except Exception:
        pass

    return 200, {"url": "/images/%s/%s" % (category, filename)}


def handle_image_delete(path):
    """
    DELETE /api/images/<category>/<file> 逻辑。
    路径校验防穿越（与 _serve_image 一致），删除磁盘文件并同步清理 images 表记录。
    返回 (status, json_obj)。
    """
    rest = path[len("/api/images/"):]
    parts = rest.split("/")
    if len(parts) != 2:
        return 400, {"error": "路径格式应为 /api/images/<category>/<file>"}
    category, filename = (
        urllib.parse.unquote(parts[0]),
        urllib.parse.unquote(parts[1]),
    )
    if category not in CATEGORIES:
        return 400, {"error": "category 必须是 %s" % "/".join(CATEGORIES)}
    if not re.fullmatch(r"[A-Za-z0-9._-]+", filename):
        return 400, {"error": "非法文件名"}
    target_dir = os.path.realpath(os.path.join(IMAGES_DIR, category))
    filepath = os.path.realpath(os.path.join(target_dir, filename))
    if not filepath.startswith(target_dir + os.sep):
        return 400, {"error": "非法路径"}
    if not os.path.isfile(filepath):
        return 404, {"error": "图片不存在"}
    try:
        os.remove(filepath)
    except OSError as e:
        return 500, {"error": "删除失败: %s" % e}
    # 同步清理 images 表记录（幂等，为图库清理服务预留）
    try:
        with _db_lock:
            conn = get_conn()
            try:
                conn.execute(
                    "DELETE FROM images WHERE filename=? AND category=?",
                    (filename, category),
                )
                conn.commit()
            finally:
                conn.close()
    except Exception:
        pass
    return 200, {"ok": True, "url": "/images/%s/%s" % (category, filename)}


# ---- HTTP Handler ----
class RPHandler(SimpleHTTPRequestHandler):
    server_version = "RP-Hub/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    # -- 工具方法 --
    def _path_no_query(self):
        return self.path.split("?", 1)[0]

    def _is_blocked(self, path):
        """屏蔽敏感文件（.git / 数据库 / 服务端脚本）。"""
        if path.startswith("/.git"):
            return True
        if "rp_hub_data.db" in path or path in ("/server.py", "/__pycache__"):
            return True
        return False

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _kv_key_from_path(self, path):
        rest = path[len("/api/kv/"):]
        if not rest or "/" in rest:
            return None
        try:
            return urllib.parse.unquote(rest)
        except Exception:
            return rest

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return None, 413
        return (self.rfile.read(length) if length else b""), None

    def _serve_image(self, path):
        # path 形如 /images/<category>/<file>，路径校验防穿越
        parts = path.split("/")
        if len(parts) != 4:
            self.send_error(404, "Not Found")
            return
        _, _, category, filename = parts
        if category not in CATEGORIES:
            self.send_error(404, "Not Found")
            return
        if not re.fullmatch(r"[A-Za-z0-9._-]+", filename):
            self.send_error(404, "Not Found")
            return
        target_dir = os.path.realpath(os.path.join(IMAGES_DIR, category))
        filepath = os.path.realpath(os.path.join(target_dir, filename))
        if not filepath.startswith(target_dir + os.sep) or not os.path.isfile(
            filepath
        ):
            self.send_error(404, "Not Found")
            return
        ctype = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        with open(filepath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def _proxy_comfy(self, method):
        """/comfy_api/* 反向代理到本机 ComfyUI，method/body/状态码/二进制透传。"""
        rest = self.path[len(COMFY_PROXY_PREFIX):]
        if not rest.startswith("/"):
            rest = "/" + rest
        body, _ = self._read_body()
        headers = {}
        for h in ("Content-Type", "Accept"):
            v = self.headers.get(h)
            if v:
                headers[h] = v
        req = urllib.request.Request(
            COMFY_TARGET + rest, data=body, method=method, headers=headers
        )
        status = 502
        data = b""
        ctype = "text/plain; charset=utf-8"
        try:
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as resp:
                data = resp.read()
                status = resp.status
                ctype = resp.headers.get("Content-Type") or ctype
        except urllib.error.HTTPError as e:
            data = e.read()
            status = e.code
            ctype = (e.headers.get("Content-Type") if e.headers else None) or ctype
        except Exception as e:
            self.send_error(502, "ComfyUI proxy failed: %s" % e)
            return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if data:
            self.wfile.write(data)

    # -- 方法分发 --
    def do_GET(self):
        path = self._path_no_query()
        if self._is_blocked(path):
            self.send_error(404, "Not Found")
            return
        if path == "/api/health":
            self._send_json(200, {"ok": True})
            return
        if path == "/api/kv/list":
            self._send_json(200, kv_list())
            return
        if path.startswith("/api/kv/"):
            key = self._kv_key_from_path(path)
            if key is None:
                self.send_error(400, "Bad Request")
                return
            raw = kv_get_raw(key)
            if raw is None:
                # 缺失键返回 200 + null（语义：无该数据），
                # 避免首次加载时大量不存在键在浏览器控制台刷 404 噪音
                self._send_json(200, None)
                return
            body = raw.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/images/"):
            self._serve_image(path)
            return
        if path == COMFY_PROXY_PREFIX or path.startswith(COMFY_PROXY_PREFIX + "/"):
            self._proxy_comfy("GET")
            return
        super().do_GET()

    def do_POST(self):
        path = self._path_no_query()
        if path == "/api/images":
            body, err = self._read_body()
            if err:
                self.send_error(err, "Payload Too Large")
                return
            assert body is not None  # err 非空时已 return，此处必然有 body
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                self.send_error(400, "Bad Request")
                return
            if not isinstance(payload, dict):
                self.send_error(400, "Bad Request")
                return
            status, result = handle_images_post(payload)
            self._send_json(status, result)
            return
        if path == COMFY_PROXY_PREFIX or path.startswith(COMFY_PROXY_PREFIX + "/"):
            self._proxy_comfy("POST")
            return
        self.send_error(405, "Method Not Allowed")

    def do_PUT(self):
        path = self._path_no_query()
        if path.startswith("/api/kv/"):
            key = self._kv_key_from_path(path)
            if key is None:
                self.send_error(400, "Bad Request")
                return
            body, err = self._read_body()
            if err:
                self.send_error(err, "Payload Too Large")
                return
            assert body is not None  # err 非空时已 return，此处必然有 body
            try:
                value = body.decode("utf-8")
            except UnicodeDecodeError:
                self.send_error(400, "Bad Request")
                return
            # 校验必须是合法 JSON 文本（前端 kvSet 总是 JSON.stringify 后发送）
            try:
                json.loads(value)
            except (ValueError, TypeError):
                self.send_error(400, "Bad Request: value must be valid JSON")
                return
            kv_put(key, value)
            self._send_json(200, {"ok": True})
            return
        self.send_error(405, "Method Not Allowed")

    def do_DELETE(self):
        path = self._path_no_query()
        if path.startswith("/api/kv/"):
            key = self._kv_key_from_path(path)
            if key is None:
                self.send_error(400, "Bad Request")
                return
            kv_delete(key)
            self._send_json(200, {"ok": True})
            return
        if path.startswith("/api/images/"):
            status, result = handle_image_delete(path)
            self._send_json(status, result)
            return
        self.send_error(405, "Method Not Allowed")

    def log_message(self, format, *args):
        # 精简访问日志（丢弃静态资源噪音）
        path = self._path_no_query()
        if path.startswith("/api/") or path.startswith("/images/") or path.startswith("/comfy_api"):
            super().log_message(format, *args)


# ---- 启动 ----
def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser(description="RP-Hub 数据服务器")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--db", default="rp_hub_data.db")
    args = parser.parse_args()

    global DB_PATH
    DB_PATH = os.path.join(ROOT_DIR, args.db)

    os.makedirs(IMAGES_DIR, exist_ok=True)
    for cat in CATEGORIES:
        os.makedirs(os.path.join(IMAGES_DIR, cat), exist_ok=True)
    init_db()

    port = args.port
    lan_ip = get_lan_ip()
    print("=" * 60)
    print("  RP-Hub 服务器已启动")
    print("  本机访问:   http://127.0.0.1:%d" % port)
    print("  局域网访问: http://%s:%d  (手机/其他设备)" % (lan_ip, port))
    firewall_hints = {
        "posix": [
            "  ufw allow %d/tcp                    # Ubuntu/Debian" % port,
            "  sudo firewall-cmd --add-port=%d/tcp # CentOS" % port,
        ],
        "nt": [
            "  netsh advfirewall firewall add rule name=RP-Hub "
            "dir=in action=allow protocol=TCP localport=%d" % port,
        ],
    }
    for line in firewall_hints.get(os.name, []):
        print("  若其他设备无法访问，请放行端口:")
        print(line)
    print("  无认证模式：仅限家庭局域网使用，请勿暴露公网")
    print("=" * 60)

    server = ThreadingHTTPServer((args.bind, port), RPHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
