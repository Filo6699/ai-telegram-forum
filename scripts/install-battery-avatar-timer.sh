#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
node_bin=$(command -v node)
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

if [[ "$repo" == *[[:space:]]* || "$node_bin" == *[[:space:]]* ]]; then
  echo "Repository and node paths must not contain whitespace" >&2
  exit 1
fi

cat > "$unit_dir/ai-telegram-forum-battery-avatar.service" <<EOF
[Unit]
Description=Update AI Telegram Forum avatar from battery level
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$repo
ExecStart=$node_bin $repo/scripts/update-battery-avatar.mjs
TimeoutStartSec=45s
EOF

cat > "$unit_dir/ai-telegram-forum-battery-avatar.timer" <<'EOF'
[Unit]
Description=Check AI Telegram Forum battery avatar every five minutes

[Timer]
OnStartupSec=30s
OnUnitActiveSec=5min
AccuracySec=30s
Unit=ai-telegram-forum-battery-avatar.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now ai-telegram-forum-battery-avatar.timer
systemctl --user start ai-telegram-forum-battery-avatar.service
