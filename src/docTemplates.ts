/**
 * 导出 PDF / HTML 用的排版模板。都是独立的浅色样式，不受应用深色模式影响。
 * 打印时 WebKit 支持 break-inside / break-after 控制分页。
 */
import { t } from './i18n'

const CODE = `
code{font:.86em ui-monospace,"SF Mono",Menlo,monospace;background:rgba(0,0,0,.05);padding:.1em .35em;border-radius:4px}
pre{background:#f6f6f8;padding:12px 16px;border-radius:8px;overflow-x:auto;font-size:.92em;line-height:1.55}
pre code{background:none;padding:0}
.hljs-keyword,.hljs-built_in,.hljs-selector-tag{color:#c2410c}.hljs-string,.hljs-regexp{color:#15803d}
.hljs-comment{color:#8e8e93;font-style:italic}.hljs-number,.hljs-literal{color:#7c3aed}
.hljs-title,.hljs-function{color:#2563eb}.hljs-type,.hljs-class{color:#b45309}.hljs-attr,.hljs-property{color:#0e7490}
`
const BASE = `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0 auto;padding:40px 24px;max-width:760px}
img{max-width:100%;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:1em 0}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f6f6f8}
hr{border:0;border-top:1px solid #e5e5e5;margin:2em 0}
ul.contains-task-list{list-style:none;padding-left:.4em}li.task-list-item input{margin-right:.5em}
h1,h2,h3,h4{break-after:avoid}pre,blockquote,img,table,figure{break-inside:avoid}
@media print{body{padding:0;max-width:none}}
`

export interface DocTemplate {
  id: string
  name: string
  desc: string
  css: string
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'clean',
    name: t('简洁'),
    desc: t('无衬线，适合大多数笔记'),
    css: `${BASE}${CODE}
body{font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}
h1{font-size:1.9em;line-height:1.3;margin:0 0 .6em}h2{font-size:1.4em;margin:1.6em 0 .5em}h3{font-size:1.15em;margin:1.3em 0 .4em}
p{margin:.6em 0}a{color:#e5484d}blockquote{margin:1em 0;padding-left:14px;border-left:3px solid #e5484d;color:#6e6e73}`,
  },
  {
    id: 'book',
    name: t('书籍'),
    desc: t('宋体衬线，首行缩进，两端对齐'),
    css: `${BASE}${CODE}
body{font:15.5px/1.95 "Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;color:#2b2622;text-align:justify}
h1{font-size:1.8em;text-align:center;margin:.4em 0 1.4em;letter-spacing:.06em}
h2{font-size:1.3em;margin:1.8em 0 .7em;text-align:center}h3{font-size:1.1em;margin:1.4em 0 .5em}
p{margin:0;text-indent:2em}h1+p,h2+p,h3+p,blockquote p{text-indent:0}
a{color:#8b4513}blockquote{margin:1.2em 2em;color:#6b5f55;font-style:italic}`,
  },
  {
    id: 'academic',
    name: t('学术'),
    desc: t('标题自动编号，紧凑的论文风格'),
    css: `${BASE}${CODE}
body{font:14px/1.7 "Times New Roman","Songti SC",serif;color:#111;counter-reset:h2}
h1{font-size:1.7em;text-align:center;margin:0 0 1.2em}
h2{font-size:1.25em;margin:1.5em 0 .5em;counter-reset:h3;counter-increment:h2}h2::before{content:counter(h2) ". "}
h3{font-size:1.05em;margin:1.2em 0 .4em;counter-increment:h3}h3::before{content:counter(h2) "." counter(h3) " "}
p{margin:.5em 0;text-align:justify}a{color:#1a4fa0}blockquote{margin:1em 1.5em;color:#444;font-size:.95em}
th{background:#eee}`,
  },
  {
    id: 'modern',
    name: t('现代'),
    desc: t('彩色标题与色块，适合分享'),
    css: `${BASE}${CODE}
body{font:15px/1.8 "Avenir Next",-apple-system,"PingFang SC",sans-serif;color:#1f2933}
h1{font-size:2.1em;line-height:1.25;margin:0 0 .3em;color:#111;font-weight:800}
h1::after{content:"";display:block;width:56px;height:4px;margin-top:.45em;border-radius:2px;background:#4f46e5}
h2{font-size:1.35em;margin:1.7em 0 .6em;padding-left:12px;border-left:4px solid #4f46e5}
h3{font-size:1.1em;margin:1.3em 0 .4em;color:#4f46e5}
p{margin:.7em 0}a{color:#4f46e5}
blockquote{margin:1.2em 0;padding:10px 16px;background:#eef2ff;border-radius:8px;color:#3730a3}
pre{background:#0f172a;color:#e2e8f0}pre .hljs-comment{color:#94a3b8}pre .hljs-title,pre .hljs-function{color:#93c5fd}pre .hljs-keyword,pre .hljs-built_in{color:#fdba74}pre .hljs-string{color:#86efac}pre .hljs-number,pre .hljs-literal{color:#c4b5fd}pre .hljs-type{color:#fcd34d}`,
  },
]

export const templateCss = (id: string) => (DOC_TEMPLATES.find((t) => t.id === id) ?? DOC_TEMPLATES[0]).css

export function documentHtml(title: string, body: string, templateId: string) {
  const esc = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title><style>${templateCss(templateId)}</style></head><body>${body}</body></html>`
}
