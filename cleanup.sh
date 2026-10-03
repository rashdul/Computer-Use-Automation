#!/usr/bin/env bash
# Removes files and folders the project does not need.
#
#   bash cleanup.sh          # dry run: lists what would be deleted, and why
#   bash cleanup.sh --yes    # deletes them
#
# Never touched: source code, evidence/, documents/, node_modules/, .git/, .env,
# target-app/.env.local, target-app/STAFF_CREDENTIALS.local.md, and working artifacts.
# artifacts/ is git-ignored (local discoveries); the reviewed example lives in evidence/.
set -euo pipefail

apply=false
case "${1:-}" in
  "") ;;
  --yes) apply=true ;;
  -h | --help)
    sed -n '2,10p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: bash cleanup.sh [--yes]" >&2
    exit 2
    ;;
esac

# Run from the repository root, and refuse anywhere else.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -d .git || ! -f package.json ]] || ! grep -q '"name": "rfcu-computer-use"' package.json; then
  echo "Stopped: cleanup.sh must sit in the Computer-Use Automation repository root." >&2
  exit 1
fi

found=0
removed=0

# remove <path> <reason>
remove() {
  local target="$1" reason="$2"
  [[ -e "$target" || -L "$target" ]] || return 0
  found=$((found + 1))
  if [[ "$apply" == true ]]; then
    # A temp folder still locked by a running browser is skipped, not fatal.
    if rm -rf -- "$target" 2>/dev/null && [[ ! -e "$target" ]]; then
      removed=$((removed + 1))
      printf '  removed   %s\n' "$target"
    else
      printf '  SKIPPED   %s (in use or locked)\n' "$target"
    fi
  else
    printf '  would remove  %-62s %s\n' "$target" "$reason"
  fi
}

echo "== Scratch and run output"
remove "runs" "output of local discover/replay runs (evidence/ keeps the curated ones)"
remove ".runtime" "old debug scripts, logs, screenshots and a stray copy of target-app"

echo "== Build and test leftovers (regenerated when needed)"
remove "target-app/dist" "Vite build output (npm --prefix target-app run build)"
remove "target-app/test-output" "screenshots from the Python UI walkthroughs"
remove "target-app/tsconfig.tsbuildinfo" "TypeScript incremental build cache"
while IFS= read -r -d '' cache; do
  remove "$cache" "Python bytecode cache"
done < <(find target-app automation -type d -name __pycache__ -not -path '*/node_modules/*' -print0 2>/dev/null)

echo "== Obsolete files from the old 'automation' branch"
remove "automation.env.local" "old config (DISCOVERY_PROVIDER, OPERATOR_PORT...); no code reads it"
remove "cleanup-main.sh" "old branch-switch helper; it deletes automation/ and evidence/ on main"

echo "== Broken local artifacts (only work for the exact record or search they were recorded on)"
remove "artifacts/rfcu.member.total-balance.v1.json" "member number 1080566 baked in"
remove "artifacts/rfcu.member.total-balance.v2.json" "URL checkpoint is the literal search 'Amber Adams'"
remove "artifacts/rfcu.member.savings-balance.v3.json" "tab 'Accounts 3' without the any-count fallback"
remove "artifacts/rfcu.member.savings-balance.v4.json" "tab 'Accounts 5' without the any-count fallback"
remove "artifacts/wikipedia.article.open.v1.json" "checkpoint is the literal /wiki/Artificial_intelligence"
remove "artifacts/wikipedia.article.open-url.v1.json" "checkpoint is the literal /wiki/Artificial_intelligence"
remove "artifacts/wikipedia.article.url.v1.json" "checkpoint is the literal /wiki/Artificial_intelligence"
remove "artifacts/amazon.search.first-product-title.v1.json" "checkpoint contains a one-time session id (crid=...)"
remove "artifacts/amazon.search.top-5-results.v1.json" "product titles used as locators (INVALID_ARTIFACT)"
remove "artifacts/youtube.search.first-video-title.v1.json" "video title used as locator (INVALID_ARTIFACT); v2 replaces it"

echo "== Temporary folders left by runs and tests"
tmp="${TEMP:-${TMPDIR:-/tmp}}"
for pattern in cua-session- cua-codex- cua-test- cua-portability- cua-search-test- cua-env-; do
  for dir in "$tmp"/"$pattern"*; do
    [[ -d "$dir" ]] && remove "$dir" "leftover browser profile / test folder"
  done
done

echo
if [[ "$found" -eq 0 ]]; then
  echo "Nothing to clean."
elif [[ "$apply" == true ]]; then
  echo "Removed $removed of $found item(s)."
else
  echo "Dry run: $found item(s) would be removed. Run 'bash cleanup.sh --yes' to delete them."
fi
