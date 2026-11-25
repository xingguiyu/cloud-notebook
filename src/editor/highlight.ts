import { $inputRule, $markSchema, $remark } from '@milkdown/kit/utils'
import { markRule } from '@milkdown/kit/prose'

/**
 * ==高亮== 语法（Bear、Obsidian 都支持，标准 Markdown 没有）。
 * 解析：在同一段的行内节点里找成对的 ==，把中间的内容包成 highlight 节点；序列化时再写回 ==…==。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdNode = any

/** 把 children 里成对的 == 包起来。开头的 == 后面、结尾的 == 前面不能是空格（a == b 不算） */
export function wrapHighlights(children: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  let open: MdNode[] | null = null
  const push = (n: MdNode) => (open ?? out).push(n)
  const pushText = (value: string) => {
    if (!value) return
    const target = open ?? out
    const last = target[target.length - 1]
    if (last?.type === 'text') last.value += value
    else target.push({ type: 'text', value })
  }
  const lastChar = () => {
    const last = (open ?? out).at(-1)
    return last ? (last.type === 'text' ? last.value.at(-1) : 'x') : ''
  }
  children.forEach((child, ci) => {
    if (child.type !== 'text') {
      if (Array.isArray(child.children) && child.type !== 'highlight') child.children = wrapHighlights(child.children)
      return push(child)
    }
    const pieces: string[] = child.value.split('==')
    pieces.forEach((piece, i) => {
      if (i > 0) {
        // 这个 == 后面紧跟的字符：本节点剩下的文字，没有的话看后面还有没有别的节点
        const next = piece[0] ?? (i === pieces.length - 1 && ci < children.length - 1 ? 'x' : '')
        const prev = lastChar()
        if (open && open.length && prev && !/\s/.test(prev)) {
          out.push({ type: 'highlight', children: open })
          open = null
        } else if (!open && next && !/[\s=]/.test(next)) {
          open = []
        } else {
          pushText('==')
        }
      }
      pushText(piece)
    })
  })
  // 没有配对的开头 ==：按原样留成文字
  if (open) {
    const rest: MdNode[] = open
    open = null
    pushText('==')
    for (const n of rest) n.type === 'text' ? pushText(n.value) : out.push(n)
  }
  return out
}

function walk(node: MdNode) {
  if (!Array.isArray(node.children)) return
  // 只处理直接装行内内容的节点；代码、行内代码没有 children，不会被动到
  if (node.children.some((c: MdNode) => c.type === 'text')) node.children = wrapHighlights(node.children)
  else node.children.forEach(walk)
}

export const remarkHighlight = $remark('remarkHighlight', () => function (this: MdNode) {
  const data = this.data()
  ;(data.toMarkdownExtensions ??= []).push({
    handlers: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      highlight: (node: MdNode, _: unknown, state: any, info: any) =>
        '==' + state.containerPhrasing(node, { ...info, before: '=', after: '=' }) + '==',
    },
  })
  return (tree: MdNode) => walk(tree)
})

export const highlightSchema = $markSchema('highlight', () => ({
  parseDOM: [{ tag: 'mark' }],
  toDOM: () => ['mark', { class: 'md-highlight' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'highlight',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'highlight')
    },
  },
}))

/** 输入 ==文字== 立刻变成高亮 */
export const highlightInputRule = $inputRule((ctx) => markRule(/(?<!=)==([^=\s](?:[^=]*[^=\s])?)==$/, highlightSchema.type(ctx)))

export const highlight = [remarkHighlight, highlightSchema, highlightInputRule].flat()
