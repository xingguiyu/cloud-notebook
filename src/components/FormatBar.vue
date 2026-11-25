<script setup lang="ts">
import { nextTick, ref } from 'vue'
import {
  Bold, Code, Heading, Image, Italic, Link, List, ListOrdered, ListTodo,
  Minus, Quote, SquareCode, Strikethrough, Table, X,
} from 'lucide-vue-next'
import { popupMenu } from '../native/menu'
import { t } from '../i18n'
import type { FormatCommand } from './MarkdownEditor.vue'

const emit = defineEmits<{ exec: [FormatCommand]; link: [string]; image: [] }>()

const linking = ref(false)
const href = ref('')
const linkInput = ref<HTMLInputElement>()

function headingMenu() {
  popupMenu([
    ...([1, 2, 3, 4, 5, 6] as const).map((l) => ({ text: t('标题 {n}　⌘{n}', { n: l }), action: () => emit('exec', `h${l}`) })),
    '-',
    { text: t('正文　⌘0'), action: () => emit('exec', 'paragraph') },
  ])
}

function startLink() {
  linking.value = true
  href.value = ''
  nextTick(() => linkInput.value?.focus())
}
function commitLink() {
  const url = href.value.trim()
  linking.value = false
  if (url) emit('link', /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`)
}

// 按钮按下时不抢编辑器焦点，否则选区会丢失
const keep = (e: MouseEvent) => e.preventDefault()
</script>

<template>
  <div class="format-bar" @mousedown="keep">
    <template v-if="!linking">
      <button :title="$t('标题||格式')" @click="headingMenu"><Heading :size="16" /></button>
      <span class="sep" />
      <button :title="$t('待办')" @click="emit('exec', 'todo')"><ListTodo :size="16" /></button>
      <button :title="$t('无序列表')" @click="emit('exec', 'bullet')"><List :size="16" /></button>
      <button :title="$t('有序列表')" @click="emit('exec', 'ordered')"><ListOrdered :size="16" /></button>
      <span class="sep" />
      <button :title="$t('粗体 ⌘B')" @click="emit('exec', 'bold')"><Bold :size="16" /></button>
      <button :title="$t('斜体 ⌘I')" @click="emit('exec', 'italic')"><Italic :size="16" /></button>
      <button :title="$t('删除线')" @click="emit('exec', 'strike')"><Strikethrough :size="16" /></button>
      <button :title="$t('行内代码')" @click="emit('exec', 'code')"><Code :size="16" /></button>
      <span class="sep" />
      <button :title="$t('链接')" @click="startLink"><Link :size="16" /></button>
      <button :title="$t('引用')" @click="emit('exec', 'quote')"><Quote :size="16" /></button>
      <button :title="$t('代码块')" @click="emit('exec', 'codeblock')"><SquareCode :size="16" /></button>
      <button :title="$t('表格')" @click="emit('exec', 'table')"><Table :size="16" /></button>
      <button :title="$t('插入图片')" @click="emit('image')"><Image :size="16" /></button>
      <button :title="$t('分隔线')" @click="emit('exec', 'hr')"><Minus :size="16" /></button>
    </template>
    <template v-else>
      <Link :size="15" class="muted" />
      <input
        ref="linkInput"
        v-model="href"
        class="link-input"
        :placeholder="$t('输入链接地址，回车确认')"
        @mousedown.stop
        @keydown.enter="commitLink"
        @keydown.esc="linking = false"
        @blur="linking = false"
      />
      <button :title="$t('取消')" @click="linking = false"><X :size="15" /></button>
    </template>
  </div>
</template>

<style>
.format-bar {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 38px;
  padding: 0 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-editor) 88%, transparent);
  backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid var(--border);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  color: var(--text-2);
  opacity: 0.55;
  transition: opacity 0.15s;
}
.format-bar:hover,
.format-bar:focus-within {
  opacity: 1;
}
.format-bar button {
  width: 30px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
}
.format-bar button:hover {
  background: var(--selected);
  color: var(--text);
}
.format-bar .sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}
.format-bar .link-input {
  width: 300px;
  height: 26px;
  margin: 0 6px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: 13px var(--font-ui);
}
.format-bar .muted {
  margin-left: 6px;
}
</style>
