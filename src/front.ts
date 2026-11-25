/**
 * 文件头部（front matter）：项目文档的状态、取代关系、来源写在这里。
 * 规则和 Rust 端 `docs::split` 一致：`---` 包着、第一行是 `key: value`（后面可以有缩进的续行、列表项、注释）才算头部，
 * 以分隔线开头的普通笔记不受影响。
 */
import { t } from './i18n'

const KEY_LINE = /^[A-Za-z0-9_-]+:/

export function splitFront(md: string): { front: string | null; body: string } {
  const none = { front: null, body: md }
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) return none
  const rest = md.slice(md.indexOf('\n') + 1)
  let pos = 0
  while (pos < rest.length) {
    const nl = rest.indexOf('\n', pos)
    const end = nl < 0 ? rest.length : nl + 1
    const line = rest.slice(pos, end).replace(/[\r\n]+$/, '')
    if (line === '---') {
      if (pos === 0) return none
      const body = rest.slice(end)
      return { front: rest.slice(0, pos), body: body.startsWith('\n') ? body.slice(1) : body }
    }
    // 第一行必须是 key: value；后面允许 YAML 的续行（缩进）、列表项和注释，别的工具写的头部也认得
    const continuation = pos > 0 && (/^[ \t#]/.test(line) || line.startsWith('- ') || line === '-')
    if (line.trim() && !KEY_LINE.test(line) && !continuation) return none
    pos = end
  }
  return none
}

/** 去掉头部后的正文 */
export const bodyOf = (md: string) => (md.startsWith('---') ? splitFront(md).body : md)

/** 把编辑过的正文和原来的头部拼回去 */
export function withFront(original: string, body: string) {
  const { front } = splitFront(original)
  return front === null ? body : `---\n${front}---\n\n${body}`
}

const unquote = (v: string) => {
  const t = v.trim()
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1).replace(/\\"/g, '"') : t
}

export function frontGet(md: string, key: string): string | undefined {
  const { front } = splitFront(md)
  if (front === null) return undefined
  for (const line of front.split('\n')) {
    // 只认顶格的键，缩进的是别的键下面的内容
    const i = line.indexOf(':')
    if (i > 0 && KEY_LINE.test(line) && line.slice(0, i) === key) {
      const v = unquote(line.slice(i + 1))
      if (v) return v
    }
  }
  return undefined
}

const quote = (raw: string) => {
  // 控制字符（换行等）换成空格：值里带换行的话能在头部里多写出几个键
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return /^[\[{"'#&*!|>%@`\- ]|: | #|[,\]]| $/.test(v) || !v ? `"${v.replace(/"/g, '\\"')}"` : v
}

/** 改头部里的键：字符串写入，undefined 删除；其他键和正文原样保留 */
export function frontSet(md: string, pairs: Record<string, string | undefined>) {
  const { front, body } = splitFront(md)
  let lines = front === null ? [] : front.split('\n').filter((l) => l.trim())
  for (const [key, value] of Object.entries(pairs)) {
    const at = lines.findIndex((l) => KEY_LINE.test(l) && l.slice(0, l.indexOf(':')) === key)
    if (value === undefined) lines = lines.filter((_, i) => i !== at)
    else if (at >= 0) lines[at] = `${key}: ${quote(value)}`
    else lines.push(`${key}: ${quote(value)}`)
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${body}` : body
}

export const DOC_STATUSES = [
  { id: 'current', label: t('当前有效') },
  { id: 'draft', label: t('草稿') },
  { id: 'superseded', label: t('已被取代') },
  { id: 'archived', label: t('已归档') },
] as const
export type DocStatus = (typeof DOC_STATUSES)[number]['id']

export function docStatus(md: string): DocStatus | undefined {
  const s = frontGet(md, 'status')
  return DOC_STATUSES.find((x) => x.id === s)?.id
}

/** 已被取代或已归档：列表里默认收起 */
export const isRetired = (s?: DocStatus) => s === 'superseded' || s === 'archived'

/** 逐行比较两段文字，返回带增删标记的行（最长公共子序列；太长时只标出首尾相同的部分） */
export function diffLines(before: string, after: string): { t: string; k: ' ' | '+' | '-' }[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  const head = a.slice(0, s).map((t) => ({ t, k: ' ' as const }))
  const tail = a.slice(a.length - e).map((t) => ({ t, k: ' ' as const }))
  const x = a.slice(s, a.length - e)
  const y = b.slice(s, b.length - e)
  const mid: { t: string; k: ' ' | '+' | '-' }[] = []
  if (x.length * y.length > 4_000_000) {
    mid.push(...x.map((t) => ({ t, k: '-' as const })), ...y.map((t) => ({ t, k: '+' as const })))
  } else {
    const w = y.length + 1
    const lcs = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) mid.push({ t: x[i++], k: ' ' }), j++
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) mid.push({ t: x[i++], k: '-' })
      else mid.push({ t: y[j++], k: '+' })
    }
    while (i < x.length) mid.push({ t: x[i++], k: '-' })
    while (j < y.length) mid.push({ t: y[j++], k: '+' })
  }
  return [...head, ...mid, ...tail]
}
