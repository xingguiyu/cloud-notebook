<script setup lang="ts">
import { computed } from 'vue'
import { Link2, X } from 'lucide-vue-next'
import { dateLocale } from '../i18n'

const props = defineProps<{ markdown: string; path: string; modified?: number; backlinks: { path: string; title: string }[] }>()
defineEmits<{ close: []; jump: [number]; open: [string] }>()

/** 中文按字计、英文按词计，和常见写作软件的口径一致 */
const stats = computed(() => {
  const text = props.markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|]/g, ' ')
  const cjk = (text.match(/[一-鿿㐀-䶿豈-﫿]/g) ?? []).length
  const words = (text.replace(/[一-鿿㐀-䶿豈-﫿]/g, ' ').match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) ?? []).length
  const chars = text.replace(/\s/g, '').length
  // 阅读速度：中文约 400 字/分钟，英文约 200 词/分钟
  const minutes = Math.max(1, Math.round(cjk / 400 + words / 200))
  const paragraphs = props.markdown.split(/\n\s*\n/).filter((p) => p.trim()).length
  return { count: cjk + words, chars, minutes, paragraphs }
})

const outline = computed(() => {
  const out: { level: number; text: string }[] = []
  let inCode = false
  for (const line of props.markdown.split('\n')) {
    if (/^```/.test(line)) inCode = !inCode
    const m = !inCode && line.match(/^(#{1,6})\s+(.+)$/)
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, '') })
  }
  return out
})

const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' }) : '')
</script>

<template>
  <div class="info-panel">
    <div class="info-head">
      <span>{{ $t('笔记信息') }}</span>
      <button class="icon-btn" :title="$t('关闭')" @click="$emit('close')"><X :size="14" /></button>
    </div>
    <div class="stats">
      <div><b>{{ stats.count.toLocaleString() }}</b><span>{{ $t('字数') }}</span></div>
      <div><b>{{ stats.chars.toLocaleString() }}</b><span>{{ $t('字符') }}</span></div>
      <div><b>{{ stats.paragraphs }}</b><span>{{ $t('段落') }}</span></div>
      <div><b>{{ $t('{n} 分钟', { n: stats.minutes }) }}</b><span>{{ $t('阅读') }}</span></div>
    </div>
    <div class="meta">
      <div><span>{{ $t('修改于') }}</span>{{ fmt(modified) }}</div>
      <div><span>{{ $t('位置') }}</span><span class="selectable path">{{ path }}</span></div>
    </div>
    <div class="info-sub">{{ $t('反向链接') }}</div>
    <div v-if="backlinks.length" class="outline">
      <div v-for="b in backlinks" :key="b.path" class="outline-item link" @click="$emit('open', b.path)">
        <Link2 :size="12" /> {{ b.title || b.path }}
      </div>
    </div>
    <div v-else class="none">{{ $t('还没有笔记用 [[{title}]] 链接到这里', { title: markdown.match(/^#\s+(.+)$/m)?.[1] ?? $t('标题') }) }}</div>
    <template v-if="outline.length">
      <div class="info-sub">{{ $t('大纲') }}</div>
      <div class="outline">
        <div
          v-for="(h, i) in outline"
          :key="i"
          class="outline-item"
          :style="{ paddingLeft: 8 + (h.level - 1) * 12 + 'px' }"
          @click="$emit('jump', i)"
        >
          {{ h.text }}
        </div>
      </div>
    </template>
  </div>
</template>

<style>
.info-panel {
  position: absolute;
  top: 48px;
  right: 14px;
  z-index: 6;
  width: 260px;
  max-height: calc(100% - 70px);
  overflow-y: auto;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg-editor);
  border: 1px solid var(--border);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
}
.info-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 10px;
}
.info-head .icon-btn {
  width: 22px;
  height: 22px;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.stats div {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--selected);
  display: flex;
  flex-direction: column;
}
.stats b {
  font-size: 15px;
}
.stats span,
.meta span:first-child {
  color: var(--text-2);
  font-size: 11px;
}
.meta {
  margin: 12px 0 4px;
  display: grid;
  gap: 6px;
}
.meta div {
  display: flex;
  gap: 10px;
}
.meta div > span:first-child {
  flex-shrink: 0;
  white-space: nowrap;
  padding-top: 1px;
}
.meta .path {
  font-size: 11px;
  word-break: break-all;
}
.info-sub {
  margin: 12px 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.outline-item {
  padding: 4px 8px;
  border-radius: 5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.outline-item.link {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
}
.none {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-2);
}
.outline-item:hover {
  background: var(--selected);
}
</style>
