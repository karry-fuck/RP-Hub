#!/usr/bin/env bash
# -*- coding: utf-8 -*-
# start.sh — 一键启动 RP-Hub 数据服务器 + ComfyUI（同机生图）
#
# 用法：
#   ./start.sh                # 同时启动 RP-Hub 与 ComfyUI
#   START_COMFY=0 ./start.sh  # 仅启动 RP-Hub（不启动 ComfyUI）
#
# 可覆盖的环境变量：
#   RP_HUB_PORT  RP-Hub 端口，默认 8000
#   COMFY_DIR    ComfyUI 项目目录，默认 ~/Ai/ComfyUI
#   START_COMFY  是否启动 ComfyUI（1=是 0=否），默认 1
#
# 行为：
#   - 端口已被占用时跳过对应启动（幂等，可重复执行）
#   - 日志写入 logs/ 目录（rphub.log / comfyui.log）
#   - Ctrl+C 优雅停止全部进程
set -euo pipefail

# ---- 配置 ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMFY_DIR="${COMFY_DIR:-$HOME/Ai/ComfyUI}"
RP_HUB_PORT="${RP_HUB_PORT:-8000}"
START_COMFY="${START_COMFY:-1}"
COMFY_PORT=8188
LOG_DIR="$SCRIPT_DIR/logs"
RP_LOG="$LOG_DIR/rphub.log"
COMFY_LOG="$LOG_DIR/comfyui.log"
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
LAN_IP="${LAN_IP:-127.0.0.1}"
RP_HUB_PID=""
COMFY_PID=""

mkdir -p "$LOG_DIR"

# 端口是否已监听（精确匹配 Local Address 列的 :port 结尾）
port_in_use() {
  local port="$1"
  ss -tln 2>/dev/null | awk -v p=":$port" 'NR>1 && $4 ~ p"$" { found=1 } END { exit !found }'
}

# ---- 启动 RP-Hub ----
if port_in_use "$RP_HUB_PORT"; then
  echo "[提示] RP-Hub 已在端口 $RP_HUB_PORT 运行，跳过启动"
else
  echo "[启动] RP-Hub 数据服务器 → http://127.0.0.1:$RP_HUB_PORT"
  (
    cd "$SCRIPT_DIR"
    exec python3 server.py --port "$RP_HUB_PORT"
  ) >>"$RP_LOG" 2>&1 &
  RP_HUB_PID=$!
fi

# ---- 启动 ComfyUI ----
if [[ "$START_COMFY" == "1" ]]; then
  if port_in_use "$COMFY_PORT"; then
    echo "[提示] ComfyUI 已在端口 $COMFY_PORT 运行，跳过启动"
  else
    if [[ ! -d "$COMFY_DIR/.venv" ]]; then
      echo "[错误] 未找到 ComfyUI 虚拟环境：$COMFY_DIR/.venv" >&2
      echo "       可用环境变量 COMFY_DIR 指定正确路径" >&2
      exit 1
    fi
    echo "[启动] ComfyUI → http://127.0.0.1:$COMFY_PORT"
    (
      cd "$COMFY_DIR"
      source .venv/bin/activate
      exec uv run main.py --enable-manager --enable-cors-header
    ) >>"$COMFY_LOG" 2>&1 &
    COMFY_PID=$!
  fi
fi

# ---- 等待服务就绪 ----
wait_ready() {
  local url="$1" name="$2" pid="${3:-}" logfile="$4"
  echo "[等待] $name 就绪..."
  for _ in $(seq 1 120); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "[错误] $name 进程已退出，日志尾部：" >&2
      tail -n 20 "$logfile" >&2 || true
      exit 1
    fi
    if curl -sf --max-time 2 "$url" >/dev/null 2>&1; then
      echo "[就绪] $name ✓"
      return 0
    fi
    sleep 1
  done
  echo "[错误] $name 就绪超时（$url），日志：$logfile" >&2
  exit 1
}

wait_ready "http://127.0.0.1:$RP_HUB_PORT/api/health" "RP-Hub" "$RP_HUB_PID" "$RP_LOG"
if [[ "$START_COMFY" == "1" ]]; then
  wait_ready "http://127.0.0.1:$COMFY_PORT/" "ComfyUI" "$COMFY_PID" "$COMFY_LOG"
fi

# ---- 优雅关闭（递归杀进程树） ----
kill_tree() {
  local pid="$1"
  local children
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  if [[ -n "$children" ]]; then
    for c in $children; do kill_tree "$c"; done
  fi
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "[关闭] 停止服务..."
  if [[ -n "$RP_HUB_PID" ]]; then kill_tree "$RP_HUB_PID"; fi
  if [[ -n "$COMFY_PID" ]]; then kill_tree "$COMFY_PID"; fi
  wait 2>/dev/null || true
  echo "[完成] 已全部停止"
}
trap cleanup INT TERM EXIT

echo ""
echo "=============================="
echo "  RP-Hub 已就绪"
echo "  本机访问:   http://127.0.0.1:$RP_HUB_PORT"
echo "  局域网访问: http://$LAN_IP:$RP_HUB_PORT"
echo "  ComfyUI:    http://127.0.0.1:$COMFY_PORT"
echo "  日志:       $LOG_DIR/"
echo "  Ctrl+C 停止全部服务"
echo "=============================="

# 前台等待，保持脚本运行直到 Ctrl+C
wait
