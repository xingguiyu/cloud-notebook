#!/bin/zsh
# 把官网和最新版本的安装包同步到国内镜像（GitHub 在国内访问不稳定，官网、下载、自动更新都需要一个国内能打开的地址）。
#
# 镜像上的内容：
#   /                      官网（site/ 目录）
#   /download/latest.json  自动更新用的清单，里面的下载地址指向镜像自己
#   /download/release.json 官网下载按钮用：最新版本号和安装包地址
#   /download/*.dmg, *.app.tar.gz
#
# 用法：pnpm site:deploy                      （先运行过 pnpm release）
#      SITE_HOST=root@1.2.3.4 SITE_DIR=/path SITE_URL=https://example.com pnpm site:deploy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_HOST="${SITE_HOST:-root@47.108.48.90}"
SITE_DIR="${SITE_DIR:-/www/wwwroot/notebook.qxsclass.com}"
SITE_URL="${SITE_URL:-https://notebook.qxsclass.com}"
VERSION=$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")
OUT="$ROOT/release/v$VERSION"
STAGE="$ROOT/release/mirror"

rm -rf "$STAGE" && mkdir -p "$STAGE/download"
cp -R "$ROOT/site/." "$STAGE/"

# 国内镜像要在页脚显示备案信息：把 scripts/mirror-footer.html 插到每个页面的 <!--beian--> 处
python3 - "$STAGE" "$ROOT/scripts/mirror-footer.html" <<'PY'
import glob, os, re, sys
stage, snippet = sys.argv[1], sys.argv[2]
block = re.sub(r'^<!--.*?-->\s*', '', open(snippet, encoding='utf-8').read(), flags=re.S).strip()
for f in glob.glob(os.path.join(stage, '*.html')):
    html = open(f, encoding='utf-8').read()
    if '<!--beian-->' not in html:
        sys.exit(f'{os.path.basename(f)} 里没有 <!--beian--> 标记，备案信息插不进去')
    open(f, 'w', encoding='utf-8').write(html.replace('<!--beian-->', block))
PY

if [ -f "$OUT/latest.json" ]; then
  cp "$OUT"/*.dmg "$OUT"/*.app.tar.gz "$STAGE/download/"
  python3 - "$OUT/latest.json" "$STAGE/download" "$SITE_URL" "$VERSION" <<'PY'
import json, os, sys
src, dest, site, version = sys.argv[1:5]
d = json.load(open(src, encoding='utf-8'))
for p in d['platforms'].values():
    p['url'] = f"{site}/download/{p['url'].rsplit('/', 1)[-1]}"
json.dump(d, open(os.path.join(dest, 'latest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
dmg = next(f for f in os.listdir(dest) if f.endswith('.dmg'))
json.dump({'version': version, 'dmg': f'{site}/download/{dmg}'}, open(os.path.join(dest, 'release.json'), 'w'))
PY
  echo "==> 镜像版本 $VERSION"
else
  echo "==> 没有找到 $OUT（没运行过 pnpm release），这次只同步官网页面"
  rmdir "$STAGE/download"
fi

echo "==> 同步到 $SITE_HOST:$SITE_DIR"
# 不带 --delete：旧版本的安装包留在服务器上，还在用旧清单的应用仍然能下载到
# 统一成「目录 755、文件 644」：本机上权限偏严的文件（比如只有自己可读的截图）原样传上去，网站服务读不了，会返回 403。
# 在本地先改好再同步（macOS 自带的 rsync 不认 --chmod 参数）
chmod -R u=rwX,go=rX "$STAGE"
rsync -az --progress "$STAGE/" "$SITE_HOST:$SITE_DIR/"

echo "==> 检查"
# 页面、更新清单，以及页面用到的每个文件都要能打开
urls=("$SITE_URL/" "$SITE_URL/privacy.html" "$SITE_URL/download/latest.json")
for f in "$STAGE"/assets/* "$STAGE"/style.css "$STAGE"/site.js; do urls+=("$SITE_URL/${f#$STAGE/}"); done
for u in "${urls[@]}"; do
  printf '    %s  %s\n' "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$u")" "$u"
done
