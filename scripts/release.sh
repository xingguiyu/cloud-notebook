#!/bin/zsh
# 打包 → Developer ID 签名 → Apple 公证 → 装订公证票据 → 校验
#
# 公证凭证存在钥匙串里（只需配置一次，密码不落盘、不进仓库）：
#   xcrun notarytool store-credentials "cloudnotebook-notary" \
#     --apple-id "<你的 Apple ID>" --team-id "<Team ID>"
#
# 签名证书：默认用钥匙串里第一张 Developer ID Application 证书，
# 也可以用 APPLE_SIGNING_IDENTITY 指定。
#
# 用法：pnpm release        （或 ./scripts/release.sh），产物在 release/v<版本>/
#      pnpm release:publish 把它们发布成 GitHub Release（自动更新从那里取 latest.json）
#      SKIP_NOTARIZE=1 pnpm release   只签名不公证，本机自用
set -euo pipefail

PROFILE="${NOTARY_PROFILE:-cloudnotebook-notary}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/src-tauri/target/release/bundle"

# 系统自带的 xattr 必须排在最前面：Anaconda 的同名命令不支持 -r，会让 Tauri 打包失败
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
fi
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  echo "ERROR: 钥匙串里没有 Developer ID Application 证书。只想本机试用可以直接运行 pnpm tauri build（不签名）。"
  exit 1
fi
export APPLE_SIGNING_IDENTITY

# 自动更新用的签名私钥（和 Apple 的签名是两回事）：更新包用它签名，应用里内置的公钥用来校验。
# 私钥放在仓库外面：~/.tauri/cloud-notebook.key，或用 TAURI_SIGNING_PRIVATE_KEY 指定（内容或文件路径都行）。
UPDATER_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/cloud-notebook.key}"
if [ ! -f "$UPDATER_KEY" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "ERROR: 找不到更新签名私钥 $UPDATER_KEY。没有它打出来的版本无法被自动更新安装。"
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$UPDATER_KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

cd "$ROOT"
echo "==> 构建并签名（$APPLE_SIGNING_IDENTITY）"
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'

APP=$(ls -d "$BUNDLE"/macos/*.app | head -1)
DMG=$(ls -t "$BUNDLE"/dmg/*.dmg | head -1)
codesign --verify --deep --strict "$APP"
echo "    签名校验通过：$APP"

if [ -n "${SKIP_NOTARIZE:-}" ]; then
  echo "==> 已跳过公证（SKIP_NOTARIZE）。发给别人前请去掉这个变量重新打包。"
  exit 0
fi

if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "ERROR: 钥匙串里没有公证凭证「$PROFILE」，请先运行脚本开头注释里的 store-credentials 命令。"
  exit 1
fi

echo "==> 上传公证（通常 2–15 分钟）"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait --output-format json > /tmp/cn-notary.json || true
STATUS=$(python3 -c "import json;print(json.load(open('/tmp/cn-notary.json')).get('status',''))")
ID=$(python3 -c "import json;print(json.load(open('/tmp/cn-notary.json')).get('id',''))")
if [ "$STATUS" != "Accepted" ]; then
  echo "ERROR: 公证未通过（$STATUS）。详细日志："
  [ -n "$ID" ] && xcrun notarytool log "$ID" --keychain-profile "$PROFILE"
  exit 1
fi

echo "==> 装订公证票据（离线也能通过 Gatekeeper）"
xcrun stapler staple "$DMG"
xcrun stapler staple "$APP"

echo "==> Gatekeeper 校验"
spctl -a -vv "$APP"
spctl -a -t open --context context:primary-signature -vv "$DMG"

# ---- 整理要发布的文件：安装包、更新包、latest.json ----
VERSION=$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")
case "$(uname -m)" in arm64) ARCH=aarch64 ;; *) ARCH=x86_64 ;; esac
REPO="${RELEASE_REPO:-$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
OUT="$ROOT/release/v$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$DMG" "$OUT/Cloud-Notebook_${VERSION}_${ARCH}.dmg"

# 更新包用装订过票据的 .app 重新打，再签名（构建时生成的那份是公证之前打的）
UPDATE="$OUT/Cloud-Notebook_${VERSION}_${ARCH}.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$UPDATE" -C "$(dirname "$APP")" "$(basename "$APP")"
if [ -f "$UPDATER_KEY" ]; then
  env -u TAURI_SIGNING_PRIVATE_KEY pnpm tauri signer sign -f "$UPDATER_KEY" -p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "$UPDATE" >/dev/null
else
  pnpm tauri signer sign -p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "$UPDATE" >/dev/null
fi
[ -f "$UPDATE.sig" ] || { echo "ERROR: 更新包签名失败"; exit 1; }

python3 "$ROOT/scripts/latest-json.py" "$VERSION" "$ARCH" "$REPO" "$UPDATE.sig" "$(basename "$UPDATE")" > "$OUT/latest.json"
rm -f "$UPDATE.sig"

# 删掉构建目录里的 .app，免得 Spotlight / 启动台里出现两个 Cloud Notebook（安装包 dmg 保留）
rm -rf "$APP"
echo
echo "完成：$OUT"
ls -lh "$OUT" | awk 'NR>1{print "    " $5 "  " $9}'
echo "发布到 GitHub：pnpm release:publish"
