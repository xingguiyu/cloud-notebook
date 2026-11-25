import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** 源码模式和代码块共用的语法高亮，颜色走 CSS 变量，跟随深浅色 */
export const highlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--code)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-2)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--hl-string)' },
  { tag: t.comment, color: 'var(--text-2)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--hl-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--hl-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--hl-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--hl-property)' },
  { tag: [t.tagName], color: 'var(--hl-keyword)' },
])

export const highlighting = syntaxHighlighting(highlightStyle)
