import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { SafeItem } from './templates'

export interface SafeStatus {
  exists: boolean
  unlocked: boolean
  hint: string
  biometric_available: boolean
  biometric_enabled: boolean
}

export const safe = {
  status: () => invoke<SafeStatus>('safe_status'),
  setup: (password: string, hint: string) => invoke<string>('safe_setup', { password, hint }),
  unlock: (password: string) => invoke<void>('safe_unlock', { password }),
  unlockBiometric: () => invoke<void>('safe_unlock_biometric'),
  recover: (recovery: string, password: string, hint: string) => invoke<void>('safe_recover', { recovery, password, hint }),
  changePassword: (old: string, password: string, hint: string) => invoke<void>('safe_change_password', { old, password, hint }),
  newRecovery: () => invoke<string>('safe_new_recovery'),
  setBiometric: (enabled: boolean) => invoke<void>('safe_set_biometric', { enabled }),
  lock: () => invoke<void>('safe_lock'),
  list: () => invoke<SafeItem[]>('safe_list'),
  save: (item: SafeItem) => invoke<SafeItem>('safe_save', { item }),
  remove: (id: string, files: string[]) => invoke<void>('safe_delete', { id, files }),
  attach: async (file: File) => invoke<string>('safe_attach', new Uint8Array(await file.arrayBuffer())),
  file: (id: string) => invoke<ArrayBuffer>('safe_file', { id }),
  exportFile: (id: string, dest: string) => invoke<void>('safe_export_file', { id, dest }),
  removeFile: (id: string) => invoke<void>('safe_remove_file', { id }),
}

// ---------------- 复制：敏感内容 30 秒后从剪贴板清掉 ----------------

export async function copySecret(value: string, secret: boolean) {
  // 敏感内容交给后端复制：它 30 秒后检查剪贴板，还是这段内容就清掉（用户又复制了别的就不动）。
  // 界面这边没有读剪贴板的权限，以前在这里做的清除其实从没生效过
  if (secret) await invoke('copy_secret', { text: value })
  else await writeText(value)
}

// ---------------- 两步验证码（TOTP, RFC 6238） ----------------

function base32(s: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const c of clean) {
    value = (value << 5) | alphabet.indexOf(c)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 255)
    }
  }
  return new Uint8Array(out)
}

/** 也接受 otpauth://totp/...?secret=XXX 形式的链接 */
export function totpSecret(raw: string) {
  const m = raw.match(/[?&]secret=([^&]+)/i)
  return m ? decodeURIComponent(m[1]) : raw
}

export async function totp(raw: string, now = Date.now()): Promise<{ code: string; remaining: number } | null> {
  const key = base32(totpSecret(raw))
  if (key.length < 10) return null
  const step = 30
  const counter = Math.floor(now / 1000 / step)
  const msg = new ArrayBuffer(8)
  new DataView(msg).setUint32(4, counter)
  new DataView(msg).setUint32(0, Math.floor(counter / 2 ** 32))
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))
  const o = h[h.length - 1] & 15
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000
  return { code: String(n).padStart(6, '0'), remaining: step - (Math.floor(now / 1000) % step) }
}

/** 生成强密码：去掉易混字符 */
export function generatePassword(length = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+'
  const r = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(r, (x) => chars[x % chars.length]).join('')
}
