#!/bin/bash
# Context Lens 服务守护脚本 — 自动重启 proxy (4040) + analysis (4041)
#
# 用法:
#   ./start-services.sh         # 启动
#   ./start-services.sh stop    # 停止
#   ./start-services.sh status  # 状态
#   ./start-services.sh logs    # 看日志

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/logs"
mkdir -p "$LOG"

# ─── 环境变量（在此设置默认值） ───
export UPSTREAM_ANTHROPIC_URL="${UPSTREAM_ANTHROPIC_URL:-https://crs.ai-data.link/api}"
export CONTEXT_LENS_BIND_HOST="${CONTEXT_LENS_BIND_HOST:-0.0.0.0}"

start_daemon() {
  local name=$1 cmd=$2 logfile="$LOG/$name.log"

  # 检查是否已在运行
  if lsof -ti :${3} >/dev/null 2>&1; then
    echo "  $name: already running on port $3"
    return
  fi

  # 写一个独立的守护脚本到 /tmp，用 nohup 运行
  local daemon="/tmp/cl-$name-daemon.sh"
  cat > "$daemon" <<DAEMON
#!/bin/bash
cd "$DIR"
while true; do
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Starting $name..." >> "$logfile"
  $cmd >> "$logfile" 2>&1
  code=\$?
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] $name exited (code: \$code), restarting in 3s..." >> "$logfile"
  sleep 3
done
DAEMON
  chmod +x "$daemon"
  nohup "$daemon" > /dev/null 2>&1 &
  echo "  $name: started (daemon PID $$!) → port $3, log: $logfile"
}

case "${1:-start}" in
  start)
    echo "Starting Context Lens services..."
    start_daemon proxy  "node dist/proxy/server.js"    4040
    start_daemon analysis "node dist/analysis/server.js" 4041
    sleep 2
    echo ""
    echo "Status:"
    for p in 4040 4041; do
      pid=$(lsof -ti :$p 2>/dev/null | head -1)
      [ -n "$pid" ] && echo "  port $p: RUNNING (PID $pid)" || echo "  port $p: NOT YET (check logs)"
    done
    ;;

  stop)
    echo "Stopping Context Lens services..."
    # 先杀 daemon 脚本
    pkill -f "cl-proxy-daemon" 2>/dev/null
    pkill -f "cl-analysis-daemon" 2>/dev/null
    # 再杀端口上的 node 进程
    lsof -ti :4040 | xargs kill 2>/dev/null
    lsof -ti :4041 | xargs kill 2>/dev/null
    sleep 1
    # 确认
    for p in 4040 4041; do
      if lsof -ti :$p >/dev/null 2>&1; then
        echo "  port $p: still running, force killing..."
        lsof -ti :$p | xargs kill -9 2>/dev/null
      else
        echo "  port $p: stopped"
      fi
    done
    ;;

  restart)
    $0 stop
    sleep 2
    $0 start
    ;;

  status)
    echo "Context Lens services:"
    for p in 4040 4041; do
      pid=$(lsof -ti :$p 2>/dev/null | head -1)
      [ -n "$pid" ] && echo "  port $p: RUNNING (PID $pid)" || echo "  port $p: STOPPED"
    done
    ;;

  logs)
    tail -f "$LOG/proxy.log" "$LOG/analysis.log"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    ;;
esac
