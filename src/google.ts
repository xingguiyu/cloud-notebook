import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ref } from 'vue'
import { renderHtml } from './export'
import { noteTitle } from './vault'
import { t, dateLocale } from './i18n'

export interface GoogleStatus {
  configured: boolean
  client_id: string
  email: string | null
  auto_sync: boolean
}
export interface SyncReport {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: string[]
  docs_pulled: number
  last_sync: number
}
export interface DocInfo {
  link: string
  two_way: boolean
}

export const google = {
  status: () => invoke<GoogleStatus>('google_status'),
  setConfig: (clientId: string, clientSecret: string) => invoke<void>('google_set_config', { clientId, clientSecret }),
  setAutoSync: (enabled: boolean) => invoke<void>('google_set_auto_sync', { enabled }),
  login: () => invoke<string>('google_login'),
  logout: () => invoke<void>('google_logout'),
  sync: () => invoke<SyncReport | null>('google_sync'),
  lastSync: () => invoke<number | null>('google_last_sync'),
  docs: () => invoke<Record<string, DocInfo>>('google_docs_list'),
  setTwoWay: (note: string, enabled: boolean) => invoke<void>('google_doc_set_two_way', { note, enabled }),
  moveDoc: (from: string, to: string) => invoke<void>('google_doc_move', { from, to }),
  async publish(note: string, md: string, twoWay?: boolean) {
    const html = await renderHtml(md, note)
    return invoke<string>('google_publish_doc', { note, title: noteTitle(note, md) || t('未命名'), html, twoWay })
  },
}

/** 全局同步状态，侧边栏和设置面板共用 */
export const syncState = ref<{ state: 'off' | 'idle' | 'syncing' | 'error'; error?: string; last?: number; report?: SyncReport }>({
  state: 'off',
})

listen<{ state: 'idle' | 'syncing' | 'error'; error?: string; report?: SyncReport }>('google-sync', ({ payload }) => {
  syncState.value = {
    ...syncState.value,
    state: payload.state,
    error: payload.error,
    report: payload.report ?? syncState.value.report,
    last: payload.report?.last_sync ?? syncState.value.last,
  }
})

export function formatAgo(sec?: number) {
  if (!sec) return ''
  const d = Math.max(0, Date.now() / 1000 - sec)
  if (d < 60) return t('刚刚')
  if (d < 3600) return t('{n} 分钟前', { n: Math.floor(d / 60) })
  return new Date(sec * 1000).toLocaleString(dateLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
