/**
 * 版本更新：检查 GitHub 上有没有新版本，下载、校验签名、安装并重启；更新后第一次启动时显示这个版本改了什么。
 *
 * 更新包的签名由 Tauri 的更新插件用内置的公钥校验，校验不过不会安装。
 * 「这个版本的更新内容」直接取自随应用打包的更新日志，不用联网。
 */
import { reactive } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { message } from '@tauri-apps/plugin-dialog'
import changelogEn from '../CHANGELOG.md?raw'
import changelogZh from '../CHANGELOG.zh-CN.md?raw'
import { lang, t } from './i18n'
import { prefs } from './prefs'

export const updateState = reactive({
  /** idle 没有要显示的；available 发现新版本；downloading 下载中；installed 装好了等重启；news 显示当前版本的更新内容 */
  phase: 'idle' as 'idle' | 'available' | 'downloading' | 'installed' | 'news',
  current: '',
  version: '',
  notes: '',
  /** 下载进度 0–1；不知道总大小时为 null */
  progress: null as number | null,
  error: '',
  checking: false,
})

let pending: Update | null = null
const SKIP = 'update.skip'
const LAST = 'app.version'
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {}
  },
}

/** 从更新日志里取出某个版本那一节（`## 0.8.0` 到下一个 `## ` 之前） */
export function notesOf(changelog: string, version: string): string {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

/** 发布时附带的说明里中英文各一份，用一行 `<!--zh-->` 隔开：英文在前，中文在后 */
export function pickLanguage(body: string, zh: boolean): string {
  const [en, cn] = body.split(/^<!--\s*zh\s*-->$/m)
  return ((zh ? cn : en) ?? en ?? '').trim()
}

const localNotes = (version: string) => notesOf(lang === 'zh' ? changelogZh : changelogEn, version) || notesOf(changelogEn, version)

/** 启动时调用：版本号变了就显示这个版本的更新内容；之后定时检查新版本 */
export async function startUpdater() {
  updateState.current = await getVersion().catch(() => '')
  const last = store.get(LAST)
  store.set(LAST, updateState.current)
  // 第一次安装不弹（没有「上一个版本」）；从旧版本升上来才弹
  if (last && last !== updateState.current) showWhatsNew()
  // 等界面空下来再联网
  window.setTimeout(() => checkForUpdate(false), 15_000)
  window.setInterval(() => checkForUpdate(false), 6 * 3600_000)
}

export function showWhatsNew() {
  if (updateState.phase === 'downloading') return
  updateState.version = updateState.current
  updateState.notes = localNotes(updateState.current)
  updateState.error = ''
  updateState.phase = 'news'
}

/** 检查新版本。`manual` 是用户自己点的：没有新版本或出错时也给个回应；自动检查时安静地跳过 */
export async function checkForUpdate(manual: boolean) {
  if (updateState.checking || updateState.phase === 'downloading' || updateState.phase === 'installed') return
  if (!manual && (!prefs.autoUpdate || updateState.phase !== 'idle')) return
  updateState.checking = true
  try {
    const update = await check({ timeout: 30_000 })
    if (!update) {
      if (manual) await message(t('当前已经是最新版本（{v}）。', { v: updateState.current }), { title: t('检查更新') })
      return
    }
    if (!manual && store.get(SKIP) === update.version) return
    pending = update
    updateState.version = update.version
    updateState.notes = pickLanguage(update.body ?? '', lang === 'zh')
    updateState.error = ''
    updateState.progress = null
    updateState.phase = 'available'
  } catch (e) {
    if (manual) await message(t('检查更新失败：{e}', { e: String(e) }), { title: t('检查更新'), kind: 'error' })
  } finally {
    updateState.checking = false
  }
}

export async function installUpdate() {
  if (!pending || updateState.phase === 'downloading') return
  updateState.phase = 'downloading'
  updateState.error = ''
  updateState.progress = null
  let total = 0
  let done = 0
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0
      else if (e.event === 'Progress') {
        done += e.data.chunkLength
        updateState.progress = total ? Math.min(1, done / total) : null
      } else updateState.progress = 1
    })
    updateState.phase = 'installed'
  } catch (e) {
    updateState.error = String(e)
    updateState.phase = 'available'
  }
}

export const restartNow = () => relaunch()

/** 这个版本不再提醒（手动检查仍然能看到） */
export function skipVersion() {
  store.set(SKIP, updateState.version)
  closeUpdate()
}

export function closeUpdate() {
  if (updateState.phase === 'downloading') return
  // 已经装好只是还没重启：关掉窗口不影响，下次启动就是新版本
  updateState.phase = 'idle'
}
