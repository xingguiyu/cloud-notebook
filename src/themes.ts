import { getCurrentWindow } from '@tauri-apps/api/window'
import { t } from './i18n'

type Tokens = Record<string, string>
export interface Theme {
  id: string
  name: string
  light: Tokens
  dark: Tokens
}

/** 每套主题只覆盖差异的变量，其余沿用 native.css 里的默认值 */
export const THEMES: Theme[] = [
  { id: 'coral', name: t('珊瑚'), light: { '--accent': '#e5484d' }, dark: { '--accent': '#f2555a' } },
  { id: 'ocean', name: t('墨蓝'), light: { '--accent': '#2563eb' }, dark: { '--accent': '#60a5fa' } },
  { id: 'forest', name: t('森林'), light: { '--accent': '#15803d' }, dark: { '--accent': '#4ade80' } },
  { id: 'wisteria', name: t('紫藤'), light: { '--accent': '#7c3aed' }, dark: { '--accent': '#a78bfa' } },
  { id: 'amber', name: t('琥珀'), light: { '--accent': '#c2410c' }, dark: { '--accent': '#fb923c' } },
  {
    id: 'paper',
    name: t('纸张'),
    light: {
      '--accent': '#a0522d',
      '--bg-editor': '#fbf7ef',
      '--bg-list': 'rgba(246, 240, 228, 0.85)',
      '--text': '#3b3127',
      '--text-2': '#8a7b69',
      '--border': 'rgba(90, 70, 40, 0.12)',
      '--selected': 'rgba(120, 90, 50, 0.08)',
      '--code-bg': 'rgba(120, 90, 50, 0.06)',
    },
    dark: {
      '--accent': '#d9a066',
      '--bg-editor': '#211d18',
      '--bg-list': 'rgba(30, 26, 21, 0.85)',
      '--text': '#ece3d4',
      '--text-2': '#a39582',
      '--border': 'rgba(255, 240, 210, 0.09)',
      '--selected': 'rgba(255, 240, 210, 0.07)',
    },
  },
  {
    id: 'graphite',
    name: t('石墨'),
    light: { '--accent': '#3f3f46', '--selected-active': '#52525b' },
    dark: { '--accent': '#d4d4d8', '--selected-active': '#52525b', '--bg-editor': '#18181b', '--bg-list': 'rgba(24, 24, 27, 0.8)' },
  },
]

export type Appearance = 'system' | 'light' | 'dark'

const media = window.matchMedia('(prefers-color-scheme: dark)')
let applied: string[] = []
let current: { theme: string; appearance: Appearance } = { theme: 'coral', appearance: 'system' }

export function applyTheme(themeId: string, appearance: Appearance) {
  current = { theme: themeId, appearance }
  const dark = appearance === 'dark' || (appearance === 'system' && media.matches)
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0]
  const root = document.documentElement
  for (const k of applied) root.style.removeProperty(k)
  // 强制浅色/深色时，先把另一套默认值也压掉：用 data-appearance 让 CSS 选对默认值
  root.dataset.appearance = dark ? 'dark' : 'light'
  const tokens: Tokens = { ...(dark ? theme.dark : theme.light) }
  // 列表选中行默认用主题色，个别主题（石墨）单独指定
  tokens['--selected-active'] ??= tokens['--accent']
  // 浅色外观下的深色侧边栏要用深色那套主题色，否则深色主题色（石墨）在深底上看不清
  tokens['--accent-on-dark'] = theme.dark['--accent']
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v)
  applied = Object.keys(tokens)
  // 窗口的毛玻璃材质也跟着深浅切换
  getCurrentWindow()
    .setTheme(appearance === 'system' ? null : appearance)
    .catch(() => {})
}

media.addEventListener('change', () => applyTheme(current.theme, current.appearance))
