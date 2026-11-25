import { reactive, watch } from 'vue'
import {
  b64,
  createConfig,
  isV2,
  rewrapPassword,
  rewrapRecovery,
  unlockWithPassword,
  unlockWithRecovery,
  upgradeConfig,
  type LockConfig,
  type LockConfigV1,
  type LockConfigV2,
  type Unlocked,
} from './crypto'
import { vault } from './vault'
import { prefs } from './prefs'

const LOCK_FILE = '.cloudnotebook/lock.json'

/** 加密笔记的全局状态 */
export const lockState = reactive({
  config: null as LockConfig | null,
  /** 数据密钥；为 null 表示已锁定 */
  key: null as CryptoKey | null,
  /** 还有旧版（v1）笔记没迁移时的旧密钥 */
  legacy: null as CryptoKey | null,
  /** 刚生成、需要提示用户保存的恢复密钥 */
  pendingRecoveryKey: null as string | null,
})
let raw: Uint8Array | null = null

/** 解锁状态下的数据密钥（base64），交给 Rust 加密同步的 Key；锁定时为 null */
export function rawKeyBase64() {
  return lockState.key && raw ? b64(raw) : null
}

let onLock: (() => Promise<void> | void) | null = null
/** App 注册：锁定前先把待保存的加密笔记写盘，再清掉内存里的明文 */
export function setLockHandler(fn: () => Promise<void> | void) {
  onLock = fn
}
let onMigrate: ((from: CryptoKey, to: CryptoKey) => Promise<void>) | null = null
/** App 注册：把用旧密钥加密的笔记解开，用新数据密钥重新加密 */
export function setMigrateHandler(fn: (from: CryptoKey, to: CryptoKey) => Promise<void>) {
  onMigrate = fn
}

export async function loadLockConfig() {
  try {
    lockState.config = JSON.parse(await vault.read(LOCK_FILE))
  } catch {
    lockState.config = null
  }
}

async function saveConfig(c: LockConfig) {
  await vault.write(LOCK_FILE, JSON.stringify(c, null, 2))
  lockState.config = c
}

function setUnlocked(u: Unlocked) {
  lockState.key = u.key
  lockState.legacy = u.legacy ?? null
  raw = u.raw.length ? u.raw : null
  touch()
}

export const hint = () => (lockState.config && isV2(lockState.config) ? lockState.config.hint : undefined)

// ---------- 输错延迟 ----------
// 只防在应用里反复试密码；离线破解靠 Argon2id 和密码强度

const FAIL_KEY = 'lock.failures'
const FREE_ATTEMPTS = 5
function failures(): { count: number; until: number } {
  try {
    return JSON.parse(localStorage.getItem(FAIL_KEY) ?? '') ?? { count: 0, until: 0 }
  } catch {
    return { count: 0, until: 0 }
  }
}
function recordFailure() {
  const f = failures()
  f.count++
  // 前 5 次不限制，之后 30 秒起步，每次翻倍，最多 1 小时
  if (f.count >= FREE_ATTEMPTS) f.until = Date.now() + Math.min(3600, 30 * 2 ** (f.count - FREE_ATTEMPTS)) * 1000
  try {
    localStorage.setItem(FAIL_KEY, JSON.stringify(f))
  } catch {}
}
function resetFailures() {
  try {
    localStorage.removeItem(FAIL_KEY)
  } catch {}
}
/** 还需要等待的毫秒数 */
export const waitRemaining = () => Math.max(0, failures().until - Date.now())
export const failureCount = () => failures().count

// ---------- 解锁 / 迁移 ----------

export type UnlockResult = { ok: true } | { ok: false; waitMs?: number }

export async function unlock(password: string): Promise<UnlockResult> {
  const config = lockState.config
  if (!config) return { ok: false }
  const wait = waitRemaining()
  if (wait > 0) return { ok: false, waitMs: wait }
  const u = await unlockWithPassword(config, password)
  if (!u) {
    recordFailure()
    return { ok: false, waitMs: waitRemaining() || undefined }
  }
  resetFailures()
  if (!isV2(config)) await migrateFromV1(config, password, u)
  else {
    setUnlocked(u)
    if (u.legacy) await finishMigration(config, u.legacy)
  }
  return { ok: true }
}

/** v1 → v2：先写入带旧版信息的新配置（中途中断也能继续），迁移笔记，再去掉旧版信息 */
async function migrateFromV1(v1: LockConfigV1, password: string, old: Unlocked) {
  const { config, unlocked, recoveryKey } = await upgradeConfig(v1, password)
  await saveConfig(config)
  setUnlocked({ ...unlocked, legacy: old.key })
  await finishMigration(config, old.key)
  lockState.pendingRecoveryKey = recoveryKey
}

async function finishMigration(config: LockConfigV2, legacy: CryptoKey) {
  await onMigrate?.(legacy, lockState.key!)
  const { legacy: _, ...done } = config
  await saveConfig(done)
  lockState.legacy = null
}

export async function setPassword(password: string, hintText?: string) {
  const { config, unlocked, recoveryKey } = await createConfig(password, hintText)
  await saveConfig(config)
  setUnlocked(unlocked)
  resetFailures()
  lockState.pendingRecoveryKey = recoveryKey
}

/** 修改密码：只重新包装数据密钥，笔记不用重新加密 */
export async function changePassword(oldPassword: string, password: string, hintText?: string) {
  const r = await unlock(oldPassword)
  if (!r.ok) return r
  const config = lockState.config as LockConfigV2
  await saveConfig(await rewrapPassword(config, raw!, password, hintText))
  return r
}

/** 忘记密码：用恢复密钥解开数据密钥，设置新密码 */
export async function recover(recoveryText: string, password: string, hintText?: string) {
  const config = lockState.config
  if (!config || !isV2(config)) return false
  const u = await unlockWithRecovery(config, recoveryText)
  if (!u) return false
  await saveConfig(await rewrapPassword(config, u.raw, password, hintText))
  setUnlocked(u)
  resetFailures()
  return true
}

/** 重新生成恢复密钥（需已解锁），旧的恢复密钥立即失效 */
export async function regenerateRecoveryKey() {
  const config = lockState.config
  if (!config || !isV2(config) || !raw) return false
  const r = await rewrapRecovery(config, raw)
  await saveConfig(r.config)
  lockState.pendingRecoveryKey = r.recoveryKey
  return true
}

export async function lockNow() {
  if (!lockState.key) return
  clearTimeout(timer)
  await onLock?.()
  lockState.key = null
  lockState.legacy = null
  raw = null
}

// ---- 闲置自动锁定 ----
let timer: number | undefined
export function touch() {
  clearTimeout(timer)
  if (!lockState.key || !prefs.autoLockMinutes) return
  timer = window.setTimeout(() => lockNow(), prefs.autoLockMinutes * 60_000)
}
for (const ev of ['keydown', 'mousedown']) window.addEventListener(ev, () => lockState.key && touch(), { passive: true })
watch(() => prefs.autoLockMinutes, touch)
