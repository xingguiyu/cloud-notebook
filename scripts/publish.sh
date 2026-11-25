#!/bin/zsh
# 把 pnpm release 打好的文件发布成 GitHub Release。
#
# 发布之后，已安装的应用会在下次检查更新时看到这个版本（它们读的是最新 Release 里的 latest.json）。
# 用法：pnpm release:publish            正式发布
#      DRAFT=1 pnpm release:publish    先存成草稿，自己在网页上点发布（草稿不会被自动更新看到）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")
OUT="$ROOT/release/v$VERSION"
[ -f "$OUT/latest.json" ] || { echo "ERROR: 没有找到 $OUT/latest.json，先运行 pnpm release。"; exit 1; }

cd "$ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: 有没提交的改动。发布的版本应该和仓库里的代码一致，先提交并推送。"
  exit 1
fi
git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "ERROR: 本地和 origin/main 不一致，先推送（或拉取）。"
  exit 1
fi

NOTES=$(mktemp)
python3 "$ROOT/scripts/latest-json.py" --notes "$VERSION" | sed 's/^<!--zh-->$/---/' > "$NOTES"
gh release create "v$VERSION" "$OUT"/* --target main --title "Cloud Notebook $VERSION" --notes-file "$NOTES" ${DRAFT:+--draft}
rm -f "$NOTES"
echo "已发布：$(gh release view "v$VERSION" --json url --jq .url)"
