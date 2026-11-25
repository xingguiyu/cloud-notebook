/**
 * 加密笔记（v2）。
 *
 * 密钥结构：随机生成一把 256 位「数据密钥」加密所有笔记；数据密钥再被包装两份——
 *   - 密码包装：Argon2id（64 MB / 3 轮）从密码派生，抗 GPU 暴力破解
 *   - 恢复密钥包装：128 位随机恢复密钥经 HKDF 派生，忘记密码时用它重设
 * 改密码、用恢复密钥重设都只需重新包装数据密钥，不用重加密笔记。
 *
 * 笔记文件保持是合法 Markdown：明文只有标题和提示，密文放在 HTML 注释里。
 * v1（PBKDF2 直接从密码派生）的笔记仍能读取，解锁后自动迁移到 v2。
 */
import { invoke } from '@tauri-apps/api/core'
import { t } from './i18n'

const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

// ---------- 笔记信封 ----------

const ENVELOPE_RE = /<!-- cloudnotebook:locked (v1|v2) iv=(\S+) data=(\S+) -->/

export function isLockedText(md: string | undefined) {
  return !!md && ENVELOPE_RE.test(md)
}
export function envelopeVersion(md: string) {
  return md.match(ENVELOPE_RE)?.[1] as 'v1' | 'v2' | undefined
}

interface Sealed {
  iv: string
  data: string
}

async function encrypt(key: CryptoKey, bytes: Uint8Array): Promise<Sealed> {
  const iv = random(12)
  return { iv: b64(iv), data: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) }
}
async function decrypt(key: CryptoKey, s: Sealed) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, key, unb64(s.data)))
}
const aesKey = (raw: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages)

export async function seal(key: CryptoKey, md: string) {
  const title = md.match(/^#[ \t]+(.+)$/m)?.[1].trim() || t('加密笔记')
  const { iv, data } = await encrypt(key, enc.encode(md))
  return `# ${title}\n\n> ${t('这篇笔记已加密，请在 Cloud Notebook 中输入密码查看。')}\n\n<!-- cloudnotebook:locked v2 iv=${iv} data=${data} -->\n`
}

export async function unseal(key: CryptoKey, envelope: string) {
  const m = envelope.match(ENVELOPE_RE)
  if (!m) throw new Error(t('不是有效的加密笔记'))
  return dec.decode(await decrypt(key, { iv: m[2], data: m[3] }))
}

// ---------- 密钥派生 ----------

const ARGON = { memoryKib: 64 * 1024, iterations: 3, parallelism: 1 }

async function passwordKek(password: string, kdf: KdfParams) {
  const raw = await invoke<string>('kdf_argon2id', {
    password,
    salt: kdf.salt,
    memoryKib: kdf.memoryKib,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
  })
  return aesKey(unb64(raw))
}

async function recoveryKek(recovery: Uint8Array, salt: string) {
  const base = await crypto.subtle.importKey('raw', recovery, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: enc.encode('cloudnotebook-recovery') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** v1 的 PBKDF2 密钥，只用于读取和迁移旧笔记 */
async function legacyKey(password: string, salt: string) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 310_000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ---------- 恢复密钥：128 位随机数，显示为 Crockford Base32 ----------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function formatRecoveryKey(bytes: Uint8Array) {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g)!.join('-')
}

/** 容错解析：忽略大小写、空格和横线，O/I/L 按 Crockford 规则当成 0/1/1 */
export function parseRecoveryKey(text: string) {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (clean.length !== 26 || [...clean].some((c) => !B32.includes(c))) return null
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out.slice(0, 16))
}

// ---------- 笔记库里的密码配置 ----------

interface KdfParams {
  salt: string
  memoryKib: number
  iterations: number
  parallelism: number
}

export interface LockConfigV2 {
  version: 2
  kdf: KdfParams
  byPassword: Sealed
  recoverySalt: string
  byRecovery: Sealed
  hint?: string
  /** 迁移未完成时保留旧版信息，用同一个密码解开剩余的 v1 笔记 */
  legacy?: LockConfigV1
}
export interface LockConfigV1 {
  salt: string
  verifier: Sealed
}
export type LockConfig = LockConfigV2 | LockConfigV1
export const isV2 = (c: LockConfig): c is LockConfigV2 => (c as LockConfigV2).version === 2

/** 解锁后在内存里持有的东西：数据密钥（加解密用）和它的原始字节（重新包装用） */
export interface Unlocked {
  key: CryptoKey
  raw: Uint8Array
  /** 还有 v1 笔记没迁移时，旧密钥 */
  legacy?: CryptoKey
}

async function wrapForPassword(raw: Uint8Array, password: string) {
  const kdf = { salt: b64(random(16)), ...ARGON }
  return { kdf, byPassword: await encrypt(await passwordKek(password, kdf), raw) }
}

async function wrapForRecovery(raw: Uint8Array) {
  const recovery = random(16)
  const recoverySalt = b64(random(16))
  return { recovery: formatRecoveryKey(recovery), recoverySalt, byRecovery: await encrypt(await recoveryKek(recovery, recoverySalt), raw) }
}

/** 首次设置：生成数据密钥和恢复密钥 */
export async function createConfig(password: string, hint?: string) {
  const raw = random(32)
  const p = await wrapForPassword(raw, password)
  const r = await wrapForRecovery(raw)
  const config: LockConfigV2 = { version: 2, ...p, recoverySalt: r.recoverySalt, byRecovery: r.byRecovery, hint: hint || undefined }
  return { config, unlocked: { key: await aesKey(raw), raw } as Unlocked, recoveryKey: r.recovery }
}

const VERIFY_TEXT = 'cloudnotebook-verify'

/** 用密码解锁。密码错误返回 null */
export async function unlockWithPassword(config: LockConfig, password: string): Promise<Unlocked | null> {
  if (!isV2(config)) {
    // v1：密钥直接由密码派生，用校验串判断对错
    const key = await legacyKey(password, config.salt)
    try {
      if (dec.decode(await decrypt(key, config.verifier)) !== VERIFY_TEXT) return null
    } catch {
      return null
    }
    return { key, raw: new Uint8Array(), legacy: key }
  }
  try {
    const raw = await decrypt(await passwordKek(password, config.kdf), config.byPassword)
    const legacy = config.legacy ? await legacyKey(password, config.legacy.salt) : undefined
    return { key: await aesKey(raw), raw, legacy }
  } catch {
    return null
  }
}

/** 用恢复密钥解开数据密钥。恢复密钥格式不对或不匹配返回 null */
export async function unlockWithRecovery(config: LockConfigV2, recoveryText: string): Promise<Unlocked | null> {
  const recovery = parseRecoveryKey(recoveryText)
  if (!recovery) return null
  try {
    const raw = await decrypt(await recoveryKek(recovery, config.recoverySalt), config.byRecovery)
    return { key: await aesKey(raw), raw }
  } catch {
    return null
  }
}

/** 换密码：只重新包装数据密钥 */
export async function rewrapPassword(config: LockConfigV2, raw: Uint8Array, password: string, hint?: string): Promise<LockConfigV2> {
  return { ...config, ...(await wrapForPassword(raw, password)), hint: hint || undefined }
}

/** 重新生成恢复密钥（旧的随即失效） */
export async function rewrapRecovery(config: LockConfigV2, raw: Uint8Array) {
  const r = await wrapForRecovery(raw)
  return { config: { ...config, recoverySalt: r.recoverySalt, byRecovery: r.byRecovery }, recoveryKey: r.recovery }
}

/** v1 → v2：新建数据密钥结构，保留旧版信息直到所有旧笔记迁移完成 */
export async function upgradeConfig(v1: LockConfigV1, password: string) {
  const created = await createConfig(password)
  return { ...created, config: { ...created.config, legacy: v1 } }
}

// ---------- 密码强度 ----------

const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyui', 'qwerty123', '11111111', '88888888', '66666666', 'abc12345', 'a1234567', 'iloveyou', 'woaini1314', '00000000', '87654321', 'asdfghjk', 'zxcvbnm1'])

/** 0–4 分，以及不合格的原因 */
export function passwordStrength(pw: string): { score: number; problem?: string } {
  if (pw.length < 8) return { score: 0, problem: t('至少 8 位') }
  if (COMMON.has(pw.toLowerCase())) return { score: 0, problem: t('这是常见密码，很容易被猜到') }
  if (/^(.)\1+$/.test(pw)) return { score: 0, problem: t('不要全部用同一个字符') }
  const seq = '0123456789abcdefghijklmnopqrstuvwxyz'
  if (seq.includes(pw.toLowerCase()) || [...seq].reverse().join('').includes(pw.toLowerCase())) return { score: 0, problem: t('不要用连续的字符') }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length + (/[^\x00-\x7f]/.test(pw) ? 1 : 0)
  let score = 1
  if (pw.length >= 10) score++
  if (pw.length >= 14) score++
  if (classes >= 3) score++
  return { score: Math.min(4, score) }
}
