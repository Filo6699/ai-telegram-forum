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

systemctl --user disable --now ai-telegram-forum-battery-avatar.timer 2>/dev/null || true
rm -f "$unit_dir/ai-telegram-forum-battery-avatar.service" \
      "$unit_dir/ai-telegram-forum-battery-avatar.timer"

cat > "$unit_dir/ailillu-watchbot-battery-avatar.service" <<EOF
[Unit]
Description=Update @claude_filo_watch_bot avatar from battery level
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$repo
ExecStart=$node_bin $repo/scripts/update-battery-avatar.mjs
TimeoutStartSec=45s
EOF

cat > "$unit_dir/ailillu-watchbot-battery-avatar.timer" <<'EOF'
[Unit]
Description=Check watchdog bot battery avatar every five minutes

[Timer]
OnStartupSec=30s
OnUnitActiveSec=5min
AccuracySec=30s
Unit=ailillu-watchbot-battery-avatar.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now ailillu-watchbot-battery-avatar.timer
systemctl --user start ailillu-watchbot-battery-avatar.service
