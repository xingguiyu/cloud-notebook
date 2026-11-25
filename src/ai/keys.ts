import { invoke } from '@tauri-apps/api/core'
import { reactive } from 'vue'

/** 各服务商是否已配置 Key（读配置标记，不触碰钥匙串） */
export const keyStatus = reactive<Record<string, boolean>>({})

export async function refreshKeys() {
  Object.assign(keyStatus, await invoke<Record<string, boolean>>('ai_key_status'))
}

export const hasAnyKey = () => Object.values(keyStatus).some(Boolean)
