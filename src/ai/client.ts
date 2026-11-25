import Anthropic from '@anthropic-ai/sdk'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Chunk } from './retrieve'
import { parseModelRef, providerById } from './providers'
import { prefs } from '../prefs'
import { t } from '../i18n'

export const AI_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', desc: t('最强，回答最细致（默认）') },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', desc: t('更快，日常问答足够') },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', desc: t('最快最便宜，适合简单任务') },
] as const

let client: Anthropic | null = null

async function getClient() {
  if (client) return client
  const apiKey = await invoke<string>('ai_get_key')
  // 桌面应用里，Key 由用户自己提供并存在本机钥匙串，只在本机直连 Anthropic
  client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  return client
}
/** 换了 Key 后丢弃旧客户端 */
export function resetClient() {
  client = null
}

export interface Source {
  /** 来自笔记时是笔记路径；来自附件（PDF）时为空 */
  path: string | null
  title: string
  heading: string
}

/** 对话里附加的图片或 PDF */
export interface AiAttachment {
  kind: 'image' | 'pdf'
  name: string
  media_type: string
  data: string // base64
}

export interface AskInput {
  question: string
  model: string
  /** 作为资料提供给模型的笔记片段，回答时可以引用 */
  chunks: Chunk[]
  /** 用户在编辑器里选中的文字 */
  selection?: string
  /** 用户附加的图片 / PDF */
  attachments?: AiAttachment[]
  /** 当前笔记里的图片（选「当前笔记」范围时） */
  noteImages?: { name: string; media_type: string; data: string }[]
  /** 之前的问答（纯文本，不重复发送资料） */
  history: { role: 'user' | 'assistant'; text: string }[]
  signal?: AbortSignal
}

export interface AskResult {
  /** 带 [n] 引用标记的回答 */
  text: string
  sources: Source[]
  servedBy: string
}

const SYSTEM = [
  t('你是 Cloud Notebook 笔记应用里的助手，帮用户基于他们自己的笔记回答问题、整理和写作。'),
  '',
  t('- 用户消息里可能附带若干笔记片段（文档）。问题和这些笔记相关时，以笔记内容为依据回答，并引用对应片段。'),
  t('- 笔记里找不到答案时，直接说明「笔记里没有提到」，再视情况用你的通用知识补充，并明确区分哪些来自笔记、哪些是你的补充。'),
  t('- 用户选中了文字时，问题通常是针对这段文字的（总结、改写、续写、解释等）。'),
  t('- 用户可能附上图片、PDF，或笔记里的图片；问题提到「图」「截图」「附件」时，以这些内容为依据。'),
  t('- 用和用户相同的语言回答，用 Markdown 排版，简洁直接，不要寒暄。'),
].join('\n')

function documents(chunks: Chunk[]): Anthropic.Beta.BetaRequestDocumentBlock[] {
  return chunks.map((c) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: c.text },
    title: c.heading === c.title ? c.title : `${c.title} › ${c.heading.split(' › ').slice(1).join(' › ') || c.heading}`,
    context: t('笔记路径：{path}', { path: c.path }),
    citations: { enabled: true },
  }))
}

/** 流式提问。按模型所属服务商分发；onText 收到逐字输出，结束后返回带 [n] 引用标记的完整回答 */
export async function ask(input: AskInput, onText: (snapshot: string) => void): Promise<AskResult> {
  const { provider, model } = parseModelRef(input.model)
  if (provider === 'anthropic') return askAnthropic({ ...input, model }, onText)
  return askOpenAICompatible(provider, { ...input, model }, onText)
}

async function askAnthropic(input: AskInput, onText: (snapshot: string) => void): Promise<AskResult> {
  const c = await getClient()
  const messages: Anthropic.Beta.BetaMessageParam[] = input.history.map((h) => ({ role: h.role, content: h.text }))
  // 可引用的文档：先是笔记片段，再是附加的 PDF；引用编号按这个顺序对应
  const pdfs = (input.attachments ?? []).filter((a) => a.kind === 'pdf')
  const docMeta: Source[] = [
    ...input.chunks.map((c) => ({ path: c.path, title: c.title, heading: c.heading })),
    ...pdfs.map((a) => ({ path: null, title: a.name, heading: a.name })),
  ]
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...documents(input.chunks),
    ...pdfs.map(
      (a): Anthropic.Beta.BetaRequestDocumentBlock => ({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: a.data },
        title: a.name,
        citations: { enabled: true },
      }),
    ),
  ]
  for (const img of input.noteImages ?? []) {
    content.push({ type: 'text', text: t('笔记中的图片：{name}', { name: img.name }) })
    content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type as 'image/png', data: img.data } })
  }
  for (const a of (input.attachments ?? []).filter((x) => x.kind === 'image')) {
    content.push({ type: 'text', text: t('我附上的图片：{name}', { name: a.name }) })
    content.push({ type: 'image', source: { type: 'base64', media_type: a.media_type as 'image/png', data: a.data } })
  }
  if (input.selection?.trim()) content.push({ type: 'text', text: t('我在笔记里选中的文字：\n\n{text}', { text: input.selection.trim() }) })
  content.push({ type: 'text', text: input.question })
  messages.push({ role: 'user', content })

  // Opus / Sonnet 开启服务端拒答兜底：被安全策略误拒时自动换备用模型回答；Haiku 不支持
  const fallback = input.model.includes('haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }

  const stream = c.beta.messages.stream(
    {
      model: input.model,
      max_tokens: 16000,
      system: SYSTEM,
      messages,
      output_config: { effort: 'medium' },
      ...fallback,
    },
    { signal: input.signal },
  )
  stream.on('text', (_delta, snapshot) => onText(snapshot))
  const msg = await stream.finalMessage()

  if (msg.stop_reason === 'refusal') throw new Error(t('这个问题被模型拒绝回答了，换个问法试试。'))

  // 把引用转成 [n] 标记；n 对应 sources 的序号（从 1 开始），同一片段复用同一个编号
  const sources: Source[] = []
  const numberOf = new Map<number, number>()
  let text = ''
  for (const block of msg.content) {
    if (block.type !== 'text') continue
    text += block.text
    const marks = new Set<number>()
    for (const cit of block.citations ?? []) {
      if (!('document_index' in cit)) continue
      const di = cit.document_index
      if (!numberOf.has(di)) {
        const meta = docMeta[di]
        if (!meta) continue
        sources.push(meta)
        numberOf.set(di, sources.length)
      }
      marks.add(numberOf.get(di)!)
    }
    if (marks.size) text += [...marks].map((n) => `[${n}]`).join('')
  }
  if (msg.stop_reason === 'max_tokens') text += '\n\n' + t('（回答太长，已截断）')
  return { text, sources, servedBy: msg.model }
}

/** SDK 错误 → 能看懂的提示 */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return t('API Key 无效或已被撤销，请在「设置 → AI」里重新填写。')
  if (e instanceof Anthropic.PermissionDeniedError) return t('这个 API Key 没有调用该模型的权限。')
  if (e instanceof Anthropic.RateLimitError) return t('请求太频繁或额度用完了，请稍后再试，或检查 Anthropic 控制台里的用量。')
  if (e instanceof Anthropic.BadRequestError) return t('请求有误：{message}', { message: e.message })
  if (e instanceof Anthropic.APIConnectionError) return t('连不上 Anthropic 服务器，请检查网络或代理设置。')
  if (e instanceof Anthropic.APIError) return t('AI 服务出错（{status}）：{message}', { status: e.status ?? '', message: e.message })
  if (e instanceof Error && e.name === 'AbortError') return t('已停止')
  return String(e instanceof Error ? e.message : e)
}

// ---------------- OpenAI 兼容服务（OpenAI / Gemini / Grok / DeepSeek / 通义 / OpenHubs / 自定义） ----------------

const CITE_RULES = '\n' + t('- 资料按 [1]、[2] 编号给出。引用资料时，在相应句子末尾标注编号，如「……[2]」；只使用给出的编号，不要编造。')

export function baseUrlOf(provider: string) {
  // 只有允许改地址的服务商（自建、中转）才用用户填的地址；官方服务商固定用内置地址，Key 不会被发到别处
  const p = providerById(provider)
  return (p?.editableBase ? prefs.aiBaseUrls[provider] : '') || p?.baseUrl || ''
}

async function askOpenAICompatible(provider: string, input: AskInput, onText: (snapshot: string) => void): Promise<AskResult> {
  const p = providerById(provider)
  if (!p) throw new Error(t('未知的服务商：{provider}', { provider }))
  const base = baseUrlOf(provider)
  if (!base) throw new Error(t('还没有设置 {name} 的接口地址，请在「设置 → AI」里填写', { name: p.name }))
  if (input.attachments?.some((a) => a.kind === 'pdf')) {
    throw new Error(t('当前模型不支持直接读取 PDF。请切换到 Claude，或把 PDF 里的文字复制进来。'))
  }
  const images = [...(input.noteImages ?? []), ...(input.attachments ?? []).filter((a) => a.kind === 'image')]
  if (images.length && !p.vision) throw new Error(t('{name} 目前不支持图片输入，请切换到其他模型。', { name: p.name }))

  // 资料编号拼进提示词，回答里的 [n] 再对回原片段
  const sourcesText = input.chunks
    .map((c, i) => t('[{n}] 《{heading}》（{path}）\n{text}', { n: i + 1, heading: c.heading, path: c.path, text: c.text }))
    .join('\n\n---\n\n')
  let text = ''
  if (sourcesText) text += t('以下是从我的笔记里找到的资料：\n\n{sources}\n\n', { sources: sourcesText })
  if (input.selection?.trim()) text += t('我在笔记里选中的文字：\n\n{text}', { text: input.selection.trim() }) + '\n\n'
  if (images.length) text += t('附图：{names}', { names: images.map((i) => i.name).join(t('、')) }) + '\n\n'
  text += input.question

  const content = images.length
    ? [{ type: 'text', text }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.media_type};base64,${i.data}` } }))]
    : text
  const body = {
    model: input.model,
    messages: [
      { role: 'system', content: SYSTEM + CITE_RULES },
      ...input.history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content },
    ],
  }

  const id = crypto.randomUUID()
  let out = ''
  let servedBy = input.model
  const finished = new Promise<void>((resolve, reject) => {
    const off = listen<{ id: string; delta?: string; done: boolean; error?: string; model?: string }>('ai-stream', ({ payload }) => {
      if (payload.id !== id) return
      if (payload.delta) {
        out += payload.delta
        if (payload.model && !payload.model.startsWith('custom-model')) servedBy = payload.model
        onText(out)
      }
      if (payload.done) {
        off.then((f) => f())
        payload.error ? reject(new Error(payload.error)) : resolve()
      }
    })
    input.signal?.addEventListener('abort', () => {
      invoke('ai_chat_cancel', { id })
      off.then((f) => f())
      reject(Object.assign(new Error(t('已停止')), { name: 'AbortError' }))
    })
  })
  await invoke('ai_chat_start', { id, provider, baseUrl: base, body })
  await finished

  // 把回答里用到的编号按出现顺序重新编为 1、2、3…，只列出真正引用到的资料
  const renumber = new Map<number, number>()
  const sources: Source[] = []
  const answer = out.replace(/\[(\d+)\]/g, (_all, n) => {
    const ch = input.chunks[Number(n) - 1]
    if (!ch) return ''
    if (!renumber.has(Number(n))) {
      sources.push({ path: ch.path, title: ch.title, heading: ch.heading })
      renumber.set(Number(n), sources.length)
    }
    return `[${renumber.get(Number(n))}]`
  })
  return { text: answer, sources, servedBy }
}
