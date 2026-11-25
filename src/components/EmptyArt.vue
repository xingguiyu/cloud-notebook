<script setup lang="ts">
/**
 * 空状态插画：白线透明底的 PNG 当遮罩，填当前主题的次要文字色——深浅色共用一张图。
 */
const arts = import.meta.glob('../assets/illustrations/*.png', { eager: true, import: 'default' }) as Record<string, string>

const props = withDefaults(defineProps<{ name: string; text?: string; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' })
const url = arts[`../assets/illustrations/${props.name}.png`]
</script>

<template>
  <div class="empty-art" :class="size">
    <div class="art" :style="{ '--art': `url(${url})` }" />
    <div v-if="text" class="text">{{ text }}</div>
    <slot />
  </div>
</template>

<style scoped>
.empty-art {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px 16px;
  color: var(--text-2);
  text-align: center;
  user-select: none;
  animation: art-in 0.4s ease both;
}
.art {
  width: 100%;
  aspect-ratio: 3 / 2;
  background: currentColor;
  opacity: 0.32;
  -webkit-mask: var(--art) center / contain no-repeat;
  mask: var(--art) center / contain no-repeat;
}
.sm .art { max-width: 200px; }
.md .art { max-width: 300px; }
.lg .art { max-width: min(560px, 70%); opacity: 0.22; }
.text { font-size: 13px; }
.sm .text { font-size: 12px; }
@keyframes art-in {
  from { opacity: 0; transform: translateY(4px); }
}
@media (prefers-reduced-motion: reduce) {
  .empty-art { animation: none; }
}
</style>
