import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { navigation, noteIndex, rankSuggestions, TAG_RE, WIKILINK_RE } from '../store'
import { t } from '../i18n'

/**
 * 标签和双向链接：
 * - 输入 `#` 或 `[[` 时弹出补全列表，方向键选择、回车/Tab 确认、Esc 关闭
 * - 正文里的 #标签、[[笔记]] 高亮显示，点击跳转
 */

type Trigger = { kind: 'tag' | 'wiki'; from: number; to: number; query: string }

function findTrigger(state: EditorState): Trigger | null {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.spec.code) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const start = $from.pos - $from.parentOffset
  const wiki = before.match(/\[\[([^\[\]\n]*)$/)
  if (wiki) return { kind: 'wiki', from: start + wiki.index!, to: $from.pos, query: wiki[1] }
  const tag = before.match(/(?:^|[\s\u3000-\u303f\uff00-\uffef(（「『【])#([^\s#，。、；：！？）」』】]*)$/)
  if (tag) {
    const hashAt = before.lastIndexOf('#')
    return { kind: 'tag', from: start + hashAt, to: $from.pos, query: tag[1] }
  }
  return null
}

class SuggestPopup {
  el = document.createElement('div')
  items: string[] = []
  index = 0
  trigger: Trigger | null = null
  view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.el.className = 'suggest-popup'
    this.el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const row = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null
      if (row) this.choose(Number(row.dataset.i))
    })
  }

  update(view: EditorView) {
    this.view = view
    const t = findTrigger(view.state)
    if (!t) return this.hide()
    const source = t.kind === 'wiki' ? noteIndex.value.titles : noteIndex.value.tags
    const items = rankSuggestions(source, t.query)
    // 标签允许输入新标签，没有匹配时不弹窗；链接没有匹配时提示新建
    if (!items.length && t.kind === 'tag') return this.hide()
    if (t.kind === 'wiki' && t.query.trim() && !items.some((i) => i === t.query.trim())) items.push(`\u0000${t.query.trim()}`)
    if (!items.length) return this.hide()
    if (this.trigger?.kind !== t.kind || this.trigger.from !== t.from) this.index = 0
    this.trigger = t
    this.items = items
    this.index = Math.min(this.index, items.length - 1)
    this.render()
    const c = view.coordsAtPos(t.from)
    this.el.style.left = `${c.left}px`
    this.el.style.top = `${c.bottom + 6}px`
    if (!this.el.isConnected) document.body.append(this.el)
  }

  render() {
    this.el.innerHTML = ''
    this.items.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'suggest-item' + (i === this.index ? ' active' : '')
      row.dataset.i = String(i)
      const isNew = it.startsWith('\u0000')
      const label = isNew ? it.slice(1) : it
      row.textContent = this.trigger?.kind === 'tag' ? `#${label}` : label
      if (isNew) {
        const hint = document.createElement('span')
        hint.className = 'suggest-hint'
        hint.textContent = t('新建笔记')
        row.append(hint)
      }
      this.el.append(row)
    })
  }

  get open() {
    return this.el.isConnected
  }

  move(d: number) {
    this.index = (this.index + d + this.items.length) % this.items.length
    this.render()
    this.el.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }

  choose(i = this.index) {
    const t = this.trigger
    const item = this.items[i]
    if (!t || item === undefined) return
    const value = item.replace(/^\u0000/, '')
    const text = t.kind === 'wiki' ? `[[${value}]]` : `#${value} `
    // 自动配对时光标后可能已经有 ]]，一并替换掉
    const after = this.view.state.doc.textBetween(t.to, Math.min(t.to + 2, this.view.state.doc.content.size))
    const to = t.kind === 'wiki' && after === ']]' ? t.to + 2 : t.to
    this.view.dispatch(this.view.state.tr.insertText(text, t.from, to))
    this.hide()
    this.view.focus()
  }

  hide() {
    this.trigger = null
    this.el.remove()
  }
}

const key = new PluginKey<SuggestPopup>('suggest')
let popup: SuggestPopup | null = null

function decorations(state: EditorState) {
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.spec.code) return false
    if (!node.isText) return true
    // 行内代码里的不算
    if (node.marks.some((m) => m.type.spec.code)) return false
    const text = node.text!
    for (const m of text.matchAll(WIKILINK_RE)) {
      decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'wikilink', 'data-wikilink': m[1] }))
    }
    for (const m of text.matchAll(TAG_RE)) {
      const start = pos + m.index! + m[1].length
      decos.push(Decoration.inline(start, start + m[2].length, { class: 'tag-pill', 'data-tag': m[2].slice(1) }))
    }
    return false
  })
  return DecorationSet.create(state.doc, decos)
}

export const suggest = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: (_, state) => decorations(state),
        apply: (tr, set, _old, state) => (tr.docChanged ? decorations(state) : set),
      },
      view(view) {
        popup = new SuggestPopup(view)
        return {
          update: (v) => popup?.update(v),
          destroy: () => {
            popup?.hide()
            popup = null
          },
        }
      },
      props: {
        decorations(state) {
          return this.getState(state)
        },
        handleKeyDown(_view, e) {
          if (!popup?.open) return false
          if (e.key === 'ArrowDown') popup.move(1)
          else if (e.key === 'ArrowUp') popup.move(-1)
          else if (e.key === 'Enter' || e.key === 'Tab') popup.choose()
          else if (e.key === 'Escape') popup.hide()
          else return false
          return true
        },
        handleDOMEvents: {
          blur: () => {
            popup?.hide()
            return false
          },
          // 单击 [[链接]] 或 #标签 跳转（和 Bear 一致）
          mousedown: (_view, e) => {
            const el = (e.target as HTMLElement).closest?.('[data-wikilink], [data-tag]') as HTMLElement | null
            if (!el || e.button !== 0 || e.shiftKey) return false
            e.preventDefault()
            if (el.dataset.wikilink) navigation.openWikiLink(el.dataset.wikilink)
            else if (el.dataset.tag) navigation.openTag(el.dataset.tag.replace(/[，。,.;；:：!?！？)）]+$/, ''))
            return true
          },
        },
      },
    }),
)
