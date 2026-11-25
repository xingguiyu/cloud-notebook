import { shallowRef } from 'vue'

/**
 * 编辑器插件需要的全局索引和跳转回调，由 App 维护。
 * 插件在 ProseMirror 里运行，拿不到组件上下文，所以放在模块级。
 */
export const noteIndex = shallowRef<{ titles: string[]; tags: string[] }>({ titles: [], tags: [] })

export const navigation = {
  openWikiLink: (_title: string) => {},
  openTag: (_tag: string) => {},
}

export const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g
/**
 * 和 parseTags 一致：# 前面是行首、空白或中文标点（如「标签：#入门」），
 * 后面不能是空格（那是标题）。英文字母、数字、/ 后面的 # 不算，避免把网址锚点当成标签。
 */
export const TAG_RE = /(^|[\s\u3000-\u303f\uff00-\uffef(（「『【])(#[^\s#，。、；：！？）」』】]+(?:\/[^\s#，。、；：！？）」』】]+)*)/g

/** 按输入过滤候选：前缀匹配排前面，其次是包含 */
export function rankSuggestions(items: string[], query: string, limit = 8) {
  const q = query.toLowerCase()
  const starts: string[] = []
  const contains: string[] = []
  for (const it of items) {
    const l = it.toLowerCase()
    if (l.startsWith(q)) starts.push(it)
    else if (l.includes(q)) contains.push(it)
  }
  return [...starts, ...contains].slice(0, limit)
}
