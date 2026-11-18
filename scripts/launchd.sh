#!/bin/zsh
# 用 launchd 让中转开机自启、退出后自动拉起。
#   scripts/launchd.sh install    写入 ~/Library/LaunchAgents/com.cc-im-bridge.relay.plist 并启动
#   scripts/launchd.sh uninstall  停止并移除
#   scripts/launchd.sh status     查看是否在运行
set -eu
LABEL=com.cc-im-bridge.relay
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
REPO=${0:A:h:h}
DATA=${CC_IM_HOME:-$HOME/.cc-im-bridge}
NODE=${CC_IM_NODE:-$(command -v node)}
DOMAIN=gui/$(id -u)

case ${1:-} in
install)
  if [[ ! -x $NODE ]]; then
    echo "找不到 node，可用 CC_IM_NODE=/path/to/node 指定" >&2
    exit 1
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$DATA"
  chmod 700 "$DATA"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/relay/relay.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>CC_IM_HOME</key><string>$DATA</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- 配置有误时进程会立即退出；限制拉起频率，避免刷日志。 -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA/relay.log</string>
  <key>StandardErrorPath</key><string>$DATA/relay.log</string>
</dict>
</plist>
EOF
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout 是异步的：旧实例没退干净时 bootstrap 会报 5（Input/output error），等它消失再加载。
  for _ in {1..50}; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.2
  done
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "已安装并启动：$PLIST"
  echo "日志：$DATA/relay.log"
  ;;
uninstall)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  if [[ -f $PLIST ]]; then
    mv "$PLIST" "$HOME/.Trash/$LABEL.plist.$(date +%Y%m%d%H%M%S)"
    echo "已停止，配置移到废纸篓"
  else
    echo "未安装"
  fi
  ;;
status)
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s+(state|pid|last exit code) ='
  else
    echo "未在运行"
  fi
  ;;
*)
  echo "用法：$0 install | uninstall | status" >&2
  exit 2
  ;;
esac
