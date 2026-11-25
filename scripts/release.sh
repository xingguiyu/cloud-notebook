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
# 用法：pnpm release        （或 ./scripts/release.sh）
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

cd "$ROOT"
echo "==> 构建并签名（$APPLE_SIGNING_IDENTITY）"
pnpm tauri build

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

# 删掉构建目录里的 .app，免得 Spotlight / 启动台里出现两个 Cloud Notebook（安装包 dmg 保留）
rm -rf "$APP"
echo
echo "完成：$DMG"
