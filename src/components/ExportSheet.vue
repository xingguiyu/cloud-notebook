<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CloudUpload, FileArchive, FileCode, FileText, FileType, Folder, Loader2, Printer, FileImage } from 'lucide-vue-next'
import { prefs } from '../prefs'
import { DOC_TEMPLATES, documentHtml } from '../docTemplates'
import { renderHtml } from '../export'
import { noteTitle } from '../vault'
import { t } from '../i18n'

const props = defineProps<{ notePath: string; markdown: string }>()
const emit = defineEmits<{ close: []; export: []; print: [] }>()

const FORMATS = [
  { id: 'pdf', label: 'PDF', desc: t('分页排版，适合打印和发送'), icon: FileType },
  { id: 'html', label: 'HTML', desc: t('单个网页文件，图片内嵌'), icon: FileCode },
  { id: 'zip', label: t('Markdown 压缩包'), desc: t('.md + 图片文件夹，打包成 zip'), icon: FileArchive },
  { id: 'md', label: t('Markdown 文件夹'), desc: t('.md + assets/ 图片'), icon: Folder },
  { id: 'inline', label: t('Markdown 单文件'), desc: t('图片转成内嵌数据'), icon: FileImage },
  { id: 'hosted', label: t('Markdown（图床链接）'), desc: t('图片上传到图床，文件最小'), icon: CloudUpload },
  { id: 'docx', label: 'Word', desc: t('通过 Pandoc 转换'), icon: FileText },
] as const

const styled = computed(() => prefs.exportFormat === 'pdf' || prefs.exportFormat === 'html')
const busy = ref(false)

// 用当前笔记实时预览模板效果
const bodyHtml = ref('')
onMounted(async () => {
  bodyHtml.value = await renderHtml(props.markdown, props.notePath)
  window.addEventListener('keydown', onKey)
})
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('close')
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const previewDoc = computed(() =>
  documentHtml(noteTitle(props.notePath, props.markdown), bodyHtml.value, prefs.exportTemplate).replace(
    '</style>',
    // 预览里模拟纸张页边距
    `body{padding:${{ narrow: 36, normal: 56, wide: 80 }[prefs.exportMargin]}px !important;max-width:none}</style>`,
  ),
)
const PAPER_RATIO = { a4: 841.89 / 595.28, letter: 792 / 612, a5: 595.28 / 419.53 }

async function run(kind: 'export' | 'print') {
  busy.value = true
  try {
    if (kind === 'export') emit('export')
    else emit('print')
  } finally {
    setTimeout(() => (busy.value = false), 300)
  }
}
watch(() => prefs.exportFormat, () => (busy.value = false))
</script>

<template>
  <div class="sheet-backdrop" @mousedown.self="emit('close')">
    <div class="sheet export-sheet">
      <div class="export-cols">
        <div class="formats">
          <h3>{{ $t('格式') }}</h3>
          <button
            v-for="f in FORMATS"
            :key="f.id"
            class="format"
            :class="{ active: prefs.exportFormat === f.id }"
            @click="prefs.exportFormat = f.id"
          >
            <component :is="f.icon" :size="18" :stroke-width="1.6" />
            <span class="f-text">
              <b>{{ f.label }}</b>
              <small>{{ f.desc }}</small>
            </span>
          </button>
          <label class="check keep-tags"><input v-model="prefs.exportKeepTags" type="checkbox" /> {{ $t('保留 #标签') }}</label>
        </div>

        <div class="options">
          <template v-if="styled">
            <h3>{{ $t('模板') }}</h3>
            <div class="templates">
              <button
                v-for="t in DOC_TEMPLATES"
                :key="t.id"
                class="tpl"
                :class="{ active: prefs.exportTemplate === t.id }"
                :title="t.desc"
                @click="prefs.exportTemplate = t.id"
              >
                {{ t.name }}
              </button>
            </div>
            <div v-if="prefs.exportFormat === 'pdf'" class="paper-row">
              <label>{{ $t('纸张') }}</label>
              <select v-model="prefs.exportPaper" class="select">
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
                <option value="a5">A5</option>
              </select>
              <label>{{ $t('页边距') }}</label>
              <select v-model="prefs.exportMargin" class="select">
                <option value="narrow">{{ $t('窄') }}</option>
                <option value="normal">{{ $t('标准') }}</option>
                <option value="wide">{{ $t('宽') }}</option>
              </select>
            </div>
            <div class="preview-wrap">
              <div
                class="paper"
                :style="{ aspectRatio: prefs.exportFormat === 'pdf' ? `1 / ${PAPER_RATIO[prefs.exportPaper]}` : '1 / 1.3' }"
              >
                <iframe :srcdoc="previewDoc" sandbox="" tabindex="-1" />
              </div>
            </div>
          </template>
          <div v-else class="plain-hint">
            <component :is="FORMATS.find((f) => f.id === prefs.exportFormat)!.icon" :size="40" :stroke-width="1.2" />
            <p>{{ FORMATS.find((f) => f.id === prefs.exportFormat)!.desc }}</p>
            <p class="hint">{{ $t('本地图片会一起导出，发给别人也能看到。') }}</p>
          </div>
        </div>
      </div>

      <div class="row end footer">
        <button v-if="prefs.exportFormat === 'pdf'" class="btn print-btn" :disabled="busy" @click="run('print')">
          <Printer :size="14" /> {{ $t('打印…') }}
        </button>
        <span class="spacer" />
        <button class="btn" @click="emit('close')">{{ $t('取消') }}</button>
        <button class="btn primary" :disabled="busy" @click="run('export')">
          <Loader2 v-if="busy" :size="14" class="spin" /> {{ $t('导出…') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style>
.export-sheet {
  width: 760px;
}
.export-cols {
  display: grid;
  grid-template-columns: 250px 1fr;
  gap: 20px;
}
.formats {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.format {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  text-align: left;
  color: var(--text-2);
}
.format:hover {
  background: var(--selected);
}
.format.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.f-text {
  display: flex;
  flex-direction: column;
}
.f-text b {
  font-size: 13px;
  color: var(--text);
}
.f-text small {
  font-size: 11px;
  color: var(--text-2);
}
.keep-tags {
  margin-top: 12px !important;
  padding-left: 10px;
}
.templates {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.tpl {
  padding: 5px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--text-2);
}
.tpl.active {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.paper-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text-2);
}
.paper-row label + .select {
  margin-right: 10px;
}
.preview-wrap {
  height: 340px;
  display: flex;
  justify-content: center;
  padding: 12px;
  border-radius: 10px;
  background: var(--selected);
}
.paper {
  height: 100%;
  background: #fff;
  border-radius: 3px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  position: relative;
}
/* 按纸张宽度（约 595pt）渲染，再缩小显示 */
.paper iframe {
  position: absolute;
  inset: 0;
  width: 400%;
  height: 400%;
  border: 0;
  transform: scale(0.25);
  transform-origin: 0 0;
  pointer-events: none;
}
.plain-hint {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  text-align: center;
}
.plain-hint p {
  margin: 8px 0 0;
}
.print-btn,
.footer .btn.primary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
