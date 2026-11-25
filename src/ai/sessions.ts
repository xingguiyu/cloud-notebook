import { reactive, watch } from 'vue'
import type { Source } from './client'
import { t } from '../i18n'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
  /** 用户这一轮附带的附件名（只用于显示） */
  attached?: string[]
  sources?: Source[]
  error?: string
  pending?: boolean
}

export interface Session {
  id: string
  scope: 'vault' | 'note'
  /** 「当前笔记」会话绑定的笔记 */
  notePath: string | null
  title: string
  turns: Turn[]
  updated: number
}

const KEY = 'cn-ai-sessions'
const MAX = 100

function load(): Session[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Session[]
    // 上次没回答完的轮次不会再继续了
    for (const s of list) for (const turn of s.turns) if (turn.pending) Object.assign(turn, { pending: false, error: turn.text ? undefined : t('已中断') })
    return list
  } catch {
    return []
  }
}

/** 会话只存在本机（可能含笔记内容），不参与云同步 */
export const sessions = reactive<Session[]>(load())

let timer: number | undefined
watch(
  sessions,
  () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      const keep = sessions.filter((s) => s.turns.length).sort((a, b) => b.updated - a.updated).slice(0, MAX)
      try {
        localStorage.setItem(KEY, JSON.stringify(keep))
      } catch {}
    }, 500)
  },
  { deep: true },
)

export function createSession(scope: Session['scope'], notePath: string | null): Session {
  sessions.unshift({ id: crypto.randomUUID(), scope, notePath, title: '', turns: [], updated: Date.now() })
  return sessions[0]
}

/** 这个范围（和笔记）最近的会话；没有就新建一个空的 */
export function latestSession(scope: Session['scope'], notePath: string | null): Session {
  const found = sessions
    .filter((s) => s.scope === scope && (scope === 'vault' || s.notePath === notePath))
    .sort((a, b) => b.updated - a.updated)[0]
  return found ?? createSession(scope, notePath)
}

export function deleteSession(id: string) {
  const i = sessions.findIndex((s) => s.id === id)
  if (i >= 0) sessions.splice(i, 1)
}
