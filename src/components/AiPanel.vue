<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { rehypeCitations, rehypeSafe } from '../safeHtml'
import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { ArrowUp, Copy, FileText, FileType, Library, Paperclip, Square, Sparkles, TextCursorInput, X, History, SquarePen, Trash2 } from 'lucide-vue-next'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { AiAttachment } from '../ai/client'
import ModelSelect from './ModelSelect.vue'
import { hasAnyKey, refreshKeys } from '../ai/keys'
import { imageFromUrl, prepareImage } from '../ai/images'
import { noteImages, resolveAsset } from '../vault'
import { ask, describeError } from '../ai/client'
import { buildIndex, chunkNote, search, type Chunk } from '../ai/retrieve'
import { prefs } from '../prefs'
import { createSession, deleteSession, latestSession, sessions, type Session, type Turn } from '../ai/sessions'
import { t } from '../i18n'

const props = defineProps<{
  /** 可供检索的笔记（已排除加密笔记）：路径 → Markdown */
  notes: Record<string, string>
  titleOf: (path: string) => string
  currentPath: string | null
  /** 取编辑器当前选中的文字 */
  getSelection: () => string
}>()
const emit = defineEmits<{ close: []; open: [string]; insert: [string]; settings: [] }>()

const input = ref('')
const scope = ref<'vault' | 'note'>('vault')

// ---- 会话：「当前笔记」每篇笔记各自一个会话，「笔记库」单独一个；切换笔记时跟着切换 ----
const notePathFor = () => (scope.value === 'note' ? props.currentPath : null)
const session = ref<Session>(latestSession(scope.value, notePathFor()))
const turns = computed(() => session.value.turns)
const showHistory = ref(false)

function syncSession() {
  if (scope.value === 'note' && !props.currentPath) scope.value = 'vault'
  const s = session.value
  if (s.scope === scope.value && s.notePath === notePathFor()) return
  session.value = latestSession(scope.value, notePathFor())
  attachments.value = []
  selection.value = ''
}
watch(() => [scope.value, props.currentPath], syncSession)

function newChat() {
  showHistory.value = false
  if (!turns.value.length) return
  session.value = createSession(scope.value, notePathFor())
}
function openSession(s: Session) {
  showHistory.value = false
  if (s.scope === 'note' && s.notePath && s.notePath !== props.currentPath) {
    // 打开对应笔记，会话跟着笔记走
    emit('open', s.notePath)
  }
  scope.value = s.scope
  session.value = s
}
function removeSession(s: Session) {
  deleteSession(s.id)
  if (s.id === session.value.id) session.value = latestSession(scope.value, notePathFor())
}
const history = computed(() => [...sessions].filter((s) => s.turns.length).sort((a, b) => b.updated - a.updated))
const contextLabel = computed(() => (scope.value === 'note' && props.currentPath ? props.titleOf(props.currentPath) : t('整个笔记库')))
function when(t: number) {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toTimeString().slice(0, 5) : `${d.getMonth() + 1}/${d.getDate()}`
}
const busy = ref(false)
const hasKey = ref(true)
const selection = ref('')
const listEl = ref<HTMLElement>()
const inputEl = ref<HTMLTextAreaElement>()
let controller: AbortController | null = null

// ---- 附件：粘贴 / 拖入 / 选择的图片和 PDF ----
const attachments = ref<(AiAttachment & { preview?: string })[]>([])
const attachError = ref('')
const MAX_ATTACH = 8

async function addBlob(blob: Blob, name: string) {
  if (attachments.value.length >= MAX_ATTACH) return (attachError.value = t('最多附加 {n} 个文件', { n: MAX_ATTACH }))
  const img = await prepareImage(blob)
  attachments.value.push({ kind: 'image', name, ...img, preview: `data:${img.media_type};base64,${img.data}` })
}

function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  files.forEach((f, i) => addBlob(f, f.name || t('截图 {n}.png', { n: attachments.value.length + i + 1 })))
}

async function pickFiles() {
  const picked = await openDialog({ multiple: true, filters: [{ name: t('图片或 PDF'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'] }] })
  await addPaths(Array.isArray(picked) ? picked : picked ? [picked] : [])
}

async function addPaths(paths: string[]) {
  attachError.value = ''
  for (const path of paths) {
    try {
      const a = await invoke<{ name: string; media_type: string; data: string }>('ai_read_attachment', { path })
      if (a.media_type === 'application/pdf') attachments.value.push({ kind: 'pdf', ...a })
      else {
        const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))
        await addBlob(new Blob([bytes], { type: a.media_type }), a.name)
      }
    } catch (e) {
      attachError.value = String(e)
    }
  }
}

/** 「当前笔记」范围时，把笔记里引用的图片也交给模型（最多 6 张） */
async function collectNoteImages(notePath: string | null) {
  if (!notePath) return []
  const p = notePath
  const out: { name: string; media_type: string; data: string }[] = []
  for (const src of noteImages(props.notes[p] ?? '', 6)) {
    try {
      out.push({ name: src.split('/').pop()!, ...(await imageFromUrl(resolveAsset(p, src))) })
    } catch {}
  }
  return out
}

// 从访达拖进面板的图片 / PDF 作为附件（系统拖放由 Tauri 接管，网页拿不到路径）
let unlistenDrop: (() => void) | undefined
const panelEl = ref<HTMLElement>()

onMounted(async () => {
  unlistenDrop = await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type !== 'drop' || !panelEl.value) return
    const x = payload.position.x / window.devicePixelRatio
    const y = payload.position.y / window.devicePixelRatio
    const r = panelEl.value.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return
    addPaths(payload.paths)
  })
  await refreshKeys()
  hasKey.value = hasAnyKey()
  selection.value = props.getSelection()
  window.addEventListener('keydown', onKey)
  nextTick(() => inputEl.value?.focus())
})
onBeforeUnmount(() => {
  unlistenDrop?.()
  window.removeEventListener('keydown', onKey)
  controller?.abort()
})
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy.value && emit('close')

/** 回答渲染成 HTML，[n] 变成可点击的引用编号。回答算不可信内容：远程图片不加载，危险链接去掉，引用编号在语法树上替换 */
function render(t: Turn) {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSafe, { remoteImages: false })
      .use(rehypeCitations, (n: number) => !!t.sources?.[n - 1])
      .use(rehypeStringify)
      .processSync(t.text),
  )
}

function chunksFor(question: string, notePath: string | null): Chunk[] {
  if (notePath) {
    const p = notePath
    const all = chunkNote(p, props.titleOf(p), props.notes[p] ?? '')
    // 当前笔记整篇提供，过长时按相关度取前若干段
    const total = all.reduce((n, c) => n + c.text.length, 0)
    return total <= 60_000 ? all : search(buildIndex(all), question, 20, 99)
  }
  const chunks = Object.entries(props.notes).flatMap(([p, text]) => chunkNote(p, props.titleOf(p), text))
  return search(buildIndex(chunks), `${question} ${selection.value}`, 8, 3)
}

async function send(question = input.value.trim() || (attachments.value.length ? t('请看附件') : '')) {
  if (!question || busy.value) return
  if (!hasKey.value) return emit('settings')
  input.value = ''
  const sending = attachments.value.map(({ preview: _, ...a }) => a)
  attachments.value = []
  attachError.value = ''
  const sess = session.value
  const notePath = sess.notePath
  const history = sess.turns.filter((t) => !t.error && !t.pending).map((t) => ({ role: t.role, text: t.text }))
  if (!sess.title) sess.title = question.slice(0, 40)
  sess.updated = Date.now()
  sess.turns.push(
    { role: 'user', text: question, attached: sending.map((a) => a.name) },
    { role: 'assistant', text: '', pending: true },
  )
  // 取响应式代理来更新，界面才会跟着刷新
  const turn = sess.turns[sess.turns.length - 1]
  busy.value = true
  controller = new AbortController()
  scrollDown()
  try {
    const r = await ask(
      {
        question,
        model: prefs.aiModel,
        chunks: chunksFor(question, notePath),
        selection: selection.value,
        attachments: sending,
        noteImages: await collectNoteImages(notePath),
        history,
        signal: controller.signal,
      },
      (snap) => {
        turn.text = snap
        if (session.value === sess) scrollDown()
      },
    )
    turn.text = r.text
    turn.sources = r.sources
  } catch (e) {
    turn.error = describeError(e)
  } finally {
    turn.pending = false
    sess.updated = Date.now()
    busy.value = false
    controller = null
    // 选中文字只用于这一次提问
    selection.value = ''
    scrollDown()
  }
}

function stop() {
  controller?.abort()
}

function scrollDown() {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
}

function onAnswerClick(e: MouseEvent, t: Turn) {
  const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  const n = a.dataset.n
  const src = n ? t.sources?.[Number(n) - 1] : undefined
  if (src?.path) emit('open', src.path)
}

/** 去掉引用标记，复制/插入纯净的 Markdown */
const plain = (t: Turn) => t.text.replace(/\[\d+\]/g, '')
async function copy(t: Turn) {
  await writeText(plain(t))
}

const QUICK = [
  { label: t('总结'), prompt: t('用几条要点总结选中的内容。') },
  { label: t('改写'), prompt: t('把选中的内容改写得更通顺、更简洁，保持原意。') },
  { label: t('续写'), prompt: t('顺着选中内容的风格和思路续写一段。') },
  { label: t('翻译'), prompt: t('把选中的内容翻译成英文（如果原文是英文就翻译成中文）。') },
]
const suggestions = computed(() =>
  scope.value === 'note' ? [t('总结这篇笔记的要点'), t('这篇笔记里有哪些待办？'), t('帮我列一个大纲')] : [t('我最近在关注哪些事情？'), t('帮我找找关于某个主题的笔记')],
)

function onEnter(e: KeyboardEvent) {
  if (e.isComposing || e.shiftKey) return
  e.preventDefault()
  send()
}
</script>

<template>
  <aside ref="panelEl" class="ai-panel">
    <header class="ai-head">
      <Sparkles :size="15" class="ai-logo" />
      <span class="ai-title">{{ $t('问 AI') }}</span>
      <div class="segmented small">
        <button :class="{ active: scope === 'vault' }" :title="$t('从整个笔记库检索相关内容')" @click="scope = 'vault'">
          <Library :size="12" /> {{ $t('笔记库') }}
        </button>
        <button :class="{ active: scope === 'note' }" :disabled="!currentPath" :title="$t('只基于当前笔记')" @click="scope = 'note'">
          <FileText :size="12" /> {{ $t('当前笔记') }}
        </button>
      </div>
      <span class="spacer" />
      <ModelSelect compact />
      <button class="icon-btn" :title="$t('关闭 Esc')" @click="emit('close')"><X :size="15" /></button>
    </header>
    <div class="ai-context">
      <span class="ctx-label" :title="contextLabel">
        <FileText v-if="scope === 'note'" :size="11" /><Library v-else :size="11" /> {{ $t('基于：{name}', { name: contextLabel }) }}
      </span>
      <button class="icon-btn" :class="{ on: showHistory }" :title="$t('会话历史')" @click="showHistory = !showHistory"><History :size="14" /></button>
      <button class="icon-btn" :title="$t('新会话')" @click="newChat"><SquarePen :size="14" /></button>
    </div>
    <div v-if="showHistory" class="ai-history">
      <p v-if="!history.length" class="hist-empty">{{ $t('还没有会话') }}</p>
      <div v-for="h in history" :key="h.id" class="hist-item" :class="{ active: h.id === session.id }" @click="openSession(h)">
        <component :is="h.scope === 'note' ? FileText : Library" :size="12" class="hist-icon" />
        <div class="hist-main">
          <div class="hist-title">{{ h.title || $t('未命名会话') }}</div>
          <div class="hist-sub">{{ h.scope === 'note' && h.notePath ? titleOf(h.notePath) : $t('笔记库') }} · {{ when(h.updated) }}</div>
        </div>
        <button class="hist-del" :title="$t('删除会话')" @click.stop="removeSession(h)"><Trash2 :size="12" /></button>
      </div>
    </div>

    <div ref="listEl" class="ai-list selectable">
      <div v-if="!hasKey" class="ai-empty">
        <p>{{ $t('先在设置里配置一个模型服务商的 API Key（Claude、OpenAI、DeepSeek、通义、OpenHubs 等都可以），就能基于你的笔记提问了。') }}</p>
        <button class="btn primary" @click="emit('settings')">{{ $t('去设置') }}</button>
      </div>
      <div v-else-if="!turns.length" class="ai-empty">
        <p>
          {{ scope === 'vault' ? $t('会从你的笔记里找相关内容来回答，并标出引用。') : $t('基于当前这篇笔记（包括里面的图片）回答。') }}
          {{ $t('可以粘贴截图、附加图片或 PDF。加密笔记不会被读取。') }}
        </p>
        <button v-for="s in suggestions" :key="s" class="suggest" @click="send(s)">{{ s }}</button>
      </div>

      <template v-for="(t, i) in turns" :key="i">
        <div v-if="t.role === 'user'" class="bubble user">
          {{ t.text }}
          <div v-if="t.attached?.length" class="attached">
            <span v-for="a in t.attached" :key="a"><Paperclip :size="10" /> {{ a }}</span>
          </div>
        </div>
        <div v-else class="bubble assistant">
          <div v-if="t.error" class="ai-error">{{ t.error }}</div>
          <template v-else>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="answer" @click="onAnswerClick($event, t)" v-html="render(t)" />
            <span v-if="t.pending && !t.text" class="typing"><i /><i /><i /></span>
            <div v-if="t.sources?.length" class="sources">
              <button
                v-for="(s, n) in t.sources"
                :key="n"
                class="source"
                :class="{ file: !s.path }"
                :title="s.path ? s.heading : $t('附件||单个')"
                @click="s.path && emit('open', s.path)"
              >
                <b>{{ n + 1 }}</b> <FileType v-if="!s.path" :size="10" /> {{ s.title }}
              </button>
            </div>
            <div v-if="!t.pending && t.text" class="answer-actions">
              <button :title="$t('复制')" @click="copy(t)"><Copy :size="13" /> {{ $t('复制') }}</button>
              <button v-if="currentPath" :title="$t('插入到当前笔记光标处')" @click="emit('insert', plain(t))"><TextCursorInput :size="13" /> {{ $t('插入笔记') }}</button>
            </div>
          </template>
        </div>
      </template>
    </div>

    <footer class="ai-foot">
      <div v-if="selection" class="ai-selection">
        <span class="sel-text">{{ $t('已选中：{text}', { text: selection.slice(0, 60) + (selection.length > 60 ? '…' : '') }) }}</span>
        <button class="sel-x" @click="selection = ''"><X :size="12" /></button>
      </div>
      <div v-if="selection && !busy" class="quick">
        <button v-for="q in QUICK" :key="q.label" @click="send(q.prompt)">{{ q.label }}</button>
      </div>
      <div v-if="attachments.length" class="attach-row">
        <div v-for="(a, i) in attachments" :key="i" class="attach" :title="a.name">
          <img v-if="a.preview" :src="a.preview" />
          <span v-else class="pdf"><FileType :size="16" /><em>{{ a.name }}</em></span>
          <button class="attach-x" @click="attachments.splice(i, 1)"><X :size="10" /></button>
        </div>
      </div>
      <p v-if="attachError" class="attach-error">{{ attachError }}</p>
      <div class="ai-input" @dragover.prevent @drop.prevent>
        <button class="attach-btn" :title="$t('附加图片或 PDF')" @click="pickFiles"><Paperclip :size="15" /></button>
        <textarea
          @paste="onPaste"
          ref="inputEl"
          v-model="input"
          rows="1"
          :placeholder="$t('问点什么…（Enter 发送，Shift+Enter 换行）')"
          @keydown.enter="onEnter"
        />
        <button v-if="busy" class="send stop" :title="$t('停止')" @click="stop"><Square :size="12" /></button>
        <button v-else class="send" :disabled="!input.trim() && !attachments.length" :title="$t('发送')" @click="send(input.trim() || $t('请看附件'))">
          <ArrowUp :size="15" />
        </button>
      </div>
    </footer>
  </aside>
</template>

<style>
.ai-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 7;
  width: 400px;
  display: flex;
  flex-direction: column;
  background: var(--bg-editor);
  border-left: 1px solid var(--border);
  box-shadow: -10px 0 30px rgba(0, 0, 0, 0.12);
  animation: ai-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes ai-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
}
.ai-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 52px;
  padding: 0 10px 0 14px;
  min-width: 0;
  border-bottom: 1px solid var(--border);
}
.ai-logo {
  color: var(--accent);
}
.ai-head > * {
  flex-shrink: 0;
}
.ai-head .model-select {
  flex-shrink: 1;
  min-width: 72px;
}
.ai-head .spacer {
  flex: 1;
  flex-shrink: 1;
}
.ai-title {
  font-weight: 700;
  white-space: nowrap;
}
.segmented.small {
  flex-wrap: nowrap;
}
.segmented.small button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.segmented.small button:disabled {
  opacity: 0.4;
}
.ai-context {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px 4px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-2);
}
.ctx-label {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon-btn.on {
  color: var(--accent);
}
.ai-history {
  max-height: 45%;
  overflow-y: auto;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
}
.hist-empty {
  margin: 10px;
  font-size: 12px;
  color: var(--text-3, var(--text-2));
}
.hist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
}
.hist-item:hover {
  background: var(--hover, rgba(127, 127, 127, 0.12));
}
.hist-item.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.hist-icon {
  flex-shrink: 0;
  color: var(--text-2);
}
.hist-main {
  flex: 1;
  min-width: 0;
}
.hist-title,
.hist-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-title {
  font-size: 12px;
}
.hist-sub {
  font-size: 10.5px;
  color: var(--text-2);
}
.hist-del {
  opacity: 0;
  border: 0;
  background: none;
  color: var(--text-2);
  padding: 2px;
}
.hist-item:hover .hist-del {
  opacity: 1;
}
.ai-list {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ai-empty {
  margin: auto 0;
  text-align: center;
  color: var(--text-2);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.suggest {
  padding: 6px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  color: var(--text);
}
.suggest:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.bubble {
  max-width: 100%;
  line-height: 1.65;
  font-size: 13.5px;
}
.bubble.user {
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px 12px 4px 12px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  white-space: pre-wrap;
}
.answer > :first-child {
  margin-top: 0;
}
.answer > :last-child {
  margin-bottom: 0;
}
.answer p,
.answer ul,
.answer ol {
  margin: 0.5em 0;
}
.answer ul,
.answer ol {
  padding-left: 1.4em;
}
.answer code {
  font: 0.88em var(--font-mono);
  background: var(--selected);
  padding: 1px 4px;
  border-radius: 4px;
}
.answer pre {
  background: var(--selected);
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
}
.answer pre code {
  background: none;
  padding: 0;
}
.answer .cite {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  margin: 0 1px;
  padding: 0 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  vertical-align: 2px;
  cursor: pointer;
}
.sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.source {
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.source b {
  color: var(--accent);
  margin-right: 2px;
}
.source:hover {
  color: var(--text);
  border-color: var(--accent);
}
.answer-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.answer-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-2);
}
.answer-actions button:hover {
  background: var(--selected);
  color: var(--text);
}
.ai-error {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 12px;
}
.typing {
  display: inline-flex;
  gap: 4px;
  padding: 6px 0;
}
.typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-2);
  animation: blink 1.2s infinite;
}
.typing i:nth-child(2) {
  animation-delay: 0.2s;
}
.typing i:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes blink {
  50% {
    opacity: 0.25;
  }
}
.ai-foot {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--border);
}
.ai-selection {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--selected);
  font-size: 11px;
  color: var(--text-2);
}
.sel-text {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.quick {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.quick button {
  padding: 3px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  font-size: 12px;
}
.quick button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.ai-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-list);
}
.ai-input:focus-within {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
}
.ai-input textarea {
  flex: 1;
  max-height: 160px;
  border: 0;
  resize: none;
  background: transparent;
  color: var(--text);
  font: 13px/1.5 var(--font-ui);
  field-sizing: content;
}
.attached {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-2);
}
.attach-row {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  overflow-x: auto;
}
.attach {
  position: relative;
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
  background: var(--selected);
}
.attach img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.attach .pdf {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--accent);
}
.attach .pdf em {
  max-width: 50px;
  font: normal 9px var(--font-ui);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.attach-x {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
}
.attach-error {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--accent);
}
.attach-btn {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-2);
}
.attach-btn:hover {
  background: var(--selected);
  color: var(--text);
}
.source.file {
  cursor: default;
}
.send {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
}
.send:disabled {
  opacity: 0.35;
}
.send.stop {
  background: var(--text-2);
}
</style>
