#!/usr/bin/env bash
# Static checks and unit tests. Run before every deploy (deploy.sh does):
# type check, a syntax check of every browser JavaScript file, then the tests
# (including tests/css.test.ts: each CSS selector defined once).
set -euo pipefail
cd "$(dirname "$0")/.."
BUN=${BUN:-bun}
"$BUN" install --frozen-lockfile >/dev/null 2>&1 || "$BUN" install >/dev/null
"$BUN" ./node_modules/typescript/lib/tsc.js -p tsconfig.json

# The web JS is served as-is (no build), so a syntax error only shows up as a
# blank app in the browser. Parse each file with bun; the copies live outside
# /home so bun never picks up a project config from the repo.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/sleipnyr2-js-XXXXXX")
trap 'rm -rf "$tmp"' EXIT
bad=0
while IFS= read -r f; do
  mkdir -p "$tmp/$(dirname "$f")" && cp "$f" "$tmp/$f"
  (cd "$tmp" && "$BUN" build --no-bundle "$f" >/dev/null 2>"$tmp/err") || { echo "syntax error in $f:" >&2; cat "$tmp/err" >&2; bad=1; }
done < <(git ls-files 'kernel/web/*.js' 'plugins/*/web/*.js')
[ "$bad" = 0 ] || exit 1

"$BUN" test tests/
