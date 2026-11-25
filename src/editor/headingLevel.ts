import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { popupMenu } from '../native/menu'
import { t } from '../i18n'

/**
 * 标题左侧显示 H1–H6 级别（类似 Bear），点击弹出原生菜单改级别或转回正文。
 */
function changeLevel(view: EditorView, pos: number, level: number) {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  const { heading, paragraph } = view.state.schema.nodes
  const tr =
    level === 0
      ? view.state.tr.setNodeMarkup(pos, paragraph)
      : view.state.tr.setNodeMarkup(pos, heading, { ...node.attrs, level })
  view.dispatch(tr)
  view.focus()
}

function marker(view: EditorView, getPos: () => number | undefined, level: number) {
  const el = document.createElement('span')
  el.className = 'heading-level'
  el.textContent = `H${level}`
  el.contentEditable = 'false'
  el.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const pos = getPos()
    if (pos === undefined) return
    const at = pos - 1 // 标记放在标题内部开头，节点本身在它前一位
    popupMenu([
      ...[1, 2, 3, 4, 5, 6].map((l) => ({
        text: t('标题 {n}', { n: l }),
        checked: l === level,
        action: () => changeLevel(view, at, l),
      })),
      '-',
      { text: t('正文'), checked: false, action: () => changeLevel(view, at, 0) },
    ])
  })
  return el
}

function build(doc: Node) {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = node.attrs.level as number
      decos.push(
        Decoration.widget(pos + 1, (v, getPos) => marker(v, getPos, level), {
          side: -1,
          key: `h${level}`,
          ignoreSelection: true,
        }),
      )
      return false
    }
    return node.isBlock && !node.isTextblock
  })
  return DecorationSet.create(doc, decos)
}

export const headingLevel = $prose(
  () =>
    new Plugin({
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, set) => (tr.docChanged ? build(tr.doc) : set),
      },
      props: {
        decorations(state) {
          return this.getState(state)
        },
      },
    }),
)
