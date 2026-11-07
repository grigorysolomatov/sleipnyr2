#!/usr/bin/env bash
# Run a release as a throwaway service next to the live one: same user and
# sandbox, a spare port, a copy of the live data and no agents (so nothing is
# sent anywhere and the live data is never touched).
#   deploy/preview.sh start <release-dir> [port]   (default port 8189)
#   deploy/preview.sh stop
# deploy.sh smoke-tests every release this way before switching to it;
# tests/stylediff.ts can compare styles on it.
set -euo pipefail
HOME_DIR=${SLEIPNYR2_HOME:-/var/lib/sleipnyr2}
UNIT=${SLEIPNYR2_UNIT:-sleipnyr2}
BUN=${BUN:-bun}
PREVIEW=$UNIT-preview
work="$HOME_DIR/preview"

if [ "${1:-}" = stop ]; then
  sudo systemctl stop "$PREVIEW" 2>/dev/null || true
  sudo systemctl reset-failed "$PREVIEW" 2>/dev/null || true
  sudo rm -rf "$work"
  exit 0
fi
[ "${1:-}" = start ] && [ -n "${2:-}" ] || { echo "usage: $0 start <release-dir> [port] | stop" >&2; exit 2; }
release=$2 port=${3:-8189}
"$0" stop

# the live unit's own settings: its config file and data owner
live_config=$(systemctl show -p Environment --value "$UNIT" | tr ' ' '\n' | sed -n 's/^SLEIPNYR2_CONFIG=//p')
[ -n "$live_config" ] || { echo "preview: no SLEIPNYR2_CONFIG on $UNIT" >&2; exit 1; }
owner=$(sudo stat -c %U "$HOME_DIR/data")

sudo install -d -o "$owner" -g "$owner" -m 750 "$work" "$work/data"
# consistent snapshot of the live database (WAL mode, in use)
sudo "$BUN" -e 'const { Database } = require("bun:sqlite");
  new Database(process.argv[1], { readonly: true }).run("VACUUM INTO ?", [process.argv[2]]);' \
  "$HOME_DIR/data/kernel.sqlite" "$work/data/kernel.sqlite"
sudo cp -r "$HOME_DIR/data/files" "$work/data/"
sudo "$BUN" -e '
  const fs = require("fs"), [src, dst, port, data] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  c.listen = { host: "127.0.0.1", port: Number(port) };
  c.dataDir = data;
  c.plugins["agent-hermes"] = { agents: [] };
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' "$live_config" "$work/config.json" "$port" "$work/data"
sudo chown -R "$owner:$owner" "$work"

sudo systemd-run --quiet --unit="$PREVIEW" --collect -p User="$owner" -p Group="$owner" \
  -p WorkingDirectory="$work" -p ProtectSystem=strict -p ProtectHome=true -p PrivateTmp=true \
  -p NoNewPrivileges=true -p ReadWritePaths="$work" -p IPAddressDeny=any -p IPAddressAllow=localhost \
  -p RuntimeMaxSec=900 \
  "$BUN" "$release/kernel/server.ts" "$work/config.json"
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$port/k/plugins" >/dev/null 2>&1 && exit 0
  systemctl is-active -q "$PREVIEW" || break
  sleep 0.25
done
echo "preview: release did not start:" >&2
sudo journalctl -u "$PREVIEW" -n 30 --no-pager -o cat >&2 || true
"$0" stop
exit 1
