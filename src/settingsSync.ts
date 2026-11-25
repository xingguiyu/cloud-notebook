import { invoke } from '@tauri-apps/api/core'
import { watch } from 'vue'
import { DEFAULT_PREFS, prefs, type Prefs } from './prefs'
import { vault } from './vault'
import { imageHost, type ImageHostConfig } from './imagehost'
import { google } from './google'
import { lockState, rawKeyBase64 } from './lock'
import { refreshKeys } from './ai/keys'

/**
 * 设置同步：
 * - 普通设置写进笔记库 `.cloudnotebook/settings.json`，跟着笔记同步到其它设备（明文，不含任何密钥）
 * - Key 由 Rust 加密成 `.cloudnotebook/secrets.json`（见 keysync.rs），需要加密笔记解锁
 */

const FILE = '.cloudnotebook/settings.json'
const STAMP = 'settings.syncedAt'

/** 每台设备各自的设置，不同步 */
/**
 * 每台设备各自的设置，不同步。
 * `aiBaseUrls` 决定 API Key 发到哪台服务器：同步文件是明文、谁都能改，如果跟着同步，
 * 能写进同步目录的人改一下地址，下一次提问就把 Key 和笔记内容送到他那里了。
 */
const LOCAL_ONLY: (keyof Prefs)[] = ['autoLockMinutes', 'aiBaseUrls']

interface SettingsFile {
  version: 1
  updated: number
  prefs: Partial<Prefs>
  imagehost?: ImageHostConfig
  google?: { client_id: string; client_secret: string }
}

const stamp = () => Number(localStorage.getItem(STAMP) ?? 0) || 0
const setStamp = (t: number) => {
  try {
    localStorage.setItem(STAMP, String(t))
  } catch {}
}

function syncedPrefs(): Partial<Prefs> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) if (!LOCAL_ONLY.includes(k)) out[k] = prefs[k]
  return JSON.parse(JSON.stringify(out))
}

async function snapshot(): Promise<Omit<SettingsFile, 'updated'>> {
  const ih = await imageHost.status().catch(() => null)
  const [client_id, client_secret] = await invoke<[string, string]>('google_client_config').catch(() => ['', ''])
  let imagehost: SettingsFile['imagehost']
  if (ih?.config.endpoint) {
    // Rust 返回的配置里还带着「本机是否有 Secret」的标记，不同步它
    const { has_secret: _, ...rest } = ih.config as ImageHostConfig & { has_secret?: boolean }
    imagehost = rest
  }
  return { version: 1, prefs: syncedPrefs(), imagehost, google: client_id ? { client_id, client_secret } : undefined }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

let applying = false
let lastWritten = ''

/** 读取笔记库里的设置，比本机上次同步的新就应用 */
export async function pullSettings() {
  let remote: SettingsFile
  try {
    remote = JSON.parse(await vault.read(FILE))
  } catch {
    // 还没有设置文件（第一台设备）：把本机的写上去
    return pushSettings()
  }
  if (!remote?.updated || remote.updated <= stamp()) return
  applying = true
  try {
    const p = remote.prefs ?? {}
    for (const k of Object.keys(p) as (keyof Prefs)[]) {
      if (LOCAL_ONLY.includes(k) || !(k in DEFAULT_PREFS)) continue
      if (!same(prefs[k], p[k])) (prefs as Record<string, unknown>)[k] = p[k]
    }
    if (remote.imagehost) {
      const ih = await imageHost.status().catch(() => null)
      const { has_secret: _, ...local } = (ih?.config ?? {}) as ImageHostConfig & { has_secret?: boolean }
      // 图床地址和 Google 客户端同理：只在这台设备还没配置时采用同步来的值，已经配好的不被远端覆盖
      if (!local.endpoint && !same(local, remote.imagehost)) await imageHost.save(remote.imagehost)
    }
    if (remote.google?.client_id) {
      const [id, secret] = await invoke<[string, string]>('google_client_config').catch(() => ['', ''])
      if (!id && (id !== remote.google.client_id || secret !== remote.google.client_secret))
        await google.setConfig(remote.google.client_id, remote.google.client_secret)
    }
    setStamp(remote.updated)
  } finally {
    // 等 prefs 的 watch 触发完再放开，避免把刚收到的设置当成本机修改又写回去
    setTimeout(() => (applying = false), 0)
  }
}

/** 把本机设置写进笔记库（内容没变就不写，避免两台设备来回改时间戳） */
export async function pushSettings() {
  const snap = await snapshot()
  const body = JSON.stringify(snap)
  if (body === lastWritten) return
  try {
    const cur: SettingsFile = JSON.parse(await vault.read(FILE))
    const { updated: _, ...rest } = cur
    if (JSON.stringify(rest) === body) {
      lastWritten = body
      setStamp(cur.updated)
      return
    }
  } catch {}
  const updated = Date.now()
  await vault.write(FILE, JSON.stringify({ ...snap, updated }, null, 2))
  lastWritten = body
  setStamp(updated)
}

let pushTimer: number | undefined
/** 设置改动后调用：稍等片刻合并多次修改再写 */
export function settingsChanged() {
  if (applying) return
  clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => pushSettings().catch((e) => console.warn('设置同步失败', e)), 1500)
}

// ---------------- Key 同步 ----------------

export const keySyncState = { lastError: '' }

/** 加密笔记已解锁时，合并本机和笔记库里的 Key */
export async function syncKeys() {
  const dek = rawKeyBase64()
  if (!dek) return
  try {
    const r = await invoke<{ received: string[]; uploaded: boolean }>('keysync_run', { dek })
    keySyncState.lastError = ''
    if (r.received.length) await refreshKeys()
  } catch (e) {
    keySyncState.lastError = String(e)
    console.warn('Key 同步失败', e)
  }
}

export const keySyncAvailable = () => invoke<boolean>('keysync_exists')

let keyTimer: number | undefined
export function keysChanged() {
  clearTimeout(keyTimer)
  keyTimer = window.setTimeout(syncKeys, 500)
}

/** App 启动、笔记库加载后调用一次 */
export function startSettingsSync() {
  pullSettings().catch((e) => console.warn('读取同步设置失败', e))
  watch(prefs, settingsChanged, { deep: true })
  // 解锁后同步一次 Key
  watch(
    () => lockState.key,
    (k) => k && syncKeys(),
  )
}

/** 笔记库有外部改动（同步盘、Google Drive 拉取）时调用 */
export function onVaultChanged() {
  pullSettings().catch(() => {})
  if (lockState.key) keysChanged()
}
