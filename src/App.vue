<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { vault, parseTags, plainInline, noteTitle, noteExcerpt, noteImages, resolveAsset, type Entry } from './vault'
import { popupMenu, type MenuSpec } from './native/menu'
import { DOC_STATUSES, bodyOf, docStatus, frontSet, isRetired, withFront, type DocStatus } from './front'
import { showWindowWhenReady } from './native/native'
import FolderTree from './components/FolderTree.vue'
import EmptyArt from './components/EmptyArt.vue'
import HistorySheet from './components/HistorySheet.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import { checkForUpdate, showWhatsNew, startUpdater, updateState } from './updater'
// 首屏用不到，按需加载
const MarkdownEditor = defineAsyncComponent(() => import('./components/MarkdownEditor.vue'))
// 首屏用不到，按需加载
const SettingsSheet = defineAsyncComponent(() => import('./components/SettingsSheet.vue'))
import type { ExportKind, ExportOptions } from './export'
// 首屏用不到，按需加载
const ExportSheet = defineAsyncComponent(() => import('./components/ExportSheet.vue'))
// 首屏用不到，按需加载
const AiPanel = defineAsyncComponent(() => import('./components/AiPanel.vue'))
const SafeView = defineAsyncComponent(() => import('./components/SafeView.vue'))
import { withHostedImages } from './imagehost'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { ask, message, open as openDialog } from '@tauri-apps/plugin-dialog'
import FormatBar from './components/FormatBar.vue'
// 首屏用不到，按需加载
const InfoPanel = defineAsyncComponent(() => import('./components/InfoPanel.vue'))
import { prefs, zoomBy } from './prefs'
import { navigation, noteIndex } from './store'
import { envelopeVersion, isLockedText, seal, unseal } from './crypto'
import {
  changePassword,
  hint as passwordHint,
  lockNow,
  lockState,
  loadLockConfig,
  recover,
  regenerateRecoveryKey,
  setLockHandler,
  setMigrateHandler,
  setPassword,
} from './lock'
// 首屏用不到，按需加载
const RecoveryKeyDialog = defineAsyncComponent(() => import('./components/RecoveryKeyDialog.vue'))
// 首屏用不到，按需加载
const PasswordDialog = defineAsyncComponent(() => import('./components/PasswordDialog.vue'))
import LockScreen from './components/LockScreen.vue'
import { onVaultChanged, startSettingsSync } from './settingsSync'
import { onOpenUrl } from '@tauri-apps/plugin-deep-link'
import {
  CalendarDays, FileText, Hash, Inbox, Info, Lock, PanelLeft, Pin, Plus, RotateCcw, Rows3,
  Share, ShieldCheck, FolderKanban, ArrowUpDown, Cloud, CloudCog, HardDrive, ImageUp, Sparkles, SquareCheckBig, SquarePen, Trash2, ChevronLeft, Menu as MenuIcon, Settings as SettingsIcon,
} from 'lucide-vue-next'
import { openUrl } from '@tauri-apps/plugin-opener'
import { google, syncState, formatAgo, type DocInfo } from './google'
import { t, dateLocale } from './i18n'

const tree = ref<Entry[]>([])
const contents = ref<Record<string, string>>({}) // path -> markdown
const modified = ref<Record<string, number>>({})
const created = ref<Record<string, number>>({})

// 侧边栏筛选：系统分类 / 某个文件夹 / 某个标签，三者互斥
type SystemView = 'all' | 'untagged' | 'todo' | 'today' | 'pinned' | 'locked' | 'trash' | 'cloud-drive' | 'cloud-docs' | 'local'
const SYSTEM_VIEWS: { id: SystemView; label: string; icon: unknown }[] = [
  { id: 'untagged', label: t('未打标签'), icon: Inbox },
  { id: 'todo', label: t('待办'), icon: SquareCheckBig },
  { id: 'today', label: t('今天'), icon: CalendarDays },
  // 这里的「置顶」是分类名（Pinned），菜单里的是动作（Pin）
  { id: 'pinned', label: t('置顶||分类'), icon: Pin },
  { id: 'locked', label: t('已加密'), icon: Lock },
]
const CLOUD_VIEWS: Record<string, string> = { 'cloud-drive': 'Google Drive', 'cloud-docs': t('Google 文档'), local: t('仅本机') }
const system = ref<SystemView | null>('all')
const folder = ref<string | null>(null)
const tag = ref<string | null>(null)
const query = ref('')
const current = ref<string | null>(null)
const source = ref(false)
// 两栏的显示状态记在本地，下次打开保持
function stored(key: string) {
  try {
    return localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}
const showSettings = ref(false)
const settingsTab = ref<'ai' | undefined>()
const showAi = ref(false)

// ---- Google：自动同步 + 已发布文档 ----
const googleOn = ref(false)
const autoSync = ref(false)
const docs = ref<Record<string, DocInfo>>({})
let syncTimer: number | undefined

// ---- 云与集成：每篇笔记同步到哪里 ----
/** 标成仅本机的笔记或文件夹（只存在这台设备上，不上传） */
const localOnly = ref<string[]>([])
const imageHostOn = ref(false)
const rootInfo = ref<{ path: string; icloud: boolean } | null>(null)
const isLocal = (p: string) => localOnly.value.some((x) => p === x || p.startsWith(x + '/'))
async function refreshCloud() {
  localOnly.value = await invoke<string[]>('cloud_local_only').catch(() => [])
  rootInfo.value = await invoke<{ path: string; icloud: boolean }>('cloud_root_info').catch(() => null)
  imageHostOn.value = await import('./imagehost').then((m) => m.imageHost.status()).then((s) => s.configured).catch(() => false)
}
async function icloudInfo() {
  const r = rootInfo.value
  if (!r) return
  if (r.icloud)
    await message(t('笔记库在 iCloud Drive 里，由系统负责同步到你的其它苹果设备：\n{path}\n\n注意：开了「优化 Mac 储存空间」时，系统会把不常用的文件移到云端，Cloud Notebook 会用本地副本秒开；如果同时用 Google Drive 同步，两套同步都会生效。', { path: r.path }), { title: 'iCloud', kind: 'info' })
  else {
    const ok = await ask(t('笔记库现在不在 iCloud Drive 里：\n{path}\n\n想用 iCloud 同步到 iPhone、iPad，可以在设置里把笔记库位置改到 iCloud Drive（访达 → iCloud 云盘）。', { path: r.path }), { title: 'iCloud', okLabel: t('打开设置'), cancelLabel: t('好') })
    if (ok) showSettings.value = true
  }
}

async function setLocalOnly(p: string, local: boolean) {
  if (local && googleOn.value) {
    const ok = await ask(t('这篇笔记以后只保存在这台设备上，不再上传 Google Drive。\n云端已有的副本会在下次同步时移除，其它设备上的这篇笔记会移到它们的回收站。'), {
      title: t('仅保存在本机'),
      okLabel: t('仅保存在本机'),
      cancelLabel: t('取消'),
    })
    if (!ok) return
  }
  await invoke('cloud_set_local_only', { path: p, local })
  await refreshCloud()
  toast.value = local ? t('已设为仅本机，不再上传云端') : t('已恢复同步到 Google Drive')
  scheduleSync(1000)
}

async function refreshGoogle() {
  const st = await google.status()
  googleOn.value = !!st.email
  autoSync.value = st.auto_sync
  if (googleOn.value) {
    if (syncState.value.state === 'off') syncState.value = { state: 'idle', last: (await google.lastSync()) ?? undefined }
    docs.value = await google.docs()
  }
}

/** 本地有改动后 5 秒同步一次，连续改动只触发最后一次 */
function scheduleSync(delay = 5000) {
  if (!googleOn.value || !autoSync.value) return
  clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => google.sync().catch(() => {}), delay)
}

// 双向同步的文档：笔记保存后自动推到 Google 文档
const docPushTimers = new Map<string, number>()
function scheduleDocPush(p: string) {
  // 加密笔记磁盘上是密文，不能推到 Google 文档去
  if (!docs.value[p]?.two_way || isLocked(p)) return
  clearTimeout(docPushTimers.get(p))
  docPushTimers.set(
    p,
    window.setTimeout(() => {
      docPushTimers.delete(p)
      google.publish(p, bodyOf(contents.value[p])).catch(() => {})
    }, 5000),
  )
}

/** 网络类错误（代理断开等）只算暂时离线，下次定时同步会自动重试 */
const isOffline = computed(() => syncState.value.state === 'error' && !!syncState.value.error?.startsWith('[网络] '))

async function onSyncStatusClick() {
  if (syncState.value.state !== 'error') return google.sync().catch(() => {})
  const detail = (syncState.value.error ?? '').replace(/^\[网络\] /, '')
  // 登录失效：重试没有用，直接提供重新登录
  if (/登录已失效|尚未登录/.test(detail)) {
    const again = await ask(detail, { title: t('Google 登录已失效'), kind: 'warning', okLabel: t('重新登录'), cancelLabel: t('关闭') })
    if (!again) return
    try {
      await google.login()
      syncState.value = { state: 'idle' }
      refreshCloud()
      google.sync().catch(() => {})
    } catch (e) {
      await message(String(e), { title: t('Google 登录失败'), kind: 'error' })
    }
    return
  }
  const retry = await ask(detail, { title: isOffline.value ? t('暂时无法连接 Google') : t('Google Drive 同步出错'), kind: 'warning', okLabel: t('重试'), cancelLabel: t('关闭') })
  if (retry) google.sync().catch(() => {})
}

async function publishDoc(twoWay?: boolean) {
  const p = current.value
  if (!p) return
  await flushSave(p)
  if (isLocked(p)) return message(t('加密笔记不能发布到 Google 文档，请先取消加密。'), { title: t('笔记已加密'), kind: 'info' })
  try {
    const link = await google.publish(p, bodyOf(contents.value[p]), twoWay)
    docs.value = await google.docs()
    await openUrl(link)
  } catch (e) {
    await message(String(e), { title: t('发布到 Google 文档失败'), kind: 'error' })
  }
}

function shareMenu() {
  const p = current.value
  if (!p) return
  const doc = docs.value[p]
  const quick: MenuSpec[] = [
    { text: t('快速导出'), enabled: false },
    { text: '    PDF', action: () => runExport('pdf') },
    { text: '    Word (.docx)', action: () => runExport('docx') },
    { text: t('    Markdown（图片内嵌）'), action: () => runExport('inline') },
    { text: t('    HTML 网页'), action: () => runExport('html') },
    { text: t('    Markdown 文件夹（含图片）'), action: () => runExport('md') },
    { text: t('复制 Markdown'), action: copyMarkdown },
    { text: t('更多导出选项…'), action: () => openExport() },
    '-',
    { text: t('同步位置'), enabled: false },
    { text: '    Google Drive', checked: googleOn.value && !isLocal(p), enabled: googleOn.value, action: () => setLocalOnly(p, false) },
    { text: t('    仅保存在本机（不上传云端）'), checked: isLocal(p), action: () => setLocalOnly(p, !isLocal(p)) },
    '-',
  ]
  if (!googleOn.value) {
    popupMenu([...quick, { text: t('登录 Google 后可同步、发布为 Google 文档…'), action: () => (showSettings.value = true) }])
    return
  }
  popupMenu([...quick, ...((
    doc
      ? [
          { text: t('在浏览器中打开 Google 文档'), action: () => openUrl(doc.link) },
          { text: t('用当前内容更新 Google 文档'), action: () => publishDoc() },
          // 双向同步（把文档里的修改拉回笔记）会用 Google 导出的内容覆盖笔记，格式可能有损，暂时不提供开启入口；
          // 之前已经开启的笔记保留这一项，方便关掉
          ...(doc.two_way
            ? [
                '-' as const,
                {
                  text: t('双向同步（文档里的修改拉回笔记）'),
                  checked: true,
                  action: async () => {
                    await google.setTwoWay(p, false)
                    docs.value = await google.docs()
                  },
                },
              ]
            : []),
        ]
      : [
          { text: t('发布为 Google 文档'), action: () => publishDoc(false) },
        ]) as MenuSpec[]),
  ])
}

async function copyMarkdown() {
  if (!current.value) return
  const md = noteBody(current.value)
  if (md === undefined) return message(t('请先解锁这篇笔记。'), { title: t('笔记已加密'), kind: 'info' })
  await navigator.clipboard.writeText(md)
  toast.value = t('已复制 Markdown')
}
const sidebar = ref(stored('pane.sidebar'))
const list = ref(stored('pane.list'))
watch([sidebar, list], ([s, l]) => {
  try {
    localStorage.setItem('pane.sidebar', s ? '1' : '0')
    localStorage.setItem('pane.list', l ? '1' : '0')
  } catch {}
})
// 侧边栏、笔记列表的宽度：拖右侧竖线调整；拖到比最小值还窄一截就当作要隐藏这一栏
const PANES = {
  sidebar: { def: 240, min: 190, max: 420, key: 'pane.sidebar.w' },
  list: { def: 340, min: 250, max: 620, key: 'pane.list.w' },
} as const
type PaneId = keyof typeof PANES
function storedWidth(id: PaneId) {
  const { def, min, max, key } = PANES[id]
  try {
    const n = Number(localStorage.getItem(key))
    return n >= min && n <= max ? n : def
  } catch {
    return def
  }
}
const paneWidth = reactive({ sidebar: storedWidth('sidebar'), list: storedWidth('list') })
const resizing = ref<PaneId | null>(null)
function savePaneWidth(id: PaneId) {
  try {
    localStorage.setItem(PANES[id].key, String(paneWidth[id]))
  } catch {}
}
function startResize(e: PointerEvent, id: PaneId) {
  if (e.button !== 0) return
  e.preventDefault()
  const { min, max } = PANES[id]
  const startX = e.clientX
  const startW = paneWidth[id]
  resizing.value = id
  const move = (ev: PointerEvent) => {
    const w = startW + ev.clientX - startX
    // 比最小值再窄 60px：隐藏这一栏，宽度保持拖动前的值，下次显示还是原来那么宽
    if (w < min - 60) {
      paneWidth[id] = startW
      if (id === 'sidebar') sidebar.value = false
      else list.value = false
      return end()
    }
    paneWidth[id] = Math.round(Math.min(max, Math.max(min, w)))
  }
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    resizing.value = null
    savePaneWidth(id)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}
function resetPaneWidth(id: PaneId) {
  paneWidth[id] = PANES[id].def
  savePaneWidth(id)
}

function focusMode() {
  const on = sidebar.value || list.value
  sidebar.value = list.value = !on
}

// 正在内联输入的新建/重命名框
const editing = ref<{ kind: 'new-folder' | 'rename'; parent: string; target?: string; value: string } | null>(null)
const editInput = ref<HTMLInputElement>()
const searchInput = ref<HTMLInputElement>()

function flatNotes(es: Entry[]): Entry[] {
  return es.flatMap((e) => (e.is_dir ? flatNotes(e.children) : [e]))
}

async function reload() {
  tree.value = await vault.tree()
  const files = flatNotes(tree.value)
  const next: Record<string, string> = {}
  const stale: string[] = []
  for (const f of files) {
    const cached = contents.value[f.path]
    // 正在编辑、还没落盘的笔记以本地为准，不被磁盘上的旧内容覆盖
    if (cached !== undefined && (pendingSave.has(f.path) || f.modified === diskModified.get(f.path))) next[f.path] = cached
    else stale.push(f.path)
  }
  // 变了的笔记一次读回来（几千篇也只是一次 IPC）
  const fresh = stale.length ? await vault.readMany(stale) : {}
  // 读盘期间用户可能又打了字：没读盘的那些，以及这期间有了待保存改动的，都用内存里最新的
  for (const p of Object.keys(next)) if (contents.value[p] !== undefined) next[p] = contents.value[p]
  for (const p of stale) {
    if (pendingSave.has(p) && contents.value[p] !== undefined) {
      next[p] = contents.value[p]
      continue
    }
    next[p] = fresh[p] ?? ''
    // 磁盘上的内容和内存里的一样，说明是这个应用自己刚保存的：解密后的正文留着，否则刚解锁的加密笔记一保存就又锁上了
    if (next[p] !== contents.value[p]) delete decrypted.value[p]
  }
  for (const f of files) diskModified.set(f.path, f.modified)
  contents.value = next
  for (const f of files) if (!pendingSave.has(f.path)) modified.value[f.path] = f.modified
  for (const f of files) if (f.created) created.value[f.path] = f.created
  if (current.value && !(current.value in next)) current.value = null
}

// ---- 置顶等元数据：存在笔记库里的隐藏文件，不污染 Markdown 正文 ----
const META = '.cloudnotebook/meta.json'
const pinned = ref<string[]>([])
/** 手动排序（拖动）的顺序；存在笔记库里，跟着同步到其它设备 */
const order = ref<string[]>([])
async function loadMeta() {
  try {
    const m = JSON.parse(await vault.read(META))
    pinned.value = m.pinned ?? []
    order.value = m.order ?? []
  } catch {
    pinned.value = []
  }
}
async function saveMeta() {
  await vault.write(META, JSON.stringify({ pinned: pinned.value, order: order.value }, null, 2))
}
async function togglePin(p: string) {
  pinned.value = pinned.value.includes(p) ? pinned.value.filter((x) => x !== p) : [...pinned.value, p]
  await saveMeta()
}
async function movePin(from: string, to: string) {
  if (!pinned.value.includes(from) && !order.value.includes(from)) return
  pinned.value = pinned.value.map((x) => (x === from ? to : x))
  order.value = order.value.map((x) => (x === from ? to : x))
  await saveMeta()
}

// ---- 回收站 ----
interface TrashItem {
  id: string
  path: string
  deleted_at: number
  is_dir: boolean
}
const trashItems = ref<(TrashItem & { title: string; excerpt: string; md: string })[]>([])
const trashSelected = ref<string | null>(null)
const trashHtml = ref('')
async function loadTrash() {
  const items = await invoke<TrashItem[]>('vault_trash_list')
  trashItems.value = await Promise.all(
    items.map(async (it) => {
      const md = it.is_dir || !it.path.endsWith('.md') ? '' : await vault.read(`.trash/${it.id}`).catch(() => '')
      const name = it.path.split('/').pop()!.replace(/\.md$/, '')
      return { ...it, md, title: it.is_dir ? t('文件夹「{name}」', { name }) : noteTitle(it.path, md) || name, excerpt: it.is_dir ? it.path : noteExcerpt(md) }
    }),
  )
  if (!trashItems.value.some((t) => t.id === trashSelected.value)) trashSelected.value = trashItems.value[0]?.id ?? null
}
watch(trashSelected, async (id) => {
  const it = trashItems.value.find((t) => t.id === id)
  trashHtml.value = it?.md ? await (await import('./export')).renderHtml(it.md, `.trash/${it.id}`) : ''
})
async function restoreTrash(it: TrashItem) {
  const target = await invoke<string>('vault_restore', { id: it.id, path: it.path })
  await Promise.all([loadTrash(), reload()])
  if (target.endsWith('.md')) {
    selectSystem('all')
    current.value = target
  }
}
async function deleteForever(it: TrashItem & { title: string }) {
  const ok = await ask(t('「{title}」将被永久删除，无法恢复。', { title: it.title }), { title: t('永久删除'), kind: 'warning', okLabel: t('永久删除'), cancelLabel: t('取消') })
  if (!ok) return
  await invoke('vault_delete_forever', { id: it.id })
  await loadTrash()
}
async function emptyTrash() {
  const ok = await ask(t('回收站里的 {n} 项将被永久删除，无法恢复。', { n: trashItems.value.length }), {
    title: t('清空回收站'),
    kind: 'warning',
    okLabel: t('清空'),
    cancelLabel: t('取消'),
  })
  if (!ok) return
  await invoke('vault_empty_trash')
  await loadTrash()
}
function trashMenu(it: TrashItem & { title: string }) {
  popupMenu([
    { text: t('恢复'), action: () => restoreTrash(it) },
    '-',
    { text: t('永久删除'), action: () => deleteForever(it) },
  ])
}

// 磁盘上各文件最近一次看到的修改时间，用来判断外部是否改过
const diskModified = new Map<string, number>()
const pendingSave = new Set<string>()

const allTags = computed(() => {
  const set = new Set<string>()
  // #工作/会议 同时生成父级「工作」
  for (const md of Object.values(contents.value))
    for (const t of parseTags(md)) t.split('/').forEach((_, i, a) => set.add(a.slice(0, i + 1).join('/')))
  return [...set].sort()
})

/** 字数：中文按字、英文按词 */
function wordCount(md: string) {
  const t = md.replace(/```[\s\S]*?```/g, '').replace(/!?\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*_`|-]/g, ' ')
  return (t.match(/[\u4e00-\u9fff]/g)?.length ?? 0) + (t.match(/[A-Za-z0-9]+/g)?.length ?? 0)
}

const startOfToday = () => new Date(new Date().toDateString()).getTime()

function inSystemView(p: string, v: SystemView) {
  const md = contents.value[p]
  if (v === 'untagged') return parseTags(md).length === 0
  if (v === 'todo') return /^\s*[-*+]\s+\[ \]/m.test(md)
  if (v === 'today') return (modified.value[p] ?? 0) >= startOfToday()
  if (v === 'pinned') return pinned.value.includes(p)
  if (v === 'cloud-drive') return googleOn.value && !isLocal(p)
  if (v === 'cloud-docs') return !!docs.value[p]
  if (v === 'local') return isLocal(p)
  if (v === 'locked') return isLockedText(md)
  return true
}

const SORTS: { id: typeof prefs.noteSort; label: string }[] = [
  { id: 'modified', label: t('最近修改') },
  { id: 'modified-asc', label: t('最早修改') },
  { id: 'created', label: t('创建日期') },
  { id: 'title', label: t('标题') },
  { id: 'words', label: t('字数') },
  { id: 'manual', label: t('手动排序（拖动调整，重要的放上面）') },
]
const orderIndex = computed(() => new Map(order.value.map((p, i) => [p, i])))
function compareNotes(a: string, b: string) {
  const m = modified.value
  switch (prefs.noteSort) {
    case 'modified-asc': return (m[a] ?? 0) - (m[b] ?? 0)
    case 'created': return (created.value[b] ?? m[b] ?? 0) - (created.value[a] ?? m[a] ?? 0)
    case 'title': return noteTitle(a, contents.value[a]).localeCompare(noteTitle(b, contents.value[b]), 'zh')
    case 'words': return wordCount(contents.value[b]) - wordCount(contents.value[a])
    case 'manual': {
      // 没排过的（新笔记）放最前，按修改时间
      const ia = orderIndex.value.get(a) ?? -1
      const ib = orderIndex.value.get(b) ?? -1
      return ia === ib ? (m[b] ?? 0) - (m[a] ?? 0) : ia - ib
    }
    default: return (m[b] ?? 0) - (m[a] ?? 0)
  }
}
function sortMenu() {
  popupMenu(SORTS.map((x) => ({ text: x.label, checked: prefs.noteSort === x.id, action: () => (prefs.noteSort = x.id) })))
}

// ---- 拖动排序：按住笔记上下拖，松手后切到手动排序 ----
const dragging = ref<string | null>(null)
const dropBefore = ref<string | null | 'end'>(null)
let dragStart: { path: string; y: number } | null = null
function onRowPointerDown(e: PointerEvent, path: string) {
  if (e.button !== 0 || system.value === 'trash') return
  dragStart = { path, y: e.clientY }
}
function onRowPointerMove(e: PointerEvent) {
  if (!dragStart) return
  if (!dragging.value) {
    if (Math.abs(e.clientY - dragStart.y) < 6) return
    dragging.value = dragStart.path
  }
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-note]') as HTMLElement | null
  if (!el) return
  const r = el.getBoundingClientRect()
  const target = el.dataset.note!
  const list = notes.value.map((n) => n.path)
  const i = list.indexOf(target)
  dropBefore.value = e.clientY < r.top + r.height / 2 ? target : list[i + 1] ?? 'end'
}
async function onRowPointerUp() {
  const from = dragging.value
  const before = dropBefore.value
  dragStart = null
  dragging.value = null
  dropBefore.value = null
  if (!from || before === null || before === from) return
  const pins = new Set(pinned.value)
  // 置顶和普通笔记各自排序，不能跨区拖
  const list = notes.value.map((n) => n.path).filter((p) => pins.has(p) === pins.has(from) && p !== from)
  const at = before === 'end' ? list.length : Math.max(0, list.indexOf(before))
  if (before !== 'end' && !list.includes(before)) return
  list.splice(at, 0, from)
  if (pins.has(from)) pinned.value = list.concat(pinned.value.filter((p) => !list.includes(p)))
  // 当前视图里的顺序写进全局顺序：没出现在视图里的笔记保持原来的相对位置
  const rest = order.value.filter((p) => !list.includes(p))
  order.value = pins.has(from) ? order.value : [...list, ...rest]
  if (prefs.noteSort !== 'manual' && !pins.has(from)) {
    prefs.noteSort = 'manual'
    toast.value = t('已切换为手动排序')
  }
  await saveMeta()
}
window.addEventListener('pointermove', onRowPointerMove)
window.addEventListener('pointerup', onRowPointerUp)

// 全文搜索：正文走本地索引库（SQLite 全文索引），标题和文件名在这里匹配。空格分开的每个词都要出现
interface Hit { path: string; snippet: string; count: number }
const searchTerms = computed(() => [...new Set(query.value.toLowerCase().split(/\s+/).filter(Boolean))])
const searchHits = ref<Map<string, Hit> | null>(null)
let searchSeq = 0
let searchTimer: number | undefined
watch(searchTerms, (terms, old) => {
  if (terms.join(' ') === old?.join(' ')) return
  clearTimeout(searchTimer)
  const seq = ++searchSeq
  if (!terms.length) return (searchHits.value = null)
  searchTimer = window.setTimeout(async () => {
    try {
      const hits = await invoke<Hit[]>('index_search', { query: terms.join(' ') })
      if (seq === searchSeq) searchHits.value = new Map(hits.map((h) => [h.path, h]))
    } catch {
      // 索引库不可用：退回到在内存里逐篇匹配
      if (seq === searchSeq) searchHits.value = null
    }
  }, 120)
})
/** 这篇笔记是否匹配当前搜索；返回排序用的分数，不匹配返回 0 */
function searchScore(p: string, terms: string[]) {
  const md = contents.value[p]
  const locked = isLockedText(md)
  const title = (noteTitle(p, locked ? '' : md) + ' ' + p).toLowerCase()
  const inTitle = terms.every((t) => title.includes(t))
  if (locked) return inTitle ? 1000 : 0
  const hit = searchHits.value?.get(p)
  // 索引里的内容可能比正在编辑的旧一点（还没保存），内存里的正文也算
  const inBody = !!hit || terms.every((t) => md.toLowerCase().includes(t) || title.includes(t))
  if (!inTitle && !inBody) return 0
  return (inTitle ? 1000 : 0) + Math.min(hit?.count ?? 1, 999)
}
/** 搜索结果里的摘要：命中的词高亮 */
function hitParts(p: string) {
  const sn = searchHits.value?.get(p)?.snippet
  if (!sn) return null
  // 摘要是原文片段，把没命中部分里的 Markdown 记号去掉
  return sn
    .split(/[\u0001\u0002]/)
    .map((t, i) => ({ t: i % 2 ? t : t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`|\[\]]+|<br\s*\/?>|(^|\s)[-+]\s/g, '$1'), hit: i % 2 === 1 }))
    .filter((x) => x.t)
}

/** 已被取代、已归档的文档默认不显示 */
const showRetired = ref(localStorage.getItem('docs.showRetired') === '1')
watch(showRetired, (v) => localStorage.setItem('docs.showRetired', v ? '1' : '0'))
const statusOf = (p: string) => (isLockedText(contents.value[p]) ? undefined : docStatus(contents.value[p]))
const STATUS_LABEL: Record<DocStatus, string> = Object.fromEntries(DOC_STATUSES.map((s) => [s.id, s.label])) as Record<DocStatus, string>

const visibleNotes = computed(() => {
  const terms = searchTerms.value
  const scores = new Map<string, number>()
  const pins = new Set(pinned.value)
  const list = Object.keys(contents.value)
    .filter((p) => !system.value || inSystemView(p, system.value))
    .filter((p) => folder.value === null || p.startsWith(folder.value + '/'))
    .filter((p) => !tag.value || parseTags(contents.value[p]).some((t) => t === tag.value || t.startsWith(tag.value + '/')))
    .filter((p) => {
      if (!terms.length) return true
      const sc = searchScore(p, terms)
      scores.set(p, sc)
      return sc > 0
    })
    // 搜索时按相关度（标题命中优先，其次命中次数）；平时置顶的排在最前，其余按选定的排序方式
    .sort((a, b) =>
      terms.length
        ? scores.get(b)! - scores.get(a)! || compareNotes(a, b)
        : Number(pins.has(b)) - Number(pins.has(a)) || (pins.has(a) ? pinned.value.indexOf(a) - pinned.value.indexOf(b) : compareNotes(a, b)),
    )
    .map((p) => ({
      path: p,
      pinned: pins.has(p),
      title: noteTitle(p, contents.value[p]),
      locked: isLockedText(contents.value[p]),
      excerpt: isLockedText(contents.value[p]) ? t('已加密') : noteExcerpt(contents.value[p]),
      parts: terms.length && !isLockedText(contents.value[p]) ? hitParts(p) : null,
      hits: terms.length ? (searchHits.value?.get(p)?.count ?? 0) : 0,
      images: noteImages(contents.value[p]).map((src) => resolveAsset(p, src)),
      tags: isLockedText(contents.value[p]) ? [] : parseTags(contents.value[p]).slice(0, 3),
      words: isLockedText(contents.value[p]) ? 0 : wordCount(contents.value[p]),
      local: isLocal(p),
      doc: !!docs.value[p],
      status: statusOf(p),
    }))
  return { list, retired: list.filter((n) => isRetired(n.status)).length }
})
const retiredCount = computed(() => visibleNotes.value.retired)
const notes = computed(() => (showRetired.value ? visibleNotes.value.list : visibleNotes.value.list.filter((n) => !isRetired(n.status) || n.path === current.value)))

const viewTitle = computed(() => {
  if (system.value === 'all') return t('全部笔记')
  if (system.value === 'trash') return t('回收站')
  if (system.value && CLOUD_VIEWS[system.value]) return CLOUD_VIEWS[system.value]
  if (system.value) return SYSTEM_VIEWS.find((v) => v.id === system.value)!.label
  if (folder.value) return folder.value.split('/').pop()!
  if (tag.value) return '#' + tag.value
  return ''
})

// ---- 手机：一次只显示一栏（侧边栏 → 笔记列表 → 编辑），像系统的导航栈 ----
const phoneQuery = window.matchMedia('(max-width: 700px)')
const phone = ref(phoneQuery.matches)
phoneQuery.addEventListener('change', (e) => (phone.value = e.matches))
const mpane = ref<'side' | 'list' | 'editor'>('list')
function showNote(p: string) {
  current.value = p
  if (phone.value) mpane.value = 'editor'
}

// 证件夹：打开时占据笔记列表和编辑区
const safeOpen = ref(false)
/** 证件夹和项目共用同一个加密库，只是界面不同 */
const safeMode = ref<'safe' | 'projects'>('safe')
function openSafe(mode: 'safe' | 'projects' = 'safe') {
  safeMode.value = mode
  safeOpen.value = true
  if (phone.value) mpane.value = 'list'
}

function selectSystem(v: SystemView) {
  safeOpen.value = false
  system.value = v
  folder.value = tag.value = null
  if (v === 'trash') loadTrash()
  if (phone.value) mpane.value = 'list'
}
function selectFolder(p: string | null) {
  if (p === null) return selectSystem('all')
  safeOpen.value = false
  folder.value = p
  tag.value = system.value = null
  if (phone.value) mpane.value = 'list'
}
function selectTag(t: string) {
  safeOpen.value = false
  tag.value = t
  folder.value = system.value = null
  if (phone.value) mpane.value = 'list'
}

// ---- 加密笔记 ----
// contents 里始终是磁盘上的原文（加密笔记就是密文信封），解密后的明文只放在内存的 decrypted 里
const decrypted = ref<Record<string, string>>({})
const isLocked = (p: string) => isLockedText(contents.value[p])
/** 笔记的明文；加密且未解锁时为 undefined */
const plainText = (p: string) => (isLocked(p) ? decrypted.value[p] : contents.value[p])
/** 去掉文件头部的正文：编辑、复制、导出、打印都用它 */
const noteBody = (p: string) => {
  const t = plainText(p)
  return t === undefined ? undefined : bodyOf(t)
}

/** 要写到磁盘上的内容：加密笔记重新封装成密文 */
async function diskText(p: string) {
  if (!isLocked(p)) return contents.value[p]
  if (!lockState.key || decrypted.value[p] === undefined) throw new Error(t('加密笔记已锁定，无法保存'))
  const env = await seal(lockState.key, decrypted.value[p])
  contents.value[p] = env
  return env
}

// 打开加密笔记且已解锁时，解密一次放进内存
watch(
  [current, () => lockState.key],
  async ([p, key]) => {
    if (!p || !key || !isLocked(p) || decrypted.value[p] !== undefined) return
    try {
      decrypted.value[p] = await unseal(keyFor(p)!, contents.value[p])
    } catch {
      await message(t('这篇笔记无法用当前密码解密，可能是在其他设备上用别的密码加密的。'), { title: t('解密失败'), kind: 'error' })
    }
  },
  { immediate: true },
)

/** 旧版（v1）笔记要用旧密钥解，其余用数据密钥 */
const keyFor = (p: string) => (envelopeVersion(contents.value[p]) === 'v1' ? lockState.legacy ?? lockState.key : lockState.key)

// 升级加密格式：把 v1 笔记解开，用新的数据密钥重新加密写盘
setMigrateHandler(async (from, to) => {
  for (const p of Object.keys(contents.value)) {
    if (envelopeVersion(contents.value[p]) !== 'v1') continue
    const md = await unseal(from, contents.value[p])
    contents.value[p] = await seal(to, md)
    await vault.write(p, contents.value[p])
  }
})

// 自动锁定前：先把加密笔记里没保存的改动写盘，再清掉明文
setLockHandler(async () => {
  for (const p of [...saveTimers.keys()]) if (isLocked(p)) await flushSave(p)
  decrypted.value = {}
})

watch(
  () => lockState.key,
  (k) => {
    if (k && unlockAsk.value) {
      const then = unlockAsk.value
      unlockAsk.value = null
      then()
    }
  },
)

const pwDialog = ref<null | { mode: 'set' | 'change' | 'recover'; then?: () => void }>(null)
const pwDialogRef = ref<InstanceType<typeof PasswordDialog>>()
const unlockAsk = ref<null | (() => void)>(null)

async function onPasswordSubmit(v: { oldPassword?: string; recoveryKey?: string; password: string; hint: string }) {
  const d = pwDialog.value
  if (!d) return
  try {
    if (d.mode === 'change') {
      const r = await changePassword(v.oldPassword!, v.password, v.hint)
      if (!r.ok) return pwDialogRef.value?.setError(r.waitMs ? t('输错次数过多，请 {n} 秒后再试', { n: Math.ceil(r.waitMs / 1000) }) : t('当前密码不正确'))
    } else if (d.mode === 'recover') {
      if (!(await recover(v.recoveryKey!, v.password, v.hint))) return pwDialogRef.value?.setError(t('恢复密钥不正确'))
    } else {
      await setPassword(v.password, v.hint)
    }
  } catch (e) {
    return pwDialogRef.value?.setError(String(e))
  }
  pwDialog.value = null
  d.then?.()
}

async function confirmRegenerateRecovery() {
  const ok = await ask(t('生成新的恢复密钥后，之前保存的恢复密钥将立即失效。'), {
    title: t('重新生成恢复密钥'),
    kind: 'warning',
    okLabel: t('重新生成'),
    cancelLabel: t('取消'),
  })
  if (ok) withKey(() => regenerateRecoveryKey())
}

/** 确保有可用的密钥：没设过密码先设置，已锁定先解锁 */
function withKey(then: () => void) {
  if (!lockState.config) pwDialog.value = { mode: 'set', then }
  else if (!lockState.key) unlockAsk.value = then
  else then()
}

function encryptNote(p: string) {
  withKey(async () => {
    await flushSave(p)
    const md = contents.value[p]
    decrypted.value[p] = md
    contents.value[p] = await seal(lockState.key!, md)
    await vault.write(p, contents.value[p])
  })
}

function decryptNote(p: string) {
  withKey(async () => {
    await flushSave(p)
    const md = decrypted.value[p] ?? (await unseal(keyFor(p)!, contents.value[p]))
    contents.value[p] = md
    delete decrypted.value[p]
    await vault.write(p, md)
  })
}

// 自动保存：停止输入 400ms 后写盘
// 每篇笔记各自一个计时器，快速切换笔记时不会互相取消保存
const saveTimers = new Map<string, number>()
const body = computed({
  get: () => (current.value ? noteBody(current.value) ?? '' : ''),
  set: (text: string) => {
    const p = current.value
    if (!p) return
    // 编辑器里只有正文，头部原样拼回去
    const md = withFront(plainText(p) ?? '', text)
    if (isLocked(p)) decrypted.value[p] = md
    else contents.value[p] = md
    modified.value[p] = Date.now()
    clearTimeout(saveTimers.get(p))
    pendingSave.add(p)
    saveTimers.set(
      p,
      window.setTimeout(async () => {
        saveTimers.delete(p)
        try {
          await vault.write(p, await diskText(p))
          scheduleDocPush(p)
        } finally {
          if (!saveTimers.has(p)) pendingSave.delete(p)
        }
      }, 400),
    )
  },
})

/** 立即写盘某篇笔记还没保存的改动 */
async function flushSave(p: string) {
  if (!saveTimers.has(p)) return
  clearTimeout(saveTimers.get(p))
  saveTimers.delete(p)
  try {
    await vault.write(p, await diskText(p))
  } finally {
    pendingSave.delete(p)
  }
}

/** 把一篇笔记改到新路径（改名或换文件夹），置顶、排序、Google 文档关联、已解密的内容都跟着走 */
async function relocate(p: string, target: string) {
  const md = contents.value[p]
  await flushSave(p)
  try {
    await vault.rename(p, target)
  } catch {
    return false
  }
  if (docs.value[p]) {
    await google.moveDoc(p, target)
    docs.value = await google.docs()
  }
  await movePin(p, target)
  if (decrypted.value[p] !== undefined) {
    decrypted.value[target] = decrypted.value[p]
    delete decrypted.value[p]
  }
  contents.value[target] = md
  modified.value[target] = modified.value[p]
  delete contents.value[p]
  if (current.value === p) current.value = target
  return true
}

/** 离开一篇笔记时，按一级标题重命名文件，和 Bear 一样文件名跟着标题走 */
async function renameByTitle(p: string) {
  if (!(p in contents.value)) return
  const md = contents.value[p]
  // 加密笔记的文件里只有占位标题（没有一级标题的笔记会被写成「加密笔记」），不能拿它来改文件名
  if (isLockedText(md)) return
  const h1 = bodyOf(md).match(/^#[ \t]+(.+)$/m)?.[1]
  const title = h1 && fileBase(plainInline(h1))
  const dir = p.split('/').slice(0, -1).join('/')
  const base = p.split('/').pop()!.replace(/\.md$/, '')
  if (!title || title === base || title === base.replace(/ \d+$/, '')) return
  await relocate(p, uniqueName(dir, title, '.md'))
  await reload()
}

watch(current, async (_, prev) => {
  if (!prev) return
  // 离开加密笔记立即重新锁定（和 Bear 一致）：再打开要重新输入密码
  if (isLocked(prev) && lockState.key) await relock(prev)
  renameByTitle(prev)
})

/** 先把没保存的改动加密写盘，再清掉明文和密钥 */
async function relock(p: string) {
  await flushSave(p)
  delete decrypted.value[p]
  await lockNow()
}

const showExport = ref(false)
const exportOpts = (): ExportOptions => ({
  template: prefs.exportTemplate,
  paper: prefs.exportPaper,
  margin: prefs.exportMargin,
  keepTags: prefs.exportKeepTags,
})

async function runExport(kind: ExportKind) {
  if (!current.value) return
  await flushSave(current.value)
  const md = noteBody(current.value)
  if (md === undefined) return message(t('请先解锁这篇笔记再导出。'), { title: t('笔记已加密'), kind: 'info' })
  try {
    if (await (await import('./export')).exportNote(kind, current.value, md, exportOpts())) showExport.value = false
  } catch (e) {
    await message(String(e), { title: t('导出失败'), kind: 'error' })
  }
}

async function runPrint() {
  if (!current.value) return
  await flushSave(current.value)
  const md = noteBody(current.value)
  if (md === undefined) return message(t('请先解锁这篇笔记再打印。'), { title: t('笔记已加密'), kind: 'info' })
  try {
    await (await import('./export')).printNote(current.value, md, exportOpts())
    showExport.value = false
  } catch (e) {
    await message(String(e), { title: t('打印失败'), kind: 'error' })
  }
}

/** 上传图片到图床，把 Markdown（图片换成网络地址）复制到剪贴板 */
async function copyHosted(p = current.value) {
  if (!p) return
  await flushSave(p)
  const md = noteBody(p)
  if (md === undefined) return message(t('请先解锁这篇笔记。'), { title: t('笔记已加密'), kind: 'info' })
  try {
    await writeText(await withHostedImages(md, p))
    toast.value = t('已复制，图片已换成图床链接')
  } catch (e) {
    const msg = String(e)
    if (msg.includes('还没有配置图床')) {
      showSettings.value = true
      return message(t('请先在「设置 → 图床」里配置 S3 兼容的存储。'), { title: t('还没有配置图床'), kind: 'info' })
    }
    await message(msg, { title: t('复制失败'), kind: 'error' })
  }
}

// 底部轻提示
const toast = ref('')
function focusSearch() {
  if (!list.value) list.value = true
  nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}
/** ⌘F：打开着笔记就在笔记里查找，否则去搜索全部笔记 */
async function findInNote(withReplace: boolean) {
  if (safeOpen.value || !current.value || !(await editorRef.value?.openFind(withReplace))) focusSearch()
}
function zoom(dir: -1 | 0 | 1) {
  toast.value = t('编辑区缩放 {n}%', { n: zoomBy(dir) })
}
// ⌘+ / ⌘-（带不带 Shift、主键盘或小键盘都算）。按键先到 WebView，这里处理并 preventDefault，
// 菜单里的同名快捷键就不会再触发一次；菜单项只在用鼠标点时走 menu 事件
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  const dir = ['=', '+'].includes(e.key) || e.code === 'Equal' || e.code === 'NumpadAdd' ? 1
    : ['-', '_'].includes(e.key) || e.code === 'Minus' || e.code === 'NumpadSubtract' ? -1 : 0
  if (!dir) return
  e.preventDefault()
  zoom(dir)
})
watch(toast, (t) => t && setTimeout(() => (toast.value = ''), 2200))

/** 菜单里的「导出为」：打开导出面板并选好格式 */
function openExport(kind?: ExportKind) {
  if (!current.value) return
  if (kind) prefs.exportFormat = kind
  showExport.value = true
}

/** 标题变成文件名：去掉路径里不能用的字符；开头的点也去掉，否则文件成了隐藏文件，在应用里就看不到了 */
const fileBase = (title: string) =>
  title
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim()

function uniqueName(dir: string, base: string, ext = '') {
  const exists = (n: string) => (dir ? `${dir}/${n}` : n) in contents.value || findDir(tree.value, dir ? `${dir}/${n}` : n)
  let name = base + ext
  for (let i = 2; exists(name); i++) name = `${base} ${i}${ext}`
  return dir ? `${dir}/${name}` : name
}
function findDir(es: Entry[], p: string): boolean {
  return es.some((e) => e.is_dir && (e.path === p || findDir(e.children, p)))
}

async function newNote(dir = folder.value ?? '') {
  if (phone.value) mpane.value = 'editor'
  const path = uniqueName(dir, t('未命名'), '.md')
  const head = prefs.newNoteHeading ? '# \n' : '\n'
  const md = !tag.value ? head : prefs.tagPosition === 'top' ? `${head}#${tag.value}\n\n` : `${head}\n#${tag.value}\n`
  if (system.value === 'trash') selectSystem('all')
  await vault.write(path, md)
  await reload()
  current.value = path
}

function startNewFolder(parent = folder.value ?? '') {
  editing.value = { kind: 'new-folder', parent, value: '' }
  nextTick(() => editInput.value?.focus())
}
function startRename(e: Entry) {
  editing.value = { kind: 'rename', parent: e.path.split('/').slice(0, -1).join('/'), target: e.path, value: e.name }
  nextTick(() => editInput.value?.select())
}
async function commitEdit() {
  const ed = editing.value
  editing.value = null
  const name = ed?.value.trim().replace(/[\\/]/g, '')
  if (!ed || !name) return
  const path = ed.parent ? `${ed.parent}/${name}` : name
  if (ed.kind === 'new-folder') await vault.mkdir(path)
  else if (ed.target && ed.target !== path) {
    await vault.rename(ed.target, path)
    if (folder.value === ed.target) folder.value = path
    // 文件夹改名后，里面笔记的置顶和手动排序跟着改路径
    const moved = (x: string) => (x.startsWith(ed.target + '/') ? path + x.slice(ed.target!.length) : x)
    if (pinned.value.some((x) => moved(x) !== x) || order.value.some((x) => moved(x) !== x)) {
      pinned.value = pinned.value.map(moved)
      order.value = order.value.map(moved)
      await saveMeta()
    }
    if (current.value) current.value = moved(current.value)
  }
  await reload()
}

async function trash(path: string) {
  await vault.trash(path)
  if (pinned.value.some((x) => x === path || x.startsWith(path + '/'))) {
    pinned.value = pinned.value.filter((x) => x !== path && !x.startsWith(path + '/'))
    await saveMeta()
  }
  // 带上「/」再比：删「工作」不能把「工作-2024」里打开的笔记也关掉
  const inside = (x: string | null) => x === path || !!x?.startsWith(path + '/')
  if (inside(current.value)) current.value = null
  if (inside(folder.value)) folder.value = null
  await reload()
}

// Delete / ⌘⌫：把选中的笔记移到回收站，然后选中下一篇。光标在正文或输入框里时按键照常删字，不删笔记
window.addEventListener('keydown', async (e) => {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return
  if (e.altKey || e.ctrlKey || e.shiftKey || e.isComposing || e.repeat) return
  const el = e.target as HTMLElement | null
  if (el?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor, .sheet, [role="dialog"]')) return
  if (safeOpen.value || showSettings.value || showExport.value || editing.value || document.querySelector('.sheet-backdrop')) return
  if (system.value === 'trash') {
    const it = trashItems.value.find((t) => t.id === trashSelected.value)
    if (!it) return
    e.preventDefault()
    return deleteForever(it) // 永久删除会先弹确认
  }
  if (picked.value.size > 1) {
    e.preventDefault()
    return trashNotes(pickedList())
  }
  const path = current.value
  if (!path) return
  e.preventDefault()
  const i = notes.value.findIndex((n) => n.path === path)
  const next = notes.value[i + 1]?.path ?? notes.value[i - 1]?.path
  const title = titleOf(path)
  await trash(path)
  if (next && next in contents.value) showNote(next)
  toast.value = t('「{title}」已移到回收站', { title })
})

function folderMenu(e: Entry) {
  popupMenu([
    { text: t('新建笔记'), action: () => newNote(e.path) },
    { text: t('新建子文件夹'), action: () => startNewFolder(e.path) },
    '-',
    { text: t('重命名'), action: () => startRename(e) },
    boundFolders.value[e.path]
      ? { text: t('解除项目目录绑定'), action: () => unbindFolder(e.path) }
      : { text: t('绑定本地项目目录…'), action: () => bindFolder(e.path) },
    '-',
    { text: t('移到回收站'), action: () => trash(e.path) },
  ])
}
// ---- 多选：⌘ 点选加减，⇧ 点选连续一段，⌘A 全选；右键或 Delete 对选中的全部生效 ----
const picked = ref<Set<string>>(new Set())
let pickAnchor: string | null = null
const pickedList = () => notes.value.map((n) => n.path).filter((p) => picked.value.has(p))
function onRowClick(e: MouseEvent, path: string) {
  const paths = notes.value.map((n) => n.path)
  if (e.metaKey || e.ctrlKey) {
    const next = new Set(picked.value.size ? picked.value : current.value ? [current.value] : [])
    next.has(path) ? next.delete(path) : next.add(path)
    picked.value = next
    pickAnchor = path
    return
  }
  if (e.shiftKey) {
    const from = paths.indexOf(pickAnchor ?? current.value ?? path)
    const to = paths.indexOf(path)
    if (from >= 0 && to >= 0) {
      picked.value = new Set(paths.slice(Math.min(from, to), Math.max(from, to) + 1))
      return
    }
  }
  picked.value = new Set()
  pickAnchor = path
  showNote(path)
}
// 列表变了（搜索、切换分类、删除）：只保留仍在列表里的选中项
watch(notes, (ns) => {
  if (!picked.value.size) return
  const live = new Set(ns.map((n) => n.path))
  const kept = [...picked.value].filter((p) => live.has(p))
  if (kept.length !== picked.value.size) picked.value = new Set(kept)
})
window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null
  if (el?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor')) return
  if (safeOpen.value || system.value === 'trash' || document.querySelector('.sheet-backdrop')) return
  if (e.key === 'Escape' && picked.value.size) picked.value = new Set()
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && notes.value.length) {
    e.preventDefault()
    picked.value = new Set(notes.value.map((n) => n.path))
  }
})

const allDirs = computed(() => {
  const out: string[] = []
  const walk = (es: Entry[]) => es.forEach((e) => e.is_dir && (out.push(e.path), walk(e.children)))
  walk(tree.value)
  return out
})
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')
/** 「移动到文件夹」子菜单 */
const moveItems = (paths: string[]): MenuSpec[] =>
  ['', ...allDirs.value].map((d) => ({
    text: d || t('笔记库根目录'),
    enabled: paths.some((p) => dirOf(p) !== d),
    action: () => moveNotes(paths, d),
  }))
async function moveNotes(paths: string[], dir: string) {
  let n = 0
  for (const p of paths) {
    if (dirOf(p) === dir || !(p in contents.value)) continue
    const base = p.split('/').pop()!.replace(/\.md$/, '')
    if (await relocate(p, uniqueName(dir, base, '.md'))) n++
  }
  picked.value = new Set()
  await reload()
  if (n) toast.value = t('已把 {n} 篇笔记移到「{dir}」', { n, dir: dir || t('笔记库根目录') })
}
async function trashNotes(paths: string[]) {
  if (paths.length > 1) {
    const ok = await ask(t('把选中的 {n} 篇笔记移到回收站？', { n: paths.length }), { title: t('移到回收站'), kind: 'warning', okLabel: t('移到回收站'), cancelLabel: t('取消') })
    if (!ok) return
  }
  for (const p of paths) await trash(p)
  picked.value = new Set()
  toast.value = t('已把 {n} 篇笔记移到回收站', { n: paths.length })
}
async function pinNotes(paths: string[], on: boolean) {
  const set = new Set(paths)
  pinned.value = on ? [...pinned.value, ...paths.filter((p) => !pinned.value.includes(p))] : pinned.value.filter((p) => !set.has(p))
  await saveMeta()
}
/** 给多篇笔记加同一个标签（写在末尾）；已经有这个标签的和加密的跳过 */
async function tagNotes(paths: string[], name: string) {
  let n = 0
  for (const p of paths) {
    const md = contents.value[p]
    if (md === undefined || isLockedText(md) || parseTags(md).includes(name)) continue
    await flushSave(p)
    const next = `${md.replace(/\s+$/, '')}\n\n#${name}\n`
    contents.value[p] = next
    await vault.write(p, next)
    modified.value[p] = Date.now()
    n++
  }
  toast.value = n ? t('已给 {n} 篇笔记加上 #{tag}', { n, tag: name }) : t('选中的笔记都已经有 #{tag}', { tag: name })
}
/** 改文档状态：写在文件头部。改成别的状态时去掉「被谁取代」 */
async function setDocStatus(paths: string[], status: DocStatus | undefined) {
  let n = 0
  for (const p of paths) {
    const md = contents.value[p]
    if (md === undefined || isLockedText(md)) continue
    await flushSave(p)
    const next = frontSet(contents.value[p], { status, ...(status === 'superseded' ? {} : { superseded_by: undefined }) })
    if (next === contents.value[p]) continue
    contents.value[p] = next
    await vault.write(p, next)
    n++
  }
  if (n) toast.value = status ? t('已标为「{status}」', { status: STATUS_LABEL[status] }) : t('已清除文档状态')
}

/** 「帮助 → 使用指南」：指南不在了就放回来，有新版就更新，然后打开第一篇 */
async function openGuide() {
  try {
    const g = await invoke<{ folder: string; start: string; written: number }>('guide_install')
    if (g.written) await reload()
    selectFolder(g.folder)
    if (contents.value[g.start] !== undefined) showNote(g.start)
    if (g.written) toast.value = t('使用指南已放进笔记库')
  } catch (e) {
    await message(String(e), { title: t('打开使用指南失败'), kind: 'error' })
  }
}

/** 回收站预览里的链接：不让它把应用窗口带到别的页面；按住 ⌘ 点才用浏览器打开 */
function onPreviewClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') ?? ''
  if ((e.metaKey || e.ctrlKey) && /^https?:\/\//i.test(href)) openUrl(href)
}

const historyOf = ref<string | null>(null)
/** 从历史版本恢复后，把内容换成恢复的那一版 */
function onRestored(p: string, md: string) {
  contents.value[p] = md
  modified.value[p] = Date.now()
  historyOf.value = null
  toast.value = t('已恢复到这个版本，恢复前的内容也留在了历史里')
}

// ---- 项目文档：文件夹绑定本地项目目录，AI 在那个目录下工作时文档自动进这个文件夹 ----
const boundFolders = ref<Record<string, string[]>>({})
async function refreshBindings() {
  const info = await invoke<{ projects: { folder: string; dirs: string[] }[] }>('docs_info').catch(() => null)
  boundFolders.value = Object.fromEntries((info?.projects ?? []).map((p) => [p.folder, p.dirs]))
}
async function bindFolder(folder: string) {
  const dir = await openDialog({ directory: true, title: t('选择这个文件夹对应的本地项目目录') })
  if (typeof dir !== 'string') return
  try {
    await invoke('docs_bind', { folder, dir })
    await refreshBindings()
    toast.value = t('已绑定。AI 在这个目录下保存的文档会进这个文件夹')
  } catch (e) {
    await message(String(e), { title: t('绑定失败'), kind: 'error' })
  }
}
async function unbindFolder(folder: string) {
  await invoke('docs_unbind', { folder })
  await refreshBindings()
  toast.value = t('已解除绑定，文件夹里的文档保留')
}

function batchMenu(paths: string[]) {
  const allPinned = paths.every((p) => pinned.value.includes(p))
  popupMenu([
    { text: t('已选中 {n} 篇笔记', { n: paths.length }), enabled: false },
    '-',
    { text: allPinned ? t('取消置顶') : t('置顶'), action: () => pinNotes(paths, !allPinned) },
    { text: t('移动到文件夹'), items: moveItems(paths) },
    { text: t('添加标签'), items: allTags.value.slice(0, 40).map((t) => ({ text: '#' + t, action: () => tagNotes(paths, t) })) },
    { text: t('文档状态'), items: DOC_STATUSES.map((s) => ({ text: s.label, action: () => setDocStatus(paths, s.id) })) },
    '-',
    { text: t('把 {n} 篇移到回收站', { n: paths.length }), action: () => trashNotes(paths) },
  ])
}

function noteMenu(path: string) {
  if (picked.value.size > 1 && picked.value.has(path)) return batchMenu(pickedList())
  const isPinned = pinned.value.includes(path)
  popupMenu([
    { text: isPinned ? t('取消置顶') : t('置顶'), action: () => togglePin(path) },
    isLocked(path) ? { text: t('取消加密'), action: () => decryptNote(path) } : { text: t('加密…'), action: () => encryptNote(path) },
    '-',
    { text: t('复制为 Markdown（图床链接）'), action: () => copyHosted(path) },
    { text: t('导出…'), action: () => ((current.value = path), openExport()) },
    { text: t('移动到文件夹'), items: moveItems([path]) },
    ...(isLocked(path)
      ? []
      : [
          {
            text: t('文档状态'),
            items: [
              ...DOC_STATUSES.map((s) => ({ text: (statusOf(path) === s.id ? '✓ ' : '') + s.label, action: () => setDocStatus([path], s.id) })),
              '-' as const,
              { text: t('清除状态'), enabled: !!statusOf(path), action: () => setDocStatus([path], undefined) },
            ],
          },
        ]),
    ...(isLocked(path) ? [] : [{ text: t('版本历史…'), action: () => flushSave(path).then(() => (historyOf.value = path)) }]),
    '-',
    { text: t('移到回收站'), action: () => trash(path) },
  ])
}

function fmtTime(ms?: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(dateLocale)
}

// ---- 双向链接 / 标签跳转 ----
const titleOf = (p: string) => noteTitle(p, contents.value[p] ?? '')
watch(
  [contents, allTags],
  () => {
    noteIndex.value = { titles: [...new Set(Object.keys(contents.value).map(titleOf).filter(Boolean))].sort(), tags: allTags.value }
  },
  { immediate: true },
)

function findByTitle(title: string) {
  const t = title.trim().toLowerCase()
  return Object.keys(contents.value).find((p) => titleOf(p).toLowerCase() === t)
}

navigation.openWikiLink = async (title: string) => {
  const hit = findByTitle(title)
  if (hit) {
    if (!notes.value.some((n) => n.path === hit)) selectSystem('all')
    current.value = hit
    return
  }
  // 链接到不存在的笔记：和 Bear 一样直接新建
  const dir = current.value?.split('/').slice(0, -1).join('/') ?? ''
  const path = uniqueName(dir, fileBase(title) || t('未命名'), '.md')
  await vault.write(path, `# ${title}\n\n`)
  await reload()
  selectSystem('all')
  current.value = path
}
navigation.openTag = (t: string) => selectTag(t)

/** 链接到当前笔记的其他笔记 */
const backlinks = computed(() => {
  const p = current.value
  if (!p) return []
  const title = titleOf(p).toLowerCase()
  if (!title) return []
  return Object.keys(contents.value)
    .filter((q) => q !== p && [...contents.value[q].matchAll(/\[\[([^\[\]\n]+?)\]\]/g)].some((m) => m[1].trim().toLowerCase() === title))
    .map((q) => ({ path: q, title: titleOf(q) }))
})

/** 笔记改了标题后，把其他笔记里的 [[旧标题]] 一起改掉 */
async function relinkTitle(oldTitle: string, newTitle: string) {
  if (!oldTitle || !newTitle || oldTitle === newTitle) return
  const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\[\\[\\s*${esc}\\s*\\]\\]`, 'gi')
  for (const [q, md] of Object.entries(contents.value)) {
    if (!re.test(md)) continue
    re.lastIndex = 0
    const next = md.replace(re, `[[${newTitle}]]`)
    contents.value[q] = next
    await vault.write(q, next)
  }
}

// 打开笔记时记下标题，离开时比较，标题变了就更新反向链接
const titleAtOpen = new Map<string, string>()
watch(current, (p, prev) => {
  if (prev && titleAtOpen.has(prev)) {
    const before = titleAtOpen.get(prev)!
    const after = titleOf(prev)
    titleAtOpen.delete(prev)
    if (before && after && before !== after) relinkTitle(before, after)
  }
  if (p) titleAtOpen.set(p, titleOf(p))
}, { immediate: true })

const editorRef = ref<InstanceType<typeof MarkdownEditor>>()

// ---- AI ----
/** 给 AI 检索用的笔记：加密笔记一律排除 */
// 加密的笔记和标成「仅本机」的笔记不给 AI：后者的意思就是不离开这台电脑
const aiNotes = computed(() => Object.fromEntries(Object.entries(contents.value).filter(([p, md]) => !isLockedText(md) && !isLocal(p))))
function openNote(p: string) {
  if (!notes.value.some((n) => n.path === p)) selectSystem('all')
  showNote(p)
}
function openAiSettings() {
  settingsTab.value = 'ai'
  showSettings.value = true
}
const showInfo = ref(false)

async function insertImageFromDialog() {
  const picked = await openDialog({ multiple: true, filters: [{ name: t('图片'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }] })
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
  if (paths.length) await editorRef.value?.insertImages(paths)
}


/** 先用本地索引库里的副本画出界面（不碰笔记文件，iCloud 没下载的也不用等） */
async function loadSnapshot() {
  const snap = await invoke<{ tree: Entry[]; notes: { path: string; modified: number; content: string }[] } | null>(
    'index_snapshot',
  ).catch(() => null)
  if (!snap) return false
  const live = new Set(flatNotes(snap.tree).map((f) => f.path))
  const next: Record<string, string> = {}
  for (const n of snap.notes) {
    if (!live.has(n.path)) continue
    next[n.path] = n.content
    modified.value[n.path] = n.modified
    // 记下缓存对应的修改时间：后台对照磁盘时，没变的笔记不用再读
    diskModified.set(n.path, n.modified)
  }
  // 有笔记文件却一篇都没缓存上（上次没读完），这份缓存用不上
  if (live.size && !Object.keys(next).length) return false
  tree.value = snap.tree
  contents.value = next
  return true
}

onMounted(async () => {
  const cached = await loadSnapshot()
  // 有缓存就立刻显示窗口，磁盘上的变化在后台补上
  const fromDisk = Promise.all([reload(), loadMeta(), loadLockConfig()]).catch((e) => console.error('加载笔记库失败', e))
  if (cached) nextTick(showWindowWhenReady)
  else await fromDisk.finally(() => nextTick(showWindowWhenReady))
  // 首屏出来后马上在后台预载编辑器，点开笔记时不用再等
  setTimeout(() => import('./components/MarkdownEditor.vue'), 0)
  // 外部改动（其他编辑器、同步盘、Git）后自动刷新
  let reloading: Promise<void> | null = null
  let reloadAgain = false
  listen('vault-changed', () => {
    // 重新加载进行中又来了变化：记下来，这一轮结束后再加载一次，否则中途改的文件会一直是旧的
    if (reloading) reloadAgain = true
    reloading ??= (async () => {
      do {
        reloadAgain = false
        await Promise.all([reload(), loadMeta(), system.value === 'trash' ? loadTrash() : null])
      } while (reloadAgain)
    })().finally(() => (reloading = null))
    scheduleSync()
    onVaultChanged()
    refreshBindings()
  })
  startSettingsSync()
  startUpdater()
  // 手机上 Google 登录的回调通过自定义 URL scheme 回到应用，转给 Rust
  onOpenUrl((urls) => urls.forEach((url) => invoke('google_oauth_callback', { url })))
  // 云端的改动靠定时拉取：每 2 分钟一次
  // 联网的事等首屏画完、空闲了再做，不和启动抢主线程
  await new Promise<void>((r) => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 1500 }) : setTimeout(r, 300)))
  await refreshGoogle()
  refreshCloud()
  refreshBindings()
  scheduleSync(1500)
  window.setInterval(() => scheduleSync(0), 120_000)
  listen<string>('menu', ({ payload }) => {
    if (payload === 'new-note') newNote()
    else if (payload === 'new-folder') startNewFolder()
    else if (payload === 'search') focusSearch()
    else if (payload === 'find') findInNote(false)
    else if (payload === 'replace') findInNote(true)
    else if (payload === 'toggle-source') source.value = !source.value
    else if (payload === 'toggle-sidebar') sidebar.value = !sidebar.value
    else if (payload === 'toggle-list') list.value = !list.value
    else if (payload === 'focus-mode') focusMode()
    else if (payload === 'zoom-in') zoom(1)
    else if (payload === 'zoom-out') zoom(-1)
    else if (payload === 'zoom-reset') zoom(0)
    else if (payload === 'settings') showSettings.value = true
    else if (payload === 'guide') openGuide()
    else if (payload === 'check-update') checkForUpdate(true)
    else if (payload === 'whats-new') showWhatsNew()
    else if (payload === 'toggle-info') showInfo.value = !showInfo.value
    else if (payload === 'ask-ai') showAi.value = !showAi.value
    else if (payload === 'lock-now') lockNow()
    else if (payload === 'export-sheet') openExport()
    else if (payload === 'print') runPrint()
    else if (payload === 'copy-hosted') copyHosted()
    else if (payload.startsWith('export-')) openExport(payload.slice(7) as ExportKind)
  })
})
</script>

<template>
  <div
    class="app"
    :class="[{ 'no-sidebar': !sidebar, 'no-list': !list, phone, resizing }, phone ? 'm-' + mpane : '']"
    :style="{ '--w-sidebar': paneWidth.sidebar + 'px', '--w-list': paneWidth.list + 'px' }"
  >
    <!-- 红绿灯右侧固定的侧边栏开关 -->
    <button class="icon-btn pane-toggle sidebar-toggle" :title="sidebar ? $t('隐藏侧边栏 ⌘\\') : $t('显示侧边栏 ⌘\\')" @click="sidebar = !sidebar">
      <PanelLeft :size="18" />
    </button>

    <!-- 侧边栏：透出窗口 vibrancy -->
    <aside class="sidebar pane">
      <div class="titlebar drag-region" />
      <div class="side-scroll">
        <div class="side-item" :class="{ active: !safeOpen && system === 'all' }" @click="selectSystem('all')">
          <FileText class="ico" :size="17" />
          <span class="label">{{ $t('全部笔记') }}</span>
          <span class="count">{{ Object.keys(contents).length }}</span>
        </div>
        <div
          v-for="v in SYSTEM_VIEWS"
          :key="v.id"
          class="side-item sub"
          :class="{ active: !safeOpen && system === v.id }"
          @click="selectSystem(v.id)"
        >
          <component :is="v.icon" class="ico muted" :size="17" />
          <span class="label">{{ v.label }}</span>
        </div>
        <div class="side-item" :class="{ active: !safeOpen && system === 'trash' }" @click="selectSystem('trash')">
          <Trash2 class="ico muted" :size="17" />
          <span class="label">{{ $t('回收站') }}</span>
        </div>
        <div class="side-item" :class="{ active: safeOpen && safeMode === 'safe' }" @click="openSafe('safe')">
          <ShieldCheck class="ico muted" :size="17" />
          <span class="label">{{ $t('证件夹') }}</span>
        </div>
        <div class="side-item" :class="{ active: safeOpen && safeMode === 'projects' }" @click="openSafe('projects')">
          <FolderKanban class="ico muted" :size="17" />
          <span class="label">{{ $t('项目') }}</span>
        </div>

        <div class="side-section">
          {{ $t('云与集成') }}
          <button class="side-add" :title="$t('连接与设置')" @click="showSettings = true"><Plus :size="13" /></button>
        </div>
        <div class="side-item" :class="{ active: !safeOpen && system === 'cloud-drive' }" @click="googleOn ? selectSystem('cloud-drive') : (showSettings = true)">
          <Cloud class="ico muted" :size="17" />
          <span class="label">Google Drive</span>
          <span v-if="!googleOn" class="count">{{ $t('未连接') }}</span>
          <span v-else class="cloud-dot" :class="[syncState.state, { offline: isOffline }]" :title="syncState.state === 'error' ? $t('同步出错') : $t('已连接')" />
        </div>
        <div class="side-item" @click="icloudInfo">
          <CloudCog class="ico muted" :size="17" />
          <span class="label">iCloud</span>
          <span class="count">{{ rootInfo?.icloud ? $t('同步中') : $t('未使用') }}</span>
        </div>
        <div v-if="googleOn" class="side-item" :class="{ active: !safeOpen && system === 'cloud-docs' }" @click="selectSystem('cloud-docs')">
          <FileText class="ico muted" :size="17" />
          <span class="label">{{ $t('Google 文档') }}</span>
          <span class="count">{{ Object.keys(docs).length || '' }}</span>
        </div>
        <div class="side-item" :class="{ active: !safeOpen && system === 'local' }" @click="selectSystem('local')">
          <HardDrive class="ico muted" :size="17" />
          <span class="label">{{ $t('仅本机') }}</span>
          <span class="count">{{ Object.keys(contents).filter(isLocal).length || '' }}</span>
        </div>
        <div class="side-item" @click="showSettings = true">
          <ImageUp class="ico muted" :size="17" />
          <span class="label">{{ $t('图床') }}</span>
          <span class="count">{{ imageHostOn ? $t('已配置') : $t('未配置') }}</span>
        </div>

        <div class="side-section">
          {{ $t('文件夹') }}
          <button class="side-add" :title="$t('新建文件夹')" @click="startNewFolder('')"><Plus :size="13" /></button>
        </div>
        <FolderTree :entries="tree" :selected="tag ? null : folder" @select="selectFolder" @menu="folderMenu" />
        <div v-if="editing" class="side-item">
          <input
            ref="editInput"
            v-model="editing.value"
            class="inline-input"
            :placeholder="editing.kind === 'new-folder' ? $t('文件夹名称') : ''"
            @keydown.enter="commitEdit"
            @keydown.esc="editing = null"
            @blur="commitEdit"
          />
        </div>

        <div v-if="allTags.length" class="side-section">{{ $t('标签') }}</div>
        <div
          v-for="t in allTags"
          :key="t"
          class="side-item"
          :class="{ active: tag === t }"
          :style="{ paddingLeft: 12 + (t.split('/').length - 1) * 14 + 'px' }"
          @click="selectTag(t)"
        >
          <Hash class="ico muted" :size="17" />
          <span class="label">{{ t.split('/').pop() }}</span>
        </div>
      </div>
      <div v-if="syncState.state !== 'off'" class="sync-status" :class="[syncState.state, { offline: isOffline }]" @click="onSyncStatusClick">
        <span class="dot" />
        <span v-if="syncState.state === 'syncing'">{{ $t('正在同步 Google Drive…') }}</span>
        <span v-else-if="isOffline">{{ $t('暂时无法连接 Google，稍后自动重试') }}</span>
        <span v-else-if="syncState.state === 'error'">{{ /登录已失效|尚未登录/.test(syncState.error ?? '') ? $t('Google 登录已失效，点击重新登录') : $t('同步出错，点击查看') }}</span>
        <span v-else>Google Drive · {{ formatAgo(syncState.last) || $t('已连接') }}</span>
      </div>
      <div v-if="phone" class="side-foot">
        <button class="side-item" @click="showSettings = true"><SettingsIcon class="ico muted" :size="17" /><span class="label">{{ $t('设置') }}</span></button>
      </div>
    </aside>

    <div v-if="sidebar && !phone" class="pane-resizer" :class="{ on: resizing === 'sidebar' }" :title="$t('拖动调整宽度，双击恢复默认')" @pointerdown="startResize($event, 'sidebar')" @dblclick="resetPaneWidth('sidebar')" />

    <SafeView v-if="safeOpen" :key="safeMode" :mode="safeMode" class="safe-host" :phone="phone" @back="mpane = 'side'" />
    <template v-else>
    <!-- 笔记列表 -->
    <section class="list pane">
      <div class="titlebar drag-region list-head">
        <button v-if="phone" class="icon-btn" :title="$t('分类')" @click="mpane = 'side'"><MenuIcon :size="18" /></button>
        <input ref="searchInput" v-model="query" class="search no-drag" :placeholder="$t('搜索全部笔记 ⇧⌘F')" @keydown.esc="query = ''" />
        <button class="icon-btn no-drag" :title="$t('新建笔记 ⌘N')" @click="newNote()">
          <SquarePen :size="18" />
        </button>
      </div>
      <div class="list-subhead">
        <span class="view-title">{{ viewTitle }}</span>
        <span class="view-count">{{ system === 'trash' ? trashItems.length : notes.length }}</span>
        <span class="spacer" />
        <button v-if="system === 'trash' && trashItems.length" class="text-btn" @click="emptyTrash">{{ $t('清空') }}</button>
        <button v-else-if="system !== 'trash'" class="sort-btn" :title="$t('排序方式')" @click="sortMenu">
          <ArrowUpDown :size="14" /> {{ SORTS.find((x) => x.id === prefs.noteSort)!.label.replace(/\s*[（(].*/, '') }}
        </button>
      </div>

      <!-- 回收站列表 -->
      <div v-if="system === 'trash'" class="list-scroll">
        <div
          v-for="t in trashItems"
          :key="t.id"
          class="note-row"
          :class="{ active: trashSelected === t.id }"
          @click="(trashSelected = t.id), phone && (mpane = 'editor')"
          @contextmenu="trashMenu(t)"
        >
          <div class="note-title">{{ t.title }}</div>
          <div class="note-excerpt">{{ t.excerpt || $t('无内容') }}</div>
          <div class="note-time">{{ $t('删除于 {time}', { time: fmtTime(t.deleted_at) }) }}</div>
        </div>
        <EmptyArt v-if="!trashItems.length" name="empty-trash" size="sm" :text="$t('回收站是空的')" />
      </div>

      <div v-else class="list-scroll">
        <div
          v-for="n in notes"
          :key="n.path"
          class="note-row"
          :data-note="n.path"
          :class="{ active: current === n.path && picked.size < 2, picked: picked.size > 1 && picked.has(n.path), dragging: dragging === n.path, 'drop-before': dragging && dropBefore === n.path }"
          @pointerdown="onRowPointerDown($event, n.path)"
          @click="onRowClick($event, n.path)"
          @contextmenu="noteMenu(n.path)"
        >
          <div class="note-title">
            <Pin v-if="n.pinned" class="pin" :size="12" />
            <Lock v-if="n.locked" class="pin" :size="12" />
            {{ n.title || $t('未命名') }}
          </div>
          <div v-if="n.parts" class="note-excerpt"><template v-for="(x, i) in n.parts" :key="i"><mark v-if="x.hit">{{ x.t }}</mark><template v-else>{{ x.t }}</template></template></div>
          <div v-else class="note-excerpt">{{ n.excerpt || $t('无内容') }}</div>
          <div v-if="n.images.length" class="note-thumbs">
            <img v-for="src in n.images" :key="src" :src="src" loading="lazy" draggable="false" />
          </div>
          <div class="note-time">
            <span>{{ fmtTime(modified[n.path]) }}</span>
            <span v-if="n.hits">{{ $t('· 命中 {n} 处', { n: n.hits }) }}</span>
            <span v-else-if="n.words">{{ $t('· {n} 字', { n: n.words }) }}</span>
            <span v-if="n.local" class="note-tag cloud" :title="$t('仅保存在本机，不上传云端')"><HardDrive :size="11" /> {{ $t('本机') }}</span>
            <span v-if="n.doc" class="note-tag cloud" :title="$t('已发布为 Google 文档')"><FileText :size="11" /> {{ $t('文档') }}</span>
            <span v-if="n.status && n.status !== 'current'" class="note-tag status" :class="n.status">{{ STATUS_LABEL[n.status] }}</span>
            <span v-for="t in n.tags" :key="t" class="note-tag">#{{ t }}</span>
          </div>
        </div>
        <button v-if="retiredCount" class="retired-toggle" @click="showRetired = !showRetired">
          {{ showRetired ? $t('收起 {n} 篇已被取代或已归档的文档', { n: retiredCount }) : $t('还有 {n} 篇已被取代或已归档的文档，点击显示', { n: retiredCount }) }}
        </button>
        <EmptyArt
          v-if="!notes.length && !retiredCount"
          size="sm"
          :name="query.trim() ? 'empty-search' : system === 'todo' ? 'empty-todo' : tag ? 'empty-tag' : 'empty-library'"
          :text="query.trim() ? $t('没有找到相关笔记') : system === 'todo' ? $t('待办都完成了') : tag ? $t('这个标签下还没有笔记') : $t('还没有笔记')"
        />
      </div>
    </section>
    <div v-if="list && !phone" class="pane-resizer" :class="{ on: resizing === 'list' }" :title="$t('拖动调整宽度，双击恢复默认')" @pointerdown="startResize($event, 'list')" @dblclick="resetPaneWidth('list')" />

    <!-- 编辑区 -->
    <main class="editor">
      <div class="titlebar drag-region editor-head">
        <button v-if="phone" class="icon-btn back-btn" :title="$t('返回')" @click="mpane = 'list'"><ChevronLeft :size="22" /></button>
        <button v-if="!phone" class="icon-btn no-drag" :title="list ? $t('隐藏笔记列表 ⌥⌘\\') : $t('显示笔记列表 ⌥⌘\\')" @click="list = !list">
          <Rows3 :size="18" />
        </button>
        <span class="spacer" />
        <button
          v-if="system !== 'trash' && current && isLocked(current) && decrypted[current] !== undefined"
          class="icon-btn no-drag"
          :title="$t('锁定 ⌥⌘L')"
          @click="relock(current)"
        >
          <Lock :size="18" />
        </button>
        <template v-if="system !== 'trash' && current">
          <button v-if="!phone" class="icon-btn no-drag" :class="{ shared: docs[current] }" :title="$t('发布与分享')" @click="shareMenu">
            <Share :size="18" />
          </button>
          <button class="icon-btn no-drag" :class="{ on: showAi }" :title="$t('问 AI ⌘J')" @click="showAi = !showAi">
            <Sparkles :size="18" />
          </button>
          <button class="icon-btn no-drag" :class="{ on: showInfo }" :title="$t('笔记信息 ⌘⇧I')" @click="showInfo = !showInfo">
            <Info :size="18" />
          </button>
        </template>
        <button v-if="system !== 'trash'" class="mode-btn no-drag" :title="$t('切换源码模式 ⌘/')" @click="source = !source">
          {{ source ? $t('预览') : 'Markdown' }}
        </button>
      </div>
      <!-- 回收站：只读预览 -->
      <template v-if="system === 'trash'">
        <template v-for="t in trashItems.filter((x) => x.id === trashSelected)" :key="t.id">
          <div class="trash-bar">
            <span>{{ $t('这篇笔记在回收站里，原位置：{path}', { path: t.path }) }}</span>
            <span class="spacer" />
            <button class="btn" @click="restoreTrash(t)"><RotateCcw :size="13" /> {{ $t('恢复') }}</button>
            <button class="btn danger" @click="deleteForever(t)"><Trash2 :size="13" /> {{ $t('永久删除') }}</button>
          </div>
          <div class="editor-body trash-preview">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="ProseMirror selectable" @click="onPreviewClick" v-html="trashHtml" />
          </div>
        </template>
        <EmptyArt v-if="!trashSelected" class="pane-empty" name="empty-trash" size="lg" :text="trashItems.length ? $t('回收站里有 {n} 篇笔记', { n: trashItems.length }) : $t('回收站是空的')" />
      </template>
      <LockScreen
        v-else-if="current && isLocked(current) && decrypted[current] === undefined"
        :title="titleOf(current)"
        @forgot="pwDialog = { mode: 'recover' }"
      />
      <template v-else-if="current">
        <MarkdownEditor ref="editorRef" :key="current" v-model="body" :source="source" :note-path="current" :highlight="searchTerms" class="editor-body" />
        <FormatBar
          v-if="!source"
          @exec="editorRef?.exec($event)"
          @link="editorRef?.setLink($event)"
          @image="insertImageFromDialog"
        />
        <AiPanel
          v-if="showAi"
          :notes="aiNotes"
          :title-of="titleOf"
          :current-path="current && !isLocked(current) ? current : null"
          :get-selection="() => editorRef?.selectionText() ?? ''"
          @close="showAi = false"
          @open="openNote"
          @insert="editorRef?.insertMarkdown($event)"
          @settings="openAiSettings"
        />
        <InfoPanel
          v-if="showInfo"
          :markdown="body"
          :path="current"
          :modified="modified[current]"
          :backlinks="backlinks"
          @open="current = $event"
          @close="showInfo = false"
          @jump="editorRef?.scrollToHeading($event)"
        />
      </template>
      <EmptyArt v-else class="pane-empty" name="empty-notes" size="lg" :text="$t('{n} 篇笔记', { n: notes.length })" />
    </main>
    </template>

    <SettingsSheet
      v-if="showSettings"
      :initial-tab="settingsTab"
      @close="showSettings = false; settingsTab = undefined; refreshGoogle(); refreshCloud()"
      @password="pwDialog = { mode: lockState.config ? 'change' : 'set' }"
      @lock="lockNow"
      @recovery="confirmRegenerateRecovery"
      @unlock="unlockAsk = () => {}"
    />
    <Transition name="toast"><div v-if="toast" class="toast">{{ toast }}</div></Transition>
    <UpdateDialog v-if="updateState.phase !== 'idle'" />
    <HistorySheet
      v-if="historyOf && plainText(historyOf) !== undefined"
      :note-path="historyOf"
      :title="titleOf(historyOf)"
      :current="plainText(historyOf)!"
      @close="historyOf = null"
      @restored="onRestored(historyOf!, $event)"
    />
    <ExportSheet
      v-if="showExport && current && plainText(current) !== undefined"
      :note-path="current"
      :markdown="noteBody(current)!"
      @close="showExport = false"
      @export="runExport(prefs.exportFormat)"
      @print="runPrint"
    />
    <PasswordDialog
      v-if="pwDialog"
      ref="pwDialogRef"
      :mode="pwDialog.mode"
      :initial-hint="pwDialog.mode === 'set' ? '' : passwordHint()"
      @cancel="pwDialog = null"
      @submit="onPasswordSubmit"
    />
    <RecoveryKeyDialog
      v-if="lockState.pendingRecoveryKey && !pwDialog"
      :recovery-key="lockState.pendingRecoveryKey"
      @done="lockState.pendingRecoveryKey = null"
    />
    <div v-if="unlockAsk" class="sheet-backdrop" @mousedown.self="unlockAsk = null">
      <div class="sheet unlock-sheet">
        <LockScreen :title="$t('输入加密密码')" @forgot="(unlockAsk = null), (pwDialog = { mode: 'recover' })" />
      </div>
    </div>
  </div>
</template>

<style>
/* 侧边栏隐藏时，证件夹标题栏给红绿灯和侧边栏开关让位 */
.app.no-sidebar:not(.phone) .safe-host .s-nav .s-head {
  padding-left: 116px;
}
/* ---------- 手机布局 ---------- */
.app.phone .pane-toggle {
  display: none;
}
.app.phone > .pane,
.app.phone > .editor {
  display: none !important;
  width: 100% !important;
  flex: 1;
  border-right: 0;
}
.app.phone > .safe-host {
  display: none !important;
}
.app.phone:not(.m-side) > .safe-host {
  display: flex !important;
}
.app.phone.m-side > .sidebar,
.app.phone.m-list > .list,
.app.phone.m-editor > .editor {
  display: flex !important;
}
.app.phone .sidebar > *,
.app.phone .list > * {
  min-width: 0;
}
.app.phone .titlebar {
  height: calc(48px + env(safe-area-inset-top));
  padding-top: env(safe-area-inset-top);
  box-sizing: border-box;
}
.app.phone .list-head,
.app.phone.no-sidebar .list-head,
.app.phone .editor-head {
  padding-left: 8px !important;
  padding-right: 8px;
}
.app.phone .side-scroll {
  padding-top: 4px;
}
.app.phone .side-item {
  min-height: 40px;
  font-size: 15px;
}
.app.phone .note-row {
  margin: 0 10px;
  padding: 12px 14px;
}
.app.phone .search {
  height: 34px;
  font-size: 15px;
}
.app.phone .side-foot {
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
}
.app.phone .side-foot .side-item {
  width: 100%;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
}
.app.phone .list-scroll {
  padding-bottom: env(safe-area-inset-bottom);
}
.app.phone .ProseMirror {
  padding: 16px 18px 40vh;
}
.app.phone .ai-panel {
  position: fixed;
  inset: 0;
  width: 100%;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
.app.phone .info-panel {
  position: fixed;
  left: 12px;
  right: 12px;
  width: auto;
  top: calc(56px + env(safe-area-inset-top));
}
.app.phone .format-bar {
  bottom: calc(10px + env(safe-area-inset-bottom));
  max-width: calc(100% - 20px);
  overflow-x: auto;
}
.app.phone .sheet {
  width: 100vw !important;
  max-width: 100vw;
  margin-top: 0 !important;
  max-height: 100vh !important;
  height: 100vh;
  border-radius: 0 !important;
  padding-top: calc(16px + env(safe-area-inset-top)) !important;
  padding-bottom: calc(16px + env(safe-area-inset-bottom)) !important;
  box-sizing: border-box;
}
.app.phone .back-btn {
  margin-left: -4px;
}

.app {
  display: flex;
  height: 100%;
}
.titlebar {
  height: 52px;
  flex-shrink: 0;
}

/* 两栏收起：宽度过渡，内容不挤压变形 */
.pane {
  overflow: hidden;
  transition: width 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.22s;
}
.no-sidebar .sidebar,
.no-list .list {
  width: 0 !important;
  border-right-color: transparent;
}
.sidebar > * {
  min-width: var(--w-sidebar);
}
.list > * {
  min-width: var(--w-list);
}
/* 两栏之间的竖线：本身不占宽度，左右各 4px 可以抓住拖动 */
.pane-resizer {
  position: relative;
  width: 0;
  flex-shrink: 0;
  z-index: 4;
}
.pane-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  width: 9px;
  cursor: col-resize;
  background: linear-gradient(var(--accent), var(--accent)) center / 2px 100% no-repeat;
  opacity: 0;
  transition: opacity 0.15s;
}
.pane-resizer:hover::after,
.pane-resizer.on::after {
  opacity: 0.55;
}
.app.resizing {
  cursor: col-resize;
}
.app.resizing .pane {
  transition: none;
}
.app.resizing * {
  user-select: none !important;
}
.pane-toggle {
  position: fixed;
  top: 10px;
  left: 86px;
  z-index: 5;
}
.spacer {
  flex: 1;
}

/* 侧边栏 */
.sidebar {
  width: var(--w-sidebar);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}
.side-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.side-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 8px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.side-add {
  font-size: 15px;
  line-height: 1;
  color: var(--text-2);
  opacity: 0;
}
.side-section:hover .side-add {
  opacity: 1;
}
.side-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 32px;
  padding: 0 12px;
  border-radius: 7px;
  font-size: 14.5px;
}
.side-item.active {
  background: var(--selected);
}
.side-item .label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ico {
  flex-shrink: 0;
  color: var(--accent);
}
.inline-input {
  width: 100%;
  height: 22px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 0 6px;
  background: var(--bg-editor);
  color: var(--text);
  font: inherit;
}

/* 浅色外观下的深空灰侧边栏（设置 → 主题里可关）。手机上侧边栏是整屏的一页，不变色 */
:root[data-appearance='light'].dark-sidebar .app:not(.phone) .sidebar {
  --text: #e9e9ec;
  --text-2: #9a9ca3;
  --border: rgba(255, 255, 255, 0.1);
  --selected: rgba(255, 255, 255, 0.1);
  --bg-editor: #1e1f22;
  --accent: var(--accent-on-dark);
  color: var(--text);
  color-scheme: dark;
  background: #2b2d31;
  border-right-color: rgba(0, 0, 0, 0.25);
}
:root[data-appearance='light'].dark-sidebar .app:not(.phone):not(.no-sidebar) .sidebar-toggle {
  color: #9a9ca3;
}
:root[data-appearance='light'].dark-sidebar .app:not(.phone):not(.no-sidebar) .sidebar-toggle:hover {
  color: #e9e9ec;
  background: rgba(255, 255, 255, 0.1);
}

/* 列表 */
.list {
  width: var(--w-list);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-list);
  border-right: 1px solid var(--border);
}
.list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}
.no-sidebar .list-head {
  padding-left: 130px; /* 让出红绿灯和侧边栏开关 */
}
.no-sidebar.no-list .editor-head {
  padding-left: 130px;
}
.list-head,
.editor-head {
  transition: padding-left 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.search {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: var(--selected);
  color: var(--text);
  font: inherit;
}
.icon-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 6px;
}
.icon-btn:hover {
  background: var(--selected);
}
.icon-btn {
  color: var(--text-2);
}
.icon-btn:hover {
  color: var(--text);
}
.list-scroll {
  flex: 1;
  overflow-y: auto;
  /* 始终给滚动条留位置，卡片右侧间隙由它提供，和左边距相等 */
  scrollbar-gutter: stable;
}
.note-row {
  margin: 0 0 0 10px;
  padding: 14px 14px;
  border-radius: 8px;
  border-bottom: 1px solid var(--border);
}
.note-row.picked {
  background: color-mix(in srgb, var(--selected-active) 22%, transparent);
  border-color: transparent;
}
.note-row.active {
  background: var(--selected-active);
  color: #fff;
  border-color: transparent;
}
.note-excerpt mark {
  background: color-mix(in srgb, #f5c400 45%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.note-row.active .note-excerpt mark {
  background: rgba(255, 255, 255, 0.32);
}
.note-row.active .note-excerpt,
.note-row.active .note-time {
  color: rgba(255, 255, 255, 0.8);
}
.note-title {
  font-weight: 600;
  font-size: 15.5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.note-excerpt {
  margin-top: 5px;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.note-time {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.note-tag {
  padding: 0 7px;
  border-radius: 5px;
  background: var(--selected);
  font-size: 11.5px;
  line-height: 18px;
}
.note-tag.cloud { display: inline-flex; align-items: center; gap: 3px; }
.note-tag.status.draft { color: #b45309; background: rgba(245, 165, 36, 0.16); }
.note-tag.status.superseded, .note-tag.status.archived { color: var(--text-2); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-2) 50%, transparent); }
.retired-toggle { display: block; width: calc(100% - 10px); margin: 4px 0 10px 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px; color: var(--text-2); text-align: center; }
.retired-toggle:hover { background: var(--selected); color: var(--text); }
.cloud-dot { width: 8px; height: 8px; margin-left: auto; margin-right: 4px; border-radius: 50%; background: #30a46c; flex-shrink: 0; }
.cloud-dot.syncing { background: #f5a524; }
.cloud-dot.error { background: var(--accent); }
.cloud-dot.offline { background: var(--text-2); }
.note-row.active .note-tag { background: rgba(255, 255, 255, 0.2); }

.sync-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 18px 14px;
  font-size: 11px;
  color: var(--text-2);
}
.sync-status .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #30a46c;
}
.sync-status.syncing .dot {
  background: #f5a524;
  animation: pulse 1s ease-in-out infinite;
}
.sync-status.error .dot {
  background: var(--accent);
}
.sync-status.offline .dot {
  background: var(--text-2);
}
.sync-status {
  cursor: pointer;
}
@keyframes pulse {
  50% { opacity: 0.3; }
}
.icon-btn.shared {
  color: var(--accent);
}

/* 系统分类、计数、置顶 */
.side-item.sub {
  padding-left: 26px;
}
.side-item .count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-2);
}
.ico.muted {
  color: var(--text-2);
}
.side-add {
  display: grid;
  place-items: center;
}
.list-subhead {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 20px 8px;
}
.view-title {
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.view-count {
  font-size: 12px;
  color: var(--text-2);
}
.text-btn {
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
}
.note-thumbs {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  overflow: hidden;
}
.note-thumbs img {
  height: 64px;
  max-width: 110px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--selected);
}
.note-title .pin {
  color: var(--accent);
  vertical-align: -1px;
  margin-right: 2px;
}
.note-row.active .note-thumbs {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  overflow: hidden;
}
.note-thumbs img {
  height: 64px;
  max-width: 110px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--selected);
}
.note-row { position: relative; user-select: none; }
.note-row.dragging { opacity: 0.4; }
.note-row.drop-before::before {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  top: -2px;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.sort-btn:hover { background: var(--selected); color: var(--text); }
.note-row.active .note-title .pin {
  color: #fff;
}
.icon-btn.on {
  background: var(--selected);
}
.trash-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 16px 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--selected);
  font-size: 12px;
  color: var(--text-2);
}
.trash-bar .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text);
}
.trash-bar .btn.danger {
  color: var(--accent);
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 70px;
  transform: translateX(-50%);
  z-index: 60;
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(30, 30, 32, 0.92);
  color: #fff;
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
.unlock-sheet {
  width: 400px;
  height: 300px;
  display: flex;
}
.unlock-sheet .lock-screen {
  padding-bottom: 0;
}
.trash-preview {
  overflow-y: auto;
}
.trash-preview .ProseMirror {
  max-width: calc(var(--doc-width) + 96px);
  margin: 0 auto;
  padding: 20px 48px 30vh;
  font-family: var(--doc-font);
  font-size: var(--doc-size);
  line-height: var(--doc-line);
  opacity: 0.85;
}

/* 编辑区 */
.editor {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-editor);
}
.editor-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 16px 0 12px;
}
.mode-btn {
  font-size: 12px;
  color: var(--text-2);
  padding: 3px 8px;
  border-radius: 6px;
}
.mode-btn:hover {
  background: var(--selected);
}
.editor-body {
  flex: 1;
  min-height: 0;
}
.pane-empty { flex: 1; padding-bottom: 8vh; }
.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-2);
}
</style>
