/**
 * 支持的模型服务商。Claude 走 Anthropic 官方 SDK（原生引用、PDF）；
 * 其余都是 OpenAI 兼容接口，请求由 Rust 端发出（避开跨域，Key 不经过前端）。
 * 模型列表从各家 /models 接口动态获取，不在代码里写死。
 */
import { t } from '../i18n'

export interface Provider {
  id: string
  name: string
  kind: 'anthropic' | 'openai'
  /** 默认接口地址（OpenAI 兼容服务） */
  baseUrl: string
  /** 允许用户修改接口地址（区域节点、自建、聚合服务） */
  editableBase: boolean
  keyUrl?: string
  hint?: string
  /** 是否支持图片输入；具体到模型以服务商为准 */
  vision: boolean
}

export const PROVIDERS: Provider[] = [
  { id: 'anthropic', name: t('Claude（Anthropic）'), kind: 'anthropic', baseUrl: '', editableBase: false, keyUrl: 'https://console.anthropic.com/settings/keys', vision: true, hint: t('支持原文引用和直接读取 PDF，效果最好。') },
  { id: 'openhubs', name: 'OpenHubs', kind: 'openai', baseUrl: 'https://openhubs.fantasticfusion.ai/v1', editableBase: true, keyUrl: 'https://openhubs.fantasticfusion.ai/console/api-keys', vision: true, hint: t('一个 Key 调用 Claude、GPT、Gemini 等多家模型。可用模型见控制台「模型广场」。') },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', editableBase: false, keyUrl: 'https://platform.openai.com/api-keys', vision: true },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', editableBase: false, keyUrl: 'https://aistudio.google.com/apikey', vision: true },
  { id: 'grok', name: 'xAI Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1', editableBase: false, keyUrl: 'https://console.x.ai', vision: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', editableBase: false, keyUrl: 'https://platform.deepseek.com/api_keys', vision: false, hint: t('国内可直连。目前不支持图片输入。') },
  { id: 'qwen', name: t('通义千问（阿里云百炼）'), kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', editableBase: true, keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1', vision: true, hint: t('国内可直连。国际站请把地址改成 dashscope-intl.aliyuncs.com。图片需选带 vl 的模型。') },
  { id: 'custom', name: t('自定义（OpenAI 兼容）'), kind: 'openai', baseUrl: 'http://localhost:11434/v1', editableBase: true, vision: true, hint: t('任何兼容 OpenAI 接口的服务，例如本机的 Ollama、LM Studio。') },
]

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id)

/** 模型引用写成「服务商:模型」，如 `deepseek:deepseek-chat` */
export function parseModelRef(ref: string) {
  const i = ref.indexOf(':')
  return i < 0 ? { provider: 'anthropic', model: ref } : { provider: ref.slice(0, i), model: ref.slice(i + 1) }
}
