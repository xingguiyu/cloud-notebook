<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { ask } from '@tauri-apps/plugin-dialog'
import { bodyOf, diffLines } from '../front'
import { t, dateLocale } from '../i18n'

const props = defineProps<{ notePath: string; title: string; current: string }>()
const emit = defineEmits<{ close: []; restored: [md: string] }>()

interface Version {
  id: string
  size: number
}
const versions = ref<Version[]>([])
const selected = ref<string | null>(null)
const text = ref('')
const compare = ref(true)
const loading = ref(true)
const error = ref('')

const fmt = (id: string) => new Date(Number(id)).toLocaleString(dateLocale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const words = (md: string) => (md.match(/[一-鿿]/g)?.length ?? 0) + (md.match(/[A-Za-z0-9]+/g)?.length ?? 0)

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  try {
    versions.value = await invoke<Version[]>('history_list', { path: props.notePath })
    selected.value = versions.value[0]?.id ?? null
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

watch(selected, async (id) => {
  text.value = ''
  if (!id) return
  try {
    text.value = await invoke<string>('history_read', { path: props.notePath, id })
  } catch (e) {
    error.value = String(e)
  }
})

/** 这个版本到当前内容的变化：「-」是后来删掉的，「+」是后来加上的 */
const lines = computed(() => (compare.value ? diffLines(bodyOf(text.value), bodyOf(props.current)) : bodyOf(text.value).split('\n').map((t) => ({ t, k: ' ' as const }))))
const changed = computed(() => lines.value.filter((l) => l.k !== ' ').length)

async function restore() {
  if (!selected.value) return
  const ok = await ask(t('恢复到 {time} 的版本？现在的内容会先存进历史，可以再恢复回来。', { time: fmt(selected.value) }), { title: t('恢复历史版本'), okLabel: t('恢复'), cancelLabel: t('取消') })
  if (!ok) return
  try {
    emit('restored', await invoke<string>('history_restore', { path: props.notePath, id: selected.value }))
  } catch (e) {
    error.value = String(e)
  }
}
</script>

<template>
  <div class="sheet-backdrop" @mousedown.self="emit('close')">
    <div class="sheet history-sheet">
      <h3>{{ $t('「{title}」的历史版本', { title }) }}</h3>
      <p v-if="error" class="history-note error">{{ error }}</p>
      <p v-else-if="loading" class="history-note">{{ $t('正在读取…') }}</p>
      <p v-else-if="!versions.length" class="history-note">
        {{ $t('还没有历史版本。笔记被修改或被 AI 重新保存时，会自动把修改前的内容留一份在这里（连续编辑时最多每十分钟一份，只保存在本机）。') }}
      </p>
      <div v-else class="history-cols">
        <div class="history-list">
          <button v-for="v in versions" :key="v.id" class="history-item" :class="{ active: selected === v.id }" @click="selected = v.id">
            <b>{{ fmt(v.id) }}</b>
            <small>{{ (v.size / 1024).toFixed(1) }} KB</small>
          </button>
        </div>
        <div class="history-view">
          <div class="history-bar">
            <label class="check"><input v-model="compare" type="checkbox" /> {{ $t('和当前内容对比') }}</label>
            <span v-if="compare" class="history-count">{{ changed ? $t('{n} 行不同', { n: changed }) : $t('和当前内容相同') }}</span>
            <span v-else class="history-count">{{ $t('{n} 字', { n: words(text) }) }}</span>
          </div>
          <div class="history-text selectable">
            <div v-for="(l, i) in lines" :key="i" class="hl" :class="{ add: l.k === '+', del: l.k === '-' }"><span class="mark">{{ l.k === ' ' ? '' : l.k }}</span>{{ l.t || ' ' }}</div>
          </div>
          <p v-if="compare" class="history-legend"><span class="del">−</span> {{ $t('这个版本有、现在没有') }} <span class="add">+</span> {{ $t('现在有、这个版本没有') }}</p>
        </div>
      </div>
      <div class="row end history-actions">
        <button class="btn" @click="emit('close')">{{ $t('关闭') }}</button>
        <button class="btn primary" :disabled="!selected || !text || (compare && !changed)" @click="restore">{{ $t('恢复到这个版本') }}</button>
      </div>
    </div>
  </div>
</template>

<style>
.history-sheet { width: 820px; }
.history-actions { margin-top: 14px; }
.history-note { color: var(--text-2); font-size: 13px; line-height: 1.6; margin: 8px 0 4px; }
.history-note.error { color: var(--accent); }
.history-cols { display: grid; grid-template-columns: 210px 1fr; gap: 16px; margin-top: 10px; min-height: 0; }
.history-list { display: flex; flex-direction: column; gap: 2px; max-height: 52vh; overflow-y: auto; }
.history-item { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-radius: 8px; text-align: left; color: var(--text-2); }
.history-item b { font-weight: 500; font-size: 13px; color: var(--text); }
.history-item small { font-size: 11.5px; }
.history-item:hover { background: var(--selected); }
.history-item.active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.history-item.active b { color: var(--accent); }
.history-view { min-width: 0; display: flex; flex-direction: column; }
.history-bar { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--text-2); margin-bottom: 6px; }
.history-text { flex: 1; max-height: 46vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px 0; font: 12.5px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; background: var(--bg-editor); }
.hl { padding: 0 12px 0 0; white-space: pre-wrap; word-break: break-word; }
.hl .mark { display: inline-block; width: 22px; text-align: center; color: var(--text-2); user-select: none; }
.hl.add { background: rgba(48, 164, 108, 0.14); }
.hl.del { background: rgba(229, 72, 77, 0.13); }
.history-legend { font-size: 11.5px; color: var(--text-2); margin: 6px 0 0; }
.history-legend .add { color: #30a46c; font-weight: 600; margin-left: 10px; }
.history-legend .del { color: #e5484d; font-weight: 600; }
</style>
