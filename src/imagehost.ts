import { invoke } from '@tauri-apps/api/core'
import { isRemote, resolveVaultPath } from './vault'
import { t } from './i18n'

export interface ImageHostConfig {
  provider: string
  endpoint: string
  region: string
  bucket: string
  access_key_id: string
  prefix: string
  public_base_url: string
  path_style: boolean
}
export interface ImageHostStatus {
  config: ImageHostConfig
  has_secret: boolean
  configured: boolean
}

/** 常见服务的预设：选中后自动填好 Endpoint 格式、区域和地址风格 */
export const PROVIDERS = [
  { id: 'r2', name: 'Cloudflare R2', endpoint: t('https://<账号ID>.r2.cloudflarestorage.com'), region: 'auto', pathStyle: true, hint: t('外网流量免费。需在 R2 里开启公开访问（r2.dev 或自定义域名），填到「公开访问地址」。') },
  { id: 's3', name: 'AWS S3', endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', pathStyle: false, hint: t('Endpoint 里的区域要和存储桶所在区域一致。') },
  { id: 'oss', name: t('阿里云 OSS'), endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', pathStyle: false, hint: t('把 Endpoint 换成存储桶所在地域；存储桶需设为公共读，或绑定 CDN 域名。') },
  { id: 'cos', name: t('腾讯云 COS'), endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou', pathStyle: false, hint: t('存储桶名称包含 APPID，形如 notes-1250000000。') },
  { id: 'custom', name: t('其他 S3 兼容服务'), endpoint: '', region: 'us-east-1', pathStyle: true, hint: t('MinIO 等自建服务一般使用路径风格。') },
] as const

export const imageHost = {
  status: () => invoke<ImageHostStatus>('imagehost_status'),
  save: (config: ImageHostConfig, secret?: string) => invoke<void>('imagehost_save', { config, secret }),
  clear: () => invoke<void>('imagehost_clear'),
  test: () => invoke<string>('imagehost_test'),
  upload: (paths: string[]) => invoke<Record<string, string>>('imagehost_upload', { paths }),
}

const IMG_RE = /(!\[[^\]]*\]\(\s*)(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\s*\))/g

/** 上传笔记引用的本地图片，返回把图片换成网络地址后的 Markdown */
export async function withHostedImages(md: string, notePath: string) {
  const local = new Map<string, string>() // 原 src → 笔记库路径
  for (const m of md.matchAll(IMG_RE)) {
    const src = m[2].replace(/^<|>$/g, '')
    if (src && !isRemote(src)) local.set(src, resolveVaultPath(notePath, src))
  }
  if (!local.size) return md
  const urls = await imageHost.upload([...new Set(local.values())])
  return md.replace(IMG_RE, (all, pre: string, raw: string, post: string) => {
    const url = urls[local.get(raw.replace(/^<|>$/g, '')) ?? '']
    return url ? `${pre}${url}${post}` : all
  })
}
