import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { Node } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

/**
 * 笔记内查找：高亮所有匹配、在匹配之间跳转、替换。
 * 也用来在从搜索结果打开笔记时高亮搜索词（多个词）。不分大小写。
 */
export interface Match {
  from: number
  to: number
}
interface FindState {
  terms: string[]
  matches: Match[]
  index: number
  deco: DecorationSet
}

export const findKey = new PluginKey<FindState>('note-find')

/** 文档里所有匹配的位置。按文本块找，匹配不会跨段落 */
export function findMatches(doc: Node, terms: string[]): Match[] {
  const needles = [...new Set(terms.map((t) => t.toLowerCase()).filter(Boolean))]
  const out: Match[] = []
  if (!needles.length) return out
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // 非文字的行内节点（图片、换行）占一个位置，用占位符顶上，偏移量才和文档位置对得上
    const text = node.textBetween(0, node.content.size, undefined, '￼').toLowerCase()
    for (const n of needles) {
      let i = text.indexOf(n)
      while (i >= 0) {
        out.push({ from: pos + 1 + i, to: pos + 1 + i + n.length })
        i = text.indexOf(n, i + n.length)
      }
    }
    return false
  })
  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

function decorate(doc: Node, matches: Match[], index: number) {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? 'find-hit current' : 'find-hit' })),
  )
}

function build(state: EditorState, terms: string[], index: number): FindState {
  const matches = findMatches(state.doc, terms)
  const i = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1
  return { terms, matches, index: i, deco: decorate(state.doc, matches, i) }
}

export const findPlugin = $prose(
  () =>
    new Plugin<FindState>({
      key: findKey,
      state: {
        init: () => ({ terms: [], matches: [], index: -1, deco: DecorationSet.empty }),
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(findKey) as { terms?: string[]; index?: number } | undefined
          if (meta?.terms) return build(state, meta.terms, meta.index ?? 0)
          if (tr.docChanged) return prev.terms.length ? build(state, prev.terms, meta?.index ?? prev.index) : prev
          if (meta?.index !== undefined) return { ...prev, index: meta.index, deco: decorate(state.doc, prev.matches, meta.index) }
          return prev
        },
      },
      props: {
        decorations: (state) => findKey.getState(state)?.deco,
      },
    }),
)

export const findInfo = (view: EditorView) => {
  const s = findKey.getState(view.state)
  return { count: s?.matches.length ?? 0, index: s?.index ?? -1 }
}

/** 把匹配滚到编辑区中间偏上，不动光标（焦点还在查找框里） */
function reveal(view: EditorView) {
  const s = findKey.getState(view.state)
  const m = s?.matches[s.index]
  if (!m) return
  const scroller = view.dom.closest('.editor-wrap') as HTMLElement | null
  if (!scroller) return
  const top = view.coordsAtPos(m.from).top
  const box = scroller.getBoundingClientRect()
  if (top < box.top + 60 || top > box.bottom - 80) scroller.scrollTop += top - box.top - box.height * 0.35
}

/** 设置要找的词。从光标之后的第一个匹配开始；fromStart 时从文档开头 */
export function setFind(view: EditorView, terms: string[], fromStart = false) {
  const matches = findMatches(view.state.doc, terms)
  const cursor = view.state.selection.from
  const at = fromStart ? 0 : Math.max(0, matches.findIndex((m) => m.to >= cursor))
  view.dispatch(view.state.tr.setMeta(findKey, { terms, index: at }))
  requestAnimationFrame(() => reveal(view))
  return findInfo(view)
}

export function stepFind(view: EditorView, dir: 1 | -1) {
  const s = findKey.getState(view.state)
  if (!s?.matches.length) return findInfo(view)
  const index = (s.index + dir + s.matches.length) % s.matches.length
  view.dispatch(view.state.tr.setMeta(findKey, { index }))
  reveal(view)
  return findInfo(view)
}

/** 替换当前这一处，然后停在下一处 */
export function replaceCurrent(view: EditorView, text: string) {
  const s = findKey.getState(view.state)
  const m = s?.matches[s.index]
  if (!s || !m) return findInfo(view)
  const tr = text ? view.state.tr.insertText(text, m.from, m.to) : view.state.tr.delete(m.from, m.to)
  view.dispatch(tr.setMeta(findKey, { index: s.index }))
  // 换上去的文字自己又能匹配上（todo → TODO、note → notes）：跳到下一处，否则会一直在同一处打转
  const now = findKey.getState(view.state)
  const again = now?.matches[now.index]
  if (text && now && again && again.from >= m.from && again.to <= m.from + text.length && now.matches.length > 1)
    view.dispatch(view.state.tr.setMeta(findKey, { index: (now.index + 1) % now.matches.length }))
  reveal(view)
  return findInfo(view)
}

/** 全部替换（一次撤销就能全部还原）。返回替换了多少处 */
export function replaceEvery(view: EditorView, text: string) {
  const s = findKey.getState(view.state)
  if (!s?.matches.length) return 0
  const tr = view.state.tr
  // 从后往前换，前面的位置不受影响；重叠的匹配跳过
  let limit = Infinity
  let n = 0
  for (const m of [...s.matches].reverse()) {
    if (m.to > limit) continue
    if (text) tr.insertText(text, m.from, m.to)
    else tr.delete(m.from, m.to)
    limit = m.from
    n++
  }
  view.dispatch(tr.setMeta(findKey, { index: 0 }))
  return n
}

/** 关掉查找：去掉高亮，把光标放到当前匹配上 */
export function clearFind(view: EditorView, selectCurrent = false) {
  const s = findKey.getState(view.state)
  const m = s?.matches[s.index]
  const tr = view.state.tr.setMeta(findKey, { terms: [] })
  if (selectCurrent && m) tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to))
  view.dispatch(tr)
}
