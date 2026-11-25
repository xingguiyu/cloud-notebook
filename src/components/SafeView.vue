<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { save as saveDialog, ask } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlarmClock, Building2, ChevronLeft, Copy, CreditCard, Eye, EyeOff, FileText, Fingerprint, FolderClosed, IdCard,
  KeyRound, Lock, Paperclip, Pencil, Plus, Settings, ShieldCheck, Star, StickyNote, Trash2, WandSparkles, X, Download, Layers, FolderKanban, Upload,
} from 'lucide-vue-next'
import { safe, copySecret, totp, generatePassword, type SafeStatus } from '../safe/api'
import { canRecognize, isWarm, needsLatin, parse as parseOcr, recognize, warmup } from '../safe/ocr'
import { classifyHousehold, isPdf, splitPdf } from '../safe/pdf'
import { P12_NOTE, certKind, inspectCert, inspectFile } from '../safe/files'
import { t } from '../i18n'
import EmptyArt from './EmptyArt.vue'
import {
  GROUPS, TYPES, blankItem, detectLlm, envText, expiryState, mask, typeOf,
  type FieldDef, type GroupId, type SafeFile, type SafeItem,
} from '../safe/templates'

const props = defineProps<{ phone?: boolean; mode?: 'safe' | 'projects' }>()
const projMode = props.mode === 'projects'
const emit = defineEmits<{ back: [] }>()

const GROUP_ICON: Record<GroupId, unknown> = {
  personal: IdCard,
  finance: CreditCard,
  login: KeyRound,
  company: Building2,
  project: FolderKanban,
  other: StickyNote,
}

// ---------------- 状态 ----------------

const status = ref<SafeStatus | null>(null)
const items = ref<SafeItem[]>([])
const phase = computed(() => (!status.value ? 'loading' : !status.value.exists ? 'setup' : status.value.unlocked ? 'open' : 'locked'))

/** 条目还在读取（显示占位动画，而不是「0 / 还没有内容」） */
const itemsLoading = ref(true)

async function refreshStatus() {
  status.value = await safe.status()
  if (status.value.unlocked) {
    itemsLoading.value = !items.value.length
    try {
      await loadItems()
    } finally {
      itemsLoading.value = false
    }
    // 解锁后就在后台把文字识别模型载入内存，传证件时不用等
    warmup()
  }
}

/** 分类列表单独存成一个加密的元数据条目（不在列表里显示） */
const META_ID = 'meta-categories'
const extraCategories = ref<string[]>([])

async function loadItems() {
  const all = await safe.list()
  const meta = all.find((i) => i.id === META_ID)
  extraCategories.value = meta ? JSON.parse(meta.fields.list || '[]') : []
  items.value = all.filter((i) => i.type !== '_meta')
  notifyExpiring()
  await migrateCategories()
  if (selectedId.value && !items.value.some((i) => i.id === selectedId.value) && !editing.value) selectedId.value = null
}

// ---------------- 设置主密码 / 解锁 ----------------

const pw = ref('')
const pw2 = ref('')
const hintText = ref('')
const error = ref('')
const busy = ref(false)
const recoveryKey = ref('')
const savedKey = ref(false)
const recoverMode = ref(false)
const rkInput = ref('')
const pwInput = ref<HTMLInputElement>()

const strength = computed(() => {
  const p = pw.value
  let s = 0
  if (p.length >= 8) s++
  if (p.length >= 12) s++
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++
  if (/\d/.test(p)) s++
  if (/[^a-zA-Z0-9]/.test(p)) s++
  return Math.min(4, s)
})

async function setup() {
  error.value = ''
  if (pw.value.length < 8) return (error.value = t('主密码至少 8 位'))
  if (pw.value !== pw2.value) return (error.value = t('两次输入的密码不一致'))
  busy.value = true
  try {
    recoveryKey.value = await safe.setup(pw.value, hintText.value.trim())
    pw.value = pw2.value = ''
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function finishSetup() {
  recoveryKey.value = ''
  await refreshStatus()
  // 支持 Touch ID 的设备上直接开启，之后基本不用再输密码
  if (status.value?.biometric_available && !status.value.biometric_enabled) {
    await safe.setBiometric(true).catch(() => {})
    await refreshStatus()
  }
}

async function unlock() {
  if (!pw.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await safe.unlock(pw.value)
    pw.value = ''
    await refreshStatus()
  } catch (e) {
    error.value = String(e)
    pw.value = ''
    await nextTick()
    pwInput.value?.focus()
  } finally {
    busy.value = false
  }
}

async function unlockBiometric() {
  error.value = ''
  try {
    await safe.unlockBiometric()
    await refreshStatus()
  } catch (e) {
    // 用户取消不算错误，留在密码输入框
    if (!/cancel|取消/i.test(String(e))) error.value = String(e)
    pwInput.value?.focus()
  }
}

async function recover() {
  error.value = ''
  if (pw.value.length < 8) return (error.value = t('新密码至少 8 位'))
  if (pw.value !== pw2.value) return (error.value = t('两次输入的密码不一致'))
  busy.value = true
  try {
    await safe.recover(rkInput.value, pw.value, hintText.value.trim())
    pw.value = pw2.value = rkInput.value = ''
    recoverMode.value = false
    await refreshStatus()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function lock() {
  await safe.lock()
  for (const u of urls.values()) URL.revokeObjectURL(u)
  urls.clear()
  items.value = []
  editing.value = null
  revealed.clear()
  viewer.value = null
  await refreshStatus()
}

// ---------------- 自动锁定：一段时间没操作就锁 ----------------

const AUTOLOCK_KEY = 'safe.autolockMinutes'
const autolock = ref(Number(localStorage.getItem(AUTOLOCK_KEY) ?? 5) || 5)
watch(autolock, (v) => localStorage.setItem(AUTOLOCK_KEY, String(v)))
let lastActive = Date.now()
const touch = () => (lastActive = Date.now())
const idleTimer = window.setInterval(() => {
  if (phase.value === 'open' && Date.now() - lastActive > autolock.value * 60_000) lock()
}, 10_000)

// ---------------- 导航与列表 ----------------

type Nav = { kind: 'all' | 'fav' | 'expiring' } | { kind: 'group'; id: GroupId } | { kind: 'category'; path: string }
const nav = ref<Nav>({ kind: 'all' })
const query = ref('')
const selectedId = ref<string | null>(null)
const pane = ref<'nav' | 'list' | 'detail'>('list')

const categories = computed(() => {
  const set = new Set<string>(extraCategories.value)
  for (const it of items.value) if (it.category) set.add(it.category)
  // 补上父级：「公司A/项目X」也生成「公司A」
  for (const c of [...set]) c.split('/').forEach((_, i, a) => set.add(a.slice(0, i + 1).join('/')))
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
})

/** 普通条目（项目本身不算） */
const entries = computed(() => items.value.filter((i) => i.type !== 'project'))
const expiringCount = computed(() => entries.value.filter((i) => expiryState(i).state).length)

// ---------------- 项目模块 ----------------

const projects = computed(() =>
  items.value
    .filter((i) => i.type === 'project')
    .sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)) || a.title.localeCompare(b.title, 'zh')),
)
// 状态是用户自己填的文字：中文、英文的常见写法都认
const isArchived = (p: SafeItem) => /结束|归档|完成|停止|\b(ended|archived?|done|completed?|finished|closed|stopped)\b/i.test(p.fields.status ?? '')
/** 项目状态存的是原文（新建时默认「进行中」），显示时把常见的几个值翻译一下 */
const STATUS_TEXT: Record<string, string> = { 进行中: t('进行中'), 暂停: t('暂停'), 已结束: t('已结束') }
const statusText = (v: string) => STATUS_TEXT[v] ?? v
const projectOf = (it: SafeItem) => (it.project ? projects.value.find((p) => p.id === it.project) : undefined)
/** 当前打开的项目；'none' 表示未归入项目的项目文件 */
const projectId = ref<string | null>(null)
const currentProject = computed(() => projects.value.find((p) => p.id === projectId.value) ?? null)
const showArchived = ref(false)
const projectQuery = ref('')
const shownProjects = computed(() => {
  const q = projectQuery.value.trim().toLowerCase()
  return projects.value.filter((p) => (showArchived.value || !isArchived(p)) && (!q || (p.title + ' ' + (p.fields.client ?? '')).toLowerCase().includes(q)))
})
const filesOf = (p: SafeItem) => entries.value.filter((i) => i.project === p.id)
const unassigned = computed(() => entries.value.filter((i) => typeOf(i.type).group === 'project' && !projectOf(i)))
const projectWarn = (p: SafeItem) => filesOf(p).some((i) => expiryState(i).state)

function openProject(id: string | null) {
  if (editing.value) return
  projectId.value = id
  selectedId.value = id && id !== 'none' ? id : null
  if (props.phone) pane.value = 'list'
}

function newProject() {
  if (editing.value) return
  editing.value = blankItem('project')
  editing.value.fields.status = '进行中'
  isNew.value = true
  selectedId.value = editing.value.id
  if (props.phone) pane.value = 'detail'
}

// ---------------- 拖动条目到左边的项目 / 分类 ----------------
const dragItem = ref<SafeItem | null>(null)
const dragPos = ref({ x: 0, y: 0 })
/** 拖到了哪个目标：项目 id、'none'（移出项目），或 'cat:分类路径' */
const dragOver = ref<string | null>(null)
let pressItem: { id: string; x: number; y: number } | null = null
function onItemDown(e: PointerEvent, id: string) {
  if (e.button !== 0 || editing.value) return
  pressItem = { id, x: e.clientX, y: e.clientY }
}
function dropAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null
  return el?.dataset.drop ?? null
}
function onItemMove(e: PointerEvent) {
  if (!pressItem) return
  if (!dragItem.value) {
    if (Math.abs(e.clientX - pressItem.x) + Math.abs(e.clientY - pressItem.y) < 6) return
    dragItem.value = items.value.find((i) => i.id === pressItem!.id) ?? null
  }
  dragPos.value = { x: e.clientX, y: e.clientY }
  dragOver.value = dropAt(e.clientX, e.clientY)
}
async function onItemUp() {
  const it = dragItem.value
  const target = dragOver.value
  pressItem = null
  dragItem.value = null
  dragOver.value = null
  if (!it || !target) return
  let next: SafeItem
  if (target.startsWith('cat:')) {
    const cat = target.slice(4)
    if (it.category === cat) return
    next = { ...it, category: cat }
  } else {
    const pid = target === 'none' ? undefined : target
    if (it.project === pid) return
    next = { ...it, project: pid }
  }
  const saved = await safe.save(next)
  items.value = items.value.map((x) => (x.id === saved.id ? saved : x))
  const name = target.startsWith('cat:') ? target.slice(4) : target === 'none' ? t('未归入项目') : projects.value.find((p) => p.id === target)?.title ?? ''
  showToast(t('已移到「{name}」', { name }))
}
window.addEventListener('pointermove', onItemMove)
window.addEventListener('pointerup', onItemUp)

/** 第一次打开项目模块：把旧版按分类放的项目文件，按分类自动建成项目 */
async function migrateCategories() {
  if (!projMode || projects.value.length) return
  const cats = [...new Set(entries.value.filter((i) => typeOf(i.type).group === 'project' && !i.project && i.category).map((i) => i.category))]
  for (const c of cats) {
    const p = await safe.save({ ...blankItem('project'), title: c.split('/').pop()!, fields: { status: '进行中', client: c.includes('/') ? c.split('/')[0] : '' } })
    items.value.push(p)
    for (const it of entries.value.filter((i) => i.category === c && typeOf(i.type).group === 'project' && !i.project)) {
      const saved = await safe.save({ ...it, project: p.id })
      items.value = items.value.map((x) => (x.id === saved.id ? saved : x))
    }
  }
}

function inNav(it: SafeItem, n: Nav) {
  if (n.kind === 'fav') return !!it.favorite
  if (n.kind === 'expiring') return !!expiryState(it).state
  if (n.kind === 'group') return typeOf(it.type).group === n.id
  if (n.kind === 'category') return it.category === n.path || it.category.startsWith(n.path + '/')
  return true
}

function searchable(it: SafeItem) {
  const t = typeOf(it.type)
  // 搜索只看非敏感字段，密码、安全码不参与
  const visible = t.fields.filter((f) => f.kind !== 'secret' && f.kind !== 'totp').map((f) => it.fields[f.key] ?? '')
  return [it.title, it.category, t.label, it.notes, ...visible, ...it.extra.filter((e) => !e.secret).map((e) => e.label + ' ' + e.value)]
    .join(' ')
    .toLowerCase()
}

const TYPE_ORDER = TYPES.map((t) => t.id)
const list = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (projMode) {
    const base = projectId.value === 'none' ? unassigned.value : currentProject.value ? filesOf(currentProject.value) : []
    return base
      .filter((it) => !q || searchable(it).includes(q))
      .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.title.localeCompare(b.title, 'zh'))
  }
  return entries.value
    .filter((it) => inNav(it, nav.value))
    .filter((it) => !q || searchable(it).includes(q))
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.updated ?? 0) - (a.updated ?? 0))
})

const navTitle = computed(() => {
  if (projMode) return projectId.value === 'none' ? t('未归入项目') : currentProject.value?.title ?? ''
  const n = nav.value
  if (n.kind === 'all') return t('全部')
  if (n.kind === 'fav') return t('收藏')
  if (n.kind === 'expiring') return t('即将到期')
  if (n.kind === 'group') return GROUPS.find((g) => g.id === n.id)!.label
  if (n.kind === 'category') return n.path.split('/').pop()!
  return ''
})

function selectNav(n: Nav) {
  nav.value = n
  if (props.phone) pane.value = 'list'
}

function select(id: string) {
  if (editing.value) return
  selectedId.value = id
  revealed.clear()
  if (props.phone) pane.value = 'detail'
}

const selected = computed(() => items.value.find((i) => i.id === selectedId.value) ?? null)

function subtitle(it: SafeItem) {
  const t = typeOf(it.type)
  const f = t.fields.find((x) => x.key === t.subtitle)
  const v = f ? it.fields[f.key] ?? '' : ''
  if (!v) return t.label
  return f!.kind === 'code' || f!.kind === 'secret' ? `${t.label} · ${mask(v)}` : `${t.label} · ${v}`
}

// ---------------- 新建分类 ----------------

const newCategory = ref<string | null>(null)
const newCatInput = ref<HTMLInputElement>()
async function startNewCategory(parent = '') {
  newCategory.value = parent ? parent + '/' : ''
  await nextTick()
  newCatInput.value?.focus()
}
async function commitNewCategory() {
  const v = (newCategory.value ?? '').split('/').map((s) => s.trim()).filter(Boolean).join('/')
  newCategory.value = null
  if (!v || categories.value.includes(v)) return
  extraCategories.value = [...extraCategories.value, v]
  await saveMeta()
  selectNav({ kind: 'category', path: v })
}
async function saveMeta() {
  await safe.save({ ...blankItem('_meta'), id: META_ID, fields: { list: JSON.stringify(extraCategories.value) } })
}

// ---------------- 查看 ----------------

const revealed = reactive(new Set<string>())
const toast = ref('')
let toastTimer: number | undefined
function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2200)
}
async function copy(value: string, secret: boolean) {
  await copySecret(value, secret)
  showToast(secret ? t('已复制，30 秒后从剪贴板清除') : t('已复制'))
}

async function copyEnv(it: SafeItem) {
  await copySecret(envText(it), true)
  showToast(t('已复制为 .env 格式，30 秒后从剪贴板清除'))
}

/**
 * 到期提醒：解锁后把 30 天内到期和已过期的条目汇总成一条系统通知，每天最多一次。
 * 条目是加密的，没解锁时读不到到期日，所以只能在解锁之后提醒。
 */
async function notifyExpiring() {
  const today = new Date().toISOString().slice(0, 10)
  try {
    if (localStorage.getItem('safe.expiry.notified') === today) return
  } catch {
    return
  }
  const due = entries.value
    .map((it) => ({ it, ...expiryState(it) }))
    .filter((x) => x.state && x.date)
    .map((x) => ({ ...x, days: Math.ceil((new Date(x.date!).getTime() - Date.now()) / 86_400_000) }))
    .filter((x) => x.days <= 30)
    .sort((a, b) => a.days - b.days)
  if (!due.length) return
  try {
    const n = await import('@tauri-apps/plugin-notification')
    let ok = await n.isPermissionGranted()
    if (!ok) ok = (await n.requestPermission()) === 'granted'
    if (!ok) return
    const when = (d: number) => (d < 0 ? t('已过期 {n} 天', { n: -d }) : d === 0 ? t('今天到期') : t('{n} 天后到期', { n: d }))
    n.sendNotification({
      title: due.length === 1 ? t('「{title}」{when}', { title: due[0].it.title, when: when(due[0].days) }) : t('{n} 项证件 / 密钥即将到期', { n: due.length }),
      body: due.length === 1 ? typeOf(due[0].it.type).label : due.slice(0, 4).map((x) => t('{title}：{when}', { title: x.it.title, when: when(x.days) })).join('\n'),
    })
    localStorage.setItem('safe.expiry.notified', today)
  } catch (e) {
    console.warn('到期提醒发送失败', e)
  }
}

// 两步验证码每秒刷新
const codes = ref<Record<string, { code: string; remaining: number } | null>>({})
async function tickCodes() {
  const it = selected.value
  if (!it) return
  for (const f of typeOf(it.type).fields.filter((f) => f.kind === 'totp')) {
    const raw = it.fields[f.key]
    codes.value[f.key] = raw ? await totp(raw).catch(() => null) : null
  }
}
const codeTimer = window.setInterval(tickCodes, 1000)
watch(selected, tickCodes)

// 附件：解密成 Blob URL，锁定时全部回收
const urls = new Map<string, string>()
const thumbs = ref<Record<string, string>>({})
async function urlOf(f: SafeFile) {
  if (!urls.has(f.id)) {
    const buf = await safe.file(f.id)
    urls.set(f.id, URL.createObjectURL(new Blob([buf], { type: f.mime })))
  }
  return urls.get(f.id)!
}
async function loadThumbs(it: SafeItem | null) {
  if (!it) return
  for (const f of it.files) {
    if (!f.mime.startsWith('image/') || thumbs.value[f.id]) continue
    urlOf(f)
      .then((u) => (thumbs.value[f.id] = u))
      .catch(() => {})
  }
}
watch(selected, loadThumbs)

const viewer = ref<{ url: string; file: SafeFile } | null>(null)
async function openFile(f: SafeFile) {
  try {
    viewer.value = { url: await urlOf(f), file: f }
  } catch (e) {
    showToast(String(e))
  }
}
async function exportFile(f: SafeFile) {
  const dest = await saveDialog({ defaultPath: f.name })
  if (!dest) return
  await safe.exportFile(f.id, dest)
  showToast(t('已导出（导出的文件没有加密，用完请妥善处理）'))
}

function fmtSize(n: number) {
  return n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
}

// ---------------- 编辑 ----------------

const editing = ref<SafeItem | null>(null)
const isNew = ref(false)
/** 这次编辑里新上传的附件：取消时删掉 */
const uploaded = new Set<string>()
const showTypePicker = ref(false)

/** 有照片位的类型可能会传 PDF：提前在后台加载 pdf.js（约 2 秒），上传时不用再等 */
const preloadPdf = (type: string) => {
  if (!typeOf(type).photos) return
  import('../safe/pdf').then((m) => m.preload())
}

// 大模型 Key：粘贴 Key 后按前缀认出服务商，补上还空着的服务商、接口地址、控制台和标题
watch(
  () => (editing.value?.type === 'llmkey' ? editing.value.fields.key : undefined),
  (key) => {
    const it = editing.value
    const hit = key && detectLlm(key)
    if (!it || !hit) return
    for (const k of ['provider', 'baseUrl', 'url'] as const) if (!it.fields[k]) it.fields[k] = hit[k]
    if (!it.title) it.title = `${hit.provider} Key`
  },
)

function startNew(type: string) {
  showTypePicker.value = false
  const cat = nav.value.kind === 'category' ? nav.value.path : ''
  editing.value = blankItem(type, cat)
  if (projMode && currentProject.value) editing.value.project = currentProject.value.id
  isNew.value = true
  preloadPdf(type)
  selectedId.value = editing.value.id
  if (props.phone) pane.value = 'detail'
}

function startEdit() {
  if (!selected.value) return
  editing.value = JSON.parse(JSON.stringify(selected.value))
  isNew.value = false
  preloadPdf(selected.value.type)
}

async function cancelEdit() {
  for (const id of uploaded) await safe.removeFile(id).catch(() => {})
  uploaded.clear()
  if (isNew.value) selectedId.value = null
  editing.value = null
}

function autoTitle(it: SafeItem) {
  const ty = typeOf(it.type)
  const f = it.fields
  const main = f.bank || f.company || f.service || f.product || f.kind || f.name || f.holder || f.ssid || f.host || f.url || ''
  if (it.type === 'bankcard' && f.number) return `${f.bank || t('银行卡')} ${mask(f.number)}`
  return main ? `${main}${main === f.name ? ' · ' + ty.label : ''}` : ty.label
}

async function saveEdit() {
  const it = editing.value!
  await readP12(it)
  it.title = it.title.trim() || autoTitle(it)
  it.category = it.category.split('/').map((s) => s.trim()).filter(Boolean).join('/')
  it.extra = it.extra.filter((e) => e.label.trim() || e.value.trim())
  // 编辑中移除的旧附件，保存后才真正删掉
  const before = items.value.find((i) => i.id === it.id)
  const saved = await safe.save(it)
  for (const f of before?.files ?? []) if (!it.files.some((x) => x.id === f.id)) await safe.removeFile(f.id).catch(() => {})
  uploaded.clear()
  editing.value = null
  const i = items.value.findIndex((x) => x.id === saved.id)
  if (i >= 0) items.value[i] = saved
  else items.value.unshift(saved)
  selectedId.value = saved.id
  if (saved.type === 'project') projectId.value = saved.id
  loadThumbs(saved)
}

async function removeItem() {
  const it = selected.value
  if (!it) return
  const ok = await ask(it.type === 'project' ? t('删除项目「{title}」？项目里的 {n} 个文件会保留，移到「未归入项目」。', { title: it.title, n: filesOf(it).length }) : t('「{title}」和它的附件将被删除，其它设备同步后也会删除。', { title: it.title }), {
    title: t('删除条目'),
    kind: 'warning',
    okLabel: t('删除'),
    cancelLabel: t('取消'),
  })
  if (!ok) return
  if (it.type === 'project') {
    for (const f of filesOf(it)) {
      const saved = await safe.save({ ...f, project: undefined })
      items.value = items.value.map((x) => (x.id === saved.id ? saved : x))
    }
    projectId.value = null
  }
  await safe.remove(it.id, it.files.map((f) => f.id))
  items.value = items.value.filter((i) => i.id !== it.id)
  selectedId.value = null
  if (props.phone) pane.value = 'list'
}

async function toggleFavorite() {
  const it = selected.value
  if (!it) return
  const saved = await safe.save({ ...it, favorite: !it.favorite })
  items.value = items.value.map((i) => (i.id === saved.id ? saved : i))
}

// 选文件：证件照片位、普通附件
const fileInput = ref<HTMLInputElement>()
let pickTarget: { slot?: string } = {}
function pickFile(slot?: string) {
  if (progress.value) return
  pickTarget = { slot }
  fileInput.value!.accept = slot ? 'image/*,application/pdf' : ''
  fileInput.value!.value = ''
  fileInput.value!.click()
}
async function onFilePicked(e: Event) {
  const files = [...((e.target as HTMLInputElement).files ?? [])]
  if (editing.value) await processFiles(editing.value, files, pickTarget.slot)
}

/** 选择或拖进来的文件：PDF 走拆页识别；图片放进照片位（指定的，或下一个空位）并识别填写；其余作附件 */
async function processFiles(it: SafeItem, files: File[], slot?: string) {
  const photos = typeOf(it.type).photos ?? []
  for (const file of files) {
    if (file.size > 100 << 20) {
      showToast(t('{name} 超过 100 MB', { name: file.name }))
      continue
    }
    if (isPdf(file)) {
      await handlePdf(it, file)
      continue
    }
    const isImage = file.type.startsWith('image/')
    // 只有第一张进指定的位置，后面的依次填空位
    const target = isImage ? (slot ?? photos.find((s) => !slotFile(it, s))) : undefined
    slot = undefined
    const entry = await addFile(it, file, target)
    if (typeOf(it.type).group === 'project' && !isImage) {
      const info = await inspectFile(file).catch(() => null)
      if (info && info.type === it.type) report(fillFields(it, info.fields))
      continue
    }
    if (entry.mime.startsWith('image/') && canRecognize(it.type)) {
      progress.value = isWarm() ? t('正在识别文字…') : t('首次识别要载入系统模型，约 15 秒…')
      try {
        report(fillFields(it, parseOcr(it.type, await recognize(file, needsLatin(it.type)))))
      } catch (err) {
        showToast(String(err))
      } finally {
        progress.value = ''
      }
    }
  }
}

// ---------------- 项目文件：一次导入多个文件，每个文件一条 ----------------

const importInput = ref<HTMLInputElement>()
function pickImport() {
  if (progress.value) return
  importInput.value!.value = ''
  importInput.value!.click()
}
async function onImportPicked(e: Event) {
  await importFiles([...((e.target as HTMLInputElement).files ?? [])])
}

/** 认出文件是什么（证书、密钥、描述文件、发票、合同……），读出信息，加密保存成新条目，归到当前分类 */
async function importFiles(files: File[]) {
  if (!files.length || progress.value) return
  if (projMode && !currentProject.value && projectId.value !== 'none') return showToast(t('先在左边选一个项目'))
  const cat = nav.value.kind === 'category' ? nav.value.path : ''
  const notes: string[] = []
  let skipped = 0
  let last: SafeItem | null = null
  try {
    for (const [i, file] of files.entries()) {
      progress.value = t('正在导入 {i}/{n}：{name}', { i: i + 1, n: files.length, name: file.name })
      if (file.size > 100 << 20) {
        notes.push(t('{name} 超过 100 MB', { name: file.name }))
        skipped++
        continue
      }
      const info = await inspectFile(file).catch(() => ({ type: 'document', title: file.name, fields: {} as Record<string, string>, note: undefined }))
      const it = blankItem(info.type, cat)
      if (projMode && currentProject.value) it.project = currentProject.value.id
      it.title = info.title
      it.fields = Object.fromEntries(Object.entries(info.fields).filter(([, v]) => v))
      if (info.note) it.notes = info.note
      const id = await safe.attach(file)
      it.files.push({ id, name: file.name, mime: file.type || 'application/octet-stream', size: file.size })
      const saved = await safe.save(it)
      items.value.unshift(saved)
      last = saved
      if (info.note) notes.push(t('{name}：{note}', { name: file.name, note: info.note }))
    }
  } catch (err) {
    notes.push(String(err))
  } finally {
    progress.value = ''
  }
  if (last) {
    selectedId.value = last.id
    if (props.phone) pane.value = 'detail'
  }
  const n = files.length - skipped
  const dest = currentProject.value?.title || cat
  const done = dest ? t('已导入 {n} 个文件到「{name}」', { n, name: dest }) : t('已导入 {n} 个文件', { n })
  showToast(notes.length ? t('{a}；{b}', { a: done, b: notes[0] }) : done)
}

/** p12 填了密码后读出证书信息 */
async function readP12(it: SafeItem) {
  if (it.type !== 'certfile' || !it.fields.password || it.fields.expires) return
  const f = it.files.find((x) => /\.(p12|pfx)$/i.test(x.name))
  if (!f) return
  try {
    const c = await inspectCert(await safe.file(f.id), true, it.fields.password)
    const n = fillFields(it, { kind: certKind(c), subject: c.subject, issuer: c.issuer, serial: c.serial, issued: c.issued, expires: c.expires, team: c.team })
    if (n) showToast(t('已从证书读出 {n} 项', { n }))
    if (it.fields.kind?.startsWith('PKCS#12')) it.fields.kind = certKind(c)
    // 提示可能是别的语言的设备写进去的，中文原文也认
    if (it.notes === P12_NOTE || it.notes.startsWith('这个 p12 有密码')) it.notes = ''
  } catch (e) {
    showToast(String(e))
  }
}

// ---------------- 从访达拖进来 ----------------
// 系统拖放由 Tauri 接管（网页里拿不到文件），这里拿到路径和位置，再让 Rust 读出内容

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
}
const detailEl = ref<HTMLElement>()
const listEl = ref<HTMLElement>()
/** 拖动经过的位置：照片位名称，'area' 表示详情区其它地方 */
const dropHover = ref<string | null>(null)

function dropTarget(px: number, py: number): string | null {
  const x = px / window.devicePixelRatio
  const y = py / window.devicePixelRatio
  const el = document.elementFromPoint(x, y)
  if (el && listEl.value?.contains(el) && !editing.value) return 'list'
  if (!el || !detailEl.value?.contains(el)) return null
  return (el.closest('[data-slot]') as HTMLElement | null)?.dataset.slot ?? 'area'
}

async function readDropped(paths: string[]) {
  const files: File[] = []
  for (const p of paths) {
    try {
      const buf = await invoke<ArrayBuffer>('safe_read_dropped', { path: p })
      const name = p.split('/').pop()!
      files.push(new File([buf], name, { type: MIME[name.split('.').pop()!.toLowerCase()] ?? '' }))
    } catch (e) {
      showToast(String(e))
    }
  }
  return files
}

async function onDrop(paths: string[], target: string) {
  if (target === 'list') return importFiles(await readDropped(paths))
  const ok = paths.filter((p) => MIME[p.split('.').pop()!.toLowerCase()] || (editing.value ?? selected.value) && typeOf((editing.value ?? selected.value)!.type).group === 'project')
  if (!ok.length) return showToast(t('拖到左边列表可以导入成新条目；照片位只接受图片和 PDF'))
  if (!editing.value) {
    if (!selected.value) return
    startEdit()
  }
  const files = await readDropped(ok)
  await processFiles(editing.value!, files, target === 'area' ? undefined : target)
}

/** 加密保存一个文件并挂到条目上；放进照片位时替换原来的 */
async function addFile(it: SafeItem, file: File, slot?: string, name = file.name): Promise<SafeFile> {
  const id = await safe.attach(file)
  uploaded.add(id)
  const entry: SafeFile = { id, name, mime: file.type || 'application/octet-stream', size: file.size, slot }
  if (slot) it.files = it.files.filter((f) => f.slot !== slot)
  it.files.push(entry)
  if (entry.mime.startsWith('image/')) thumbs.value[id] = await urlOf(entry)
  return entry
}

/** 本机识别出的内容填进还空着的字段（已填的不覆盖），返回填了几项 */
function fillFields(it: SafeItem, found: Record<string, string>) {
  const known = new Set(typeOf(it.type).fields.map((f) => f.key))
  let n = 0
  for (const [k, v] of Object.entries(found)) {
    if (known.has(k) && !it.fields[k]?.trim()) {
      it.fields[k] = v
      n++
    }
  }
  return n
}
const report = (n: number, extra = '') => {
  const msg = n ? t('已识别并填写 {n} 项，请核对', { n }) : t('没有识别出可填写的内容')
  showToast(extra ? t('{a}；{b}', { a: msg, b: extra }) : msg)
}

/** 进度提示（识别、拆分 PDF 时显示） */
const progress = ref('')

/**
 * PDF：原件整本保存；可识别的证件类型再拆成单页图片——
 * 户口簿按内容认出首页、户主页放进照片位，其余每页按成员姓名单独保存；
 * 其它证件按页序放进照片位（第 1 页正面、第 2 页背面）。
 */
async function handlePdf(it: SafeItem, file: File) {
  await addFile(it, file, undefined, it.type === 'household' ? t('正本 · {name}', { name: file.name }) : file.name)
  const ty = typeOf(it.type)
  if (!ty.photos || !canRecognize(it.type)) return showToast(t('PDF 已加密保存'))
  try {
    progress.value = isWarm() ? t('正在读取 PDF…') : t('首次识别要载入系统模型，约 15 秒…')
    const pages = await splitPdf(file, (d, n) => (progress.value = d < n ? t('正在识别第 {i}/{n} 页…', { i: d + 1, n }) : t('正在保存…')), true, needsLatin(it.type))
    const n = fillFields(it, parseOcr(it.type, pages.flatMap((p) => p.lines)))
    progress.value = t('正在保存单页…')
    const used = new Set<string>()
    for (const p of pages) {
      let slot: string | undefined
      let label = t('第{n}页', { n: p.index })
      if (it.type === 'household') {
        const c = classifyHousehold(p.lines)
        // 照片位的名字是存进条目里的，保持原文；文件名里的说明按界面语言写
        if (c.kind === 'cover' && !used.has('首页')) slot = '首页'
        else if (c.kind === 'head' && !used.has('户主页')) slot = '户主页'
        const what = c.kind === 'cover' ? t('首页') : c.kind === 'head' ? (c.name ? t('户主 {name}', { name: c.name }) : t('户主')) : c.name ?? ''
        if (what) label += ' · ' + what
      } else {
        slot = ty.photos.find((s) => !used.has(s) && !slotFile(it, s))
      }
      if (slot) used.add(slot)
      await addFile(it, p.image, slot, `${label}.jpg`)
    }
    report(n, t('已拆成 {n} 页', { n: pages.length }))
  } catch (err) {
    showToast(t('PDF 处理失败：{err}', { err: String(err) }))
  } finally {
    progress.value = ''
  }
}

/** 任何条目里的 PDF 附件都可以手动拆成单页图片 */
async function splitAttachment(f: SafeFile) {
  const it = editing.value
  if (!it) return
  try {
    progress.value = t('正在拆分 PDF…')
    const buf = await safe.file(f.id)
    const pages = await splitPdf(new File([buf], f.name, { type: 'application/pdf' }), (d, n) => (progress.value = t('正在拆分第 {i}/{n} 页…', { i: d, n })), false)
    for (const p of pages) await addFile(it, p.image, undefined, p.image.name)
    showToast(t('已拆成 {n} 页', { n: pages.length }))
  } catch (err) {
    showToast(t('拆分失败：{err}', { err: String(err) }))
  } finally {
    progress.value = ''
  }
}
function removeFile(f: SafeFile) {
  editing.value!.files = editing.value!.files.filter((x) => x.id !== f.id)
}

const slotFile = (it: SafeItem, slot: string) => it.files.find((f) => f.slot === slot)
const looseFiles = (it: SafeItem) => it.files.filter((f) => !f.slot || !typeOf(it.type).photos?.includes(f.slot))

function inputType(f: FieldDef) {
  if (f.kind === 'date') return 'date'
  if (f.kind === 'month') return 'month'
  if (f.kind === 'secret') return revealed.has('edit:' + f.key) ? 'text' : 'password'
  if (f.kind === 'number') return 'number'
  return 'text'
}

// ---------------- 设置 ----------------

const showSettings = ref(false)
const oldPw = ref('')
async function changePassword() {
  error.value = ''
  if (pw.value.length < 8) return (error.value = t('新密码至少 8 位'))
  if (pw.value !== pw2.value) return (error.value = t('两次输入的密码不一致'))
  busy.value = true
  try {
    await safe.changePassword(oldPw.value, pw.value, hintText.value.trim())
    oldPw.value = pw.value = pw2.value = ''
    showToast(t('主密码已修改'))
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}
async function newRecoveryKey() {
  const ok = await ask(t('生成新的恢复密钥后，之前保存的恢复密钥立即失效。'), { title: t('重新生成恢复密钥'), okLabel: t('生成'), cancelLabel: t('取消') })
  if (ok) recoveryKey.value = await safe.newRecovery()
}
async function toggleBiometric() {
  try {
    await safe.setBiometric(!status.value!.biometric_enabled)
  } catch (e) {
    showToast(String(e))
  }
  await refreshStatus()
}

// ---------------- 生命周期 ----------------

let unlistenVault: (() => void) | undefined
let unlistenMenu: (() => void) | undefined
let unlistenDrop: (() => void) | undefined
let reloadTimer: number | undefined
onMounted(async () => {
  await refreshStatus()
  if (phase.value === 'locked' && status.value?.biometric_enabled) unlockBiometric()
  else nextTick(() => pwInput.value?.focus())
  window.addEventListener('pointerdown', touch)
  window.addEventListener('keydown', touch)
  // 其它设备同步过来的改动
  unlistenVault = await listen('vault-changed', () => {
    clearTimeout(reloadTimer)
    reloadTimer = window.setTimeout(() => {
      if (phase.value === 'open' && !editing.value) loadItems().catch(() => {})
      else if (phase.value !== 'open') refreshStatus()
    }, 600)
  })
  unlistenMenu = await listen<string>('menu', ({ payload }) => payload === 'lock-now' && lock())
  unlistenDrop = await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (phase.value !== 'open') return
    if (payload.type === 'leave') return (dropHover.value = null)
    // 识别中不接收新文件，避免重复添加
    if (progress.value) {
      dropHover.value = null
      if (payload.type === 'drop') showToast(t('正在识别，请稍候'))
      return
    }
    const target = dropTarget(payload.position.x, payload.position.y)
    // 只看条目时也能拖：放下后自动进入编辑
    const usable = target === 'list' || (target && (editing.value || selected.value))
    if (payload.type === 'drop') {
      dropHover.value = null
      if (usable) onDrop(payload.paths, target!)
    } else dropHover.value = usable ? target : null
  })
})
onBeforeUnmount(() => {
  clearInterval(idleTimer)
  clearInterval(codeTimer)
  window.removeEventListener('pointerdown', touch)
  window.removeEventListener('keydown', touch)
  unlistenVault?.()
  unlistenMenu?.()
  unlistenDrop?.()
  window.removeEventListener('pointermove', onItemMove)
  window.removeEventListener('pointerup', onItemUp)
  if (editing.value) cancelEdit()
})

defineExpose({ lock })
</script>

<template>
  <div class="safe" :class="[{ phone }, 'p-' + pane]">
    <input ref="fileInput" type="file" multiple hidden @change="onFilePicked" />
    <input ref="importInput" type="file" multiple hidden @change="onImportPicked" />

    <div v-if="phase === 'loading'" class="safe-gate">
      <div class="titlebar drag-region" />
      <div class="gate"><i class="spinner big" /><div class="gate-sub">{{ $t('正在打开证件夹…') }}</div></div>
    </div>

    <!-- ========== 第一次使用：设主密码 ========== -->
    <div v-else-if="phase === 'setup' && !recoveryKey" class="safe-gate">
      <div class="titlebar drag-region gate-bar">
        <button v-if="phone" class="icon-btn" @click="emit('back')"><ChevronLeft :size="22" /></button>
      </div>
      <div class="gate">
        <div class="gate-icon"><ShieldCheck :size="30" :stroke-width="1.6" /></div>
        <div class="gate-title">{{ $t('创建证件夹') }}</div>
        <p class="gate-sub">
          {{ $t('存放证件、银行卡、密码和公司证照。所有内容在本机加密后才同步，云端只有密文。') }}<br />
          {{ $t('主密码和加密笔记的密码分开，请设一个只用在这里的强密码。') }}
        </p>
        <form class="gate-form" @submit.prevent="setup">
          <input ref="pwInput" v-model="pw" class="field" type="password" :placeholder="$t('主密码（至少 8 位）')" autocomplete="new-password" />
          <div class="meter"><i v-for="n in 4" :key="n" :class="{ on: strength >= n, ['s' + strength]: true }" /></div>
          <input v-model="pw2" class="field" type="password" :placeholder="$t('再输一次')" autocomplete="new-password" />
          <input v-model="hintText" class="field" :placeholder="$t('密码提示（可选，别直接写密码）')" />
          <div v-if="error" class="gate-error">{{ error }}</div>
          <button class="btn primary wide" :disabled="busy || !pw">{{ busy ? $t('正在创建…') : $t('创建') }}</button>
        </form>
      </div>
    </div>

    <!-- ========== 恢复密钥：只显示一次 ========== -->
    <div v-else-if="recoveryKey" class="safe-gate">
      <div class="titlebar drag-region" />
      <div class="gate">
        <div class="gate-icon"><KeyRound :size="30" :stroke-width="1.6" /></div>
        <div class="gate-title">{{ $t('保存恢复密钥') }}</div>
        <p class="gate-sub">{{ $t('忘记主密码时，只能用它找回证件夹。它只显示这一次，请抄在纸上或存进别的安全地方。') }}</p>
        <div class="rk selectable">{{ recoveryKey }}</div>
        <div class="row-center">
          <button class="btn" @click="copy(recoveryKey, true)"><Copy :size="13" /> {{ $t('复制') }}</button>
        </div>
        <label class="check"><input v-model="savedKey" type="checkbox" /> {{ $t('我已经妥善保存了恢复密钥') }}</label>
        <button class="btn primary wide" :disabled="!savedKey" @click="(savedKey = false), status?.unlocked ? (recoveryKey = '') : finishSetup()">
          {{ $t('完成') }}
        </button>
      </div>
    </div>

    <!-- ========== 已锁定 ========== -->
    <div v-else-if="phase === 'locked'" class="safe-gate">
      <div class="titlebar drag-region gate-bar">
        <button v-if="phone" class="icon-btn" @click="emit('back')"><ChevronLeft :size="22" /></button>
      </div>
      <div v-if="!recoverMode" class="gate">
        <EmptyArt name="safe-locked" size="sm" class="gate-art" />
        <div class="gate-title">{{ projMode ? $t('项目已锁定（和证件夹同一个主密码）') : $t('证件夹已锁定') }}</div>
        <form class="gate-form" @submit.prevent="unlock">
          <div class="inline">
            <input ref="pwInput" v-model="pw" class="field" type="password" :placeholder="$t('主密码')" autocomplete="current-password" @input="error = ''" />
            <button v-if="status?.biometric_enabled" type="button" class="icon-btn bio" title="Touch ID / Face ID" @click="unlockBiometric">
              <Fingerprint :size="20" />
            </button>
          </div>
          <div v-if="error" class="gate-error">{{ error }}</div>
          <div v-if="error && status?.hint" class="gate-hint">{{ $t('提示：{hint}', { hint: status.hint }) }}</div>
          <button class="btn primary wide" :disabled="!pw || busy">{{ busy ? $t('解锁中…') : $t('解锁') }}</button>
        </form>
        <button class="link-btn" @click="(recoverMode = true), (error = '')">{{ $t('忘记主密码？') }}</button>
      </div>
      <div v-else class="gate">
        <div class="gate-title">{{ $t('用恢复密钥重设主密码') }}</div>
        <form class="gate-form" @submit.prevent="recover">
          <input v-model="rkInput" class="field mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" />
          <input v-model="pw" class="field" type="password" :placeholder="$t('新主密码（至少 8 位）')" autocomplete="new-password" />
          <input v-model="pw2" class="field" type="password" :placeholder="$t('再输一次')" autocomplete="new-password" />
          <input v-model="hintText" class="field" :placeholder="$t('密码提示（可选）')" />
          <div v-if="error" class="gate-error">{{ error }}</div>
          <button class="btn primary wide" :disabled="busy || !rkInput || !pw">{{ busy ? $t('处理中…') : $t('重设并解锁') }}</button>
        </form>
        <button class="link-btn" @click="(recoverMode = false), (error = '')">{{ $t('返回') }}</button>
      </div>
    </div>

    <!-- ========== 已解锁 ========== -->
    <template v-else-if="phase === 'open'">
      <!-- 导航 -->
      <nav class="s-nav">
        <div class="titlebar drag-region s-head">
          <button v-if="phone" class="icon-btn" @click="emit('back')"><ChevronLeft :size="22" /></button>
          <span class="s-brand"><component :is="projMode ? FolderKanban : ShieldCheck" :size="15" /> {{ projMode ? $t('项目') : $t('证件夹') }}</span>
          <span class="spacer" />
          <button class="icon-btn no-drag" :title="$t('立即锁定')" @click="lock"><Lock :size="15" /></button>
          <button class="icon-btn no-drag" :title="$t('证件夹设置')" @click="(showSettings = true), (error = '')"><Settings :size="15" /></button>
        </div>
        <div v-if="projMode" class="s-scroll">
          <div class="p-tools">
            <input v-model="projectQuery" class="search" :placeholder="$t('搜索项目')" />
            <button class="icon-btn" :title="$t('新建项目')" @click="newProject"><Plus :size="16" /></button>
          </div>
          <div
            v-for="p in shownProjects"
            :key="p.id"
            class="s-item p-item"
            :data-drop="p.id"
            :class="{ active: projectId === p.id, archived: isArchived(p), 'drop-target': dragOver === p.id }"
            @click="openProject(p.id)"
          >
            <FolderKanban class="ico" :size="17" />
            <span class="label">{{ p.title }}<small v-if="p.fields.client">{{ p.fields.client }}</small></span>
            <span v-if="projectWarn(p)" class="count warn">!</span>
            <span v-else class="count">{{ filesOf(p).length || '' }}</span>
          </div>
          <div v-if="!projects.length" class="s-empty">{{ $t('点 + 新建第一个项目') }}</div>
          <div v-if="unassigned.length || dragItem" class="s-item" data-drop="none" :class="{ active: projectId === 'none', 'drop-target': dragOver === 'none' }" @click="openProject('none')">
            <FolderClosed class="ico" :size="17" /><span class="label">{{ $t('未归入项目') }}</span><span class="count">{{ unassigned.length }}</span>
          </div>
          <label v-if="projects.some(isArchived)" class="p-archived"><input v-model="showArchived" type="checkbox" /> {{ $t('显示已结束的项目') }}</label>
        </div>
        <div v-else class="s-scroll">
          <div class="s-item" :class="{ active: nav.kind === 'all' }" @click="selectNav({ kind: 'all' })">
            <Layers class="ico" :size="17" /><span class="label">{{ $t('全部') }}</span><span class="count">{{ itemsLoading ? '' : entries.length }}</span>
          </div>
          <div class="s-item" :class="{ active: nav.kind === 'fav' }" @click="selectNav({ kind: 'fav' })">
            <Star class="ico" :size="17" /><span class="label">{{ $t('收藏') }}</span>
          </div>
          <div class="s-item" :class="{ active: nav.kind === 'expiring' }" @click="selectNav({ kind: 'expiring' })">
            <AlarmClock class="ico" :size="17" /><span class="label">{{ $t('即将到期') }}</span>
            <span v-if="expiringCount" class="count warn">{{ expiringCount }}</span>
          </div>

          <div class="s-section">{{ $t('类型||分类标题') }}</div>
          <div
            v-for="g in GROUPS"
            :key="g.id"
            class="s-item"
            :class="{ active: nav.kind === 'group' && nav.id === g.id }"
            @click="selectNav({ kind: 'group', id: g.id })"
          >
            <component :is="GROUP_ICON[g.id]" class="ico" :size="17" /><span class="label">{{ g.label }}</span>
          </div>

          <div class="s-section">
            {{ $t('分类') }}
            <button class="side-add" :title="$t('新建分类（用 / 分级，如 公司A/项目X）')" @click="startNewCategory()"><Plus :size="13" /></button>
          </div>
          <div
            v-for="c in categories"
            :key="c"
            class="s-item"
            :data-drop="'cat:' + c"
            :class="{ active: nav.kind === 'category' && nav.path === c, 'drop-target': dragOver === 'cat:' + c }"
            :style="{ paddingLeft: 12 + (c.split('/').length - 1) * 14 + 'px' }"
            @click="selectNav({ kind: 'category', path: c })"
          >
            <FolderClosed class="ico" :size="17" /><span class="label">{{ c.split('/').pop() }}</span>
            <button class="side-add row-add" :title="$t('新建子分类')" @click.stop="startNewCategory(c)"><Plus :size="12" /></button>
          </div>
          <div v-if="newCategory !== null" class="s-item">
            <input
              ref="newCatInput"
              v-model="newCategory"
              class="inline-input"
              :placeholder="$t('如 公司A/项目X')"
              @keydown.enter="commitNewCategory"
              @keydown.esc="newCategory = null"
              @blur="commitNewCategory"
            />
          </div>
          <div v-if="!categories.length && newCategory === null" class="s-empty">{{ $t('按公司、项目分类，点 + 新建') }}</div>
        </div>
      </nav>

      <!-- 列表 -->
      <section ref="listEl" class="s-list" :class="{ 'drop-on': dropHover === 'list' }">
        <div v-if="dropHover === 'list'" class="list-drop"><Upload :size="22" /><span>{{ nav.kind === 'category' ? $t('松手导入到「{name}」', { name: navTitle }) : $t('松手导入') }}</span><small>{{ $t('证书、密钥、描述文件、发票、合同……每个文件一条') }}</small></div>
        <div v-if="progress && !editing" class="list-busy"><i class="spinner" />{{ progress }}</div>
        <div class="titlebar drag-region s-head">
          <button v-if="phone" class="icon-btn" @click="pane = 'nav'"><ChevronLeft :size="22" /></button>
          <input v-model="query" class="search no-drag" :placeholder="$t('搜索证件夹')" />
          <button class="icon-btn no-drag" :title="$t('导入文件（证书、密钥、发票…也可以直接拖进列表）')" @click="pickImport"><Upload :size="16" /></button>
          <button class="icon-btn no-drag" :title="$t('新建')" @click="showTypePicker = !showTypePicker"><Plus :size="17" /></button>
        </div>
        <div v-if="projMode && currentProject" class="p-card" :class="{ active: selectedId === currentProject.id }" @click="select(currentProject.id)">
          <div class="p-name">{{ currentProject.title }}</div>
          <div class="p-meta">
            <span v-if="currentProject.fields.client">{{ currentProject.fields.client }}</span>
            <span v-if="currentProject.fields.status" class="tag" :class="{ warn: !isArchived(currentProject) }">{{ statusText(currentProject.fields.status) }}</span>
            <span>{{ $t('{n} 个文件', { n: list.length }) }}</span>
          </div>
        </div>
        <div class="list-subhead">
          <span class="view-title">{{ navTitle }}</span>
          <span class="view-count">{{ itemsLoading ? '' : list.length }}</span>
        </div>
        <div class="s-rows">
          <template v-for="(it, i) in list" :key="it.id">
          <div v-if="projMode && (i === 0 || list[i - 1].type !== it.type)" class="p-group">{{ typeOf(it.type).label }}</div>
          <div class="s-row" :class="{ active: selectedId === it.id, dragging: dragItem?.id === it.id }" @pointerdown="onItemDown($event, it.id)" @click="select(it.id)">
            <div class="row-ico" :class="'g-' + typeOf(it.type).group">
              <component :is="GROUP_ICON[typeOf(it.type).group]" :size="16" />
            </div>
            <div class="row-main">
              <div class="row-title">
                <Star v-if="it.favorite" class="fav" :size="11" />
                {{ it.title }}
              </div>
              <div class="row-sub">{{ subtitle(it) }}</div>
              <div v-if="(!projMode && (it.category || projectOf(it))) || expiryState(it).state" class="row-tags">
                <span v-if="!projMode && projectOf(it)" class="tag">{{ projectOf(it)!.title }}</span>
                <span v-else-if="!projMode && it.category" class="tag">{{ it.category }}</span>
                <span v-if="expiryState(it).state === 'expired'" class="tag bad">{{ $t('已过期') }}</span>
                <span v-else-if="expiryState(it).state === 'soon'" class="tag warn">{{ $t('{date} 到期', { date: expiryState(it).date ?? '' }) }}</span>
              </div>
            </div>
          </div>
          </template>
          <template v-if="itemsLoading">
            <div v-for="n in 5" :key="'sk' + n" class="s-row skeleton">
              <div class="row-ico sk" />
              <div class="row-main"><div class="sk line" /><div class="sk line short" /></div>
            </div>
          </template>
          <EmptyArt
            v-else-if="!list.length"
            size="sm"
            :name="query.trim() ? 'empty-search' : projMode || nav.kind === 'group' && nav.id === 'project' || nav.kind === 'category' ? 'project-files' : 'safe-empty'"
            :text="query.trim() ? $t('没有匹配的条目') : projMode ? (currentProject || projectId === 'none' ? $t('把证书、密钥、合同、发票拖到这里') : $t('在左边选择或新建一个项目')) : nav.kind === 'category' || (nav.kind === 'group' && nav.id === 'project') ? $t('把证书、密钥、合同、发票拖到这里') : items.length ? $t('这里还没有条目') : $t('还没有内容，点右上角 + 添加')"
          />
        </div>

        <!-- 新建：选类型 -->
        <div v-if="showTypePicker" class="type-picker" @click.self="showTypePicker = false">
          <div class="tp-card">
            <div v-for="g in projMode ? GROUPS.filter((x) => ['project', 'login', 'company'].includes(x.id)) : GROUPS" :key="g.id" class="tp-group">
              <div class="tp-title">{{ g.label }}</div>
              <div class="tp-grid">
                <button v-for="t in TYPES.filter((x) => x.group === g.id && x.id !== 'project')" :key="t.id" class="tp-btn" @click="startNew(t.id)">
                  <component :is="GROUP_ICON[g.id]" :size="14" /> {{ t.label }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 详情 / 编辑 -->
      <main ref="detailEl" class="s-detail" :class="{ dropping: dropHover === 'area' }" :data-drop-text="$t('松开以添加照片或 PDF')">
        <div class="titlebar drag-region s-head">
          <button v-if="phone" class="icon-btn" @click="editing ? cancelEdit() : (pane = 'list')"><ChevronLeft :size="22" /></button>
          <span class="spacer" />
          <template v-if="editing">
            <button class="btn no-drag" :disabled="!!progress" @click="cancelEdit">{{ $t('取消') }}</button>
            <button class="btn primary no-drag" :disabled="!!progress" @click="saveEdit">{{ $t('保存') }}</button>
          </template>
          <template v-else-if="selected">
            <button class="icon-btn no-drag" :class="{ on: selected.favorite }" :title="$t('收藏')" @click="toggleFavorite"><Star :size="15" /></button>
            <button class="icon-btn no-drag" :title="$t('删除')" @click="removeItem"><Trash2 :size="15" /></button>
            <button v-if="envText(selected)" class="btn no-drag" :title="$t('复制成 .env 文件的格式，30 秒后从剪贴板清除')" @click="copyEnv(selected)"><Copy :size="13" /> .env</button>
            <button class="btn no-drag" @click="startEdit"><Pencil :size="13" /> {{ $t('编辑') }}</button>
          </template>
        </div>

        <!-- 编辑 -->
        <div v-if="editing" class="d-body">
          <div class="d-type">{{ typeOf(editing.type).label }}</div>
          <input v-model="editing.title" class="title-input" :placeholder="$t('{title}（标题，可留空）', { title: autoTitle(editing) })" />
          <template v-if="typeOf(editing.type).photos">
            <div class="d-section first">
              {{ $t('证件照片') }}
              <span class="muted">{{ progress ? '' : canRecognize(editing.type) ? $t('点击或把照片、PDF 拖到这里，自动识别并填写（在本机完成）') : $t('点击或拖入照片、PDF') }}</span>
            </div>
            <div class="slots" :class="{ busy: !!progress }">
              <div v-if="progress" class="scan"><span class="scan-label"><i class="spinner" />{{ progress }}</span></div>
              <div v-for="slot in typeOf(editing.type).photos" :key="slot" class="slot" :class="{ drop: dropHover === slot }" :data-slot="slot" @click="pickFile(slot)">
                <template v-if="slotFile(editing, slot)">
                  <img v-if="thumbs[slotFile(editing, slot)!.id]" :src="thumbs[slotFile(editing, slot)!.id]" />
                  <FileText v-else :size="22" />
                  <button class="slot-x" :title="$t('移除')" @click.stop="removeFile(slotFile(editing, slot)!)"><X :size="12" /></button>
                </template>
                <template v-else><Plus :size="18" /></template>
                <span class="slot-label">{{ $t(slot) }}</span>
              </div>
            </div>
          </template>

          <div v-if="typeOf(editing.type).photos" class="d-section">{{ $t('信息') }}</div>
          <div class="form">
            <template v-if="editing.type !== 'project'">
              <label class="f-label">{{ $t('所属项目') }}</label>
              <select v-model="editing.project" class="field">
                <option :value="undefined">{{ $t('不属于项目') }}</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.title }}{{ p.fields.client ? ' · ' + p.fields.client : '' }}</option>
              </select>
            </template>
            <label v-if="!projMode || editing.type !== 'project'" class="f-label">{{ $t('分类') }}</label>
            <div v-if="!projMode || editing.type !== 'project'">
              <input v-model="editing.category" class="field" list="safe-cats" :placeholder="$t('个人（留空）或 公司A/项目X')" />
              <datalist id="safe-cats"><option v-for="c in categories" :key="c" :value="c" /></datalist>
            </div>
            <template v-for="f in typeOf(editing.type).fields" :key="f.key">
              <label class="f-label">{{ f.label }}</label>
              <textarea v-if="f.kind === 'multiline'" v-model="editing.fields[f.key]" class="field area" :placeholder="f.placeholder" rows="3" />
              <div v-else class="inline">
                <input
                  v-model="editing.fields[f.key]"
                  class="field"
                  :class="{ mono: f.kind === 'code' || f.kind === 'secret' || f.kind === 'totp' }"
                  :type="inputType(f)"
                  :placeholder="f.placeholder"
                  autocomplete="off"
                  spellcheck="false"
                />
                <template v-if="f.kind === 'secret'">
                  <button class="icon-btn" type="button" :title="$t('显示 / 隐藏')" @click="revealed.has('edit:' + f.key) ? revealed.delete('edit:' + f.key) : revealed.add('edit:' + f.key)">
                    <EyeOff v-if="revealed.has('edit:' + f.key)" :size="15" /><Eye v-else :size="15" />
                  </button>
                  <button
                    v-if="f.key === 'password'"
                    class="icon-btn"
                    type="button"
                    :title="$t('生成强密码')"
                    @click="(editing.fields[f.key] = generatePassword()), revealed.add('edit:' + f.key)"
                  >
                    <WandSparkles :size="15" />
                  </button>
                </template>
              </div>
            </template>

            <template v-for="(e, i) in editing.extra" :key="'x' + i">
              <input v-model="e.label" class="field f-label-input" :placeholder="$t('字段名')" />
              <div class="inline">
                <input v-model="e.value" class="field" :type="e.secret && !revealed.has('x' + i) ? 'password' : 'text'" :placeholder="$t('内容||值')" />
                <button class="icon-btn" :class="{ on: e.secret }" type="button" :title="$t('敏感内容（默认隐藏）')" @click="e.secret = !e.secret">
                  <EyeOff v-if="e.secret" :size="15" /><Eye v-else :size="15" />
                </button>
                <button class="icon-btn" type="button" :title="$t('删除字段')" @click="editing.extra.splice(i, 1)"><X :size="15" /></button>
              </div>
            </template>
            <span />
            <button class="link-btn left" type="button" @click="editing.extra.push({ label: '', value: '' })"><Plus :size="12" /> {{ $t('添加字段') }}</button>
          </div>

          <div class="d-section">{{ $t('附件') }} <span class="muted">{{ $t('合同、扫描件等，加密保存') }}</span></div>
          <div class="files">
            <div v-for="f in looseFiles(editing)" :key="f.id" class="file">
              <Paperclip :size="13" /><span class="fname">{{ f.name }}</span><span class="muted">{{ fmtSize(f.size) }}</span>
              <button v-if="f.mime === 'application/pdf'" class="text-link" :disabled="!!progress" :title="$t('拆成单页图片')" @click="splitAttachment(f)">{{ $t('拆分') }}</button>
              <button class="icon-btn" @click="removeFile(f)"><X :size="13" /></button>
            </div>
            <button class="btn" type="button" :disabled="!!progress" @click="pickFile()"><Paperclip :size="13" /> {{ $t('添加附件') }}</button>
            <span v-if="!progress" class="muted">{{ $t('也可以把文件拖进来') }}</span>
            <span v-if="progress" class="muted">{{ progress }}</span>
          </div>

          <div class="d-section">{{ $t('备注') }}</div>
          <textarea v-model="editing.notes" class="field area" rows="4" :placeholder="$t('其它信息')" />
        </div>

        <!-- 查看 -->
        <div v-else-if="selected" class="d-body">
          <div class="d-type">{{ typeOf(selected.type).label }}<template v-if="projectOf(selected)"> · {{ projectOf(selected)!.title }}</template><template v-else-if="selected.category"> · {{ selected.category }}</template></div>
          <h1 class="d-title selectable">{{ selected.title }}</h1>

          <div v-if="selected.type === 'bankcard'" class="bankcard">
            <div class="bc-bank">{{ selected.fields.bank || $t('银行卡') }}</div>
            <div class="bc-number">
              {{ revealed.has('number') ? (selected.fields.number || '').replace(/(\d{4})(?=\d)/g, '$1 ') : mask(selected.fields.number || '') }}
            </div>
            <div class="bc-foot">
              <span>{{ selected.fields.holder }}</span>
              <span v-if="selected.fields.expires">{{ $t('有效期 {date}', { date: selected.fields.expires.slice(5) + '/' + selected.fields.expires.slice(2, 4) }) }}</span>
            </div>
          </div>

          <div v-if="expiryState(selected).state" class="expiry" :class="expiryState(selected).state">
            <AlarmClock :size="14" />
            {{ expiryState(selected).state === 'expired' ? $t('已于 {date} 过期', { date: expiryState(selected).date ?? '' }) : $t('将于 {date} 到期', { date: expiryState(selected).date ?? '' }) }}
          </div>

          <div class="props">
            <template v-for="f in typeOf(selected.type).fields" :key="f.key">
              <div v-if="selected.fields[f.key]" class="prop">
                <div class="p-label">{{ f.label }}</div>
                <div class="p-value" :class="{ mono: f.kind === 'code' || f.kind === 'secret' || f.kind === 'totp' }">
                  <template v-if="f.kind === 'totp'">
                    <span class="totp selectable">{{ codes[f.key]?.code.replace(/(\d{3})/, '$1 ') ?? $t('密钥无效') }}</span>
                    <span v-if="codes[f.key]" class="totp-left" :class="{ low: codes[f.key]!.remaining <= 5 }">{{ codes[f.key]!.remaining }}s</span>
                  </template>
                  <template v-else-if="f.kind === 'secret'">
                    <span class="selectable" :class="{ pre: revealed.has(f.key) }">{{ revealed.has(f.key) ? selected.fields[f.key] : '••••••••' }}</span>
                  </template>
                  <a v-else-if="f.kind === 'url'" class="link" @click="openUrl(selected.fields[f.key].includes('://') ? selected.fields[f.key] : 'https://' + selected.fields[f.key])">
                    {{ selected.fields[f.key] }}
                  </a>
                  <span v-else class="selectable pre">{{ selected.type === 'project' && f.key === 'status' ? statusText(selected.fields[f.key]) : selected.fields[f.key] }}</span>
                </div>
                <div class="p-actions">
                  <button
                    v-if="f.kind === 'secret' || (selected.type === 'bankcard' && f.key === 'number')"
                    class="icon-btn"
                    :title="$t('显示 / 隐藏')"
                    @click="revealed.has(f.key) ? revealed.delete(f.key) : revealed.add(f.key)"
                  >
                    <EyeOff v-if="revealed.has(f.key)" :size="14" /><Eye v-else :size="14" />
                  </button>
                  <button
                    class="icon-btn"
                    :title="$t('复制')"
                    @click="copy(f.kind === 'totp' ? codes[f.key]?.code ?? '' : selected.fields[f.key], f.kind === 'secret' || f.kind === 'totp' || f.kind === 'code')"
                  >
                    <Copy :size="14" />
                  </button>
                </div>
              </div>
            </template>
            <div v-for="(e, i) in selected.extra" :key="'x' + i" class="prop">
              <div class="p-label">{{ e.label }}</div>
              <div class="p-value">
                <span class="selectable pre">{{ e.secret && !revealed.has('x' + i) ? '••••••••' : e.value }}</span>
              </div>
              <div class="p-actions">
                <button v-if="e.secret" class="icon-btn" @click="revealed.has('x' + i) ? revealed.delete('x' + i) : revealed.add('x' + i)">
                  <EyeOff v-if="revealed.has('x' + i)" :size="14" /><Eye v-else :size="14" />
                </button>
                <button class="icon-btn" :title="$t('复制')" @click="copy(e.value, !!e.secret)"><Copy :size="14" /></button>
              </div>
            </div>
          </div>

          <template v-if="selected.files.some((f) => f.slot && typeOf(selected!.type).photos?.includes(f.slot))">
            <div class="d-section">{{ $t('证件照片') }}</div>
            <div class="slots">
              <template v-for="slot in typeOf(selected.type).photos" :key="slot">
                <div v-if="slotFile(selected, slot)" class="slot filled" :class="{ drop: dropHover === slot }" :data-slot="slot" @click="openFile(slotFile(selected, slot)!)">
                  <img v-if="thumbs[slotFile(selected, slot)!.id]" :src="thumbs[slotFile(selected, slot)!.id]" />
                  <FileText v-else :size="22" />
                  <span class="slot-label">{{ $t(slot) }}</span>
                </div>
              </template>
            </div>
          </template>

          <template v-if="looseFiles(selected).length">
            <div class="d-section">{{ $t('附件') }}</div>
            <div class="files">
              <div v-for="f in looseFiles(selected)" :key="f.id" class="file click" @click="openFile(f)">
                <Paperclip :size="13" /><span class="fname">{{ f.name }}</span><span class="muted">{{ fmtSize(f.size) }}</span>
                <button class="icon-btn" :title="$t('导出')" @click.stop="exportFile(f)"><Download :size="13" /></button>
              </div>
            </div>
          </template>

          <template v-if="selected.notes">
            <div class="d-section">{{ $t('备注') }}</div>
            <div class="notes selectable">{{ selected.notes }}</div>
          </template>
        </div>

        <EmptyArt v-else class="d-empty" :name="nav.kind === 'category' || (nav.kind === 'group' && nav.id === 'project') ? 'project-files' : 'safe-empty'" size="lg" :text="$t('选择一个条目，或点 + 新建')" />
      </main>

      <div v-if="dragItem" class="drag-ghost" :style="{ left: dragPos.x + 12 + 'px', top: dragPos.y + 8 + 'px' }">
        {{ dragItem.title }}<small v-if="!dragOver">{{ projMode ? $t('拖到左边的项目') : $t('拖到左边的分类') }}</small>
      </div>

      <!-- 附件预览 -->
      <div v-if="viewer" class="viewer" @click.self="viewer = null">
        <div class="viewer-bar">
          <span>{{ viewer.file.name }}</span>
          <span class="spacer" />
          <button class="btn" @click="exportFile(viewer.file)"><Download :size="13" /> {{ $t('导出') }}</button>
          <button class="icon-btn" @click="viewer = null"><X :size="16" /></button>
        </div>
        <img v-if="viewer.file.mime.startsWith('image/')" :src="viewer.url" class="viewer-img" />
        <iframe v-else-if="viewer.file.mime === 'application/pdf'" :src="viewer.url" class="viewer-pdf" />
        <div v-else class="viewer-other">{{ $t('这种文件不能直接预览，请导出后用其它应用打开') }}</div>
      </div>

      <!-- 证件夹设置 -->
      <div v-if="showSettings" class="sheet-backdrop" @click.self="showSettings = false">
        <div class="sheet safe-settings">
          <h3>{{ $t('解锁') }}</h3>
          <label v-if="status?.biometric_available" class="check">
            <input type="checkbox" :checked="status.biometric_enabled" @change="toggleBiometric" /> {{ $t('用 Touch ID / Face ID 解锁') }}
          </label>
          <div class="check">
            <span>{{ $t('闲置') }}</span>
            <select v-model.number="autolock" class="select">
              <option :value="1">{{ $t('{n} 分钟', { n: 1 }) }}</option>
              <option :value="5">{{ $t('{n} 分钟', { n: 5 }) }}</option>
              <option :value="15">{{ $t('{n} 分钟', { n: 15 }) }}</option>
              <option :value="30">{{ $t('{n} 分钟', { n: 30 }) }}</option>
            </select>
            <span>{{ $t('后自动锁定') }}</span>
          </div>
          <h3 class="gap">{{ $t('修改主密码') }}</h3>
          <input v-model="oldPw" class="field" type="password" :placeholder="$t('当前主密码')" autocomplete="current-password" />
          <input v-model="pw" class="field" type="password" :placeholder="$t('新主密码（至少 8 位）')" autocomplete="new-password" />
          <input v-model="pw2" class="field" type="password" :placeholder="$t('再输一次')" autocomplete="new-password" />
          <input v-model="hintText" class="field" :placeholder="$t('密码提示（可选）')" />
          <div v-if="error" class="gate-error">{{ error }}</div>
          <div class="row end">
            <button class="btn" :disabled="busy || !oldPw || !pw" @click="changePassword">{{ $t('修改') }}</button>
          </div>
          <h3 class="gap">{{ $t('恢复密钥') }}</h3>
          <p class="hint">{{ $t('恢复密钥丢了或可能泄露时，生成一个新的，旧的立即作废。') }}</p>
          <div class="row end">
            <button class="btn" @click="newRecoveryKey">{{ $t('重新生成恢复密钥') }}</button>
          </div>
          <div class="row end">
            <button class="btn primary" @click="showSettings = false">{{ $t('完成') }}</button>
          </div>
        </div>
      </div>
    </template>

    <div v-if="toast" class="s-toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.safe {
  flex: 1;
  display: flex;
  min-width: 0;
  height: 100%;
  position: relative;
  background: var(--bg-editor);
  color: var(--text);
}
.spacer { flex: 1; }
.muted { color: var(--text-2); font-size: 11px; }
.mono { font-family: var(--font-mono); }
.pre { white-space: pre-wrap; word-break: break-all; }

/* ---------- 门（设置 / 解锁） ---------- */
.safe-gate { flex: 1; display: flex; flex-direction: column; }
.gate-bar { display: flex; align-items: center; padding: 0 8px; }
.gate {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 24px 12vh;
  text-align: center;
}
.gate-icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background: var(--selected);
  color: var(--accent);
  margin-bottom: 6px;
}
.gate-title { font-size: 18px; font-weight: 700; }
.gate-sub { max-width: 420px; margin: 0 0 8px; color: var(--text-2); font-size: 12px; line-height: 1.7; }
.gate-form { display: flex; flex-direction: column; width: 280px; gap: 0; }
.gate-form .field { margin-bottom: 8px; }
.gate-error { color: var(--accent); font-size: 12px; margin: -2px 0 8px; }
.gate-hint { color: var(--text-2); font-size: 12px; margin: -4px 0 8px; }
.btn.wide { width: 100%; height: 30px; }
.inline { display: flex; align-items: center; gap: 4px; }
.inline .field { flex: 1; margin-bottom: 0; }
.gate-form .inline { margin-bottom: 8px; }
.bio { color: var(--accent); width: 32px; height: 28px; }
.link-btn { margin-top: 8px; font-size: 12px; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; gap: 3px; }
.link-btn:hover { color: var(--accent); }
.link-btn.left { margin: 0; justify-self: start; }
.meter { display: flex; gap: 4px; margin: -4px 0 8px; }
.meter i { flex: 1; height: 3px; border-radius: 2px; background: var(--border); }
.meter i.on.s1 { background: #e5484d; }
.meter i.on.s2 { background: #f5a524; }
.meter i.on.s3 { background: #8bc34a; }
.meter i.on.s4 { background: #30a46c; }
.rk {
  padding: 14px 18px;
  border-radius: 10px;
  background: var(--selected);
  font: 15px/1.6 var(--font-mono);
  letter-spacing: 0.04em;
  max-width: 360px;
  word-break: break-all;
}
.row-center { display: flex; gap: 8px; margin: 4px 0; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 8px 0; }
.gate .btn.wide { width: 280px; }

/* ---------- 三栏 ---------- */
.s-head { display: flex; align-items: center; gap: 6px; padding: 0 10px; }
.s-nav {
  width: 210px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-list);
  border-right: 1px solid var(--border);
}
.s-brand { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; color: var(--accent); }
.s-scroll { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
.s-item {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 32px;
  font-size: 14.5px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: default;
}
.s-item:hover .row-add { opacity: 1; }
.s-item.active { background: var(--selected); }
.s-item .ico { color: var(--text-2); flex-shrink: 0; }
.s-item .label { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.count { color: var(--text-2); font-size: 11px; }
.count.warn { color: #f5a524; font-weight: 600; }
.s-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.side-add { width: 18px; height: 18px; display: grid; place-items: center; border-radius: 4px; color: var(--text-2); }
.side-add:hover { background: var(--selected); color: var(--text); }
.row-add { opacity: 0; }
.s-empty { margin: 2px 10px; font-size: 11px; color: var(--text-2); }
.inline-input { width: 100%; height: 22px; padding: 0 6px; border: 1px solid var(--accent); border-radius: 4px; background: var(--bg-editor); color: var(--text); }

.s-list {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-list);
  position: relative;
}
.search {
  flex: 1;
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  border: none;
  background: var(--selected);
  color: var(--text);
}
.list-subhead { display: flex; align-items: baseline; gap: 6px; padding: 4px 18px 8px; }
.view-title { font-size: 18px; font-weight: 700; }
.view-count { color: var(--text-2); }
.s-rows { flex: 1; overflow-y: auto; padding: 0 8px; }
.s-row { display: flex; gap: 10px; padding: 10px; border-radius: 8px; }
.s-row.active { background: var(--selected-active); color: #fff; }
.s-row.active .row-sub, .s-row.active .tag { color: rgba(255, 255, 255, 0.85); background: rgba(255, 255, 255, 0.16); }
.s-row.active .row-sub { background: none; }
.row-ico {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #fff;
}
.g-personal { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.g-finance { background: linear-gradient(135deg, #f59e0b, #d97706); }
.g-login { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
.g-project { background: linear-gradient(135deg, #f59e0b, #b45309); }
.g-company { background: linear-gradient(135deg, #10b981, #047857); }
.g-other { background: linear-gradient(135deg, #94a3b8, #64748b); }
.row-main { min-width: 0; flex: 1; }
.row-title { font-weight: 600; font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fav { color: #f5a524; vertical-align: -1px; }
.row-sub { font-size: 12px; color: var(--text-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-top: 2px; }
.row-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--selected); color: var(--text-2); }
.tag.warn { background: rgba(245, 165, 36, 0.16); color: #d98a00; }
.tag.bad { background: rgba(229, 72, 77, 0.15); color: #e5484d; }
.empty { padding: 40px 16px; text-align: center; color: var(--text-2); font-size: 12px; }

.type-picker { position: absolute; inset: 52px 0 0; z-index: 5; background: rgba(0, 0, 0, 0.12); padding: 8px; }
.tp-card {
  max-height: 100%;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-editor);
  border: 1px solid var(--border);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.tp-group + .tp-group { margin-top: 10px; }
.tp-title { font-size: 11px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.tp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.tp-btn { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; text-align: left; font-size: 12px; }
.tp-btn:hover { background: var(--selected); }

/* ---------- 详情 ---------- */
.s-detail { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.s-detail .s-head .btn { display: inline-flex; align-items: center; gap: 4px; }
.icon-btn.on { color: #f5a524; }
.d-body { flex: 1; overflow-y: auto; padding: 4px 36px 40px; max-width: 760px; width: 100%; box-sizing: border-box; }
.d-type { font-size: 12px; color: var(--text-2); }
.d-title { margin: 4px 0 16px; font-size: 24px; }
.title-input { width: 100%; margin: 4px 0 16px; padding: 4px 0; border: none; border-bottom: 1px solid var(--border); background: none; color: var(--text); font-size: 22px; font-weight: 700; }
.title-input:focus { outline: none; border-color: var(--accent); }
.d-section.first { margin-top: 0; }
.d-section { margin: 24px 0 8px; font-size: 12px; font-weight: 600; color: var(--text-2); display: flex; gap: 8px; align-items: baseline; }

.props { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.prop { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 12px; padding: 9px 12px; }
.prop + .prop { border-top: 1px solid var(--border); }
.prop:hover .p-actions { opacity: 1; }
.p-label { color: var(--text-2); font-size: 12px; }
.p-value { min-width: 0; font-size: 13px; display: flex; align-items: center; gap: 10px; }
.p-actions { display: flex; gap: 2px; opacity: 0.35; transition: opacity 0.15s; }
.link { color: var(--accent); cursor: pointer; word-break: break-all; }
.totp { font: 600 18px var(--font-mono); letter-spacing: 0.06em; color: var(--accent); }
.totp-left { font-size: 11px; color: var(--text-2); }
.totp-left.low { color: #e5484d; }

.form { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; align-items: center; }
.f-label { color: var(--text-2); font-size: 12px; text-align: right; }
.f-label-input { text-align: right; margin: 0; }
.form .field { margin: 0; }
.field.area { height: auto; padding: 6px 8px; resize: vertical; font: 13px/1.5 var(--font-ui); }

.slots { display: flex; flex-wrap: wrap; gap: 10px; position: relative; }
/* 识别中：照片区不可点、扫描线动画 */
.slots.busy .slot { pointer-events: none; opacity: 0.55; }
.s-list { position: relative; }
.list-drop {
  position: absolute; inset: 52px 8px 8px; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  border: 2px dashed var(--accent); border-radius: 12px; background: color-mix(in srgb, var(--accent) 10%, var(--bg)); color: var(--accent); pointer-events: none;
}
.list-drop small { color: var(--muted, #888); font-size: 11px; }
.list-busy { display: flex; align-items: center; gap: 8px; margin: 4px 12px 8px; padding: 8px 10px; border-radius: 8px; background: var(--hover, rgba(127,127,127,.12)); font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.scan {
  position: absolute;
  inset: -4px;
  z-index: 2;
  border-radius: 12px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--bg-editor) 35%, transparent);
  cursor: progress;
}
.scan::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 36%;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--accent) 22%, transparent) 80%, var(--accent) 100%);
  animation: scan 1.6s ease-in-out infinite;
}
@keyframes scan {
  from { transform: translateY(-100%); }
  to { transform: translateY(290%); }
}
.scan-label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--bg-editor);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-size: 12px;
}
.spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.spinner.big { width: 26px; height: 26px; border-width: 3px; }
/* 读取中的占位行 */
.skeleton { pointer-events: none; }
.sk { background: var(--selected); animation: pulse 1.2s ease-in-out infinite; }
.row-ico.sk { background: var(--selected); }
.sk.line { height: 11px; border-radius: 4px; margin: 4px 0 8px; width: 70%; }
.sk.line.short { width: 45%; }
@keyframes pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) {
  .scan::before, .spinner, .sk { animation: none; }
}
.slot {
  width: 168px;
  height: 108px;
  border-radius: 10px;
  border: 1.5px dashed var(--border);
  display: grid;
  place-items: center;
  position: relative;
  overflow: hidden;
  color: var(--text-2);
  cursor: pointer;
}
.slot.filled { border-style: solid; }
.slot.drop { border: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }
.s-detail { position: relative; }
.s-detail.dropping::after {
  content: attr(data-drop-text);
  position: absolute;
  inset: 60px 16px 16px;
  display: grid;
  place-items: center;
  border: 2px dashed var(--accent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--accent);
  font-size: 13px;
  pointer-events: none;
}
.slot img { width: 100%; height: 100%; object-fit: cover; }
.slot-label {
  position: absolute;
  left: 6px;
  bottom: 6px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.slot-x { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: rgba(0, 0, 0, 0.55); color: #fff; }
.text-link { font-size: 12px; color: var(--accent); cursor: pointer; }
.files { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.file { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border-radius: 8px; background: var(--selected); font-size: 12px; box-sizing: border-box; }
.file.click { cursor: pointer; }
.fname { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.files .btn { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; }
.notes { white-space: pre-wrap; font-size: 13px; line-height: 1.6; padding: 10px 12px; border-radius: 10px; background: var(--selected); }
.p-tools { display: flex; gap: 6px; align-items: center; padding: 4px 8px 8px; }
.p-tools .search { flex: 1; min-width: 0; }
.p-item .label { display: flex; flex-direction: column; line-height: 1.25; overflow: hidden; }
.p-item .label small { font-size: 10.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-item.archived { opacity: 0.55; }
.p-archived { display: flex; gap: 6px; align-items: center; margin: 10px 12px; font-size: 11px; color: var(--text-2); }
.p-card { margin: 4px 10px 6px; padding: 10px 12px; border-radius: 10px; background: var(--hover, rgba(127,127,127,.1)); cursor: pointer; }
.p-card.active { outline: 1.5px solid var(--accent); }
.p-name { font-weight: 600; font-size: 15px; }
.p-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 4px; font-size: 11.5px; color: var(--text-2); }
.p-group { margin: 10px 14px 2px; font-size: 11px; font-weight: 600; color: var(--text-2); }
.s-item.drop-target { background: color-mix(in srgb, var(--accent) 18%, transparent); outline: 1.5px dashed var(--accent); outline-offset: -1.5px; }
.s-row.dragging { opacity: 0.4; }
.s-row { user-select: none; }
.drag-ghost { position: fixed; z-index: 80; pointer-events: none; display: flex; flex-direction: column; max-width: 240px; padding: 6px 10px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 12.5px; box-shadow: 0 6px 20px rgba(0,0,0,.25); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.drag-ghost small { opacity: .8; font-size: 11px; }
.gate-art { padding: 0; margin-bottom: -6px; }
.d-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding-bottom: 12vh; }

.bankcard {
  width: 340px;
  max-width: 100%;
  aspect-ratio: 1.586;
  box-sizing: border-box;
  padding: 18px 20px;
  margin-bottom: 16px;
  border-radius: 14px;
  color: #fff;
  background: linear-gradient(135deg, #1f2937, #4b5563 60%, #9ca3af);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
}
.bc-bank { font-weight: 700; font-size: 15px; }
.bc-number { margin-top: auto; font: 600 19px var(--font-mono); letter-spacing: 0.08em; }
.bc-foot { display: flex; justify-content: space-between; margin-top: 10px; font-size: 12px; opacity: 0.9; }
.expiry { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 14px; }
.expiry.soon { background: rgba(245, 165, 36, 0.14); color: #d98a00; }
.expiry.expired { background: rgba(229, 72, 77, 0.13); color: #e5484d; }

.viewer { position: absolute; inset: 0; z-index: 30; background: rgba(0, 0, 0, 0.75); display: flex; flex-direction: column; align-items: center; }
.viewer-bar { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 16px 12px 90px; box-sizing: border-box; color: #fff; }
.viewer-bar .icon-btn { color: #fff; }
.viewer-bar .btn { display: inline-flex; align-items: center; gap: 4px; }
.viewer-img { max-width: 92%; max-height: calc(100% - 80px); object-fit: contain; border-radius: 6px; }
.viewer-pdf { width: 90%; flex: 1; margin-bottom: 20px; border: none; border-radius: 6px; background: #fff; }
.viewer-other { color: #fff; margin-top: 30vh; }

.safe-settings { width: 460px; }
.select { height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-list); color: var(--text); }
.s-toast {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 40;
  padding: 7px 14px;
  border-radius: 8px;
  background: rgba(30, 30, 30, 0.9);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
}

/* ---------- 手机：一次一栏 ---------- */
.safe.phone .s-nav, .safe.phone .s-list, .safe.phone .s-detail { width: 100%; flex: 1; border: none; }
.safe.phone.p-nav .s-list, .safe.phone.p-nav .s-detail { display: none; }
.safe.phone.p-list .s-nav, .safe.phone.p-list .s-detail { display: none; }
.safe.phone.p-detail .s-nav, .safe.phone.p-detail .s-list { display: none; }
.safe.phone .d-body { padding: 4px 16px 40px; }
.safe.phone .prop { grid-template-columns: 96px 1fr auto; }
.safe.phone .p-actions { opacity: 1; }
.safe.phone .form { grid-template-columns: 1fr; }
.safe.phone .f-label { text-align: left; margin-bottom: -4px; }
.safe.phone .slot { width: calc(50% - 5px); }
.safe.phone .viewer-bar { padding-left: 16px; }
</style>
