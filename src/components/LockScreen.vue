<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Lock } from 'lucide-vue-next'
import { failureCount, hint, unlock, waitRemaining } from '../lock'
import { t } from '../i18n'

defineProps<{ title: string }>()
const emit = defineEmits<{ forgot: [] }>()
const pw = ref('')
const error = ref(false)
const busy = ref(false)
const input = ref<HTMLInputElement>()
const wait = ref(waitRemaining())
const fails = ref(failureCount())

// 输错太多次后的倒计时
const ticker = window.setInterval(() => (wait.value = waitRemaining()), 500)
onBeforeUnmount(() => clearInterval(ticker))
const waitText = computed(() => {
  const s = Math.ceil(wait.value / 1000)
  return s >= 60 ? t('{m} 分 {sec} 秒', { m: Math.floor(s / 60), sec: s % 60 }) : t('{sec} 秒', { sec: s })
})

async function submit() {
  if (!pw.value || busy.value || wait.value > 0) return
  busy.value = true
  const r = await unlock(pw.value)
  busy.value = false
  if (!r.ok) {
    error.value = true
    pw.value = ''
    fails.value = failureCount()
    wait.value = waitRemaining()
    await nextTick()
    input.value?.focus()
  }
}

onMounted(() => nextTick(() => input.value?.focus()))
</script>

<template>
  <div class="lock-screen">
    <div class="lock-icon"><Lock :size="28" :stroke-width="1.6" /></div>
    <div class="lock-title">{{ title || $t('加密笔记') }}</div>
    <div class="lock-sub">{{ $t('这篇笔记已加密') }}</div>
    <form class="lock-form" @submit.prevent="submit">
      <input
        ref="input"
        v-model="pw"
        class="field selectable"
        :class="{ shake: error }"
        type="password"
        :placeholder="wait > 0 ? $t('请 {wait}后再试', { wait: waitText }) : $t('输入密码解锁')"
        :disabled="wait > 0"
        @input="error = false"
        @animationend="error = false"
      />
      <button class="btn primary" :disabled="!pw || busy || wait > 0">{{ busy ? $t('解锁中…') : $t('解锁') }}</button>
    </form>
    <div v-if="wait > 0" class="lock-error">{{ $t('已连续输错 {n} 次，请 {wait}后再试', { n: fails, wait: waitText }) }}</div>
    <div v-else-if="error" class="lock-error">{{ $t('密码不正确') }}</div>
    <div v-if="fails > 0 && hint()" class="lock-hint">{{ $t('提示：{hint}', { hint: hint() ?? '' }) }}</div>
    <button class="lock-forgot" type="button" @click="emit('forgot')">{{ $t('忘记密码？') }}</button>
  </div>
</template>

<style>
.lock-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding-bottom: 12vh;
  color: var(--text);
}
.lock-icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background: var(--selected);
  color: var(--text-2);
  margin-bottom: 8px;
}
.lock-title {
  font-size: 18px;
  font-weight: 700;
}
.lock-sub {
  color: var(--text-2);
  font-size: 12px;
  margin-bottom: 14px;
}
.lock-form {
  display: flex;
  gap: 8px;
}
.lock-form .field {
  width: 240px;
  margin: 0;
}
.lock-form .btn {
  height: 28px;
}
.lock-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--accent);
}
.lock-hint {
  font-size: 12px;
  color: var(--text-2);
}
.lock-forgot {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.lock-forgot:hover {
  color: var(--accent);
}
.shake {
  animation: shake 0.3s;
  border-color: var(--accent) !important;
}
@keyframes shake {
  25% { transform: translateX(-6px); }
  75% { transform: translateX(6px); }
}
</style>
