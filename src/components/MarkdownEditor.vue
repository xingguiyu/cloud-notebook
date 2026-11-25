<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { DOMParser as PMParser, DOMSerializer } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload'
import {
  createCodeBlockCommand,
  imageSchema,
  insertHrCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark'
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { openUrl } from '@tauri-apps/plugin-opener'
import { listen } from '@tauri-apps/api/event'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose, $view, callCommand, getMarkdown, insert, replaceAll } from '@milkdown/kit/utils'
import { codeBlockComponent, codeBlockConfig } from '@milkdown/kit/component/code-block'
import { languages } from '@codemirror/language-data'
import { EditorView as CMView } from '@codemirror/view'
import SourceEditor from './SourceEditor.vue'
import { t } from '../i18n'
import { highlighting } from '../editor/cmTheme'
import { headingLevel } from '../editor/headingLevel'
import { suggest } from '../editor/suggest'
import { clearFind, findInfo, findPlugin, replaceCurrent, replaceEvery, setFind, stepFind } from '../editor/find'
import { highlight } from '../editor/highlight'
import { mapImages, paragraphBreaks, preferMarkdownText, type ClipImage } from '../editor/paste'
import { importImage, onImageDrop, resolveAsset, saveImage } from '../vault'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'

const props = defineProps<{ modelValue: string; source: boolean; notePath: string; highlight?: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const root = ref<HTMLElement>()
let editor: Editor | null = null
let unlistenDrop: (() => void) | undefined
let unlistenMenu: (() => void) | undefined
// 最近一次由编辑器自己产出的 markdown，用来区分外部切换笔记和自身输入
let lastEmitted = props.modelValue
// 编辑器把原文规范化后的结果。和它相同说明用户没改内容，不能回写，否则一打开笔记就会改动文件
let normalized: string | null = null
/** 这次打开之后发出过几次修改 */
let emitted = 0

/** Lucide 图标的 SVG 字符串，给只接受 HTML 字符串的 Milkdown 组件用 */
function icon(paths: string) {
  return `<svg class="lucide-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
}

// Markdown 里存相对路径，显示时换成 vault:// 地址
const imageView = $view(imageSchema.node, () => (node) => {
  const img = document.createElement('img')
  const apply = (n: typeof node) => {
    img.src = resolveAsset(props.notePath, n.attrs.src)
    img.alt = n.attrs.alt ?? ''
    img.title = n.attrs.title ?? ''
  }
  apply(node)
  return {
    dom: img,
    update: (n) => {
      if (n.type !== node.type) return false
      apply(n)
      return true
    },
  }
})

/** 序列化时行首 #标签 会被转义成 \#标签；#后面不是空格就不会被当成标题，去掉转义 */
const unescapeTags = (md: string) => md.replace(/^(\s*)\\#(?=[^\s#\\])/gm, '$1#')

/** `文字` 自动变行内代码：输入法打出的反引号不触发输入规则，这里在每次输入后补上 */
const inlineCodeAuto = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((t) => t.docChanged) || !state.selection.empty) return null
        const code = state.schema.marks.inlineCode ?? state.schema.marks.code_inline
        const { $from } = state.selection
        const block = $from.parent
        if (!code || !block.isTextblock || block.type.spec.code) return null
        const start = $from.start()
        const text = block.textBetween(0, $from.parentOffset, undefined, '\ufffc')
        const m = text.match(/(^|[^`])`([^`\ufffc]+)`$/)
        if (!m) return null
        const to = start + text.length
        const from = to - m[2].length - 2
        if (state.doc.rangeHasMark(from, to, code)) return null
        const tr = state.tr.delete(to - 1, to).delete(from, from + 1)
        tr.addMark(from, to - 2, code.create()).removeStoredMark(code)
        return tr
      },
    }),
)

/** 临时图片地址（blob: / data:）只在这次运行里有效，存成笔记库里的文件再把地址换掉 */
const isTempImage = (src: string) => /^(blob:|data:image\/)/i.test(src)
async function persistTempImages(view: EditorView) {
  const found: { src: string; alt: string }[] = []
  view.state.doc.descendants((n) => {
    if (n.type.name === 'image' && isTempImage(n.attrs.src)) found.push({ src: n.attrs.src, alt: n.attrs.alt ?? '' })
  })
  const saved = new Map<string, string>()
  for (const { src, alt } of found) {
    if (saved.has(src)) continue
    try {
      const blob = await (await fetch(src)).blob()
      if (!blob.type.startsWith('image/')) continue
      saved.set(src, await saveImage(props.notePath, new File([blob], alt || 'image', { type: blob.type })))
    } catch (e) {
      console.warn('粘贴的图片保存失败', e)
    }
  }
  if (!saved.size || view.isDestroyed) return
  const tr = view.state.tr
  view.state.doc.descendants((n, pos) => {
    const to = n.type.name === 'image' && saved.get(n.attrs.src)
    if (to) tr.setNodeMarkup(pos, undefined, { ...n.attrs, src: to, title: n.attrs.title === n.attrs.alt ? '' : n.attrs.title })
  })
  view.dispatch(tr)
}

/**
 * 粘贴：从 Bear 等 Markdown 应用复制时，剪贴板的纯文本才是完整的 Markdown（富文本里标题只是加粗、
 * 图片是临时地址），按 Markdown 解析；粘贴进来的临时图片一律存进笔记库。要排在 Milkdown 的 clipboard 前面。
 */
const smartPaste = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handlePaste(view, event) {
          const data = event.clipboardData
          if (!data || view.state.selection.$from.parent.type.spec.code) return false
          const text = data.getData('text/plain')
          const html = data.getData('text/html')
          // 其它情况走默认粘贴，等内容进了文档再把临时图片存下来
          if (data.getData('vscode-editor-data') || !preferMarkdownText(text, html)) {
            if (/src=["']?(blob:|data:image\/)/i.test(html)) setTimeout(() => persistTempImages(view), 0)
            return false
          }
          const images: ClipImage[] = []
          if (html) {
            const doc = new DOMParser().parseFromString(html, 'text/html')
            for (const img of doc.querySelectorAll('img[src]'))
              images.push({ src: img.getAttribute('src')!, name: img.getAttribute('alt') || img.getAttribute('title') || '' })
          }
          const md = mapImages(paragraphBreaks(text), images)
          const parsed = ctx.get(parserCtx)(md)
          if (!parsed || typeof parsed === 'string') return false
          const schema = view.state.schema
          const dom = DOMSerializer.fromSchema(schema).serializeFragment(parsed.content)
          try {
            view.dispatch(view.state.tr.replaceSelection(PMParser.fromSchema(schema).parseSlice(dom)).scrollIntoView())
          } catch {
            return false
          }
          persistTempImages(view)
          return true
        },
      },
    }),
)

onMounted(async () => {
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root.value!)
      ctx.set(defaultValueCtx, props.modelValue)
      ctx.update(editorViewOptionsCtx, (o) => ({ ...o, attributes: { spellcheck: 'false' } }))
      // 代码块：内嵌 CodeMirror 高亮，可选语言、一键复制
      ctx.update(codeBlockConfig.key, (prev) => ({
        ...prev,
        languages,
        extensions: [highlighting, CMView.lineWrapping, CMView.theme({ '&.cm-focused': { outline: 'none' } })],
        searchPlaceholder: t('搜索语言'),
        noResultText: t('没有匹配的语言'),
        copyText: t('复制'),
        expandIcon: icon('<path d="m6 9 6 6 6-6"/>'),
        searchIcon: icon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
        clearSearchIcon: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        copyIcon: icon('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
        // 返回值按纯文本渲染；选中项的对勾用 CSS（aria-selected）画
        renderLanguage: (lang) => lang,
        onCopy: () => {},
      }))
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        uploader: async (files, schema) => {
          const images = [...files].filter((f) => f.type.startsWith('image/'))
          const paths = await Promise.all(images.map((f) => saveImage(props.notePath, f)))
          return paths.map((src) => schema.nodes.image.createAndFill({ src, alt: '' })!)
        },
      }))
      ctx.get(listenerCtx).markdownUpdated((_, raw) => {
        const md = unescapeTags(raw)
        // 和上次发出去的一样才跳过。以前是和刚打开时的内容比，结果「改了又改回去」的那一步不会保存
        if (normalized === null || md === lastEmitted || (emitted === 0 && md === normalized)) return
        emitted++
        lastEmitted = md
        emit('update:modelValue', md)
      })
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(smartPaste)
    .use(clipboard)
    .use(listener)
    .use(trailing)
    .use(upload)
    .use(imageView)
    .use(codeBlockComponent)
    .use(headingLevel)
    .use(suggest)
    .use(inlineCodeAuto)
    .use(findPlugin)
    .use(highlight)
    .create()
  normalized = unescapeTags(editor.action(getMarkdown()))
  // 从搜索结果打开：高亮搜索词并滚到第一处
  if (props.highlight?.length && !props.source) setFind(view(), props.highlight, true)

  // 按住 ⌘ 点链接在浏览器打开（和 Bear 一致；不按 ⌘ 是正常编辑）
  root.value!.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    if (e.metaKey || e.ctrlKey) openUrl(a.href)
  })

  // 点任务列表左侧的复选框切换完成状态
  root.value!.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest?.("li[data-item-type='task']") as HTMLElement | null
    if (!li || !editor || e.clientX > li.getBoundingClientRect().left) return
    e.preventDefault()
    const view = editor.ctx.get(editorViewCtx)
    const pos = view.posAtDOM(li, 0) - 1
    const node = view.state.doc.nodeAt(pos)
    if (node) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }))
  })

  // 格式菜单 ⌘0–⌘6；源码模式由 SourceEditor 自己处理
  unlistenMenu = await listen<string>('menu', ({ payload }) => {
    const m = payload.match(/^heading-(\d)$/)
    if (!m || props.source || !editor) return
    const level = Number(m[1])
    editor.action(level ? callCommand(wrapInHeadingCommand.key, level) : callCommand(turnIntoTextCommand.key))
  })

  unlistenDrop = await onImageDrop(
    () => (props.source ? undefined : root.value),
    async (paths, x, y) => {
      if (!editor) return
      const rels = await Promise.all(paths.map((p) => importImage(props.notePath, p)))
      const view = editor.ctx.get(editorViewCtx)
      const { schema } = view.state
      const at = view.posAtCoords({ left: x, top: y })?.pos ?? view.state.selection.from
      const nodes = rels.map((src) => schema.nodes.image.createAndFill({ src, alt: '' })!)
      view.dispatch(view.state.tr.insert(at, nodes).scrollIntoView())
      view.focus()
    },
  )
})

const view = () => editor!.ctx.get(editorViewCtx)

// ---- 笔记内查找替换（⌘F） ----
const find = reactive({ open: false, query: '', replace: '', withReplace: false, count: 0, index: -1 })
const findInput = ref<HTMLInputElement>()
const syncFind = (info: { count: number; index: number }) => Object.assign(find, info)
async function openFind(withReplace = false) {
  if (!editor || props.source) return false
  const sel = selectionText()
  find.open = true
  find.withReplace = withReplace || find.withReplace
  if (sel && !sel.includes('\n')) find.query = sel
  else if (!find.query && props.highlight?.length) find.query = props.highlight[0]
  syncFind(setFind(view(), find.query ? [find.query] : []))
  await nextTick()
  findInput.value?.focus()
  findInput.value?.select()
  return true
}
function closeFind() {
  if (!find.open) return
  find.open = false
  if (editor) {
    clearFind(view(), true)
    view().focus()
  }
}
watch(
  () => find.query,
  (q) => find.open && editor && syncFind(setFind(view(), q ? [q] : [])),
)
const findStep = (dir: 1 | -1) => editor && syncFind(stepFind(view(), dir))
const findReplace = () => editor && syncFind(replaceCurrent(view(), find.replace))
function findReplaceAll() {
  if (!editor) return
  replaceEvery(view(), find.replace)
  syncFind(findInfo(view()))
}
function onFindKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Escape') closeFind()
  else if (e.key === 'Enter') findStep(e.shiftKey ? -1 : 1)
  else if (e.key.toLowerCase() === 'g' && e.metaKey) findStep(e.shiftKey ? -1 : 1)
  else return
  e.preventDefault()
}
// 搜索词变了（或清空了）：没开查找栏时跟着更新高亮
watch(
  () => props.highlight,
  (terms) => !find.open && editor && !props.source && setFind(view(), terms ?? [], true),
)

// ---- 图片双击放大 ----
const zoomed = ref<string | null>(null)
function onDblClick(e: MouseEvent) {
  const img = e.target as HTMLElement
  if (img instanceof HTMLImageElement && img.closest('.ProseMirror') && img.src) zoomed.value = img.src
}

export type FormatCommand =
  | 'bold' | 'italic' | 'strike' | 'code' | 'bullet' | 'ordered' | 'todo' | 'quote'
  | 'codeblock' | 'table' | 'hr' | 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/** 格式工具栏调用的命令 */
function exec(cmd: FormatCommand) {
  if (!editor) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (key: any, payload?: unknown) => editor!.action(callCommand(key, payload))
  const h = cmd.match(/^h(\d)$/)
  if (h) run(wrapInHeadingCommand.key, Number(h[1]))
  else if (cmd === 'paragraph') run(turnIntoTextCommand.key)
  else if (cmd === 'bold') run(toggleStrongCommand.key)
  else if (cmd === 'italic') run(toggleEmphasisCommand.key)
  else if (cmd === 'strike') run(toggleStrikethroughCommand.key)
  else if (cmd === 'code') run(toggleInlineCodeCommand.key)
  else if (cmd === 'bullet') run(wrapInBulletListCommand.key)
  else if (cmd === 'ordered') run(wrapInOrderedListCommand.key)
  else if (cmd === 'quote') run(wrapInBlockquoteCommand.key)
  else if (cmd === 'codeblock') run(createCodeBlockCommand.key)
  else if (cmd === 'table') run(insertTableCommand.key, { row: 3, col: 3 })
  else if (cmd === 'hr') run(insertHrCommand.key)
  else if (cmd === 'todo') toggleTodo()
  editor.ctx.get(editorViewCtx).focus()
}

/** 当前段落变成待办；已经是待办则取消 */
function toggleTodo() {
  const view = editor!.ctx.get(editorViewCtx)
  const { $from } = view.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'list_item') {
      const checked = node.attrs.checked == null ? false : null
      view.dispatch(view.state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked }))
      return
    }
  }
  editor!.action(callCommand(wrapInBulletListCommand.key))
  const s = editor!.ctx.get(editorViewCtx).state
  const $p = s.selection.$from
  for (let d = $p.depth; d > 0; d--) {
    if ($p.node(d).type.name === 'list_item') {
      view.dispatch(s.tr.setNodeMarkup($p.before(d), undefined, { ...$p.node(d).attrs, checked: false }))
      return
    }
  }
}

function setLink(href: string) {
  if (!editor) return
  editor.action(callCommand(toggleLinkCommand.key, { href }))
  editor.ctx.get(editorViewCtx).focus()
}

async function insertImages(paths: string[]) {
  if (!editor) return
  for (const p of paths) {
    const src = await importImage(props.notePath, p)
    editor.action(callCommand(insertImageCommand.key, { src, alt: '' }))
  }
}

/** 信息面板里的大纲：滚动到第 i 个标题 */
function scrollToHeading(i: number) {
  const h = root.value?.querySelectorAll('.ProseMirror > h1, .ProseMirror > h2, .ProseMirror > h3, .ProseMirror > h4, .ProseMirror > h5, .ProseMirror > h6')[i]
  h?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const sourceRef = ref<InstanceType<typeof SourceEditor>>()

/** 当前选中的文字（AI 面板用） */
function selectionText() {
  if (props.source) return sourceRef.value?.selectionText() ?? ''
  if (!editor) return ''
  const { state } = editor.ctx.get(editorViewCtx)
  return state.doc.textBetween(state.selection.from, state.selection.to, '\n')
}

/** 在光标处插入一段 Markdown（AI 回答插入笔记） */
function insertMarkdown(markdown: string) {
  if (props.source) return sourceRef.value?.insert(`\n${markdown}\n`)
  if (!editor) return
  editor.action(insert(markdown))
  editor.ctx.get(editorViewCtx).focus()
}

defineExpose({ exec, setLink, insertImages, scrollToHeading, selectionText, insertMarkdown, openFind, closeFind })

watch(
  () => props.modelValue,
  (md) => {
    if (md !== lastEmitted && editor) {
      lastEmitted = md
      normalized = null
      editor.action(replaceAll(md, true))
      normalized = unescapeTags(editor.action(getMarkdown()))
    }
  },
)

onBeforeUnmount(() => {
  unlistenMenu?.()
  unlistenDrop?.()
  // 编辑器把修改攒 200ms 再通知，销毁时没通知的那一段会被丢掉：这里先把当前内容取出来发出去
  try {
    if (editor && normalized !== null) {
      const md = unescapeTags(editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)))
      if (md !== lastEmitted && !(emitted === 0 && md === normalized)) {
        lastEmitted = md
        emit('update:modelValue', md)
      }
    }
  } catch {}
  editor?.destroy()
})

</script>

<template>
  <div class="editor-wrap" @dblclick="onDblClick">
    <div v-if="find.open && !source" class="find-bar no-drag" @keydown="onFindKey">
      <div class="find-row">
        <button class="find-btn" :class="{ on: find.withReplace }" :title="$t('显示替换')" @click="find.withReplace = !find.withReplace">⇄</button>
        <input ref="findInput" v-model="find.query" class="find-input" :placeholder="$t('在笔记中查找')" spellcheck="false" />
        <span class="find-count" :class="{ none: !!find.query && !find.count }">{{ find.query ? (find.count ? `${find.index + 1} / ${find.count}` : $t('无结果')) : '' }}</span>
        <button class="find-btn" :title="$t('上一个 ⇧↩')" :disabled="!find.count" @click="findStep(-1)">↑</button>
        <button class="find-btn" :title="$t('下一个 ↩')" :disabled="!find.count" @click="findStep(1)">↓</button>
        <button class="find-btn" :title="$t('关闭 Esc')" @click="closeFind">✕</button>
      </div>
      <div v-if="find.withReplace" class="find-row">
        <span class="find-btn ghost" />
        <input v-model="find.replace" class="find-input" :placeholder="$t('替换为')" spellcheck="false" />
        <button class="find-text" :disabled="!find.count" @click="findReplace">{{ $t('替换') }}</button>
        <button class="find-text" :disabled="!find.count" @click="findReplaceAll">{{ $t('全部替换') }}</button>
      </div>
    </div>
    <div v-if="zoomed" class="img-zoom" @click="zoomed = null" @keydown.esc="zoomed = null"><img :src="zoomed" /></div>
    <div v-show="!source" ref="root" class="md-wysiwyg" />
    <SourceEditor
      v-if="source"
      ref="sourceRef"
      :model-value="modelValue"
      :note-path="notePath"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>

<style>
/* 查找栏：贴在编辑区右上角，跟着滚动条不动 */
.find-bar {
  position: sticky;
  top: 8px;
  z-index: 6;
  float: right;
  margin: 8px 16px -100px 0;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-editor);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.16);
  font-size: 13px;
}
.find-row { display: flex; align-items: center; gap: 4px; }
.find-input {
  width: 200px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--code-bg);
  color: var(--text);
  font: inherit;
  outline: none;
  user-select: text;
  -webkit-user-select: text;
}
.find-input:focus { border-color: var(--accent); }
.find-count { min-width: 52px; text-align: center; color: var(--text-2); font-variant-numeric: tabular-nums; font-size: 12px; }
.find-count.none { color: #d14343; }
.find-btn { width: 26px; height: 26px; border-radius: 6px; color: var(--text-2); display: grid; place-items: center; }
.find-btn.ghost { visibility: hidden; }
.find-btn:hover:not(:disabled), .find-btn.on, .find-text:hover:not(:disabled) { background: var(--selected); color: var(--text); }
.find-btn:disabled, .find-text:disabled { opacity: 0.35; }
.find-text { height: 26px; padding: 0 9px; border-radius: 6px; color: var(--text-2); white-space: nowrap; }
.find-hit { background: color-mix(in srgb, #f5c400 40%, transparent); border-radius: 2px; }
.find-hit.current { background: #ff9d00; color: #1d1d1f; }
.ProseMirror mark.md-highlight { background: color-mix(in srgb, #ffd60a 55%, transparent); color: inherit; border-radius: 3px; padding: 0.05em 0.1em; }
.md-wysiwyg .ProseMirror img { cursor: zoom-in; }
.img-zoom {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.78);
  cursor: zoom-out;
}
.img-zoom img { max-width: 94vw; max-height: 94vh; border-radius: 6px; box-shadow: 0 12px 50px rgba(0, 0, 0, 0.5); }
.editor-wrap {
  height: 100%;
  overflow-y: auto;
}
.editor-wrap:has(.source-editor) {
  overflow: hidden;
}
.md-wysiwyg .ProseMirror {
  max-width: calc(var(--doc-width) + 96px);
  margin: 0 auto;
  padding: 28px 48px 30vh;
  min-height: 100%;
  font-family: var(--doc-font);
  font-size: var(--doc-size);
  line-height: var(--doc-line);
  color: var(--text);
  outline: none;
}
/* [[双向链接]] 和 #标签：单击跳转 */
.ProseMirror .wikilink {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent);
  text-underline-offset: 3px;
  cursor: pointer;
}
.ProseMirror .tag-pill {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 0.9em;
  cursor: pointer;
}
.suggest-popup {
  position: fixed;
  z-index: 50;
  min-width: 200px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-editor);
  border: 1px solid var(--border);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  font: 13px var(--font-ui);
  color: var(--text);
}
.suggest-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 10px;
  border-radius: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.suggest-item.active {
  background: var(--accent);
  color: #fff;
}
.suggest-hint {
  font-size: 11px;
  opacity: 0.7;
}

/* 标题级别标记：放在左侧留白里 */
.ProseMirror h1, .ProseMirror h2, .ProseMirror h3,
.ProseMirror h4, .ProseMirror h5, .ProseMirror h6 { position: relative; }
.heading-level {
  position: absolute;
  right: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  font: 600 11px/1 var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  opacity: 0.45;
  padding: 3px 5px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.heading-level:hover { opacity: 1; background: var(--selected); }
.hide-heading-level .heading-level { display: none; }

/* 代码块组件 */
.milkdown-code-block {
  display: block;
  position: relative;
  margin: 1em 0;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.milkdown-code-block .tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px 0;
  font: 12px var(--font-ui);
  color: var(--text-2);
}
.milkdown-code-block .tools-button-group { display: flex; gap: 6px; }
.milkdown-code-block .language-button,
.milkdown-code-block .copy-button,
.milkdown-code-block .preview-toggle-button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 5px;
  color: var(--text-2);
  cursor: pointer;
}
.milkdown-code-block .copy-button { opacity: 0; }
.milkdown .language-list-item[aria-selected='true'] { color: var(--accent); font-weight: 600; }
.milkdown .language-list-item[aria-selected='true']::before {
  content: '';
  display: inline-block;
  width: 13px;
  height: 13px;
  margin-right: 4px;
  vertical-align: -2px;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/contain no-repeat;
}
.lucide-inline { width: 13px; height: 13px; vertical-align: -2px; margin-right: 3px; }
.milkdown-code-block .expand-icon, .milkdown-code-block .search-icon { display: flex; color: var(--text-2); }
.milkdown-code-block:hover .copy-button { opacity: 1; }
.milkdown-code-block .language-button:hover,
.milkdown-code-block .copy-button:hover { background: var(--selected); color: var(--text); }
.milkdown-code-block .language-picker {
  position: absolute;
  z-index: 10;
  top: 32px;
  left: 10px;
  width: 200px;
  background: var(--bg-editor);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 6px;
}
.milkdown-code-block .language-picker:empty { display: none; }
.milkdown-code-block .search-box { display: flex; align-items: center; margin-bottom: 4px; }
.milkdown-code-block .search-input {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: var(--selected);
  color: var(--text);
  font: 12px var(--font-ui);
}
.milkdown-code-block .list-wrapper { max-height: 240px; overflow-y: auto; }
.milkdown-code-block .language-list { list-style: none; margin: 0; padding: 0; }
.milkdown-code-block .language-list-item {
  padding: 4px 8px;
  border-radius: 5px;
  font: 12px var(--font-ui);
  color: var(--text);
  cursor: pointer;
}
.milkdown-code-block .language-list-item:hover { background: var(--selected); }
.milkdown-code-block .language-list-item.no-result { color: var(--text-2); cursor: default; }
.milkdown-code-block .cm-editor { background: transparent; }
.milkdown-code-block .cm-scroller { font: 13.5px/1.65 var(--font-mono); padding: 6px 6px 10px; }
.milkdown-code-block .cm-gutters { display: none; }
.milkdown-code-block .preview-panel:empty,
.milkdown-code-block .preview-panel { display: none; }

/*
 * 排版间距：段落间距由 --doc-para 控制；标题上方留白约为下方的 2–2.5 倍（乘 --doc-heading），
 * 让标题贴近下面的内容。首个元素不留上边距。
 */
.ProseMirror > :first-child { margin-top: 0; }
.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6 {
  line-height: 1.35;
  font-weight: 700;
}
.ProseMirror h1 { font-size: 1.75em; margin: calc(1.1em * var(--doc-heading)) 0 0.45em; }
.ProseMirror h2 { font-size: 1.4em; margin: calc(1.1em * var(--doc-heading)) 0 0.4em; }
.ProseMirror h3 { font-size: 1.18em; margin: calc(1em * var(--doc-heading)) 0 0.35em; }
.ProseMirror h4, .ProseMirror h5, .ProseMirror h6 { font-size: 1em; margin: calc(0.9em * var(--doc-heading)) 0 0.3em; }
.ProseMirror p { margin: var(--doc-para) 0; }
.ProseMirror ul, .ProseMirror ol { margin: var(--doc-para) 0; padding-left: 1.6em; }
/* 列表项里的段落不加段距，项与项之间留一点间隔 */
.ProseMirror li > p { margin: 0; }
.ProseMirror li + li { margin-top: 0.2em; }
.ProseMirror li > ul, .ProseMirror li > ol { margin: 0.2em 0; }
.ProseMirror li::marker { color: var(--accent); }
.ProseMirror ol > li::marker { font-variant-numeric: tabular-nums; font-weight: 500; }
.ProseMirror a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent);
  text-underline-offset: 3px;
  transition: text-decoration-color 0.12s;
}
.ProseMirror a:hover { text-decoration-color: var(--accent); }
.ProseMirror blockquote { border-left-color: var(--accent); }
.ProseMirror hr { border-top-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.ProseMirror blockquote {
  margin: 1em 0;
  padding-left: 14px;
  border-left: 3px solid var(--accent);
  color: var(--text-2);
}
.ProseMirror code {
  font: 0.88em var(--font-mono);
  background: var(--selected);
  padding: 2px 5px;
  border-radius: 4px;
}
.ProseMirror pre {
  background: var(--selected);
  padding: 12px 16px;
  border-radius: 8px;
  overflow-x: auto;
}
.ProseMirror pre code { background: none; padding: 0; }
.ProseMirror table { border-collapse: collapse; margin: calc(var(--doc-para) * 1.5) 0; }
.ProseMirror td, .ProseMirror th { border: 1px solid var(--border); padding: 6px 10px; }
.ProseMirror img { max-width: 100%; border-radius: 6px; }
.ProseMirror li[data-item-type='task'] { list-style: none; position: relative; }
.ProseMirror li[data-item-type='task']::before {
  content: '';
  position: absolute;
  left: -1.5em;
  top: 0.45em;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--text-2);
  border-radius: 4px;
  cursor: pointer;
}
.ProseMirror li[data-item-type='task'][data-checked='true']::before {
  background: var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.5 2.5L12 5.5' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E") center/12px no-repeat;
  border-color: var(--accent);
}
.ProseMirror li[data-item-type='task'][data-checked='true'] > * { color: var(--text-2); text-decoration: line-through; }
.ProseMirror hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
</style>
