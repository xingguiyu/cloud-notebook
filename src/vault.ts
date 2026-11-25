import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { bodyOf } from './front'
import { getCurrentWebview } from '@tauri-apps/api/webview'

export interface Entry {
  path: string
  name: string
  is_dir: boolean
  modified: number
  created?: number
  children: Entry[]
}

export const vault = {
  tree: () => invoke<Entry[]>('vault_tree'),
  read: (path: string) => invoke<string>('vault_read', { path }),
  readMany: (paths: string[]) => invoke<Record<string, string>>('vault_read_many', { paths }),
  write: (path: string, content: string) => invoke<void>('vault_write', { path, content }),
  mkdir: (path: string) => invoke<void>('vault_mkdir', { path }),
  rename: (from: string, to: string) => invoke<void>('vault_rename', { from, to }),
  trash: (path: string) => invoke<void>('vault_trash', { path }),
}

/** 正文里的 #标签、#标签/子标签（行首 # 加空格是标题，不算） */
const TAG_RE = /(?:^|\\|[\s\u3000-\u303f\uff00-\uffef(（「『【])#([^\s#，。、；：！？）」』】]+(?:\/[^\s#，。、；：！？）」』】]+)*)/g
export function parseTags(md: string): string[] {
  // 代码和链接地址里的 # 不是标签（[文字](#小节) 是页内链接）
  const body = bodyOf(md).replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)\n]*\)/g, ']')
  const tags = new Set<string>()
  for (const m of body.matchAll(TAG_RE)) tags.add(m[1].replace(/[，。,.;；:：!?！？)）]+$/, ''))
  tags.delete('')
  return [...tags]
}

/** 去掉行内 Markdown 记号（加粗、斜体、代码、链接、转义），标题和文件名用纯文字 */
export function plainInline(s: string) {
  // 先把反斜杠转义的字符（\*、\_ 等）换成占位符，免得下面去加粗、斜体时把它们当成记号，最后再换回来
  const escaped: string[] = []
  const held = s.replace(/\\([\\`*_{}\[\]()#+\-.!~|<>])/g, (_, c: string) => `\ue000${escaped.push(c) - 1}\ue001`)
  return held
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[^>\s@]+@[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?![\w*])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\ue000(\d+)\ue001/g, (_, i: string) => escaped[Number(i)])
    .trim()
}

/** 标题取第一个一级标题，没有就用文件名 */
export function noteTitle(path: string, md: string) {
  const h = bodyOf(md).match(/^#[ \t]+(.+)$/m)?.[1]
  return (h && plainInline(h)) || path.split('/').pop()!.replace(/\.md$/, '')
}

export function noteExcerpt(md: string) {
  return bodyOf(md)
    .replace(/^#\s+.+$/m, '')
    .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[^>\s@]+@[^>\s]+)>/g, '$1')
    .replace(/(^|\s)\\?#[^\s#]+/g, '$1')
    .replace(/[#>*_`\-\[\]()!|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** 保存粘贴的图片，返回相对笔记的 Markdown 路径（如 `assets/123.png`） */
export async function saveImage(notePath: string, file: File) {
  const ext = IMAGE_EXT[file.type] ?? file.name.split('.').pop()?.toLowerCase() ?? 'png'
  const bytes = new Uint8Array(await file.arrayBuffer())
  return invoke<string>('vault_save_image', bytes, {
    headers: { 'x-note': encodeURIComponent(notePath), 'x-ext': ext },
  })
}

export function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'))
}

/** 把笔记里的相对图片路径换成 WebView 能加载的 vault:// 地址；网络图片原样返回 */
export const isRemote = (src: string) => /^[a-z][a-z0-9+.-]*:/i.test(src)

/** 笔记里的相对图片路径 → 笔记库里的相对路径 */
export function resolveVaultPath(notePath: string, src: string) {
  const parts = notePath.split('/').slice(0, -1)
  let decoded = src
  try {
    decoded = decodeURI(src)
  } catch {}
  for (const seg of decoded.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

export function resolveAsset(notePath: string, src: string) {
  if (!src || isRemote(src)) return src
  return convertFileSrc(resolveVaultPath(notePath, src), 'vault')
}

export const importImage = (notePath: string, source: string) =>
  invoke<string>('vault_import_image', { note: notePath, source })

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg)$/i

/**
 * 监听从访达拖进窗口的图片文件，只处理落在 el 范围内的。
 * 系统拖放由 Tauri 接管（网页里拿不到真实路径），这里拿到的是磁盘绝对路径和窗口内坐标。
 */
export async function onImageDrop(
  el: () => HTMLElement | undefined,
  handler: (paths: string[], x: number, y: number) => void,
) {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type !== 'drop') return
    const paths = payload.paths.filter((p) => IMAGE_PATH_RE.test(p))
    const target = el()
    if (!paths.length || !target) return
    const x = payload.position.x / window.devicePixelRatio
    const y = payload.position.y / window.devicePixelRatio
    const r = target.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return
    // 落在编辑区上方的浮层（AI 面板、信息面板）里，交给浮层自己处理
    if (document.elementFromPoint(x, y)?.closest('.ai-panel, .info-panel')) return
    handler(paths, x, y)
  })
}

/** 笔记里出现的前几张图片，列表缩略图用 */
export function noteImages(md: string, limit = 3) {
  const out: string[] = []
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (/^(blob|data):/i.test(m[1])) continue // 临时地址，重启后就失效
    out.push(m[1])
    if (out.length >= limit) break
  }
  return out
}
