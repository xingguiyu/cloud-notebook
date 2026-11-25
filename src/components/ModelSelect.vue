<script setup lang="ts">
import { computed } from 'vue'
import { prefs } from '../prefs'
import { AI_MODELS } from '../ai/client'
import { PROVIDERS } from '../ai/providers'
import { keyStatus } from '../ai/keys'

/** 按服务商分组的模型选择；只列出已配置 Key 的服务商 */
defineProps<{ compact?: boolean }>()

const groups = computed(() =>
  PROVIDERS.filter((p) => keyStatus[p.id]).map((p) => ({
    provider: p,
    models:
      p.kind === 'anthropic'
        ? AI_MODELS.map((m) => ({ ref: `anthropic:${m.id}`, label: m.name.replace('Claude ', '') }))
        : (prefs.aiProviderModels[p.id] ?? []).map((m) => ({ ref: `${p.id}:${m}`, label: m })),
  })),
)

// 当前选中的模型不在列表里（比如删了 Key）时也要显示出来，避免下拉框空白
const orphan = computed(() => !groups.value.some((g) => g.models.some((m) => m.ref === prefs.aiModel)))
</script>

<template>
  <select v-model="prefs.aiModel" class="select model-select" :class="{ compact }" :title="$t('选择模型')">
    <option v-if="orphan" :value="prefs.aiModel">{{ $t('{model}（未配置）', { model: prefs.aiModel.split(':').pop() ?? '' }) }}</option>
    <optgroup v-for="g in groups" :key="g.provider.id" :label="g.provider.name">
      <option v-if="!g.models.length" disabled :value="null">{{ $t('先在设置里获取模型列表') }}</option>
      <option v-for="m in g.models" :key="m.ref" :value="m.ref">{{ m.label }}</option>
    </optgroup>
  </select>
</template>

<style>
.model-select.compact {
  height: 24px;
  max-width: 130px;
  padding: 0 4px;
  font-size: 11px;
  color: var(--text-2);
  background: transparent;
}
</style>
