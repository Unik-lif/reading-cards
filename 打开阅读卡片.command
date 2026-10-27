#!/bin/zsh
# Run by the user: keep this Terminal window open while using the reading room.
APP_DIR="${0:A:h}"
NODE_BIN="$(command -v node 2>/dev/null)"
if [[ -z "$NODE_BIN" && -x /opt/homebrew/bin/node ]]; then NODE_BIN=/opt/homebrew/bin/node; fi
if [[ -z "$NODE_BIN" && -x /usr/local/bin/node ]]; then NODE_BIN=/usr/local/bin/node; fi
if [[ -z "$NODE_BIN" ]]; then
  print '需要 Node.js 22 或更高版本。安装后再次双击此文件。'
  read -k 1 '?按任意键关闭…'
  exit 1
fi
if /usr/bin/curl --silent --max-time 2 http://127.0.0.1:4317/api/info | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).app==="reading-cards"?0:1)}catch{process.exit(1)}})'; then
  /usr/bin/open http://127.0.0.1:4317
  print '阅读卡片已在另一个窗口运行。这个窗口可以关闭。'
  exit 0
fi
"$NODE_BIN" "$APP_DIR/server.mjs" &
READING_PID=$!
trap 'kill "$READING_PID" 2>/dev/null' EXIT INT TERM
for attempt in {1..30}; do
  if /usr/bin/curl --silent --fail http://127.0.0.1:4317/api/info >/dev/null; then
    /usr/bin/open http://127.0.0.1:4317
    print '\n保留此窗口即可继续自动保存。按 Control+C 停止。'
    wait "$READING_PID"
    exit $?
  fi
  if ! kill -0 "$READING_PID" 2>/dev/null; then break; fi
  sleep 0.2
done
print '启动失败。请查看上方提示；可能是 4317 端口被其他程序占用。'
read -k 1 '?按任意键关闭…'
exit 1
