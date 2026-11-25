/** 粘贴处理的纯函数：判断剪贴板的纯文本是不是 Markdown、把 Bear 的换行变成段落、对上图片 */

/** 纯文本里有明确的 Markdown 块语法（标题、代码围栏、图片、链接） */
export function looksLikeMarkdown(text: string) {
  return (
    /^#{1,6}\s+\S/m.test(text) ||
    /^(```|~~~)/m.test(text) ||
    /!\[[^\]]*\]\([^)]+\)/.test(text) ||
    /\[[^\]]+\]\([^)\s]+\)/.test(text)
  )
}

/**
 * 富文本和 Markdown 纯文本同时存在时用哪个：Bear 之类的 Markdown 应用，富文本里标题只是加粗段落、
 * 图片是临时地址，纯文本才是完整的 Markdown。富文本里本来就有标题标签的（网页）保持原样。
 */
export function preferMarkdownText(text: string, html: string) {
  if (!looksLikeMarkdown(text)) return false
  return !/<h[1-6][\s>]/i.test(html)
}

const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/
const kind = (l: string) =>
  LIST.test(l) ? 'list' : /^\s*\|/.test(l) ? 'table' : /^\s*>/.test(l) ? 'quote' : /^\s{2,}\S/.test(l) ? 'indent' : 'text'

/** Bear 里每一行就是一段；标准 Markdown 里相邻两行会并成一段，这里在它们之间补空行 */
export function paragraphBreaks(md: string) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]
    out.push(a)
    if (/^\s*(```|~~~)/.test(a)) {
      fence = !fence
      continue
    }
    const b = lines[i + 1]
    if (fence || b === undefined || !a.trim() || !b.trim()) continue
    const ka = kind(a)
    const kb = kind(b)
    // 列表项及其缩进内容、表格行、引用行连在一起才成立，不能拆开
    if (ka === kb && ka !== 'text') continue
    if ((ka === 'list' || ka === 'indent') && (kb === 'list' || kb === 'indent')) continue
    if (/^\s*(```|~~~)/.test(b) && ka === 'list') continue
    out.push('')
  }
  return out.join('\n')
}

const MD_IMAGE = /(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?\s*\))/g
const isRemote = (src: string) => /^(https?|data|blob):/i.test(src)
const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export interface ClipImage {
  src: string
  name: string
}

/**
 * Markdown 里的本地图片（`![](image%204.png)`）换成剪贴板富文本里对应的图片地址：
 * 先按文件名对，对不上的按出现顺序对。
 */
export function mapImages(md: string, images: ClipImage[]) {
  const left = [...images]
  const refs = [...md.matchAll(MD_IMAGE)].filter((m) => !isRemote(m[2]))
  const picked = new Map<number, string>()
  for (const m of refs) {
    const name = decode(m[2]).split('/').pop()
    const i = left.findIndex((x) => x.name && x.name === name)
    if (i >= 0) picked.set(m.index!, left.splice(i, 1)[0].src)
  }
  for (const m of refs) if (!picked.has(m.index!) && left.length) picked.set(m.index!, left.shift()!.src)
  return md.replace(MD_IMAGE, (all, pre, _src, post, at) => (picked.has(at) ? `${pre}${picked.get(at)}${post}` : all))
}
