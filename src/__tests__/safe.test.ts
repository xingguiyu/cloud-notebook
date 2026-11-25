import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankItem, detectLlm, envText, expiryState, mask, typeOf, TYPES, type SafeItem } from '../safe/templates'
import { generatePassword, totp, totpSecret } from '../safe/api'
import { parseInvoice, parseProvision } from '../safe/files'
import { luhn, validId, ymd } from '../safe/ocr'

const item = (type: string, fields: Record<string, string>, title = ''): SafeItem => ({ ...blankItem(type), title, fields })

describe('detectLlm', () => {
  it('recognises providers by key prefix', () => {
    const cases: [string, string][] = [
      ['sk-ant-api03-xxxx', 'Anthropic'],
      ['sk-or-v1-xxxx', 'OpenRouter'],
      ['sk-proj-xxxx', 'OpenAI'],
      ['sk-svcacct-xxxx', 'OpenAI'],
      ['sk-admin-xxxx', 'OpenAI'],
      ['AIzaSyXXXX', 'Google Gemini'],
      ['gsk_xxxx', 'Groq'],
      ['xai-xxxx', 'xAI'],
      ['hf_xxxx', 'Hugging Face'],
      ['r8_xxxx', 'Replicate'],
      ['pplx-xxxx', 'Perplexity'],
      ['fw_xxxx', 'Fireworks'],
    ]
    for (const [key, provider] of cases) expect(detectLlm(key)?.provider, key).toBe(provider)
  })

  it('returns the default endpoint and console address', () => {
    expect(detectLlm('sk-ant-x')).toEqual({ provider: 'Anthropic', baseUrl: 'https://api.anthropic.com', url: 'https://console.anthropic.com/settings/keys' })
  })

  it('ignores surrounding whitespace but is case-sensitive and anchored at the start', () => {
    expect(detectLlm('  sk-ant-x\n')?.provider).toBe('Anthropic')
    expect(detectLlm('SK-ANT-x')).toBeNull()
    expect(detectLlm('my sk-ant-x')).toBeNull()
  })

  it('returns null for ambiguous or unknown keys', () => {
    expect(detectLlm('sk-abcdef')).toBeNull() // bare sk- is used by several providers
    expect(detectLlm('')).toBeNull()
    expect(detectLlm('random')).toBeNull()
  })
})

describe('envText', () => {
  it('formats an LLM key with a prefix derived from the provider', () => {
    const it1 = item('llmkey', { provider: 'Anthropic', key: 'sk-ant-1', baseUrl: 'https://api.anthropic.com', model: 'claude', org: 'org-1' })
    expect(envText(it1)).toBe('ANTHROPIC_API_KEY=sk-ant-1\nANTHROPIC_BASE_URL=https://api.anthropic.com\nANTHROPIC_MODEL=claude\nANTHROPIC_ORG_ID=org-1')
  })

  it('uses the conventional prefix for Gemini and Hugging Face', () => {
    expect(envText(item('llmkey', { provider: 'Google Gemini', key: 'AIza1' }))).toBe('GEMINI_API_KEY=AIza1')
    expect(envText(item('llmkey', { provider: 'Hugging Face', key: 'hf_1' }))).toBe('HF_API_KEY=hf_1')
  })

  it('falls back to the title, then to LLM, for the prefix', () => {
    expect(envText(item('llmkey', { key: 'k' }, 'My Local-Model 2'))).toBe('MY_LOCAL_MODEL_2_API_KEY=k')
    expect(envText(item('llmkey', { provider: '通义千问', key: 'k' }, '千问'))).toBe('LLM_API_KEY=k')
    expect(envText(item('llmkey', { provider: '  x.ai / Grok  ', key: 'k' }))).toBe('X_AI_GROK_API_KEY=k')
  })

  it('skips empty fields and trims values', () => {
    expect(envText(item('llmkey', { provider: 'OpenAI', key: '  sk-1  ', baseUrl: '   ', model: '' }))).toBe('OPENAI_API_KEY="sk-1"')
    expect(envText(item('llmkey', { provider: 'OpenAI' }))).toBe('')
  })

  it('quotes values that contain spaces, #, or quotes', () => {
    expect(envText(item('llmkey', { provider: 'P', key: 'a b' }))).toBe('P_API_KEY="a b"')
    expect(envText(item('llmkey', { provider: 'P', key: 'a#b' }))).toBe('P_API_KEY="a#b"')
    expect(envText(item('llmkey', { provider: 'P', key: 'a"b' }))).toBe('P_API_KEY="a\\"b"')
    expect(envText(item('llmkey', { provider: 'P', key: "a'b" }))).toBe('P_API_KEY="a\'b"')
  })

  it('formats an API key: single value is API_KEY, key + secret are split', () => {
    expect(envText(item('apikey', { service: 'Stripe', key: 'pk_1' }))).toBe('STRIPE_API_KEY=pk_1')
    expect(envText(item('apikey', { service: 'Stripe', secret: 'sk_1' }))).toBe('STRIPE_API_KEY=sk_1')
    expect(envText(item('apikey', { service: 'Stripe', appId: 'app', key: 'pk_1', secret: 'sk_1', endpoint: 'https://api.stripe.com' }))).toBe(
      'STRIPE_APP_ID=app\nSTRIPE_KEY=pk_1\nSTRIPE_SECRET=sk_1\nSTRIPE_ENDPOINT=https://api.stripe.com',
    )
    expect(envText(item('apikey', { key: 'k' }, '高德地图'))).toBe('API_API_KEY=k')
    expect(envText(item('apikey', { service: '阿里云 OSS', key: 'k' }))).toBe('OSS_API_KEY=k')
  })

  it('is empty for every other type', () => {
    expect(envText(item('login', { username: 'u', password: 'p' }))).toBe('')
    expect(envText(item('custom', { key: 'k' }))).toBe('')
  })
})

describe('typeOf / mask', () => {
  it('finds a type by id and falls back to the custom type', () => {
    expect(typeOf('passport').id).toBe('passport')
    expect(typeOf('no-such-type').id).toBe('custom')
    expect(new Set(TYPES.map((t) => t.id)).size).toBe(TYPES.length)
  })

  it('every expiry key refers to a field of that type', () => {
    for (const t of TYPES) {
      const keys = t.fields.map((f) => f.key)
      if (t.expiry) expect(keys, `${t.id}.expiry`).toContain(t.expiry)
    }
  })

  it('mask shows only the last four characters', () => {
    expect(mask('6222 0200 1234 5678')).toBe('•••• 5678')
    expect(mask('1234')).toBe('••••')
    expect(mask('')).toBe('••••')
  })
})

describe('expiryState', () => {
  afterEach(() => vi.useRealTimers())
  const at = (y: number, m: number, d: number, h = 12) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(y, m - 1, d, h))
  }

  it('is null without an expiry field, without a value, or with an unparsable value', () => {
    at(2026, 11, 25)
    expect(expiryState(item('note', { content: 'x' }))).toEqual({ state: null })
    expect(expiryState(item('passport', {}))).toEqual({ state: null })
    expect(expiryState(item('passport', { expires: '   ' }))).toEqual({ state: null })
    expect(expiryState(item('idcard', { expires: '长期' }))).toEqual({ state: null })
  })

  it('reports expired, soon (within 60 days) and nothing beyond that', () => {
    at(2026, 11, 25)
    expect(expiryState(item('passport', { expires: '2026-11-20' }))).toEqual({ state: 'expired', date: '2026-11-20' })
    expect(expiryState(item('passport', { expires: '2020-01-01' })).state).toBe('expired')
    expect(expiryState(item('passport', { expires: '2026-12-25' }))).toEqual({ state: 'soon', date: '2026-12-25' })
    expect(expiryState(item('passport', { expires: '2027-01-20' })).state).toBe('soon')
    expect(expiryState(item('passport', { expires: '2027-01-28' })).state).toBeNull()
    expect(expiryState(item('passport', { expires: ' 2030-01-01 ' }))).toEqual({ state: null, date: '2030-01-01' })
  })

  it('reads a month value as the last day of that month', () => {
    at(2026, 11, 25)
    expect(expiryState(item('bankcard', { expires: '2026-10' })).state).toBe('expired')
    expect(expiryState(item('bankcard', { expires: '2026-12' })).state).toBe('soon')
    expect(expiryState(item('bankcard', { expires: '2027-03' })).state).toBeNull()
    // February of a leap year ends on the 29th: on the 28th the card is still valid
    at(2028, 2, 28)
    expect(expiryState(item('bankcard', { expires: '2028-02' })).state).toBe('soon')
    at(2028, 3, 1)
    expect(expiryState(item('bankcard', { expires: '2028-02' })).state).toBe('expired')
  })

  it('uses the field named by the type (vehicle inspection)', () => {
    at(2026, 11, 25)
    expect(expiryState(item('vehicle', { inspection: '2026-12', expires: '2020-01-01' })).state).toBe('soon')
  })

  // The date is compared at its first instant (and `new Date('YYYY-MM-DD')` is UTC midnight), so a
  // document is reported as expired during the last day it is still valid; west of UTC it flips the
  // evening before.
  // BUG CANDIDATE (low): "已过期" is shown on the expiry date itself.
  it('a document is not expired on its expiry date', () => {
    at(2027, 8, 15, 23)
    expect(expiryState(item('passport', { expires: '2027-08-15' })).state).toBe('soon')
  })
  it('a card that expires in a month is not expired on the last day of that month', () => {
    at(2027, 8, 31, 12)
    expect(expiryState(item('bankcard', { expires: '2027-08' })).state).toBe('soon')
  })
})

describe('totp', () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (last six digits of the 8-digit values)
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  it('matches the RFC 6238 test vectors', async () => {
    expect((await totp(SECRET, 59_000))?.code).toBe('287082')
    expect((await totp(SECRET, 1111111109_000))?.code).toBe('081804')
    expect((await totp(SECRET, 1234567890_000))?.code).toBe('005924')
    expect((await totp(SECRET, 20000000000_000))?.code).toBe('353130')
  })

  it('reports the seconds left in the 30-second step', async () => {
    expect((await totp(SECRET, 59_000))?.remaining).toBe(1)
    expect((await totp(SECRET, 60_000))?.remaining).toBe(30)
    expect((await totp(SECRET, 75_500))?.remaining).toBe(15)
  })

  it('accepts lower case, spaces, dashes and otpauth links', async () => {
    const expected = (await totp(SECRET, 59_000))?.code
    expect((await totp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59_000))?.code).toBe(expected)
    expect((await totp(`otpauth://totp/Example:me@x.y?secret=${SECRET}&issuer=Example`, 59_000))?.code).toBe(expected)
    expect(totpSecret('otpauth://totp/a?issuer=b&SECRET=ABC%3D')).toBe('ABC=')
    expect(totpSecret('PLAIN')).toBe('PLAIN')
  })

  it('returns null for a secret that is too short', async () => {
    expect(await totp('ABCD', 0)).toBeNull()
    expect(await totp('', 0)).toBeNull()
  })
})

describe('generatePassword', () => {
  it('has the requested length and avoids look-alike characters', () => {
    expect(generatePassword()).toHaveLength(20)
    const pw = generatePassword(400)
    expect(pw).toHaveLength(400)
    expect(pw).not.toMatch(/[0O1lI\s]/)
    expect(generatePassword(32)).not.toBe(generatePassword(32))
  })
})

describe('parseInvoice', () => {
  it('reads number, date, amount, parties and item from the text layer of an e-invoice', () => {
    const text = [
      '电子发票（普通发票）',
      '发票号码：25117000000123456789',
      '开票日期：2026年3月5日',
      '购买方信息 名称：成都某某科技有限公司 统一社会信用代码/纳税人识别号：91510100MA00000000',
      '销售方信息 名称：北京供应商有限公司 统一社会信用代码/纳税人识别号：91110000MA11111111',
      '*信息技术服务*软件服务费 6% 100.00 6.00',
      '价税合计（大写） 壹佰零陆圆整 （小写）¥106.00',
    ].join('\n')
    expect(parseInvoice(text)).toEqual({
      number: '25117000000123456789',
      date: '2026-03-05',
      amount: '¥106.00',
      buyer: '成都某某科技有限公司',
      seller: '北京供应商有限公司',
      content: '信息技术服务 · 软件服务费',
    })
  })

  it('accepts dashed dates and full-width digits, and returns {} for unrelated text', () => {
    expect(parseInvoice('开票日期:2026-3-5 发票号码:１２３４５６７８').date).toBe('2026-03-05')
    expect(parseInvoice('开票日期:2026-3-5 发票号码:１２３４５６７８').number).toBe('12345678')
    expect(parseInvoice('hello world')).toEqual({})
  })
})

describe('parseProvision', () => {
  const profile = (extra: string) => `garbage<?xml version="1.0"?><plist version="1.0"><dict>
<key>Name</key><string>My App Dev</string>
<key>UUID</key><string>ABCD-1234</string>
<key>TeamName</key><string>Example Ltd</string>
<key>TeamIdentifier</key><array><string>TEAM123456</string></array>
<key>ApplicationIdentifierPrefix</key><array><string>TEAM123456</string></array>
<key>CreationDate</key><date>2026-01-02T03:04:05Z</date>
<key>ExpirationDate</key><date>2027-01-02T03:04:05Z</date>
<key>Entitlements</key><dict><key>application-identifier</key><string>TEAM123456.com.example.app</string>${extra}</dict>
</dict></plist>signature-bytes`

  it('reads the plain-text plist inside a signed profile', () => {
    expect(parseProvision(profile('<key>get-task-allow</key><true/>').replace('<key>Entitlements</key>', '<key>ProvisionedDevices</key><array><string>udid</string></array><key>Entitlements</key>'))).toEqual({
      name: 'My App Dev',
      kind: '开发',
      appId: 'com.example.app',
      team: 'Example Ltd · TEAM123456',
      uuid: 'ABCD-1234',
      issued: '2026-01-02',
      expires: '2027-01-02',
    })
  })

  it('tells the distribution kinds apart', () => {
    expect(parseProvision(profile('')).kind).toBe('App Store')
    expect(parseProvision(profile('').replace('<key>Entitlements</key>', '<key>ProvisionedDevices</key><array/><key>Entitlements</key>')).kind).toBe('Ad Hoc')
    expect(parseProvision(profile('').replace('<key>Entitlements</key>', '<key>ProvisionsAllDevices</key><true/><key>Entitlements</key>')).kind).toBe('企业分发')
    expect(parseProvision(profile('').replace('<key>Entitlements</key>', '<key>Platform</key><array><string>OSX</string></array><key>Entitlements</key>')).kind).toBe('App Store（macOS）')
  })

  it('returns empty fields for something that is not a profile', () => {
    expect(parseProvision('not a plist')).toMatchObject({ name: '', appId: '', uuid: '', expires: '' })
  })
})

describe('OCR helpers', () => {
  it('ymd normalises the common date spellings', () => {
    expect(ymd('2027年8月3日')).toBe('2027-08-03')
    expect(ymd('2027.08.03')).toBe('2027-08-03')
    expect(ymd('有效期至 2027-8-3')).toBe('2027-08-03')
    expect(ymd('2027/12/31')).toBe('2027-12-31')
    expect(ymd('20270803')).toBe('2027-08-03')
    expect(ymd('2027-13-01')).toBe('')
    expect(ymd('2027-00-10')).toBe('')
    expect(ymd('2027-01-32')).toBe('')
    expect(ymd('长期')).toBe('')
    expect(ymd('1899-01-01')).toBe('')
  })

  it('validId checks the ID-card check digit', () => {
    expect(validId('11010519491231002X')).toBe(true)
    expect(validId('110105194912310021')).toBe(false)
    expect(validId('11010519491231002x')).toBe(false)
    expect(validId('1101051949123100')).toBe(false)
    expect(validId('')).toBe(false)
  })

  it('luhn checks bank-card numbers', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    expect(luhn('79927398713')).toBe(true)
  })
})
