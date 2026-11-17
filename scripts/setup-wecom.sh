#!/bin/zsh
# 写入企微智能机器人配置 ~/.cc-im-bridge/wecom.json（权限 600）。Secret 输入时不回显，也不经过任何日志。
set -eu
DIR=${CC_IM_HOME:-$HOME/.cc-im-bridge}
FILE=$DIR/wecom.json
mkdir -p "$DIR" && chmod 700 "$DIR"

printf 'Bot ID: '
read -r BOT_ID
printf 'Secret（输入不显示）: '
read -rs SECRET
echo
printf '你的企微 userid（不知道就直接回车，之后给机器人发消息会告诉你）: '
read -r USER_ID

if [[ -z $BOT_ID || -z $SECRET ]]; then
  echo 'Bot ID 和 Secret 都不能为空，未写入' >&2
  exit 1
fi

umask 077
BOT_ID=$BOT_ID SECRET=$SECRET USER_ID=$USER_ID FILE=$FILE node -e '
const fs = require("node:fs")
const { BOT_ID, SECRET, USER_ID, FILE } = process.env
const config = { botId: BOT_ID.trim(), secret: SECRET.trim(), allowUsers: USER_ID.trim() ? [USER_ID.trim()] : [] }
fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
fs.chmodSync(FILE, 0o600)
'
echo "已写入 $FILE（权限 600）。重启中转后生效。"
