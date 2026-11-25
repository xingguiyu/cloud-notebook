/**
 * 项目文件：拖进来的证书、密钥、描述文件、发票……认出是什么，读出能读的信息（有效期、Key ID、Team ID 等）。
 * 全部在本机解析。
 */
import { invoke } from '@tauri-apps/api/core'
import { t } from '../i18n'

export interface Inspected {
  type: string
  title: string
  fields: Record<string, string>
  /** 需要用户补充才能读完的提示，如 p12 要密码 */
  note?: string
}

interface CertInfo {
  kind: string
  subject: string
  issuer: string
  serial: string
  issued: string
  expires: string
  team: string
  has_key: boolean
}

const ext = (name: string) => name.split('.').pop()!.toLowerCase()
const base = (name: string) => name.replace(/\.[^.]+$/, '')

export function inspectCert(file: File | ArrayBuffer, p12 = false, password = '') {
  return (async () =>
    invoke<CertInfo>('cert_inspect', new Uint8Array(file instanceof File ? await file.arrayBuffer() : file), {
      headers: { 'x-kind': p12 ? 'p12' : 'cert', 'x-password': encodeURIComponent(password) },
    }))()
}

/** 证书类型的显示文字：带私钥的加上说明 */
export const certKind = (c: { kind: string; has_key: boolean }) => (c.has_key ? t('{kind}（含私钥）', { kind: c.kind }) : c.kind)

/** p12 有密码、还读不出内容时写进备注的提示（填了密码读出信息后会清掉） */
export const P12_NOTE = t('这个 p12 有密码：编辑时填上「证书密码」，保存后会读出有效期等信息')

function certFields(c: CertInfo): Record<string, string> {
  return { kind: certKind(c), subject: c.subject, issuer: c.issuer, serial: c.serial, issued: c.issued, expires: c.expires, team: c.team }
}

const textOf = async (f: File, max = 2 << 20) => (f.size > max ? '' : new TextDecoder('utf-8', { fatal: false }).decode(await f.arrayBuffer()))

/** 描述文件是签名过的 plist，中间那段 XML 是明文 */
export function parseProvision(raw: string): Record<string, string> {
  const xml = raw.slice(raw.indexOf('<?xml'), raw.indexOf('</plist>') + 8)
  const str = (k: string) => xml.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? ''
  const date = (k: string) => xml.match(new RegExp(`<key>${k}</key>\\s*<date>(\\d{4}-\\d{2}-\\d{2})`))?.[1] ?? ''
  const arr = (k: string) => xml.match(new RegExp(`<key>${k}</key>\\s*<array>\\s*<string>([^<]*)</string>`))?.[1] ?? ''
  const appId = xml.match(/<key>(?:application-identifier|com\.apple\.application-identifier)<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? ''
  const prefix = arr('ApplicationIdentifierPrefix')
  const hasDevices = /<key>ProvisionedDevices<\/key>/.test(xml)
  const allDevices = /<key>ProvisionsAllDevices<\/key>\s*<true\/>/.test(xml)
  const getTask = /<key>get-task-allow<\/key>\s*<true\/>/.test(xml)
  const kind = allDevices ? t('企业分发') : hasDevices ? (getTask ? t('开发') : 'Ad Hoc') : 'App Store'
  const team = [str('TeamName'), arr('TeamIdentifier')].filter(Boolean).join(' · ')
  return {
    name: str('Name'),
    kind: /macOS|OSX/i.test(arr('Platform')) ? t('{kind}（macOS）', { kind }) : kind,
    appId: prefix && appId.startsWith(prefix + '.') ? appId.slice(prefix.length + 1) : appId,
    team,
    uuid: str('UUID'),
    issued: date('CreationDate'),
    expires: date('ExpirationDate'),
  }
}

/** 电子发票（PDF 文字层 / OFD 里的文字）里认出发票号码、日期、金额、双方 */
export function parseInvoice(text: string): Record<string, string> {
  const t = text.normalize('NFKC').replace(/[ \t]+/g, ' ')
  const flat = t.replace(/\s/g, '')
  const f: Record<string, string> = {}
  const num = flat.match(/发票号码[:：]?(\d{8,20})/)
  if (num) f.number = num[1]
  const d = flat.match(/开票日期[:：]?(\d{4})年(\d{1,2})月(\d{1,2})日/) ?? flat.match(/开票日期[:：]?(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (d) f.date = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`
  const amt = flat.match(/价税合计.*?[(（]小写[)）][¥￥]?([\d,]+\.\d{2})/) ?? flat.match(/小写[)）]?[¥￥]([\d,]+\.\d{2})/)
  if (amt) f.amount = '¥' + amt[1]
  const names = [...flat.matchAll(/名称[:：](.{2,40}?)(?=统一社会信用代码|纳税人识别号|地址|$)/g)].map((m) => m[1])
  if (names[0]) f.buyer = names[0]
  if (names[1]) f.seller = names[1]
  const item = flat.match(/\*([^*]{1,20})\*([^\d*¥￥]{1,30})/)
  if (item) f.content = `${item[1]} · ${item[2]}`
  return f
}

export async function inspectFile(file: File): Promise<Inspected> {
  const e = ext(file.name)
  const name = base(file.name)
  const done = (type: string, fields: Record<string, string>, title = name, note?: string): Inspected => ({ type, title, fields, note })

  if (e === 'p8') {
    const keyId = file.name.match(/AuthKey_([A-Z0-9]{10})/)?.[1] ?? file.name.match(/\b([A-Z0-9]{10})\b/)?.[1] ?? ''
    return done('keyfile', { kind: t('Apple 密钥 (.p8)'), keyId, service: 'Apple Developer' }, keyId ? t('Apple 密钥 {keyId}', { keyId }) : name, t('Apple .p8 不含用途，请在「用途」里写明是推送（APNs）、App Store Connect API 还是 Sign in with Apple'))
  }
  if (e === 'p12' || e === 'pfx') {
    try {
      const c = await inspectCert(file, true, '')
      return done('certfile', certFields(c), c.subject || name)
    } catch {
      return done('certfile', { kind: t('PKCS#12 证书 (.p12)') }, name, P12_NOTE)
    }
  }
  if (['cer', 'crt', 'der'].includes(e)) {
    try {
      const c = await inspectCert(file)
      return done('certfile', certFields(c), c.subject || name)
    } catch {
      return done('certfile', { kind: t('证书') }, name)
    }
  }
  if (e === 'mobileprovision' || e === 'provisionprofile') {
    const f = parseProvision(await textOf(file, 5 << 20))
    return done('profile', f, f.name || name)
  }
  if (['jks', 'keystore'].includes(e)) return done('keyfile', { kind: t('Android 签名密钥库'), service: 'Android' }, name)
  if (e === 'pub') return done('keyfile', { kind: t('SSH 公钥') }, name)
  if (e === 'ppk') return done('keyfile', { kind: t('PuTTY 私钥') }, name)
  if (e === 'gpg' || e === 'asc') return done('keyfile', { kind: t('GPG 密钥') }, name)
  if (e === 'ofd') return done('invoice', {}, name)

  if (['pem', 'key', 'json', 'txt', ''].includes(e) || /^id_(rsa|ed25519|ecdsa)/.test(file.name)) {
    const text = await textOf(file)
    if (/-----BEGIN CERTIFICATE-----/.test(text)) {
      try {
        const c = await inspectCert(file)
        const withKey = /PRIVATE KEY-----/.test(text)
        return done('certfile', { ...certFields(c), kind: certKind({ kind: c.kind, has_key: withKey }) }, c.subject || name)
      } catch { /* 往下当普通文件 */ }
    }
    if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) return done('keyfile', { kind: t('SSH 私钥') }, name)
    if (/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
      const enc = /ENCRYPTED/.test(text)
      return done('keyfile', { kind: enc ? t('私钥 ({ext})，有口令', { ext: e || 'pem' }) : t('私钥 ({ext})', { ext: e || 'pem' }) }, name)
    }
    if (/-----BEGIN PGP/.test(text)) return done('keyfile', { kind: t('GPG 密钥') }, name)
    if (e === 'json') {
      try {
        const j = JSON.parse(text)
        if (j.type === 'service_account')
          return done('keyfile', { kind: t('Google 服务账号密钥'), keyId: j.private_key_id ?? '', team: j.client_email ?? '', service: j.project_id ? `Google Cloud · ${j.project_id}` : 'Google Cloud' }, j.client_email ?? name)
        if (j.installed || j.web) return done('keyfile', { kind: t('Google OAuth 客户端'), keyId: (j.installed ?? j.web).client_id ?? '', service: 'Google Cloud' }, name)
      } catch { /* 不是 JSON */ }
    }
  }

  if (e === 'pdf') {
    const { pdfText } = await import('./pdf')
    const text = await pdfText(file).catch(() => '')
    if (/发票/.test(text) && /(发票号码|价税合计)/.test(text)) {
      const f = parseInvoice(text)
      return done('invoice', f, [f.seller, f.amount].filter(Boolean).join(' ') || name)
    }
    if (/合同|协议/.test(text.slice(0, 300))) return done('contract', {}, name)
  }
  if (/合同|协议/.test(name)) return done('contract', {}, name)
  if (/发票|invoice/i.test(name)) return done('invoice', {}, name)
  return done('document', { kind: e ? t('{ext} 文件', { ext: e.toUpperCase() }) : t('文件') }, name)
}
