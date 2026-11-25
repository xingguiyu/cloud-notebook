<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { KeyRound } from 'lucide-vue-next'
import { passwordStrength } from '../crypto'
import { t } from '../i18n'

/** set：首次设置；change：修改（需要当前密码）；recover：用恢复密钥重设 */
const props = defineProps<{ mode: 'set' | 'change' | 'recover'; initialHint?: string }>()
const emit = defineEmits<{ cancel: []; submit: [{ oldPassword?: string; recoveryKey?: string; password: string; hint: string }] }>()

const oldPw = ref('')
const recoveryKey = ref('')
const pw = ref('')
const pw2 = ref('')
const hintText = ref(props.initialHint ?? '')
const first = ref<HTMLInputElement>()
const error = ref('')
const busy = ref(false)
defineExpose({
  setError: (e: string) => {
    error.value = e
    busy.value = false
  },
})

const strength = computed(() => passwordStrength(pw.value))
const LABELS = [t('太弱'), t('弱'), t('一般'), t('强'), t('很强')]
const valid = computed(
  () =>
    !strength.value.problem &&
    pw.value === pw2.value &&
    (props.mode !== 'change' || oldPw.value) &&
    (props.mode !== 'recover' || recoveryKey.value.trim()),
)

function submit() {
  if (strength.value.problem) return (error.value = t('密码{problem}', { problem: strength.value.problem }))
  if (pw.value !== pw2.value) return (error.value = t('两次输入的密码不一致'))
  if (hintText.value && pw.value.includes(hintText.value)) return (error.value = t('提示里不能包含密码本身'))
  busy.value = true
  error.value = ''
  emit('submit', {
    oldPassword: props.mode === 'change' ? oldPw.value : undefined,
    recoveryKey: props.mode === 'recover' ? recoveryKey.value : undefined,
    password: pw.value,
    hint: hintText.value.trim(),
  })
}

const TITLES = { set: t('设置加密密码'), change: t('修改加密密码'), recover: t('用恢复密钥重设密码') }
onMounted(() => nextTick(() => first.value?.focus()))
</script>

<template>
  <div class="sheet-backdrop" @mousedown.self="emit('cancel')" @keydown.esc="emit('cancel')">
    <form class="sheet pw-sheet" @submit.prevent="submit">
      <div class="pw-icon"><KeyRound :size="22" /></div>
      <h2>{{ TITLES[mode] }}</h2>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <p v-if="mode === 'set'" class="hint" v-html="$t('所有加密笔记共用这一个密码，会随笔记库同步到其他设备。设置后会生成一个<b>恢复密钥</b>，忘记密码时可以用它重设。')" />
      <p v-else-if="mode === 'recover'" class="hint">{{ $t('输入设置密码时保存的恢复密钥（26 位，横线和大小写都可以忽略）。') }}</p>

      <input v-if="mode === 'change'" ref="first" v-model="oldPw" class="field selectable" type="password" :placeholder="$t('当前密码')" />
      <input
        v-if="mode === 'recover'"
        ref="first"
        v-model="recoveryKey"
        class="field selectable mono"
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
        spellcheck="false"
        autocomplete="off"
      />
      <input
        :ref="mode === 'set' ? 'first' : undefined"
        v-model="pw"
        class="field selectable"
        type="password"
        :placeholder="$t('新密码（至少 8 位）')"
      />
      <div v-if="pw" class="meter">
        <span v-for="i in 4" :key="i" :class="{ on: i <= strength.score, ['s' + strength.score]: true }" />
        <em>{{ strength.problem ?? LABELS[strength.score] }}</em>
      </div>
      <input v-model="pw2" class="field selectable" type="password" :placeholder="$t('再次输入新密码')" />
      <input v-model="hintText" class="field selectable" :placeholder="$t('密码提示（可选，会以明文保存）')" maxlength="60" />
      <p v-if="error" class="pw-error">{{ error }}</p>
      <div class="row end">
        <button type="button" class="btn" @click="emit('cancel')">{{ $t('取消') }}</button>
        <button type="submit" class="btn primary" :disabled="!valid || busy">{{ busy ? $t('处理中…') : $t('确定') }}</button>
      </div>
    </form>
  </div>
</template>

<style>
.pw-sheet {
  width: 400px;
  text-align: left;
}
.pw-sheet h2 {
  margin: 8px 0 6px;
  font-size: 15px;
}
.pw-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.pw-sheet .hint {
  margin: 0 0 12px;
}
.pw-error {
  margin: -2px 0 8px;
  color: var(--accent);
  font-size: 12px;
}
.field.mono {
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}
.meter {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: -4px 0 10px;
}
.meter span {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--selected);
}
.meter span.on.s0,
.meter span.on.s1 {
  background: #e5484d;
}
.meter span.on.s2 {
  background: #f5a524;
}
.meter span.on.s3,
.meter span.on.s4 {
  background: #30a46c;
}
.meter em {
  min-width: 120px;
  font-style: normal;
  font-size: 11px;
  color: var(--text-2);
  text-align: right;
}
</style>
