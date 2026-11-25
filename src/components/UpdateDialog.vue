<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { openUrl } from '@tauri-apps/plugin-opener'
import { rehypeSafe } from '../safeHtml'
import { closeUpdate, installUpdate, restartNow, skipVersion, updateState as u } from '../updater'

// 更新说明来自网络，按不可信内容处理：不加载远程图片，去掉危险链接
const html = computed(() =>
  u.notes ? String(unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSafe, { remoteImages: false }).use(rehypeStringify).processSync(u.notes)) : '',
)
const percent = computed(() => (u.progress === null ? null : Math.round(u.progress * 100)))

function onNotesClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) openUrl(href)
}
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeUpdate()
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="sheet-backdrop" @mousedown.self="closeUpdate">
    <div class="sheet update-sheet">
      <h3 v-if="u.phase === 'news'">{{ $t('已更新到 {v}', { v: u.version }) }}</h3>
      <h3 v-else-if="u.phase === 'installed'">{{ $t('{v} 已安装', { v: u.version }) }}</h3>
      <h3 v-else>{{ $t('发现新版本 {v}', { v: u.version }) }}</h3>
      <p v-if="u.phase === 'news'" class="update-sub">{{ $t('这个版本的更新内容：') }}</p>
      <p v-else-if="u.phase === 'installed'" class="update-sub">{{ $t('重新启动后生效。现在不重启也可以，下次打开就是新版本。') }}</p>
      <p v-else class="update-sub">{{ $t('当前版本是 {v}。更新包会校验签名后再安装。', { v: u.current }) }}</p>

      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="html" class="update-notes selectable" @click="onNotesClick" v-html="html" />
      <p v-else class="update-notes empty">{{ $t('这个版本没有附带说明。') }}</p>

      <div v-if="u.phase === 'downloading'" class="update-progress">
        <div class="bar"><i :class="{ unknown: percent === null }" :style="percent === null ? {} : { width: percent + '%' }" /></div>
        <span>{{ percent === null ? $t('正在下载…') : $t('正在下载 {n}%', { n: percent }) }}</span>
      </div>
      <p v-if="u.error" class="update-error selectable">{{ $t('更新失败：{e}', { e: u.error }) }}</p>

      <div class="row end update-actions">
        <template v-if="u.phase === 'news'">
          <button class="btn primary" @click="closeUpdate">{{ $t('知道了') }}</button>
        </template>
        <template v-else-if="u.phase === 'installed'">
          <button class="btn" @click="closeUpdate">{{ $t('稍后重启') }}</button>
          <button class="btn primary" @click="restartNow">{{ $t('立即重启') }}</button>
        </template>
        <template v-else>
          <button class="btn skip" :disabled="u.phase === 'downloading'" @click="skipVersion">{{ $t('跳过这个版本') }}</button>
          <span class="spacer" />
          <button class="btn" :disabled="u.phase === 'downloading'" @click="closeUpdate">{{ $t('稍后') }}</button>
          <button class="btn primary" :disabled="u.phase === 'downloading'" @click="installUpdate">{{ u.error ? $t('重试') : $t('下载并安装') }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style>
.update-sheet { width: 560px; }
.update-sheet > h3 { font-size: 16px; margin: 0; }
.update-sub { margin: 4px 0 10px; font-size: 13px; color: var(--text-2); }
.update-notes { max-height: 46vh; overflow-y: auto; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 13.5px; line-height: 1.6; background: var(--bg-editor); }
.update-notes.empty { color: var(--text-2); }
.update-notes h1, .update-notes h2, .update-notes h3, .update-notes h4 { font-size: 13.5px; font-weight: 600; margin: 14px 0 4px; }
.update-notes > :first-child { margin-top: 0; }
.update-notes > :last-child { margin-bottom: 0; }
.update-notes p { margin: 0 0 6px; }
.update-notes ul, .update-notes ol { margin: 0 0 6px; padding-left: 1.3em; }
.update-notes li { margin: 3px 0; }
.update-notes li > p { margin: 0; }
.update-notes code { padding: 1px 4px; border-radius: 4px; font: 12px ui-monospace, 'SF Mono', Menlo, monospace; background: var(--code-bg, var(--selected)); }
.update-notes a { color: var(--accent); cursor: pointer; }
.update-progress { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 12.5px; color: var(--text-2); }
.update-progress .bar { flex: 1; height: 6px; border-radius: 3px; background: var(--selected); overflow: hidden; }
.update-progress .bar i { display: block; height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.2s; }
.update-progress .bar i.unknown { width: 35%; animation: update-slide 1.2s ease-in-out infinite alternate; }
@keyframes update-slide { from { margin-left: 0; } to { margin-left: 65%; } }
.update-progress span { white-space: nowrap; min-width: 92px; text-align: right; }
.update-error { margin: 10px 0 0; font-size: 12.5px; color: var(--accent); word-break: break-word; }
.update-actions { margin-top: 14px; }
.update-actions .skip { color: var(--text-2); }
</style>
