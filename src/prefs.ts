import { reactive, watch } from 'vue'
import { applyTheme, type Appearance } from './themes'

/**
 * 偏好设置。排版类全部映射成 CSS 变量，编辑器、预览共用。
 * 默认值参考常见阅读排版：正文 16px、行高 1.7、标题上方留白约为下方的 2 倍，让标题贴近它所属的内容。
 */
export interface Prefs {
  fontFamily: 'system' | 'serif' | 'mono'
  fontSize: number // px
  lineHeight: number
  paragraphSpacing: number // em，段落之间
  headingSpacing: number // 标题上方留白的倍数，1 为默认
  contentWidth: number // px，正文最大宽度
  newNoteHeading: boolean // 新建笔记以一级标题开头
  tagPosition: 'bottom' | 'top' // 在标签下新建笔记时，标签写在哪里
  showHeadingLevel: boolean // 标题左侧显示 H1–H6
  theme: string
  appearance: Appearance
  autoLockMinutes: number // 加密笔记解锁后多久自动锁上，0 为退出应用前不锁
  exportFormat: 'pdf' | 'html' | 'zip' | 'md' | 'inline' | 'hosted' | 'docx'
  exportTemplate: string
  exportPaper: 'a4' | 'letter' | 'a5'
  exportMargin: 'narrow' | 'normal' | 'wide'
  exportKeepTags: boolean
  aiModel: string // 「服务商:模型」
  aiProviderModels: Record<string, string[]> // 各服务商拉取到的模型列表
  aiBaseUrls: Record<string, string> // 用户改过的接口地址
  zoom: number // 编辑区缩放，1 为 100%（⌘+ / ⌘-）
  darkSidebar: boolean // 浅色外观下侧边栏用深空灰
  noteSort: 'modified' | 'modified-asc' | 'created' | 'title' | 'words' | 'manual' // 笔记列表排序
}

export const DEFAULT_PREFS: Prefs = {
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.7,
  paragraphSpacing: 0.6,
  headingSpacing: 1,
  contentWidth: 720,
  newNoteHeading: true,
  tagPosition: 'bottom',
  showHeadingLevel: true,
  noteSort: 'modified',
  zoom: 1,
  darkSidebar: true,
  theme: 'coral',
  appearance: 'system',
  autoLockMinutes: 5,
  exportFormat: 'pdf',
  exportTemplate: 'clean',
  exportPaper: 'a4',
  exportMargin: 'normal',
  exportKeepTags: true,
  aiModel: 'anthropic:claude-opus-5-5',
  aiProviderModels: {},
  aiBaseUrls: {},
}

const KEY = 'prefs.v1'

function load(): Prefs {
  try {
    const p: Prefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    // 早期只存了 Claude 模型名
    if (!p.aiModel.includes(':')) p.aiModel = `anthropic:${p.aiModel}`
    return p
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export const prefs = reactive<Prefs>(load())

const FONTS: Record<Prefs['fontFamily'], string> = {
  system: 'var(--font-ui)',
  serif: '"Songti SC", "Noto Serif SC", Georgia, serif',
  mono: 'var(--font-mono)',
}

export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 2
/** 编辑区放大 / 缩小一档（10%）；dir 为 0 时恢复 100%。返回新的百分比 */
export function zoomBy(dir: -1 | 0 | 1) {
  const z = dir === 0 ? 1 : Math.round(((prefs.zoom || 1) + dir * 0.1) * 10) / 10
  prefs.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
  return Math.round(prefs.zoom * 100)
}

function apply(p: Prefs) {
  const s = document.documentElement.style
  s.setProperty('--doc-font', FONTS[p.fontFamily])
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, p.zoom || 1))
  s.setProperty('--doc-size', `${Math.round(p.fontSize * zoom * 10) / 10}px`)
  s.setProperty('--doc-line', String(p.lineHeight))
  s.setProperty('--doc-para', `${p.paragraphSpacing}em`)
  s.setProperty('--doc-heading', String(p.headingSpacing))
  // 正文宽度跟着缩放，每行字数不变
  s.setProperty('--doc-width', `${Math.round(p.contentWidth * zoom)}px`)
  document.documentElement.classList.toggle('dark-sidebar', p.darkSidebar)
  document.documentElement.classList.toggle('hide-heading-level', !p.showHeadingLevel)
  applyTheme(p.theme, p.appearance)
}

apply(prefs)
watch(
  prefs,
  (p) => {
    apply(p)
    try {
      localStorage.setItem(KEY, JSON.stringify(p))
    } catch {}
  },
  { deep: true },
)

export function resetTypography() {
  for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'paragraphSpacing', 'headingSpacing', 'contentWidth'] as const)
    (prefs as Record<string, unknown>)[k] = DEFAULT_PREFS[k]
}
