<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { ask, message, open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { google, syncState, formatAgo, type GoogleStatus } from '../google'
import { Check, Cloud, FolderGit2, ImageUp, KeyRound, ShieldCheck, Monitor, Moon, Palette, SlidersHorizontal, Sparkles, Sun, Type } from 'lucide-vue-next'
import { baseUrlOf, resetClient } from '../ai/client'
import { PROVIDERS as AI_PROVIDERS } from '../ai/providers'
import { keyStatus, refreshKeys } from '../ai/keys'
import ModelSelect from './ModelSelect.vue'
import { imageHost, PROVIDERS, type ImageHostConfig } from '../imagehost'
import { THEMES } from '../themes'
import { prefs, resetTypography, zoomBy } from '../prefs'
import { keySyncAvailable, keysChanged, settingsChanged } from '../settingsSync'
import { LANG_OPTIONS, langChoice, setLang, t, type LangChoice } from '../i18n'
import { checkForUpdate, updateState } from '../updater'

type Tab = 'general' | 'typography' | 'theme' | 'ai' | 'docs' | 'sync' | 'imagehost'
const props = defineProps<{ initialTab?: Tab }>()
const tab = ref<Tab>(props.initialTab ?? 'general')
const TABS = [
  { id: 'general', label: t('通用'), icon: SlidersHorizontal },
  { id: 'typography', label: t('排版'), icon: Type },
  { id: 'theme', label: t('主题'), icon: Palette },
  { id: 'ai', label: 'AI', icon: Sparkles },
  ...(isMobile ? [] : [{ id: 'docs', label: t('项目文档'), icon: FolderGit2 } as const]),
  { id: 'sync', label: t('存储与同步'), icon: Cloud },
  { id: 'imagehost', label: t('图床'), icon: ImageUp },
] as const

const emit = defineEmits<{ close: []; password: []; lock: []; recovery: []; unlock: [] }>()

// ---- 项目文档：MCP 接入 ----
interface DocsInfo {
  write: boolean
  exe: string
  projects: { name: string; folder: string; dirs: string[]; remotes: string[] }[]
}
const docsInfo = ref<DocsInfo | null>(null)
const loadDocs = async () => (docsInfo.value = await invoke<DocsInfo>('docs_info').catch(() => null))
const mcpCommand = computed(() => `claude mcp add --scope user cloud-notebook -- "${docsInfo.value?.exe ?? ''}" mcp`)
const mcpJson = computed(() => JSON.stringify({ mcpServers: { 'cloud-notebook': { command: docsInfo.value?.exe ?? '', args: ['mcp'] } } }, null, 2))
const copied = ref('')
async function copyText(which: string, text: string) {
  await writeText(text)
  copied.value = which
  setTimeout(() => copied.value === which && (copied.value = ''), 1500)
}
async function setDocsWrite(allow: boolean) {
  await invoke('docs_set_write', { allow })
  await loadDocs()
}
async function unbindProject(folder: string) {
  const ok = await ask(t('解除后，AI 在这个目录下保存文档时会新建一个项目文件夹。已有的文档保留。'), { title: t('解除绑定'), okLabel: t('解除'), cancelLabel: t('取消') })
  if (!ok) return
  await invoke('docs_unbind', { folder })
  await loadDocs()
}

// ---- Key 同步状态 ----
const remoteKeys = ref(false)
keySyncAvailable().then((v) => (remoteKeys.value = v)).catch(() => {})
const keySync = computed(() => {
  if (!lockState.config) return 'off'
  if (!lockState.key) return remoteKeys.value ? 'locked-remote' : 'locked'
  return 'on'
})
import { lockState } from '../lock'
import { isMobile } from '../platform'
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('close')
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

interface VaultInfo {
  root: string
  icloud: string
  icloud_available: boolean
}
const info = ref<VaultInfo>()
const copyNotes = ref(true)

const g = ref<GoogleStatus>()
const clientId = ref('')
const clientSecret = ref('')
const iosClientId = ref('')
const busy = ref(false)

async function refreshGoogle() {
  g.value = await google.status()
  clientId.value = g.value.client_id
  if (isMobile) iosClientId.value = await invoke<string>('google_ios_client')
}
async function saveGoogleConfig() {
  if (isMobile) await invoke('google_set_ios_client', { clientId: iosClientId.value })
  else await google.setConfig(clientId.value, clientSecret.value)
  settingsChanged()
  await refreshGoogle()
}
async function googleLogin() {
  busy.value = true
  try {
    await google.login()
    await refreshGoogle()
    syncState.value = { state: 'idle' }
    google.sync().catch(() => {})
  } catch (e) {
    await message(String(e), { title: t('Google 登录失败'), kind: 'error' })
  } finally {
    busy.value = false
  }
}
async function googleLogout() {
  const ok = await ask(t('退出后停止同步。Drive 上的文件和本地笔记都会保留。'), { title: t('退出 Google 账号'), okLabel: t('退出'), cancelLabel: t('取消') })
  if (!ok) return
  await google.logout()
  syncState.value = { state: 'off' }
  await refreshGoogle()
}
async function syncNow() {
  try {
    await google.sync()
  } catch (e) {
    await message(String(e), { title: t('同步失败'), kind: 'error' })
  }
}
async function toggleAuto(e: Event) {
  await google.setAutoSync((e.target as HTMLInputElement).checked)
  await refreshGoogle()
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  loadDocs()
  info.value = await invoke<VaultInfo>('vault_info')
  await refreshGoogle()
  await loadImageHost()
  await refreshKeys()
})

async function switchTo(path: string) {
  const ok = await ask(
    copyNotes.value
      ? t('笔记库将切换到：\n{path}\n\n现有笔记会复制过去，原文件夹保留不动。切换后应用会重启。', { path })
      : t('笔记库将切换到：\n{path}\n\n不复制现有笔记。切换后应用会重启。', { path }),
    { title: t('切换笔记库位置'), kind: 'info', okLabel: t('切换并重启'), cancelLabel: t('取消') },
  )
  if (!ok) return
  try {
    await invoke('vault_set_root', { path, moveNotes: copyNotes.value })
  } catch (e) {
    await message(String(e), { title: t('切换失败'), kind: 'error' })
  }
}

async function chooseFolder() {
  const dir = await open({ directory: true, title: t('选择笔记库文件夹') })
  if (typeof dir === 'string') await switchTo(dir)
}

// ---- AI ----
const aiKeys = ref<Record<string, string>>({})
const aiBusy = ref<string | null>(null)
const aiMsg = ref<Record<string, { ok: boolean; text: string }>>({})
const aiOpen = ref<string | null>(null)

function setBase(id: string, v: string) {
  prefs.aiBaseUrls = { ...prefs.aiBaseUrls, [id]: v.trim() }
}

async function saveProviderKey(id: string) {
  aiBusy.value = id
  try {
    await invoke('ai_set_provider_key', { provider: id, key: aiKeys.value[id] ?? '' })
    aiKeys.value[id] = ''
    keysChanged()
    if (id === 'anthropic') resetClient()
    await refreshKeys()
    aiMsg.value[id] = { ok: true, text: t('已保存到钥匙串') }
    // 保存后顺便拉一次模型列表
    if (AI_PROVIDERS.find((p) => p.id === id)?.kind === 'openai') await fetchModels(id)
  } catch (e) {
    aiMsg.value[id] = { ok: false, text: String(e) }
  } finally {
    aiBusy.value = null
  }
}

async function fetchModels(id: string) {
  aiBusy.value = id
  try {
    const models = await invoke<string[]>('ai_list_models', { provider: id, baseUrl: baseUrlOf(id) })
    prefs.aiProviderModels = { ...prefs.aiProviderModels, [id]: models }
    aiMsg.value[id] = { ok: true, text: t('获取到 {n} 个模型', { n: models.length }) }
  } catch (e) {
    aiMsg.value[id] = { ok: false, text: String(e) }
  } finally {
    aiBusy.value = null
  }
}

async function clearProviderKey(id: string) {
  await invoke('ai_clear_provider_key', { provider: id })
  keysChanged()
  if (id === 'anthropic') resetClient()
  await refreshKeys()
  aiMsg.value[id] = { ok: true, text: t('已删除') }
}

/** 手动添加接口不返回的模型名 */
function addModel(id: string, e: Event) {
  const input = e.target as HTMLInputElement
  const m = input.value.trim()
  if (!m) return
  prefs.aiProviderModels = { ...prefs.aiProviderModels, [id]: [...new Set([...(prefs.aiProviderModels[id] ?? []), m])] }
  input.value = ''
}

// ---- 图床 ----
const ih = ref<ImageHostConfig>({ provider: 'r2', endpoint: '', region: 'auto', bucket: '', access_key_id: '', prefix: 'notes', public_base_url: '', path_style: true })
const ihSecret = ref('')
const ihHasSecret = ref(false)
const ihConfigured = ref(false)
const ihBusy = ref(false)
const ihResult = ref<{ ok: boolean; text: string } | null>(null)
const provider = computed(() => PROVIDERS.find((p) => p.id === ih.value.provider) ?? PROVIDERS[PROVIDERS.length - 1])

async function loadImageHost() {
  const st = await imageHost.status()
  if (st.config.endpoint) ih.value = { ...st.config, provider: st.config.provider || 'custom' }
  ihHasSecret.value = st.has_secret
  ihConfigured.value = st.configured
}
function pickProvider(id: string) {
  const p = PROVIDERS.find((x) => x.id === id)!
  ih.value.provider = id
  ih.value.region = p.region
  ih.value.path_style = p.pathStyle
  ih.value.endpoint = ''
}
async function saveImageHost(thenTest = false) {
  ihBusy.value = true
  ihResult.value = null
  try {
    await imageHost.save(ih.value, ihSecret.value || undefined)
    settingsChanged()
    keysChanged()
    ihSecret.value = ''
    await loadImageHost()
    if (thenTest) {
      const url = await imageHost.test()
      ihResult.value = { ok: true, text: t('连接正常，测试文件可公开访问：{url}', { url }) }
    } else ihResult.value = { ok: true, text: t('已保存') }
  } catch (e) {
    ihResult.value = { ok: false, text: String(e) }
  } finally {
    ihBusy.value = false
  }
}
async function clearImageHost() {
  const ok = await ask(t('将删除图床配置和钥匙串里的密钥。已上传的图片不会被删除。'), { title: t('清除图床配置'), okLabel: t('清除'), cancelLabel: t('取消') })
  if (!ok) return
  await imageHost.clear()
  settingsChanged()
  keysChanged()
  ihResult.value = null
  await loadImageHost()
}

const APPEARANCES = [
  { id: 'system', label: t('跟随系统'), icon: Monitor },
  { id: 'light', label: t('浅色'), icon: Sun },
  { id: 'dark', label: t('深色'), icon: Moon },
] as const

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
</script>

<template>
  <div class="sheet-backdrop" @mousedown.self="$emit('close')">
    <div class="sheet" tabindex="-1">
      <nav class="tabs">
        <button v-for="t in TABS" :key="t.id" class="tab" :class="{ active: tab === t.id }" @click="tab = t.id">
          <component :is="t.icon" :size="20" :stroke-width="1.6" />
          <span>{{ t.label }}</span>
        </button>
      </nav>

      <!-- 通用 -->
      <div v-if="tab === 'general'" class="pane-body">
        <div class="form-row">
          <label>{{ $t('语言') }}</label>
          <select :value="langChoice" class="select" @change="setLang(($event.target as HTMLSelectElement).value as LangChoice)">
            <option v-for="o in LANG_OPTIONS" :key="o.id" :value="o.id">{{ o.id === 'system' ? $t(o.label) : o.label }}</option>
          </select>
        </div>
        <p class="hint indent">{{ $t('切换语言会重新加载窗口。') }}</p>
        <div class="form-row">
          <label>{{ $t('软件更新') }}</label>
          <div class="update-row">
            <label class="check"><input v-model="prefs.autoUpdate" type="checkbox" /> {{ $t('自动检查新版本') }}</label>
            <button class="btn small" :disabled="updateState.checking" @click="checkForUpdate(true)">{{ updateState.checking ? $t('正在检查…') : $t('立即检查') }}</button>
          </div>
        </div>
        <p class="hint indent">{{ $t('当前版本 {v}。检查更新时会访问 GitHub，不发送任何笔记内容；更新包校验签名后才会安装。', { v: updateState.current }) }}</p>
        <div class="form-row">
          <label>{{ $t('新建笔记||设置项') }}</label>
          <div>
            <label class="check"><input v-model="prefs.newNoteHeading" type="checkbox" /> {{ $t('以一级标题开头') }}</label>
          </div>
        </div>
        <div class="form-row">
          <label>{{ $t('标签位置') }}</label>
          <select v-model="prefs.tagPosition" class="select">
            <option value="bottom">{{ $t('笔记末尾') }}</option>
            <option value="top">{{ $t('标题下方') }}</option>
          </select>
        </div>
        <p class="hint indent">{{ $t('在某个标签下新建笔记时，自动写入的 #标签 放在哪里。') }}</p>
        <div class="form-row">
          <label>{{ $t('加密笔记||设置项') }}</label>
          <div class="row">
            <button class="btn" @click="emit('password')">{{ lockState.config ? $t('修改密码…') : $t('设置密码…') }}</button>
            <button v-if="lockState.config" class="btn" @click="emit('recovery')">{{ $t('重新生成恢复密钥…') }}</button>
            <button v-if="lockState.key" class="btn" @click="emit('lock')">{{ $t('立即锁定') }}</button>
          </div>
        </div>
        <div class="form-row">
          <label>{{ $t('自动锁定') }}</label>
          <select v-model.number="prefs.autoLockMinutes" class="select">
            <option :value="1">{{ $t('闲置 1 分钟') }}</option>
            <option :value="5">{{ $t('闲置 5 分钟') }}</option>
            <option :value="15">{{ $t('闲置 15 分钟') }}</option>
            <option :value="60">{{ $t('闲置 1 小时') }}</option>
            <option :value="0">{{ $t('退出应用前不锁定') }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('编辑器') }}</label>
          <div>
            <label class="check"><input v-model="prefs.showHeadingLevel" type="checkbox" /> {{ $t('标题左侧显示 H1–H6') }}</label>
          </div>
        </div>
        <div class="form-row">
          <label>{{ $t('缩放') }}</label>
          <div class="zoom-row">
            <button class="btn" @click="zoomBy(-1)">−</button>
            <span class="val">{{ Math.round(prefs.zoom * 100) }}%</span>
            <button class="btn" @click="zoomBy(1)">+</button>
            <button class="btn" :disabled="prefs.zoom === 1" @click="zoomBy(0)">{{ $t('恢复 100%') }}</button>
            <span class="hint">{{ $t('⌘+ 放大 · ⌘- 缩小 · ⌥⌘0 恢复') }}</span>
          </div>
        </div>
      </div>

      <!-- 排版 -->
      <div v-else-if="tab === 'typography'" class="pane-body">
        <div class="form-row">
          <label>{{ $t('字体') }}</label>
          <select v-model="prefs.fontFamily" class="select">
            <option value="system">{{ $t('系统无衬线（苹方）') }}</option>
            <option value="serif">{{ $t('衬线（宋体）') }}</option>
            <option value="mono">{{ $t('等宽') }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>{{ $t('字号') }}</label>
          <input v-model.number="prefs.fontSize" type="range" min="13" max="22" step="1" />
          <span class="val">{{ prefs.fontSize }} px</span>
        </div>
        <div class="form-row">
          <label>{{ $t('行高') }}</label>
          <input v-model.number="prefs.lineHeight" type="range" min="1.3" max="2.2" step="0.05" />
          <span class="val">{{ prefs.lineHeight.toFixed(2) }}</span>
        </div>
        <div class="form-row">
          <label>{{ $t('段落间距') }}</label>
          <input v-model.number="prefs.paragraphSpacing" type="range" min="0" max="1.5" step="0.05" />
          <span class="val">{{ prefs.paragraphSpacing.toFixed(2) }} em</span>
        </div>
        <div class="form-row">
          <label>{{ $t('标题间距') }}</label>
          <input v-model.number="prefs.headingSpacing" type="range" min="0.4" max="2" step="0.1" />
          <span class="val">{{ prefs.headingSpacing.toFixed(1) }}×</span>
        </div>
        <div class="form-row">
          <label>{{ $t('正文宽度') }}</label>
          <input v-model.number="prefs.contentWidth" type="range" min="560" max="1100" step="20" />
          <span class="val">{{ prefs.contentWidth }} px</span>
        </div>
        <div class="preview" :style="{ fontFamily: 'var(--doc-font)', fontSize: 'var(--doc-size)', lineHeight: 'var(--doc-line)' }">
          <div class="pv-h">{{ $t('标题示例') }}</div>
          <p>{{ $t('这是一段正文示例，用来预览字号、行高和段落间距的效果。The quick brown fox jumps over the lazy dog.') }}</p>
          <p>{{ $t('第二段正文。') }}</p>
        </div>
        <div class="row end">
          <button class="btn" @click="resetTypography">{{ $t('恢复默认') }}</button>
        </div>
      </div>

      <!-- 主题 -->
      <div v-else-if="tab === 'theme'" class="pane-body">
        <h3>{{ $t('外观') }}</h3>
        <div class="segmented">
          <button v-for="a in APPEARANCES" :key="a.id" :class="{ active: prefs.appearance === a.id }" @click="prefs.appearance = a.id">
            <component :is="a.icon" :size="14" /> {{ a.label }}
          </button>
        </div>
        <label class="check" style="margin-top: 12px"><input v-model="prefs.darkSidebar" type="checkbox" /> {{ $t('浅色外观下侧边栏用深空灰') }}</label>
        <h3 class="gap">{{ $t('配色') }}</h3>
        <div class="themes">
          <button v-for="t in THEMES" :key="t.id" class="theme" :class="{ active: prefs.theme === t.id }" @click="prefs.theme = t.id">
            <span class="swatch" :style="{ background: t.light['--bg-editor'] ?? '#fff', borderColor: t.light['--accent'] }">
              <span class="half" :style="{ background: t.dark['--bg-editor'] ?? '#1e1e20' }" />
              <span class="dot" :style="{ background: t.light['--accent'] }"><Check v-if="prefs.theme === t.id" :size="11" :stroke-width="3" /></span>
            </span>
            <span>{{ t.name }}</span>
          </button>
        </div>
      </div>

      <!-- AI -->
      <div v-else-if="tab === 'ai'" class="pane-body">
        <p class="hint" style="margin-top: 0">
          {{ $t('按 ⌘J 打开 AI 面板。配置任意一家服务商的 Key 即可使用，Key 存在系统钥匙串里，只在本机直连对应服务商。') }}
          {{ $t('提问时只会发送检索到的相关片段，加密笔记永远不会被读取。') }}
        </p>
        <div class="form-row">
          <label>{{ $t('默认模型') }}</label>
          <ModelSelect />
        </div>
        <div class="keysync" :class="keySync">
          <template v-if="keySync === 'on'">
            <ShieldCheck :size="14" /> <span>{{ $t('Key 已加密同步到你的其它设备（用加密笔记的密码保护，云端只存密文）。') }}</span>
          </template>
          <template v-else-if="keySync === 'locked-remote'">
            <KeyRound :size="14" /> <span>{{ $t('其它设备同步过来了 Key。输入加密笔记的密码（不是证件夹的主密码）后即可使用。') }}</span>
            <button class="btn small primary" @click="emit('unlock')">{{ $t('解锁') }}</button>
          </template>
          <template v-else-if="keySync === 'locked'">
            <KeyRound :size="14" /> <span>{{ $t('解锁加密笔记后，Key 会加密同步到其它设备。') }}</span>
            <button class="btn small" @click="emit('unlock')">{{ $t('解锁') }}</button>
          </template>
          <template v-else>
            <KeyRound :size="14" /> <span>{{ $t('设置加密密码后，Key 会加密同步到你的其它设备（手机上不用重新填）。') }}</span>
            <button class="btn small" @click="emit('password')">{{ $t('设置密码') }}</button>
          </template>
        </div>

        <div v-for="p in AI_PROVIDERS" :key="p.id" class="provider" :class="{ open: aiOpen === p.id }">
          <button class="provider-row" @click="aiOpen = aiOpen === p.id ? null : p.id">
            <span class="p-name">{{ p.name }}</span>
            <span v-if="keyStatus[p.id]" class="ok-badge">{{ $t('已配置') }}</span>
            <span v-if="keyStatus[p.id] && p.kind === 'openai'" class="p-count">{{ $t('{n} 个模型', { n: (prefs.aiProviderModels[p.id] ?? []).length }) }}</span>
            <span class="spacer" />
            <span class="p-chevron">{{ aiOpen === p.id ? $t('收起') : $t('配置') }}</span>
          </button>
          <div v-if="aiOpen === p.id" class="provider-body">
            <p v-if="p.hint" class="hint">{{ p.hint }}</p>
            <div v-if="p.editableBase" class="form-row">
              <label>{{ $t('接口地址') }}</label>
              <input
                class="field selectable"
                :value="prefs.aiBaseUrls[p.id] ?? p.baseUrl"
                :placeholder="p.baseUrl || 'https://…/v1'"
                @change="setBase(p.id, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="form-row">
              <label>API Key</label>
              <input v-model="aiKeys[p.id]" class="field selectable" type="password" :placeholder="keyStatus[p.id] ? $t('已保存在钥匙串（留空不修改）') : ''" />
            </div>
            <div v-if="keyStatus[p.id] && p.kind === 'openai'" class="form-row">
              <label>{{ $t('手动添加') }}</label>
              <input class="field selectable" :placeholder="$t('接口没列出的模型名，回车添加')" @keydown.enter="addModel(p.id, $event)" />
            </div>
            <p v-if="aiMsg[p.id]" class="ih-result" :class="{ bad: !aiMsg[p.id].ok }">{{ aiMsg[p.id].text }}</p>
            <div class="row end">
              <a v-if="p.keyUrl" href="#" class="key-link" @click.prevent="openUrl(p.keyUrl)">{{ $t('获取 Key') }}</a>
              <button v-if="keyStatus[p.id]" class="btn" @click="clearProviderKey(p.id)">{{ $t('删除 Key') }}</button>
              <span class="spacer" />
              <button v-if="keyStatus[p.id] && p.kind === 'openai'" class="btn" :disabled="aiBusy === p.id" @click="fetchModels(p.id)">{{ $t('刷新模型列表') }}</button>
              <button class="btn primary" :disabled="!aiKeys[p.id]?.trim() || aiBusy === p.id" @click="saveProviderKey(p.id)">
                {{ aiBusy === p.id ? $t('处理中…') : $t('保存') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 图床 -->
      <div v-else-if="tab === 'docs'" class="pane-body">
        <h3>{{ $t('让 AI 编程工具把文档存进来') }}</h3>
        <p class="hint">
          {{ $t('用 Claude Code、Cursor 这类工具写代码时，计划、方案、设计文档会散落在各个仓库里。接入后，AI 可以把它们存进笔记库里对应项目的文件夹，并标明哪一份是当前有效的、哪一份已经被取代。仓库里的原文件不会被移动或删除。') }}
        </p>
        <p class="hint">{{ $t('AI 只能读写已绑定项目的文档文件夹，读不到其他笔记，也碰不到证件夹里的密钥和证件。') }}</p>

        <h3 class="gap">Claude Code</h3>
        <p class="hint">{{ $t('在终端里运行一次：') }}</p>
        <pre class="mcp-code selectable">{{ mcpCommand }}</pre>
        <div class="row"><button class="btn small" @click="copyText('cmd', mcpCommand)">{{ copied === 'cmd' ? $t('已复制') : $t('复制命令') }}</button></div>

        <h3 class="gap">{{ $t('Cursor 等其他工具') }}</h3>
        <p class="hint">{{ $t('把下面这段加进它的 MCP 配置文件：') }}</p>
        <pre class="mcp-code selectable">{{ mcpJson }}</pre>
        <div class="row"><button class="btn small" @click="copyText('json', mcpJson)">{{ copied === 'json' ? $t('已复制') : $t('复制配置') }}</button></div>

        <h3 class="gap">{{ $t('权限') }}</h3>
        <label class="check"><input type="checkbox" :checked="docsInfo?.write ?? true" @change="setDocsWrite(($event.target as HTMLInputElement).checked)" /> {{ $t('允许 AI 写入（保存文档、改状态、导入）') }}</label>
        <p class="hint">{{ $t('关掉后 AI 只能读取项目文档。') }}</p>

        <h3 class="gap">{{ $t('已绑定的项目') }}</h3>
        <p v-if="!docsInfo?.projects.length" class="hint">
          {{ $t('还没有。AI 第一次在某个仓库里保存文档时，会自动在「项目文档」下新建同名文件夹并绑定；也可以在侧边栏右键任意文件夹，选「绑定本地项目目录」。') }}
        </p>
        <div v-for="p in docsInfo?.projects ?? []" :key="p.folder" class="mcp-project">
          <div class="mcp-project-main">
            <b>{{ p.folder }}</b>
            <small v-for="d in p.dirs" :key="d" class="selectable">{{ d }}</small>
            <small v-for="r in p.remotes" :key="r" class="selectable">{{ r }}</small>
          </div>
          <button class="link" @click="unbindProject(p.folder)">{{ $t('解除') }}</button>
        </div>
      </div>

      <div v-else-if="tab === 'imagehost'" class="pane-body">
        <p class="hint" style="margin-top: 0">
          {{ $t('笔记里的图片始终保存在本地。配置图床后，「复制为 Markdown（图床链接）」和导出时会把图片上传，换成网络地址，发给别人也能看到。') }}
          <span v-if="ihConfigured" class="ok-badge">{{ $t('已配置') }}</span>
        </p>
        <div class="form-row">
          <label>{{ $t('服务商') }}</label>
          <select :value="ih.provider" class="select" @change="pickProvider(($event.target as HTMLSelectElement).value)">
            <option v-for="p in PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <p class="hint indent">{{ provider.hint }}</p>
        <div class="form-row"><label>Endpoint</label><input v-model="ih.endpoint" class="field selectable" :placeholder="provider.endpoint || 'https://…'" /></div>
        <div class="form-row"><label>{{ $t('区域') }}</label><input v-model="ih.region" class="field selectable" placeholder="us-east-1" /></div>
        <div class="form-row"><label>{{ $t('存储桶') }}</label><input v-model="ih.bucket" class="field selectable" :placeholder="$t('bucket 名称')" /></div>
        <div class="form-row"><label>Access Key</label><input v-model="ih.access_key_id" class="field selectable" /></div>
        <div class="form-row">
          <label>Secret Key</label>
          <input v-model="ihSecret" class="field selectable" type="password" :placeholder="ihHasSecret ? $t('已保存在钥匙串（留空不修改）') : ''" />
        </div>
        <div class="form-row"><label>{{ $t('路径前缀') }}</label><input v-model="ih.prefix" class="field selectable" placeholder="notes" /></div>
        <div class="form-row">
          <label>{{ $t('公开访问地址') }}</label>
          <input v-model="ih.public_base_url" class="field selectable" :placeholder="$t('可选：CDN 或自定义域名，如 https://img.example.com')" />
        </div>
        <div class="form-row">
          <label />
          <label class="check"><input v-model="ih.path_style" type="checkbox" /> {{ $t('路径风格地址（endpoint/bucket/文件）') }}</label>
        </div>
        <p v-if="ihResult" class="ih-result selectable" :class="{ bad: !ihResult.ok }">{{ ihResult.text }}</p>
        <div class="row end">
          <button v-if="ihConfigured" class="btn" @click="clearImageHost">{{ $t('清除配置') }}</button>
          <span class="spacer" />
          <button class="btn" :disabled="ihBusy || !ih.endpoint || !ih.bucket" @click="saveImageHost(false)">{{ $t('保存') }}</button>
          <button class="btn primary" :disabled="ihBusy || !ih.endpoint || !ih.bucket || !ih.access_key_id || (!ihSecret && !ihHasSecret)" @click="saveImageHost(true)">
            {{ ihBusy ? $t('测试中…') : $t('保存并测试') }}
          </button>
        </div>
      </div>

      <!-- 存储与同步 -->
      <div v-else class="pane-body">
        <h3>{{ $t('笔记库位置') }}</h3>
        <div class="path selectable">{{ info ? home(info.root) : '…' }}</div>
        <label class="check"><input v-model="copyNotes" type="checkbox" /> {{ $t('切换时复制现有笔记') }}</label>
        <div class="row">
          <button
            class="btn primary"
            :disabled="!info?.icloud_available || info?.root === info?.icloud"
            @click="info && switchTo(info.icloud)"
          >
            {{ info?.root === info?.icloud ? $t('已在 iCloud Drive') : $t('放到 iCloud Drive') }}
          </button>
          <button class="btn" @click="chooseFolder">{{ $t('选择其他文件夹…') }}</button>
        </div>
        <p class="hint">
          {{ $t('放进 iCloud Drive 后，同一 Apple ID 的多台 Mac 会自动同步。') }}
          <template v-if="info && !info.icloud_available">{{ $t('本机没有开启 iCloud Drive。') }}</template>
        </p>

        <h3 class="gap">Google Drive <span class="badge-exp">{{ $t('实验性') }}</span></h3>
        <p class="hint">{{ $t('Google Drive 同步还在完善中。建议先保留一份笔记库的备份；遇到异常，回收站和版本历史里可以找回内容。') }}</p>
        <template v-if="g && (!g.configured || !g.email)">
          <template v-if="isMobile">
            <p v-if="!g.configured" class="hint">{{ $t('填写 Google Cloud 里「iOS」类型 OAuth 客户端的 ID（软件包 ID 为 com.qxsclass.cloudnotebook）。') }}</p>
            <input v-if="!g.configured" v-model="iosClientId" class="field selectable" :placeholder="$t('iOS 客户端 ID（xxx.apps.googleusercontent.com）')" />
          </template>
          <template v-else>
            <p class="hint">
              {{ $t('先在') }}
              <a href="#" @click.prevent="openUrl('https://console.cloud.google.com/apis/credentials')">{{ $t('Google Cloud 控制台') }}</a>
              {{ $t('创建 OAuth 客户端（桌面应用），把客户端 ID 和密钥填在下面。详细步骤见笔记「Google Drive / Google 文档接入配置」。') }}
            </p>
            <input v-model="clientId" class="field selectable" :placeholder="$t('客户端 ID（xxx.apps.googleusercontent.com）')" />
            <input v-model="clientSecret" class="field selectable" type="password" :placeholder="$t('客户端密钥')" />
          </template>
          <div class="row">
            <button v-if="!isMobile || !g.configured" class="btn" :disabled="isMobile ? !iosClientId : !clientId" @click="saveGoogleConfig">{{ $t('保存') }}</button>
            <button class="btn primary" :disabled="!g.configured || busy" @click="googleLogin">
              {{ busy ? $t('等待浏览器授权…') : $t('登录 Google') }}
            </button>
          </div>
        </template>
        <template v-else-if="g">
          <div class="account">
            <span class="selectable">{{ g.email }}</span>
            <button class="link" @click="googleLogout">{{ $t('退出') }}</button>
          </div>
          <label class="check"><input type="checkbox" :checked="g.auto_sync" @change="toggleAuto" /> {{ $t('自动同步') }}</label>
          <div class="row">
            <button class="btn primary" :disabled="syncState.state === 'syncing'" @click="syncNow">
              {{ syncState.state === 'syncing' ? $t('同步中…') : $t('立即同步') }}
            </button>
          </div>
          <p class="hint">
            <template v-if="syncState.state === 'error'">{{ $t('同步出错：{error}', { error: syncState.error ?? '' }) }}</template>
            <template v-else-if="syncState.last">{{ $t('上次同步：{ago}。', { ago: formatAgo(syncState.last) }) }}</template>
            {{ $t('笔记同步到 Drive 的「Cloud Notebook」文件夹，发布的 Google 文档放在其中的「Cloud Notebook 文档」。') }}
          </p>
        </template>

        <h3 class="gap">{{ $t('飞书云文档') }} <span class="soon">{{ $t('稍后支持') }}</span></h3>
      </div>

      <div class="row end footer">
        <button class="btn" @click="$emit('close')">{{ $t('完成') }}</button>
      </div>
    </div>
  </div>
</template>

<style>
.update-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.badge-exp { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 5px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; vertical-align: 2px; color: #b45309; background: rgba(245, 165, 36, 0.16); }
.mcp-code { margin: 6px 0; padding: 10px 12px; border-radius: 8px; background: var(--code-bg, var(--selected)); font: 12px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
.mcp-project { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.mcp-project-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mcp-project-main b { font-size: 13px; font-weight: 500; }
.mcp-project-main small { font-size: 11.5px; color: var(--text-2); word-break: break-all; }
.tabs {
  display: flex;
  justify-content: center;
  gap: 4px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 70px;
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 11px;
}
.tab:hover { background: var(--selected); }
.tab.active { background: var(--selected); color: var(--accent); }
.pane-body { padding: 16px 4px 4px; min-height: 260px; }
.form-row { display: grid; grid-template-columns: 90px 1fr auto; align-items: center; gap: 12px; margin-bottom: 12px; }
.form-row > label:first-child { text-align: right; color: var(--text-2); }
.form-row .check { margin: 0; }
/* 英文的标签更长：加宽标签列，页签不换行 */
:root:lang(en) .form-row { grid-template-columns: 124px 1fr auto; }
:root:lang(en) .tab { white-space: nowrap; }
.form-row input[type='range'] { width: 100%; accent-color: var(--accent); }
.form-row .val { min-width: 62px; color: var(--text-2); font: 11px var(--font-mono); text-align: right; }
.zoom-row { display: flex; align-items: center; gap: 8px; }
.zoom-row .val { min-width: 44px; text-align: center; }
.zoom-row .hint { margin: 0 0 0 6px; }
.hint.indent { margin: -6px 0 12px 102px; }
.select {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-list);
  color: var(--text);
  font: 12px var(--font-ui);
}
.preview {
  margin: 6px 0 12px;
  padding: 14px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text);
}
.preview .pv-h { font-size: 1.4em; font-weight: 700; line-height: 1.35; margin-bottom: 0.4em; }
.preview p { margin: var(--doc-para) 0; }
.segmented { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--selected); }
.segmented button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 6px; color: var(--text-2); }
.segmented button.active { background: var(--bg-editor); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
.themes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.theme { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.theme.active { color: var(--text); }
.swatch {
  position: relative;
  width: 64px;
  height: 44px;
  border-radius: 8px;
  border: 2px solid transparent;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--border);
}
.theme:not(.active) .swatch { border-color: transparent !important; }
.swatch .half { position: absolute; right: 0; top: 0; bottom: 0; width: 50%; }
.swatch .dot {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.7);
}
.form-row .field { margin: 0; }
.ok-badge { margin-left: 6px; padding: 1px 8px; border-radius: 10px; background: color-mix(in srgb, #30a46c 18%, transparent); color: #30a46c; font-size: 11px; }
.ih-result { margin: 4px 0 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, #30a46c 12%, transparent); word-break: break-all; white-space: pre-wrap; }
.ih-result.bad { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.spacer { flex: 1; }
.provider { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; }
.provider.open { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.provider-row { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 12px; text-align: left; }
.p-name { font-weight: 600; }
.p-count, .p-chevron { font-size: 11px; color: var(--text-2); }
.provider-body { padding: 0 12px 12px; }
.provider-body .hint { margin: 0 0 10px; }
.key-link { font-size: 12px; align-self: center; }
.footer { padding-top: 12px; border-top: 1px solid var(--border); }
.provider-head { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 6px; }
.account { display: flex; justify-content: space-between; align-items: center; }
.link { color: var(--accent); cursor: pointer; }
.soon { color: var(--text-2); font-size: 12px; }
.keysync {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 14px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-2);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.keysync span {
  flex: 1;
}
.keysync.on svg {
  color: var(--accent);
}
</style>
