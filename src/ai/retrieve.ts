/**
 * 本地关键词检索（BM25），给 AI 问答挑选相关笔记片段。
 * 不依赖向量模型，离线可用；中文按相邻两字切词，英文按单词，足够应付个人笔记库。
 */

export interface Chunk {
  path: string
  title: string
  /** 片段所在的标题路径，如「项目复盘 › 数据」 */
  heading: string
  text: string
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/

/** 中文二元组 + 英文单词，统一小写 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+|[㐀-䶿一-鿿豈-﫿]+/g)) {
    const w = m[0]
    if (!CJK.test(w)) {
      if (w.length > 1) out.push(w)
      continue
    }
    if (w.length === 1) out.push(w)
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
  }
  return out
}

const MAX_CHUNK = 1200

/** 按标题切段；过长的段落再按空行切开 */
export function chunkNote(path: string, title: string, md: string): Chunk[] {
  const chunks: Chunk[] = []
  const stack: string[] = []
  let buf: string[] = []
  let inCode = false
  const flush = () => {
    const text = buf.join('\n').trim()
    buf = []
    if (!text) return
    const heading = stack.filter(Boolean).join(' › ') || title
    if (text.length <= MAX_CHUNK) return void chunks.push({ path, title, heading, text })
    let part = ''
    for (const para of text.split(/\n\s*\n/)) {
      if (part && part.length + para.length > MAX_CHUNK) {
        chunks.push({ path, title, heading, text: part.trim() })
        part = ''
      }
      part += para + '\n\n'
    }
    if (part.trim()) chunks.push({ path, title, heading, text: part.trim() })
  }
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) inCode = !inCode
    const h = !inCode && line.match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      flush()
      stack.length = h[1].length - 1
      stack[h[1].length - 1] = h[2].trim()
    }
    buf.push(line)
  }
  flush()
  return chunks
}

export interface Index {
  chunks: Chunk[]
  tf: Map<string, number>[]
  len: number[]
  df: Map<string, number>
  avgLen: number
}

export function buildIndex(chunks: Chunk[]): Index {
  const tf: Map<string, number>[] = []
  const len: number[] = []
  const df = new Map<string, number>()
  for (const c of chunks) {
    // 标题和小节名也参与匹配，权重加倍
    const toks = [...tokenize(c.text), ...tokenize(`${c.title} ${c.heading}`), ...tokenize(`${c.title} ${c.heading}`)]
    const m = new Map<string, number>()
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1)
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    tf.push(m)
    len.push(toks.length)
  }
  const avgLen = len.reduce((a, b) => a + b, 0) / Math.max(1, len.length)
  return { chunks, tf, len, df, avgLen }
}

/** BM25 打分，返回得分最高的若干片段（同一篇笔记最多取 maxPerNote 段） */
export function search(index: Index, query: string, k = 8, maxPerNote = 3): Chunk[] {
  const q = [...new Set(tokenize(query))]
  if (!q.length) return []
  const N = index.chunks.length
  const k1 = 1.4
  const b = 0.75
  const scored: { i: number; s: number }[] = []
  index.tf.forEach((m, i) => {
    let s = 0
    for (const t of q) {
      const f = m.get(t)
      if (!f) continue
      const df = index.df.get(t) ?? 0
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.len[i]) / index.avgLen))
    }
    if (s > 0) scored.push({ i, s })
  })
  scored.sort((a, b) => b.s - a.s)
  const perNote = new Map<string, number>()
  const out: Chunk[] = []
  for (const { i } of scored) {
    const c = index.chunks[i]
    const n = perNote.get(c.path) ?? 0
    if (n >= maxPerNote) continue
    perNote.set(c.path, n + 1)
    out.push(c)
    if (out.length >= k) break
  }
  return out
}
