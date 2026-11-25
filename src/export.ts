import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import rehypeStringify from 'rehype-stringify'
import { rehypeSafe } from './safeHtml'
import { isRemote, noteTitle, resolveAsset, resolveVaultPath } from './vault'
import { documentHtml } from './docTemplates'
import { withHostedImages } from './imagehost'
import { t } from './i18n'

export type ExportKind = 'md' | 'zip' | 'inline' | 'hosted' | 'html' | 'pdf' | 'docx'

function toDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

/**
 * Markdown 转 HTML 片段。本地图片有两种处理：
 * - `link`（默认）：指向应用内的图片地址，由页面自己去加载。预览、PDF、打印都用它，快，长文档也不卡。
 * - `inline`：读出来内嵌成 data URL。只有导出成单独的 HTML 文件、发布到 Google 文档时才需要，
 *   因为那份内容离开应用后要能自己显示图片；图片多而大时会慢，生成的内容也很大。
 */
export async function renderHtml(md: string, notePath: string, images: 'link' | 'inline' = 'link') {
  const html = String(
    await unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeHighlight, { detect: false }).use(rehypeSafe, { remoteImages: true }).use(rehypeStringify).process(md),
  )
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  await Promise.all(
    [...doc.querySelectorAll('img')].map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return
      const url = resolveAsset(notePath, src)
      if (images === 'link') {
        img.setAttribute('src', url)
        return
      }
      try {
        img.src = await toDataUrl(await (await fetch(url)).blob())
      } catch {
        // 读不到就退回成链接，至少在应用里还能显示
        img.setAttribute('src', url)
      }
    }),
  )
  return doc.body.firstElementChild!.innerHTML
}

/** Markdown 图片语法：![alt](src "title")，src 可以用 <> 包起来 */
const IMG_RE = /(!\[[^\]]*\]\(\s*)(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\s*\))/g

/**
 * 把笔记引用的本地图片改写成 assets/<文件名>，返回改写后的 Markdown 和要打包的文件。
 * 不同目录下的同名图片会自动改名，网络图片保持不变。
 */
export function collectImages(md: string, notePath: string) {
  const files: { src: string; name: string }[] = []
  const byPath = new Map<string, string>()
  const used = new Set<string>()
  const out = md.replace(IMG_RE, (all, pre: string, raw: string, post: string) => {
    const src = raw.replace(/^<|>$/g, '')
    if (!src || isRemote(src)) return all
    const vaultPath = resolveVaultPath(notePath, src)
    let name = byPath.get(vaultPath)
    if (!name) {
      const base = vaultPath.split('/').pop()!
      const dot = base.lastIndexOf('.')
      name = base
      for (let i = 2; used.has(name); i++) name = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`
      used.add(name)
      byPath.set(vaultPath, name)
      files.push({ src: vaultPath, name })
    }
    const rel = `assets/${name}`
    return `${pre}${/\s/.test(rel) ? `<${rel}>` : rel}${post}`
  })
  return { markdown: out, files }
}

/** 图片转成 data URI 直接写进 Markdown，单个文件就能带走 */
async function inlineImages(md: string, notePath: string) {
  const srcs = new Set<string>()
  for (const m of md.matchAll(IMG_RE)) {
    const src = m[2].replace(/^<|>$/g, '')
    if (src && !isRemote(src)) srcs.add(src)
  }
  const data = new Map<string, string>()
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        data.set(src, await toDataUrl(await (await fetch(resolveAsset(notePath, src))).blob()))
      } catch {}
    }),
  )
  return md.replace(IMG_RE, (all, pre: string, raw: string, post: string) => {
    const url = data.get(raw.replace(/^<|>$/g, ''))
    return url ? `${pre}${url}${post}` : all
  })
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]/g, '-').trim() || t('未命名')
}

export interface ExportOptions {
  template: string
  paper: 'a4' | 'letter' | 'a5'
  margin: 'narrow' | 'normal' | 'wide'
  keepTags: boolean
}
const MARGINS = { narrow: 36, normal: 56, wide: 80 }

/** 导出时可选去掉 #标签（代码块里的不动） */
function stripTags(md: string) {
  return md
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[\s\u3000-\u303f\uff00-\uffef(（「『【])#[^\s#，。、；：！？）」』】]+(?:\/[^\s#，。、；：！？）」』】]+)*/gm, '$1')))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
}

async function makePdf(md: string, notePath: string, title: string, path: string, opts: ExportOptions) {
  const html = documentHtml(title, await renderHtml(md, notePath), opts.template)
  await invoke('export_pdf', { html, path, paperSize: opts.paper, margin: MARGINS[opts.margin] })
}

/** 打印：弹出系统打印面板，版式和导出 PDF 一致 */
export async function printNote(notePath: string, source: string, opts: ExportOptions) {
  const md = opts.keepTags ? source : stripTags(source)
  const html = documentHtml(noteTitle(notePath, md) || t('未命名'), await renderHtml(md, notePath), opts.template)
  await invoke('print_document', { html, paperSize: opts.paper, margin: MARGINS[opts.margin] })
}

const FILTERS: Record<Exclude<ExportKind, 'md'>, { name: string; extensions: string[] }> = {
  pdf: { name: 'PDF', extensions: ['pdf'] },
  zip: { name: t('Zip 压缩包'), extensions: ['zip'] },
  inline: { name: 'Markdown', extensions: ['md'] },
  hosted: { name: 'Markdown', extensions: ['md'] },
  html: { name: 'HTML', extensions: ['html'] },
  docx: { name: 'Word', extensions: ['docx'] },
}

/** 导出当前笔记。返回 false 表示用户取消 */
export async function exportNote(kind: ExportKind, notePath: string, source: string, opts: ExportOptions) {
  const title = noteTitle(notePath, source) || t('未命名')
  const md = opts.keepTags ? source : stripTags(source)
  const name = safeName(title)
  if (kind === 'md') {
    // 保存对话框里填的名字作为文件夹名，里面放 .md 和 assets/
    const path = await save({ defaultPath: name, title: t('导出为 Markdown 文件夹') })
    if (!path) return false
    const { markdown, files } = collectImages(md, notePath)
    await invoke('export_bundle', { markdown, mdName: name, files, out: path.replace(/\.md$/i, ''), zip: false })
    return true
  }
  const path = await save({ defaultPath: `${name}.${FILTERS[kind].extensions[0]}`, filters: [FILTERS[kind]] })
  if (!path) return false
  if (kind === 'zip') {
    const { markdown, files } = collectImages(md, notePath)
    await invoke('export_bundle', { markdown, mdName: name, files, out: path, zip: true })
  } else if (kind === 'pdf') await makePdf(md, notePath, title, path, opts)
  else if (kind === 'hosted') await invoke('export_write', { path, content: await withHostedImages(md, notePath) })
  else if (kind === 'inline') await invoke('export_write', { path, content: await inlineImages(md, notePath) })
  else if (kind === 'docx') await invoke('export_docx', { note: notePath, markdown: md, path })
  else {
    const html = documentHtml(title, await renderHtml(md, notePath, 'inline'), opts.template)
    await invoke('export_write', { path, content: html })
  }
  return true
}
