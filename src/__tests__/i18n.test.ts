import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { memoryStorage } from './setup'
import app from '../locales/en/app'
import safe from '../locales/en/safe'
import settings from '../locales/en/settings'
import templates from '../locales/en/templates'
import en from '../locales/en'
import { TYPES } from '../safe/templates'

// NOTE: scripts/i18n-check.py scans every file under src/ for calls of the translate function
// written with a string literal. The function is therefore imported under another name here, so
// that the made-up keys in this file are not reported as missing translations.
type I18n = typeof import('../i18n')

/** i18n.ts decides the language at import time, so each case loads a fresh copy of the module */
async function load(opts: { language?: string; stored?: string | null; brokenStorage?: boolean }): Promise<I18n> {
  vi.resetModules()
  vi.stubGlobal('navigator', { language: opts.language ?? 'zh-CN' })
  if (opts.brokenStorage) {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
    })
  } else {
    vi.stubGlobal('localStorage', memoryStorage(opts.stored ? { lang: opts.stored } : {}))
  }
  return import('../i18n')
}

beforeEach(() => {
  vi.mocked(invoke).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('localStorage', memoryStorage())
})

describe('language selection', () => {
  it('follows the system language: Chinese stays Chinese, everything else is English', async () => {
    expect((await load({ language: 'zh-CN' })).lang).toBe('zh')
    expect((await load({ language: 'zh-Hant-TW' })).lang).toBe('zh')
    expect((await load({ language: 'ZH' })).lang).toBe('zh')
    expect((await load({ language: 'en-US' })).lang).toBe('en')
    expect((await load({ language: 'ja-JP' })).lang).toBe('en')
  })

  it('a stored choice wins over the system language', async () => {
    const a = await load({ language: 'zh-CN', stored: 'en' })
    expect([a.langChoice, a.lang, a.dateLocale]).toEqual(['en', 'en', 'en-US'])
    const b = await load({ language: 'en-US', stored: 'zh' })
    expect([b.langChoice, b.lang, b.dateLocale]).toEqual(['zh', 'zh', 'zh-CN'])
  })

  it('ignores an unknown stored value and survives a broken localStorage', async () => {
    expect((await load({ language: 'en-US', stored: 'fr' })).langChoice).toBe('system')
    const m = await load({ language: 'en-US', brokenStorage: true })
    expect([m.langChoice, m.lang]).toEqual(['system', 'en'])
  })

  it('tells the native side which language was chosen, at import time', async () => {
    await load({ language: 'en-US', stored: 'en' })
    expect(invoke).toHaveBeenCalledWith('set_language', { choice: 'en' })
    vi.mocked(invoke).mockClear()
    await load({ language: 'en-US' })
    expect(invoke).toHaveBeenCalledWith('set_language', { choice: 'system' })
  })

  it('setLang stores the choice, notifies the native side and reloads', async () => {
    const m = await load({ language: 'zh-CN' })
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    await m.setLang('en')
    expect(localStorage.getItem('lang')).toBe('en')
    expect(invoke).toHaveBeenLastCalledWith('set_language', { choice: 'en' })
    expect(reload).toHaveBeenCalledTimes(1)
    await m.setLang('system')
    expect(localStorage.getItem('lang')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
})

describe('translate, Chinese interface', () => {
  it('returns the source text and substitutes parameters', async () => {
    const { t: translate } = await load({ language: 'zh-CN' })
    expect(translate('取消')).toBe('取消')
    expect(translate('已选中 {n} 篇笔记', { n: 3 })).toBe('已选中 3 篇笔记')
    expect(translate('{a} 和 {b}，还是 {a}', { a: '甲', b: '乙' })).toBe('甲 和 乙，还是 甲')
  })

  it('shows only the part before || of a key with context', async () => {
    const { t: translate } = await load({ language: 'zh-CN' })
    expect(translate('置顶||分类')).toBe('置顶')
    expect(translate('第 {n} 项||列表', { n: 2 })).toBe('第 2 项')
  })

  it('leaves unknown placeholders in place and accepts 0 and empty strings', async () => {
    const { t: translate } = await load({ language: 'zh-CN' })
    expect(translate('{n} 篇，{m} 个', { n: 0 })).toBe('0 篇，{m} 个')
    expect(translate('名字：{name}。', { name: '' })).toBe('名字：。')
    expect(translate('没有参数 {n}')).toBe('没有参数 {n}')
  })

  it('does not re-expand placeholders that arrive inside a parameter value', async () => {
    const { t: translate } = await load({ language: 'zh-CN' })
    expect(translate('{a}/{b}', { a: '{b}', b: 'x' })).toBe('{b}/x')
  })

  it('does not look at the dictionary', async () => {
    const { t: translate } = await load({ language: 'zh-CN' })
    expect(translate('未打标签')).toBe('未打标签')
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('translate, English interface', () => {
  it('looks the source text up in the dictionary', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    expect(translate('未打标签')).toBe(en['未打标签'])
    expect(translate('取消')).toBe('Cancel')
  })

  it('uses the full key||context entry when there is one', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    expect(en['置顶||分类']).toBeDefined()
    expect(translate('置顶||分类')).toBe(en['置顶||分类'])
  })

  it('falls back to the entry without context, then to the Chinese text before ||', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    expect(translate('取消||某个没有单独译文的位置')).toBe('Cancel')
    expect(translate('词表里没有的词||说明')).toBe('词表里没有的词')
  })

  it('falls back to the Chinese source when there is no translation, and warns once in dev', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    expect(translate('词表里没有的句子 {n}', { n: 5 })).toBe('词表里没有的句子 5')
    translate('词表里没有的句子 {n}', { n: 6 })
    expect(vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('词表里没有的句子'))).toHaveLength(1)
  })

  it('substitutes parameters in the translation', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    const key = Object.keys(en).find((k) => /^[^{]*\{n\}[^{]*$/.test(k) && /\{n\}/.test(en[k]) && !/\{s:/.test(en[k]))!
    expect(key).toBeDefined()
    expect(translate(key, { n: 42 })).toBe(en[key].replace(/\{n\}/g, '42'))
  })

  it('expands {s:n} to a plural s unless the number is 1', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    const key = Object.keys(en).find((k) => /\{s:n\}/.test(en[k]) && /\{n\}/.test(en[k]) && !/\{(?!n\}|s:n\})/.test(en[k]))!
    expect(key, 'the dictionary has at least one entry with a {s:n} plural').toBeDefined()
    const one = translate(key, { n: 1 })
    const many = translate(key, { n: 5 })
    const zero = translate(key, { n: 0 })
    expect(one).toBe(en[key].replace(/\{n\}/g, '1').replace(/\{s:n\}/g, ''))
    expect(many).toBe(en[key].replace(/\{n\}/g, '5').replace(/\{s:n\}/g, 's'))
    expect(zero).toBe(en[key].replace(/\{n\}/g, '0').replace(/\{s:n\}/g, 's'))
    expect(one).not.toMatch(/[{}]/)
    // a numeric string counts the same as a number
    expect(translate(key, { n: '1' })).toBe(one)
  })

  it('leaves {s:x} alone when the parameter is missing', async () => {
    const { t: translate } = await load({ language: 'en-US' })
    const key = Object.keys(en).find((k) => /\{s:n\}/.test(en[k]))!
    expect(translate(key, { other: 1 })).toContain('{s:n}')
  })
})

// ---------------------------------------------------------------------------------------------
// Dictionary checks: the same rules as scripts/i18n-check.py, on the imported dictionaries.
// ---------------------------------------------------------------------------------------------
describe('English dictionary', () => {
  const parts: Record<string, Record<string, string>> = { app, safe, templates, settings }
  const names = (s: string, re: RegExp) => new Set([...s.matchAll(re)].map((m) => m[1]))

  it('the merged dictionary contains every entry of every part', () => {
    for (const [file, d] of Object.entries(parts)) for (const k of Object.keys(d)) expect(en[k], `${file}: ${k}`).toBeDefined()
    expect(Object.keys(en).length).toBeGreaterThan(500)
  })

  it('a translation only uses placeholders that exist in its key', () => {
    const bad: string[] = []
    for (const [k, v] of Object.entries(en)) {
      const inKey = names(k, /\{(\w+)\}/g)
      for (const p of names(v, /\{(?:s:)?(\w+)\}/g)) if (!inKey.has(p)) bad.push(`${k} → ${v} (uses {${p}})`)
    }
    expect(bad).toEqual([])
  })

  it('a translation does not drop a placeholder of its key', () => {
    // stricter than the script: a parameter the Chinese text shows should also appear in English
    const bad: string[] = []
    for (const [k, v] of Object.entries(en)) {
      const inValue = names(v, /\{(?:s:)?(\w+)\}/g)
      for (const p of names(k, /\{(\w+)\}/g)) if (!inValue.has(p)) bad.push(`${k} → ${v} (drops {${p}})`)
    }
    expect(bad).toEqual([])
  })

  it('the same key has the same translation in every part', () => {
    const seen = new Map<string, [string, string]>()
    const bad: string[] = []
    for (const [file, d] of Object.entries(parts))
      for (const [k, v] of Object.entries(d)) {
        const prev = seen.get(k)
        if (prev && prev[1] !== v) bad.push(`${k}: ${prev[0]}=${prev[1]} / ${file}=${v}`)
        else seen.set(k, [file, v])
      }
    expect(bad).toEqual([])
  })

  it('no translation is empty or still contains Chinese characters', () => {
    const empty = Object.entries(en).filter(([, v]) => !v.trim()).map(([k]) => k)
    expect(empty).toEqual([])
    // the only Chinese allowed in English text is a literal name that exists outside the app:
    // the Drive folder created by src-tauri/src/google/docs.rs (DOCS_FOLDER)
    const LITERAL_NAMES = ['Cloud Notebook 文档']
    const strip = (v: string) => LITERAL_NAMES.reduce((x, n) => x.split(n).join(''), v)
    const han = Object.entries(en).filter(([, v]) => /[\u4e00-\u9fff]/.test(strip(v))).map(([k, v]) => `${k} → ${v}`)
    expect(han).toEqual([])
  })

  it('keys that are only passed to the translate function through a variable have a translation', () => {
    // the script cannot see these: photo slot names (SafeView: $t(slot)) and the language picker label
    const dynamic = [...new Set(TYPES.flatMap((ty) => ty.photos ?? [])), '首页', '户主页', '跟随系统']
    expect(dynamic.length).toBeGreaterThan(5)
    expect(dynamic.filter((k) => !(k in en))).toEqual([])
  })

  it('every Chinese string passed to the translate function in the source has a translation', () => {
    const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.vue', '!../locales/**', '!../i18n.ts', '!../__tests__/**'], {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    expect(Object.keys(sources).length).toBeGreaterThan(30)
    // same pattern as the script: t('…') / $t("…") / t(`…`) not preceded by a word character or a dot
    const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|` + '`((?:[^`\\\\$]|\\\\.)*)`'
    const CALL = new RegExp(String.raw`(?<![\w.])\$?t\(\s*(?:` + STR + ')', 'g')
    const unesc = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
    const missing: string[] = []
    let used = 0
    for (const [file, code] of Object.entries(sources)) {
      for (const m of code.matchAll(CALL)) {
        const key = unesc(m[1] ?? m[2] ?? m[3])
        if (!/[\u4e00-\u9fff]/.test(key)) continue
        used++
        if (!(key in en)) missing.push(`${file}: ${key}`)
      }
    }
    expect(used).toBeGreaterThan(500)
    expect(missing).toEqual([])
  })
})
