/**
 * PDF 处理：拆页、渲染成图片、取每页文字（有文字层直接用，扫描件走本机文字识别）。
 * pdf.js 体积较大，只在用到 PDF 时才加载。
 */
import { recognize, type OcrLine } from './ocr'
import { t } from '../i18n'

export interface PdfPage {
  index: number
  image: File
  /** 这一页的文字行（文字层或识别结果） */
  lines: OcrLine[]
}

let loading: ReturnType<typeof load> | null = null
const lib = () => (loading ??= load())
export const preload = () => void lib().catch(() => (loading = null))

async function load() {
  const pdfjs = await import('pdfjs-dist')
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = worker
  return pdfjs
}

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)

/** 渲染所有页（长边约 2000 像素，足够看清证件、也够识别），并取文字 */
export async function splitPdf(
  file: File,
  onProgress?: (done: number, total: number) => void,
  withText = true,
  latin = false,
): Promise<PdfPage[]> {
  const pdfjs = await lib()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const base = file.name.replace(/\.pdf$/i, '')
  const pages: PdfPage[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const v1 = page.getViewport({ scale: 1 })
      const scale = Math.min(3, 2000 / Math.max(v1.width, v1.height))
      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.88))
      const image = new File([blob], t('{base} 第{n}页', { base, n: i }) + '.jpg', { type: 'image/jpeg' })

      // 文字层：电子版 PDF 直接有字，按行拼起来；扫描件没有就识别图片
      let lines: OcrLine[] = []
      if (withText) {
        const tc = await page.getTextContent()
        lines = textLayerLines(tc.items as { str: string; transform: number[]; height: number }[], v1.height)
        if (lines.map((l) => l.text).join('').replace(/\s/g, '').length < 10) lines = await recognize(image, latin).catch((e) => (console.warn('第', i, '页识别失败', e), lines))
      }
      pages.push({ index: i, image, lines })
      canvas.width = canvas.height = 0
      onProgress?.(i, doc.numPages)
    }
  } finally {
    doc.destroy()
  }
  return pages
}

/** pdf.js 的文字块按纵坐标归成行 */
function textLayerLines(items: { str: string; transform: number[]; height: number }[], pageH: number): OcrLine[] {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = []
  for (const it of items) {
    if (!it.str.trim()) continue
    const x = it.transform[4]
    const y = pageH - it.transform[5]
    const tol = Math.max(3, (it.height || 10) * 0.5)
    let row = rows.find((r) => Math.abs(r.y - y) < tol)
    if (!row) rows.push((row = { y, parts: [] }))
    row.parts.push({ x, s: it.str })
  }
  return rows
    .sort((a, b) => a.y - b.y)
    .map((r) => ({ text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' '), x: 0, y: r.y / pageH, w: 1, h: 0 }))
}

// ---------------- 户口簿：按内容认页 ----------------

export interface HouseholdPage {
  kind: 'cover' | 'head' | 'member' | 'other'
  /** 成员页上的姓名 */
  name?: string
}

export function classifyHousehold(lines: OcrLine[]): HouseholdPage {
  const text = lines.map((l) => l.text).join('\n').normalize('NFKC')
  const flat = text.replace(/\s/g, '')
  const isCard = /常住人口登记卡/.test(flat) || (/与户主关系/.test(flat) && /(公民身份|身份证)/.test(flat))
  if (isCard) {
    const name = flat.match(/姓名[:：]?([一-龥·]{2,6}?)(?=户主|与户主|曾用名|性别|$)/)?.[1]
    const rel = flat.match(/与户主关系[:：]?(\S{1,4}?)(?=曾用名|性别|姓名|出生|民族|$)/)?.[1] ?? ''
    return { kind: rel.startsWith('户主') ? 'head' : 'member', name }
  }
  if (/户别/.test(flat) && /(户主姓名|户号)/.test(flat)) return { kind: 'cover' }
  return { kind: 'other' }
}

/** 只取 PDF 文字层（前 3 页），不渲染、不识别：用来判断是不是发票、合同 */
export async function pdfText(file: File, maxPages = 3) {
  const pdfjs = await lib()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  try {
    const out: string[] = []
    for (let i = 1; i <= Math.min(maxPages, doc.numPages); i++) {
      const page = await doc.getPage(i)
      const v1 = page.getViewport({ scale: 1 })
      const tc = await page.getTextContent()
      out.push(textLayerLines(tc.items as { str: string; transform: number[]; height: number }[], v1.height).map((l) => l.text).join('\n'))
    }
    return out.join('\n')
  } finally {
    doc.destroy()
  }
}
