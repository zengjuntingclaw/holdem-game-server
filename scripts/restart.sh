#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-6565}"
NODE_ENV="${NODE_ENV:-production}"
PID_FILE="${PID_FILE:-server.pid}"
LOG_FILE="${LOG_FILE:-server.log}"

if ! command -v node >/dev/null 2>&1; then
  echo "node 未安装或不在 PATH 中。请先安装 Node.js 22.5 或更高版本。"
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    echo "停止旧服务 pid=$OLD_PID"
    kill "$OLD_PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$OLD_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$OLD_PID" >/dev/null 2>&1; then
      kill -9 "$OLD_PID" >/dev/null 2>&1 || true
    fi
  fi
fi

echo "启动服务 HOST=$HOST PORT=$PORT"
HOST="$HOST" PORT="$PORT" NODE_ENV="$NODE_ENV" nohup node server.js > "$LOG_FILE" 2>&1 &
NEW_PID="$!"
echo "$NEW_PID" > "$PID_FILE"
sleep 0.8

if kill -0 "$NEW_PID" >/dev/null 2>&1; then
  echo "已启动 pid=$NEW_PID"
  echo "访问地址：http://$HOST:$PORT"
  echo "日志：$ROOT_DIR/$LOG_FILE"
else
  echo "启动失败，请查看日志：$ROOT_DIR/$LOG_FILE"
  tail -n 80 "$LOG_FILE" || true
  exit 1
fi
