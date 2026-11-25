/**
 * 把 Markdown 渲染成要用 `v-html` 放进界面的 HTML 之前，过一遍这里的 rehype 插件。
 *
 * 笔记和 AI 的回答都算不可信内容：笔记可能是同步、粘贴或 AI 工具导入进来的，回答可能被笔记里的文字带偏。
 * 界面里跑起来的脚本能调用应用的全部后端命令，所以这里只在语法树上动手，不对拼好的 HTML 字符串做替换
 * （字符串替换会改到属性里面，把属性提前闭合，剩下的内容就成了活的标签）。
 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/** 链接只允许 http、https、mailto、tel 和不带协议的相对地址；javascript:、data:、vault: 之类一律去掉 */
export function safeHref(href: unknown): boolean {
  if (typeof href !== 'string') return false
  // 浏览器解析地址时会忽略里面的空白和控制字符，`java\nscript:` 一样是 javascript:
  const h = href.replace(/[\u0000- \u007f-\u009f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1].toLowerCase()
  return scheme === undefined || ['http', 'https', 'mailto', 'tel'].includes(scheme)
}

const localImage = (src: unknown) => typeof src === 'string' && (/^(data:image\/|vault:|blob:)/i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src) || /^https?:\/\/vault\.localhost\//i.test(src))

function walk(node: Node, fn: (node: Node, parents: Node[]) => Node[] | void, parents: Node[] = []) {
  if (!node.children) return
  const out: Node[] = []
  for (const child of node.children) {
    const replaced = fn(child, [...parents, node])
    if (replaced) out.push(...replaced)
    else {
      out.push(child)
      walk(child, fn, [...parents, node])
    }
  }
  node.children = out
}

export interface SafeOptions {
  /** 远程图片是否保留。AI 的回答里不保留：图片地址可以被用来把别的笔记内容带出去 */
  remoteImages?: boolean
}

/** 去掉危险的链接地址、事件属性；按需把远程图片换成文字 */
export function rehypeSafe(options: SafeOptions = {}) {
  return (tree: Node) =>
    walk(tree, (node) => {
      if (node.type !== 'element') return
      // 这条渲染链本来就不产生这些标签；万一以后放开了原始 HTML，这里兜底
      if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'meta', 'link', 'base'].includes(node.tagName ?? '')) return []
      const props = (node.properties ??= {})
      for (const key of Object.keys(props)) if (/^on/i.test(key) || key === 'srcDoc' || key === 'style') delete props[key]
      if (node.tagName === 'a' && !safeHref(props.href)) delete props.href
      if (node.tagName === 'img' && !options.remoteImages && !localImage(props.src)) {
        const label = String(props.alt || props.src || '')
        return [{ type: 'text', value: label ? `[${label}]` : '' }]
      }
    })
}

/**
 * 把正文里的 [1]、[2] 换成可点的引用编号。只换文字节点，链接和代码里的不动。
 * `has(n)` 说明第 n 条资料存不存在，不存在的原样留着。
 */
export function rehypeCitations(has: (n: number) => boolean) {
  return (tree: Node) =>
    walk(tree, (node, parents) => {
      if (node.type !== 'text' || !node.value || parents.some((p) => ['a', 'code', 'pre'].includes(p.tagName ?? ''))) return
      const parts = node.value.split(/(\[\d+\])/)
      if (parts.length === 1) return
      return parts
        .filter((s) => s)
        .map((s): Node => {
          const n = /^\[(\d+)\]$/.exec(s)?.[1]
          return n && has(Number(n)) ? { type: 'element', tagName: 'a', properties: { className: ['cite'], 'data-n': n }, children: [{ type: 'text', value: n }] } : { type: 'text', value: s }
        })
    })
}
