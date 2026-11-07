#!/usr/bin/env bash
# Deploy the committed HEAD of this repo as a release and restart the app.
#   deploy/deploy.sh            check, copy HEAD to releases/<sha>, smoke-test it, switch, smoke-test again
#   deploy/deploy.sh rollback   switch back to the previous release
# Releases live in $SLEIPNYR2_HOME/releases (default /var/lib/sleipnyr2); "current" points at one.
#
# Gates, in order; the first failure stops the deploy:
#   1. tests/check.sh: type check, syntax check of all web JS, unit tests,
#      each CSS selector defined once
#   2. the new release runs as a preview next to the live app (copy of the
#      data, no agents) and passes tests/smoke.ts in a headless browser:
#      app loads, a thread opens with its messages, no JS errors.
#      On failure the live app is not touched.
#   3. after the switch: health check and the same smoke test on the live
#      app; on failure it switches back to the release that was running.
# SKIP_SMOKE=1 skips the browser tests (emergencies only).
set -euo pipefail
HOME_DIR=${SLEIPNYR2_HOME:-/var/lib/sleipnyr2}
UNIT=${SLEIPNYR2_UNIT:-sleipnyr2}
URL=${SLEIPNYR2_URL:-http://127.0.0.1:8180}
PREVIEW_PORT=${SLEIPNYR2_PREVIEW_PORT:-8189}
BUN=${BUN:-bun}
export BUN
REPO=$(cd "$(dirname "$0")/.." && pwd)
rel="$HOME_DIR/releases"

health() {
  for _ in $(seq 1 20); do
    curl -fsS "$URL/k/plugins" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

smoke() { [ "${SKIP_SMOKE:-}" = 1 ] && { echo "smoke test skipped (SKIP_SMOKE=1)"; return 0; }; "$BUN" "$REPO/tests/smoke.ts" "$1"; }

switch_to() {
  sudo ln -sfn "$1" "$rel/current.new" && sudo mv -T "$rel/current.new" "$rel/current"
  sudo systemctl restart "$UNIT"
}

if [ "${1:-}" = rollback ]; then
  prev=$(sudo cat "$rel/previous")
  echo "rolling back to $prev"
  switch_to "$prev"
  health && echo ok || { echo "health check failed" >&2; exit 1; }
  exit 0
fi

cd "$REPO"
[ -z "$(git status --porcelain -- kernel plugins tools)" ] || { echo "commit your changes first" >&2; exit 1; }
"$REPO/tests/check.sh"
sha=$(git rev-parse --short=12 HEAD)
sudo mkdir -p "$rel"
if [ ! -d "$rel/$sha" ]; then
  tmp=$(mktemp -d)
  git archive HEAD kernel plugins tools | tar -x -C "$tmp"
  sudo cp -a "$tmp" "$rel/$sha" && rm -rf "$tmp"
  sudo chmod -R a+rX "$rel/$sha"
fi

# gate 2: the new release on its own, before the live app is touched
if [ "${SKIP_SMOKE:-}" != 1 ]; then
  echo "smoke test of $sha (preview on port $PREVIEW_PORT)"
  trap '"$REPO/deploy/preview.sh" stop' EXIT
  "$REPO/deploy/preview.sh" start "$rel/$sha" "$PREVIEW_PORT" \
    || { echo "NOT deployed: release $sha does not start; the live app is unchanged" >&2; exit 1; }
  smoke "http://127.0.0.1:$PREVIEW_PORT" \
    || { echo "NOT deployed: release $sha failed the smoke test; the live app is unchanged" >&2; exit 1; }
  "$REPO/deploy/preview.sh" stop; trap - EXIT
fi

# gate 3: switch, then check the live app
cur=$(sudo readlink "$rel/current" 2>/dev/null || true)
[ -n "$cur" ] && [ "$cur" != "$rel/$sha" ] && echo "$cur" | sudo tee "$rel/previous" >/dev/null
switch_to "$rel/$sha"
if health && smoke "$URL"; then
  echo "deployed $sha"
else
  echo "live check failed; switching back to $cur" >&2
  [ -n "$cur" ] && switch_to "$cur" && health
  exit 1
fi
