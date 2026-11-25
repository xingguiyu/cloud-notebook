<script setup lang="ts">
import { ref } from 'vue'
import { ShieldCheck, Copy, Download } from 'lucide-vue-next'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { t, dateLocale } from '../i18n'

const props = defineProps<{ recoveryKey: string }>()
const emit = defineEmits<{ done: [] }>()
const saved = ref(false)
const copied = ref(false)

async function copy() {
  await invoke('copy_secret', { text: props.recoveryKey })
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

async function saveFile() {
  const path = await save({ defaultPath: t('Cloud Notebook 恢复密钥.txt'), filters: [{ name: t('文本'), extensions: ['txt'] }] })
  if (!path) return
  const date = new Date().toLocaleString(dateLocale)
  await invoke('export_write', {
    path,
    content: t('Cloud Notebook 加密笔记恢复密钥\n\n{key}\n\n生成时间：{date}\n\n忘记加密密码时，用这个恢复密钥重设密码。\n请保存在安全的地方（例如打印出来或存进密码管理器），不要和笔记放在一起。\n任何拿到它的人都能解开你的加密笔记。\n', { key: props.recoveryKey, date }),
  })
}
</script>

<template>
  <div class="sheet-backdrop">
    <div class="sheet rk-sheet">
      <div class="pw-icon"><ShieldCheck :size="22" /></div>
      <h2>{{ $t('保存你的恢复密钥') }}</h2>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <p class="hint" v-html="$t('忘记加密密码时，只能用这个恢复密钥重设，<b>它只显示这一次</b>。请打印出来或存进密码管理器，不要和笔记放在同一个地方。')" />
      <div class="rk-key selectable">{{ recoveryKey }}</div>
      <div class="row">
        <button class="btn" @click="copy"><Copy :size="13" /> {{ copied ? $t('已复制') : $t('复制') }}</button>
        <button class="btn" @click="saveFile"><Download :size="13" /> {{ $t('存为文件…') }}</button>
      </div>
      <label class="check rk-check"><input v-model="saved" type="checkbox" /> {{ $t('我已经妥善保存了恢复密钥') }}</label>
      <div class="row end">
        <button class="btn primary" :disabled="!saved" @click="emit('done')">{{ $t('完成') }}</button>
      </div>
    </div>
  </div>
</template>

<style>
.rk-sheet {
  width: 440px;
}
.rk-sheet h2 {
  margin: 8px 0 6px;
  font-size: 15px;
}
.rk-key {
  margin: 4px 0 12px;
  padding: 14px;
  border-radius: 8px;
  background: var(--selected);
  font: 600 17px/1.4 var(--font-mono);
  letter-spacing: 0.06em;
  text-align: center;
  word-break: break-all;
}
.rk-sheet .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.rk-check {
  margin: 14px 0 6px !important;
}
</style>
