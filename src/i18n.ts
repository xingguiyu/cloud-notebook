/**
 * 界面文字的翻译。
 *
 * 用法：`t(原文)`，带变量时 `t('已选中 {n} 篇笔记', { n })`。模板里用 `$t(...)`。
 * 中文原文就是词条的键：中文界面直接显示原文，其他语言去词表里查，查不到就显示中文。
 * 加一种语言 = 加一份「中文 → 译文」的词表（见 `src/locales/`）。
 * 同一个词在不同位置意思不同（比如「置顶」既是动作也是分类名）时，键写成 `置顶||分类`，中文仍显示「置顶」。
 *
 * 语言在启动时确定，切换语言会重新加载窗口，所以模块顶层的常量里也可以直接调用 `t`。
 */
import { invoke } from '@tauri-apps/api/core'
import en from './locales/en'

export type Lang = 'zh' | 'en'
export const LANG_OPTIONS = [
  { id: 'system', label: '跟随系统' },
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
] as const
export type LangChoice = (typeof LANG_OPTIONS)[number]['id']

const DICTS: Record<Exclude<Lang, 'zh'>, Record<string, string>> = { en }

const KEY = 'lang'
function stored(): LangChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'zh' || v === 'en' ? v : 'system'
  } catch {
    return 'system'
  }
}
export const langChoice: LangChoice = stored()
/** 实际使用的语言：系统语言是中文就用中文，其他一律英文 */
export const lang: Lang = langChoice === 'system' ? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en') : langChoice
const dict = lang === 'zh' ? null : DICTS[lang]

/** 日期、数字格式化用的地区代码 */
export const dateLocale = lang === 'zh' ? 'zh-CN' : 'en-US'

const missing = new Set<string>()

/**
 * 译文里可以用 `{名字}` 引用变量；英文复数用 `{s:名字}`，变量等于 1 时为空，否则是 `s`，
 * 例如 `'{n} note{s:n}'`。
 */
export function t(zh: string, params?: Record<string, string | number>): string {
  // 同一个中文词在不同位置要译成不同的词时，写成 `原文||说明`：中文界面只显示「原文」，词表里按整个键分别给译文
  const cut = zh.indexOf('||')
  let s = cut < 0 ? zh : zh.slice(0, cut)
  if (dict) {
    const hit = dict[zh] ?? (cut < 0 ? undefined : dict[s])
    if (hit !== undefined) s = hit
    else if (import.meta.env.DEV && !missing.has(zh)) {
      missing.add(zh)
      console.warn(`[i18n] 缺少 ${lang} 译文：${zh}`)
    }
  }
  if (!params) return s
  return s.replace(/\{(s:)?(\w+)\}/g, (m, plural: string | undefined, k: string) => (k in params ? (plural ? (Number(params[k]) === 1 ? '' : 's') : String(params[k])) : m))
}

// 原生菜单栏和使用指南跟着用同一种语言
invoke('set_language', { choice: langChoice }).catch(() => {})

/** 换语言：记下选择，通知原生部分，然后重新加载窗口 */
export async function setLang(choice: LangChoice) {
  if (choice === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, choice)
  await invoke('set_language', { choice }).catch(() => {})
  location.reload()
}
