import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  b64,
  createConfig,
  envelopeVersion,
  formatRecoveryKey,
  isLockedText,
  isV2,
  parseRecoveryKey,
  passwordStrength,
  rewrapPassword,
  rewrapRecovery,
  seal,
  unb64,
  unlockWithPassword,
  unlockWithRecovery,
  unseal,
  upgradeConfig,
  type LockConfigV1,
} from '../crypto'

// crypto.ts runs on WebCrypto, which Node provides. The only native piece is the Argon2id KDF
// (`invoke('kdf_argon2id')`); it is replaced by a deterministic stand-in: SHA-256(password | salt).
// That keeps the property the callers rely on (same password + salt → same 32-byte key).
const kdfCalls: Record<string, unknown>[] = []
beforeEach(() => {
  kdfCalls.length = 0
  const fake = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'kdf_argon2id') return undefined
    kdfCalls.push(args!)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${args!.password}|${args!.salt}`))
    return b64(digest)
  }
  vi.mocked(invoke).mockImplementation(fake as unknown as typeof invoke)
})

const newKey = () => crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt'])
const NOTE = '# 我的秘密\n\n正文 with ünïcödé 🎉 and a fake <!-- cloudnotebook:locked v2 iv=AAAA data=BBBB --> inside\n'

describe('b64 / unb64', () => {
  it('round-trips bytes, from a Uint8Array or an ArrayBuffer', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...unb64(b64(bytes))]).toEqual([...bytes])
    expect(b64(bytes.buffer)).toBe(b64(bytes))
    expect(b64(new Uint8Array())).toBe('')
  })
})

describe('envelope', () => {
  it('seal writes a readable Markdown file: title, notice, ciphertext in a comment', async () => {
    const sealed = await seal(await newKey(), NOTE)
    expect(sealed).toMatch(/^# 我的秘密\n\n> .+\n\n<!-- cloudnotebook:locked v2 iv=\S+ data=\S+ -->\n$/)
    expect(sealed).not.toContain('正文')
    expect(isLockedText(sealed)).toBe(true)
    expect(envelopeVersion(sealed)).toBe('v2')
  })

  it('uses a placeholder title when the note has no heading', async () => {
    const sealed = await seal(await newKey(), 'no heading here\n')
    expect(sealed.startsWith('# 加密笔记\n')).toBe(true)
    expect(sealed).not.toContain('no heading here')
  })

  it('unseal returns exactly what was sealed', async () => {
    const key = await newKey()
    for (const md of [NOTE, '', '---\nstatus: draft\n---\n\n# T\n\nbody', 'x'.repeat(200_000)]) {
      expect(await unseal(key, await seal(key, md))).toBe(md)
    }
  })

  it('uses a fresh IV every time', async () => {
    const key = await newKey()
    const a = await seal(key, NOTE)
    const b = await seal(key, NOTE)
    expect(a).not.toBe(b)
    expect(a.match(/iv=(\S+)/)![1]).not.toBe(b.match(/iv=(\S+)/)![1])
  })

  it('unseal rejects a wrong key', async () => {
    const sealed = await seal(await newKey(), NOTE)
    await expect(unseal(await newKey(), sealed)).rejects.toThrow()
  })

  it('unseal rejects tampered ciphertext, a tampered IV and truncated data', async () => {
    const key = await newKey()
    const sealed = await seal(key, NOTE)
    const [, iv, data] = sealed.match(/iv=(\S+) data=(\S+)/)!
    const flip = (s: string, at: number) => {
      const bytes = unb64(s)
      bytes[at] ^= 1
      return b64(bytes)
    }
    await expect(unseal(key, sealed.replace(data, flip(data, 0)))).rejects.toThrow()
    await expect(unseal(key, sealed.replace(data, flip(data, unb64(data).length - 1)))).rejects.toThrow()
    await expect(unseal(key, sealed.replace(iv, flip(iv, 0)))).rejects.toThrow()
    await expect(unseal(key, sealed.replace(data, b64(unb64(data).slice(0, -1))))).rejects.toThrow()
    // untouched envelope still opens
    expect(await unseal(key, sealed)).toBe(NOTE)
  })

  it('unseal rejects text that is not an envelope', async () => {
    await expect(unseal(await newKey(), '# just a note')).rejects.toThrow('不是有效的加密笔记')
  })

  it('unseal reads the envelope even when a sync tool changed the text around it', async () => {
    const key = await newKey()
    const sealed = await seal(key, NOTE)
    expect(await unseal(key, sealed.replace(/\n/g, '\r\n') + '\r\n\r\n')).toBe(NOTE)
  })

  it('isLockedText / envelopeVersion recognise v1 and v2 and nothing else', () => {
    expect(isLockedText('<!-- cloudnotebook:locked v1 iv=a data=b -->')).toBe(true)
    expect(envelopeVersion('x\n<!-- cloudnotebook:locked v1 iv=a data=b -->')).toBe('v1')
    expect(isLockedText('<!-- cloudnotebook:locked v3 iv=a data=b -->')).toBe(false)
    expect(isLockedText('<!-- cloudnotebook:locked v2 iv=a -->')).toBe(false)
    expect(isLockedText('# plain')).toBe(false)
    expect(isLockedText('')).toBe(false)
    expect(isLockedText(undefined)).toBe(false)
    expect(envelopeVersion('# plain')).toBeUndefined()
  })

  // `^#\s+(.+)$` lets \s+ run across line breaks. With an empty first heading ("#" on its own line,
  // which is what the editor writes for an empty H1) the "title" is the next non-empty line of the
  // note, and seal() writes it in clear text in front of the ciphertext.
  // BUG CANDIDATE: the first paragraph of an encrypted note can end up unencrypted on disk / in the cloud.
  it('never writes body text in the clear when the heading is empty', async () => {
    const sealed = await seal(await newKey(), '#\n\nmy bank PIN is 4321\n')
    expect(sealed).not.toContain('4321')
  })
})

describe('recovery key', () => {
  it('formats 16 bytes as 26 Crockford base32 characters in groups of four', () => {
    const text = formatRecoveryKey(new Uint8Array(16))
    expect(text).toBe('0000-0000-0000-0000-0000-0000-00')
    expect(formatRecoveryKey(new Uint8Array(16).fill(255))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZW')
  })

  it('round-trips random keys', () => {
    for (let i = 0; i < 200; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      const text = formatRecoveryKey(bytes)
      expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/)
      expect([...parseRecoveryKey(text)!]).toEqual([...bytes])
    }
  })

  it('parses leniently: case, spaces, dashes, and O/I/L typed for 0/1/1', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    const text = formatRecoveryKey(bytes)
    const sloppy = text.toLowerCase().replace(/-/g, '  ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect([...parseRecoveryKey(sloppy)!]).toEqual([...bytes])
    expect([...parseRecoveryKey(text.replace(/1/g, 'I'))!]).toEqual([...bytes])
  })

  it('rejects wrong lengths and characters outside the alphabet', () => {
    const text = formatRecoveryKey(new Uint8Array(16).fill(7))
    expect(parseRecoveryKey(text.slice(0, -1))).toBeNull()
    expect(parseRecoveryKey(text + '0')).toBeNull()
    expect(parseRecoveryKey(text.replace(/.$/, 'U'))).toBeNull()
    expect(parseRecoveryKey('')).toBeNull()
  })
})

describe('lock configuration', () => {
  it('createConfig → unlockWithPassword gives a key that opens notes sealed with the original', async () => {
    const { config, unlocked, recoveryKey } = await createConfig('correct horse', 'a hint')
    expect(isV2(config)).toBe(true)
    expect(config.hint).toBe('a hint')
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
    expect(kdfCalls[0]).toMatchObject({ password: 'correct horse', salt: config.kdf.salt, memoryKib: 64 * 1024, iterations: 3, parallelism: 1 })
    // the configuration survives being stored as JSON
    const stored = JSON.parse(JSON.stringify(config))
    const sealed = await seal(unlocked.key, NOTE)
    const again = await unlockWithPassword(stored, 'correct horse')
    expect(again).not.toBeNull()
    expect(await unseal(again!.key, sealed)).toBe(NOTE)
    expect([...again!.raw]).toEqual([...unlocked.raw])
  })

  it('a wrong password returns null', async () => {
    const { config } = await createConfig('correct horse')
    expect(await unlockWithPassword(config, 'wrong horse')).toBeNull()
    expect(await unlockWithPassword(config, '')).toBeNull()
    expect(config.hint).toBeUndefined()
  })

  it('the recovery key opens the same data key; a wrong or malformed one returns null', async () => {
    const { config, unlocked, recoveryKey } = await createConfig('pw-one-two')
    const sealed = await seal(unlocked.key, NOTE)
    const viaRecovery = await unlockWithRecovery(config, recoveryKey.toLowerCase())
    expect(await unseal(viaRecovery!.key, sealed)).toBe(NOTE)
    expect(await unlockWithRecovery(config, formatRecoveryKey(new Uint8Array(16)))).toBeNull()
    expect(await unlockWithRecovery(config, 'not a key')).toBeNull()
  })

  it('changing the password re-wraps the key: old password stops working, notes and recovery key still open', async () => {
    const { config, unlocked, recoveryKey } = await createConfig('old password')
    const sealed = await seal(unlocked.key, NOTE)
    const next = await rewrapPassword(config, unlocked.raw, 'new password', 'new hint')
    expect(next.hint).toBe('new hint')
    expect(next.kdf.salt).not.toBe(config.kdf.salt)
    expect(await unlockWithPassword(next, 'old password')).toBeNull()
    const u = await unlockWithPassword(next, 'new password')
    expect(await unseal(u!.key, sealed)).toBe(NOTE)
    expect(await unlockWithRecovery(next, recoveryKey)).not.toBeNull()
  })

  it('regenerating the recovery key invalidates the old one and keeps the password', async () => {
    const { config, unlocked, recoveryKey } = await createConfig('some password')
    const r = await rewrapRecovery(config, unlocked.raw)
    expect(r.recoveryKey).not.toBe(recoveryKey)
    expect(await unlockWithRecovery(r.config, recoveryKey)).toBeNull()
    expect(await unlockWithRecovery(r.config, r.recoveryKey)).not.toBeNull()
    expect(await unlockWithPassword(r.config, 'some password')).not.toBeNull()
  })

  it('upgradeConfig keeps the v1 information so remaining v1 notes can be opened with the same password', async () => {
    // build a v1 configuration by hand: PBKDF2 key + verifier, as the old version stored it
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('legacy pw'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 310_000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const verifier = { iv: b64(iv), data: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('cloudnotebook-verify'))) }
    const v1: LockConfigV1 = { salt, verifier }
    const v1Note = (await seal(key, NOTE)).replace('locked v2', 'locked v1')

    expect(isV2(v1)).toBe(false)
    expect(await unlockWithPassword(v1, 'nope')).toBeNull()
    const old = await unlockWithPassword(v1, 'legacy pw')
    expect(old?.legacy).toBeDefined()
    expect(await unseal(old!.legacy!, v1Note)).toBe(NOTE)

    const up = await upgradeConfig(v1, 'legacy pw')
    expect(up.config.legacy).toEqual(v1)
    const u = await unlockWithPassword(up.config, 'legacy pw')
    expect(await unseal(u!.legacy!, v1Note)).toBe(NOTE)
    await expect(unseal(u!.key, v1Note)).rejects.toThrow()
  })
})

describe('passwordStrength', () => {
  it('rejects short, common, repeated and sequential passwords with a reason', () => {
    for (const pw of ['', 'short', '1234567', 'password', 'PASSWORD1', 'aaaaaaaaaa', 'abcdefghij', '23456789', '987654321', 'zyxwvuts']) {
      const r = passwordStrength(pw)
      expect(r.score, pw).toBe(0)
      expect(r.problem, pw).toBeTruthy()
    }
  })

  it('scores by length and variety, capped at 4', () => {
    expect(passwordStrength('kxqmwzpt')).toEqual({ score: 1 })
    expect(passwordStrength('kxqmwzptrv')).toEqual({ score: 2 })
    expect(passwordStrength('kxqmwzptrvbnhg')).toEqual({ score: 3 })
    expect(passwordStrength('Kxqmwzp7')).toEqual({ score: 2 })
    expect(passwordStrength('Kxqmwzptrvbnh7!')).toEqual({ score: 4 })
    expect(passwordStrength('我的密码很长很安全呀')).toEqual({ score: 2 })
  })
})
