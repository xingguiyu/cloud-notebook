<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlighting } from '../editor/cmTheme'
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { noteIndex, rankSuggestions } from '../store'
import { listen } from '@tauri-apps/api/event'
import { imageFiles, importImage, onImageDrop, saveImage } from '../vault'

const props = defineProps<{ modelValue: string; notePath: string }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const root = ref<HTMLElement>()
let view: EditorView | null = null
let unlistenDrop: (() => void) | undefined
let unlistenMenu: (() => void) | undefined

/** 把光标所在行设成 level 级标题，0 为正文 */
function setHeading(v: EditorView, level: number) {
  const line = v.state.doc.lineAt(v.state.selection.main.head)
  const prefix = line.text.match(/^#{1,6}\s+/)?.[0] ?? ''
  const insert = level ? '#'.repeat(level) + ' ' : ''
  v.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert } })
  v.focus()
}

const theme = EditorView.theme({
  '&': { height: '100%', background: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '14px', lineHeight: '1.75' },
  '.cm-content': { maxWidth: 'calc(var(--doc-width) + 96px)', margin: '0 auto', padding: '28px 48px 30vh', caretColor: 'var(--accent)' },
  '.cm-activeLine': { background: 'transparent' },
  '&.cm-focused .cm-activeLine': { background: 'var(--selected)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--bg-editor)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 10px 30px rgba(0,0,0,.2)',
    padding: '4px',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-ui)', fontSize: '13px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px', borderRadius: '5px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent)', color: '#fff' },
})

/** 应用菜单占用的快捷键，CodeMirror 自带的同名绑定（如 ⌘/ 切换注释）要让出来 */
const APP_KEYS = new Set([
  'Mod-/', 'Mod-\\', 'Shift-Mod-\\', 'Alt-Mod-\\', 'Mod-Alt-\\', 'Shift-Mod-i', 'Mod-Shift-i',
  'Mod-0', 'Mod-1', 'Mod-2', 'Mod-3', 'Mod-4', 'Mod-5', 'Mod-6', 'Mod-p', 'Mod-,', 'Shift-Mod-e', 'Shift-Mod-c', 'Alt-Mod-l', 'Mod-Alt-l', 'Mod-j',
])

/** 源码模式里同样补全 #标签 和 [[笔记]] */
function completeTagsAndLinks(ctx: CompletionContext) {
  const wiki = ctx.matchBefore(/\[\[[^\[\]\n]*/)
  if (wiki) {
    const q = wiki.text.slice(2)
    return {
      from: wiki.from,
      filter: false,
      options: rankSuggestions(noteIndex.value.titles, q, 20).map((t) => ({ label: t, apply: `[[${t}]]`, type: 'text' })),
    }
  }
  const tag = ctx.matchBefore(/(?:^|\s)#[^\s#]*/)
  if (tag) {
    const at = tag.from + tag.text.indexOf('#')
    const q = tag.text.slice(tag.text.indexOf('#') + 1)
    const options = rankSuggestions(noteIndex.value.tags, q, 20).map((t) => ({ label: `#${t}`, apply: `#${t} `, type: 'keyword' }))
    return options.length ? { from: at, filter: false, options } : null
  }
  return null
}

/** 粘贴图片：存进 assets/，在光标处插入 Markdown 图片语法 */
const pasteImage = EditorView.domEventHandlers({
  paste(e, v) {
    const files = imageFiles(e.clipboardData)
    if (!files.length) return false
    e.preventDefault()
    Promise.all(files.map((f) => saveImage(props.notePath, f))).then((paths) => {
      const text = paths.map((p) => `![](${p})`).join('\n')
      const { from, to } = v.state.selection.main
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    })
    return true
  },
})

onMounted(async () => {
  view = new EditorView({
    parent: root.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap.filter((b) => !APP_KEYS.has(b.key ?? b.mac ?? '')), ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        highlighting,
        theme,
        pasteImage,
        autocompletion({ override: [completeTagsAndLinks], icons: false }),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
      ],
    }),
  })
  view.focus()

  unlistenMenu = await listen<string>('menu', ({ payload }) => {
    const m = payload.match(/^heading-(\d)$/)
    if (m && view) setHeading(view, Number(m[1]))
  })

  unlistenDrop = await onImageDrop(
    () => root.value,
    async (paths, x, y) => {
      const v = view
      if (!v) return
      const rels = await Promise.all(paths.map((p) => importImage(props.notePath, p)))
      const text = rels.map((p) => `![](${p})`).join('\n')
      const at = v.posAtCoords({ x, y }) ?? v.state.selection.main.head
      v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
      v.focus()
    },
  )
})

defineExpose({
  selectionText: () => (view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : ''),
  insert(text: string) {
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    view.focus()
  },
})

onBeforeUnmount(() => {
  unlistenMenu?.()
  unlistenDrop?.()
  view?.destroy()
})
</script>

<template>
  <div ref="root" class="source-editor" />
</template>

<style>
.source-editor {
  height: 100%;
}
</style>
