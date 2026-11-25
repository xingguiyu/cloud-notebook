/** 证件夹的条目类型：每种类型有自己的字段、照片位和到期字段 */

import { t } from '../i18n'

export type FieldKind = 'text' | 'secret' | 'date' | 'month' | 'url' | 'multiline' | 'totp' | 'number' | 'code'

export interface FieldDef {
  key: string
  label: string
  kind?: FieldKind
  placeholder?: string
}

export interface TypeDef {
  id: string
  label: string
  group: GroupId
  fields: FieldDef[]
  /** 证件照片位（正面、反面、首页……） */
  photos?: string[]
  /** 哪个字段是到期日，用来提醒 */
  expiry?: string
  /** 列表里标题下面显示哪个字段（敏感字段会打码） */
  subtitle?: string
}

export type GroupId = 'personal' | 'finance' | 'login' | 'company' | 'project' | 'other'

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'personal', label: t('个人证件') },
  { id: 'finance', label: t('银行与金融') },
  { id: 'login', label: t('账号与密钥') },
  { id: 'company', label: t('公司证照') },
  { id: 'project', label: t('项目文件') },
  { id: 'other', label: t('其它') },
]

const name: FieldDef = { key: 'name', label: t('姓名') }
const issueDate: FieldDef = { key: 'issued', label: t('签发日期'), kind: 'date' }
const expires: FieldDef = { key: 'expires', label: t('有效期至'), kind: 'date', placeholder: t('长期有效可留空') }
const authority: FieldDef = { key: 'authority', label: t('签发机关') }
const usage: FieldDef = { key: 'usage', label: t('用途 / 说明'), kind: 'multiline', placeholder: t('这个文件是干什么用的、在哪里配置') }

export const TYPES: TypeDef[] = [
  // ---- 个人证件 ----
  {
    id: 'idcard',
    label: t('身份证'),
    group: 'personal',
    fields: [
      name,
      { key: 'number', label: t('公民身份号码'), kind: 'code' },
      { key: 'gender', label: t('性别') },
      { key: 'ethnicity', label: t('民族') },
      { key: 'birth', label: t('出生日期'), kind: 'date' },
      { key: 'address', label: t('住址'), kind: 'multiline' },
      authority,
      issueDate,
      expires,
    ],
    photos: ['人像面', '国徽面'],
    expiry: 'expires',
    subtitle: 'number',
  },
  {
    id: 'passport',
    label: t('护照'),
    group: 'personal',
    fields: [
      name,
      { key: 'nameEn', label: t('英文姓名') },
      { key: 'number', label: t('护照号码'), kind: 'code' },
      { key: 'nationality', label: t('国籍') },
      { key: 'birth', label: t('出生日期'), kind: 'date' },
      { key: 'birthPlace', label: t('出生地点') },
      { key: 'issuePlace', label: t('签发地点') },
      authority,
      issueDate,
      expires,
    ],
    photos: ['资料页', '签名页'],
    expiry: 'expires',
    subtitle: 'number',
  },
  {
    id: 'travel',
    label: t('港澳台通行证'),
    group: 'personal',
    fields: [name, { key: 'number', label: t('证件号码'), kind: 'code' }, authority, issueDate, expires, { key: 'endorsement', label: t('签注'), kind: 'multiline' }],
    photos: ['正面', '背面'],
    expiry: 'expires',
    subtitle: 'number',
  },
  {
    id: 'workpermit',
    label: t('工作准证 / 工作许可'),
    group: 'personal',
    fields: [
      name,
      { key: 'kind', label: t('准证类型'), placeholder: t('如 EP / S Pass / 外国人工作许可证') },
      { key: 'number', label: t('证件号码'), kind: 'code', placeholder: t('如 FIN、许可证号') },
      { key: 'employer', label: t('雇主 / 工作单位') },
      { key: 'position', label: t('职位') },
      { key: 'country', label: t('签发国家 / 地区') },
      authority,
      issueDate,
      expires,
    ],
    photos: ['正面', '背面'],
    expiry: 'expires',
    subtitle: 'kind',
  },
  {
    id: 'visa',
    label: t('签证 / 居留许可'),
    group: 'personal',
    fields: [
      name,
      { key: 'country', label: t('国家 / 地区') },
      { key: 'kind', label: t('签证类型'), placeholder: t('如 商务 B1/B2、申根 C、居留许可') },
      { key: 'number', label: t('签证号码'), kind: 'code' },
      { key: 'passport', label: t('对应护照号'), kind: 'code' },
      { key: 'entries', label: t('入境次数'), placeholder: t('单次 / 多次') },
      { key: 'stay', label: t('每次停留'), placeholder: t('如 90 天') },
      issueDate,
      expires,
    ],
    photos: ['签证页'],
    expiry: 'expires',
    subtitle: 'country',
  },
  {
    id: 'driver',
    label: t('驾驶证'),
    group: 'personal',
    fields: [
      name,
      { key: 'number', label: t('证号'), kind: 'code' },
      { key: 'file', label: t('档案编号'), kind: 'code' },
      { key: 'class', label: t('准驾车型') },
      { key: 'first', label: t('初次领证日期'), kind: 'date' },
      expires,
    ],
    photos: ['主页', '副页'],
    expiry: 'expires',
    subtitle: 'class',
  },
  {
    id: 'vehicle',
    label: t('行驶证'),
    group: 'personal',
    fields: [
      { key: 'plate', label: t('号牌号码'), kind: 'code' },
      { key: 'owner', label: t('所有人') },
      { key: 'model', label: t('品牌型号') },
      { key: 'vin', label: t('车辆识别代号'), kind: 'code' },
      { key: 'engine', label: t('发动机号码'), kind: 'code' },
      { key: 'registered', label: t('注册日期'), kind: 'date' },
      { key: 'inspection', label: t('检验有效期至'), kind: 'month' },
    ],
    photos: ['主页', '副页'],
    expiry: 'inspection',
    subtitle: 'plate',
  },
  {
    id: 'degree',
    label: t('学历学位证书'),
    group: 'personal',
    fields: [
      name,
      { key: 'kind', label: t('证书类型'), placeholder: t('毕业证 / 学士学位 / 硕士学位…') },
      { key: 'number', label: t('证书编号'), kind: 'code' },
      { key: 'school', label: t('学校') },
      { key: 'major', label: t('专业') },
      { key: 'date', label: t('授予日期'), kind: 'date' },
      { key: 'verify', label: t('学信网验证码'), kind: 'code' },
    ],
    photos: ['证书'],
    subtitle: 'school',
  },
  {
    id: 'birth',
    label: t('出生医学证明'),
    group: 'personal',
    fields: [name, { key: 'number', label: t('证明编号'), kind: 'code' }, { key: 'birth', label: t('出生日期'), kind: 'date' }, { key: 'place', label: t('出生地点') }, { key: 'parents', label: t('父母') }],
    photos: ['证明'],
    subtitle: 'birth',
  },
  {
    id: 'household',
    label: t('户口簿'),
    group: 'personal',
    fields: [{ key: 'head', label: t('户主') }, { key: 'kind', label: t('户别'), placeholder: t('家庭户 / 集体户') }, { key: 'number', label: t('户号'), kind: 'code' }, { key: 'address', label: t('住址'), kind: 'multiline' }, authority],
    photos: ['首页', '户主页', '本人页'],
    subtitle: 'head',
  },
  {
    id: 'social',
    label: t('社保卡 / 医保卡'),
    group: 'personal',
    fields: [name, { key: 'number', label: t('卡号'), kind: 'code' }, { key: 'bank', label: t('金融账户所属银行') }, { key: 'pin', label: t('密码'), kind: 'secret' }, expires],
    photos: ['正面', '背面'],
    expiry: 'expires',
    subtitle: 'number',
  },
  {
    id: 'cert',
    label: t('其它证件'),
    group: 'personal',
    fields: [name, { key: 'number', label: t('证件号码'), kind: 'code' }, authority, issueDate, expires],
    photos: ['正面', '背面'],
    expiry: 'expires',
    subtitle: 'number',
  },

  // ---- 银行与金融 ----
  {
    id: 'bankcard',
    label: t('银行卡'),
    group: 'finance',
    fields: [
      { key: 'bank', label: t('发卡行') },
      { key: 'holder', label: t('持卡人') },
      { key: 'number', label: t('卡号'), kind: 'code' },
      { key: 'kind', label: t('卡类型'), placeholder: t('借记卡 / 信用卡') },
      { key: 'expires', label: t('有效期'), kind: 'month' },
      { key: 'cvv', label: t('安全码（CVV）'), kind: 'secret' },
      { key: 'pin', label: t('取款 / 支付密码'), kind: 'secret' },
      { key: 'branch', label: t('开户网点') },
      { key: 'phone', label: t('预留手机号') },
    ],
    photos: ['正面', '背面'],
    expiry: 'expires',
    subtitle: 'number',
  },
  {
    id: 'bankaccount',
    label: t('银行账户（对公）'),
    group: 'finance',
    fields: [
      { key: 'company', label: t('户名') },
      { key: 'number', label: t('账号'), kind: 'code' },
      { key: 'bank', label: t('开户行') },
      { key: 'swift', label: t('SWIFT / 联行号'), kind: 'code' },
      { key: 'ukey', label: t('U 盾 / 网银密码'), kind: 'secret' },
    ],
    photos: ['开户许可证'],
    subtitle: 'bank',
  },
  {
    id: 'insurance',
    label: t('保险单'),
    group: 'finance',
    fields: [
      { key: 'company', label: t('保险公司') },
      { key: 'number', label: t('保单号'), kind: 'code' },
      { key: 'insured', label: t('被保险人') },
      { key: 'product', label: t('险种') },
      { key: 'amount', label: t('保额') },
      { key: 'start', label: t('生效日期'), kind: 'date' },
      expires,
      { key: 'phone', label: t('客服电话') },
    ],
    expiry: 'expires',
    subtitle: 'company',
  },

  // ---- 账号与密钥 ----
  {
    id: 'login',
    label: t('网站登录'),
    group: 'login',
    fields: [
      { key: 'url', label: t('网址'), kind: 'url' },
      { key: 'username', label: t('用户名 / 邮箱') },
      { key: 'password', label: t('密码'), kind: 'secret' },
      { key: 'totp', label: t('两步验证密钥'), kind: 'totp', placeholder: t('网站给的 TOTP 密钥（Base32）') },
    ],
    subtitle: 'username',
  },
  {
    id: 'apikey',
    label: t('接口 API Key'),
    group: 'login',
    fields: [
      { key: 'service', label: t('服务'), placeholder: t('如 高德地图、Stripe、阿里云短信、SendGrid') },
      { key: 'env', label: t('环境'), placeholder: t('生产 / 测试 / 沙箱') },
      { key: 'appId', label: t('App ID / 应用'), kind: 'code' },
      { key: 'key', label: 'Key / ID', kind: 'secret' },
      { key: 'secret', label: 'Secret', kind: 'secret' },
      { key: 'endpoint', label: t('接口地址'), kind: 'url' },
      { key: 'url', label: t('控制台地址'), kind: 'url' },
      { key: 'docs', label: t('接口文档'), kind: 'url' },
      expires,
      usage,
    ],
    expiry: 'expires',
    subtitle: 'service',
  },
  {
    id: 'server',
    label: t('服务器'),
    group: 'login',
    fields: [
      { key: 'host', label: t('主机'), kind: 'code' },
      { key: 'port', label: t('端口'), kind: 'number' },
      { key: 'username', label: t('用户名') },
      { key: 'password', label: t('密码'), kind: 'secret' },
      { key: 'privateKey', label: t('私钥'), kind: 'secret' },
      { key: 'panel', label: t('面板地址'), kind: 'url' },
    ],
    subtitle: 'host',
  },
  {
    id: 'wifi',
    label: 'Wi-Fi',
    group: 'login',
    fields: [{ key: 'ssid', label: t('网络名称') }, { key: 'password', label: t('密码'), kind: 'secret' }, { key: 'security', label: t('加密方式'), placeholder: 'WPA2 / WPA3' }],
    subtitle: 'ssid',
  },
  {
    id: 'license',
    label: t('软件授权'),
    group: 'login',
    fields: [
      { key: 'product', label: t('软件') },
      { key: 'key', label: t('授权码'), kind: 'secret' },
      { key: 'email', label: t('注册邮箱') },
      { key: 'order', label: t('订单号'), kind: 'code' },
      expires,
    ],
    expiry: 'expires',
    subtitle: 'product',
  },

  // ---- 公司证照 ----
  {
    id: 'bizlicense',
    label: t('营业执照'),
    group: 'company',
    fields: [
      { key: 'company', label: t('名称') },
      { key: 'uscc', label: t('统一社会信用代码'), kind: 'code' },
      { key: 'kind', label: t('类型') },
      { key: 'legal', label: t('法定代表人') },
      { key: 'capital', label: t('注册资本') },
      { key: 'founded', label: t('成立日期'), kind: 'date' },
      { key: 'expires', label: t('营业期限至'), kind: 'date', placeholder: t('长期可留空') },
      { key: 'address', label: t('住所'), kind: 'multiline' },
      { key: 'scope', label: t('经营范围'), kind: 'multiline' },
    ],
    photos: ['正本', '副本'],
    expiry: 'expires',
    subtitle: 'uscc',
  },
  {
    id: 'qualification',
    label: t('资质证照'),
    group: 'company',
    fields: [
      { key: 'kind', label: t('证照名称'), placeholder: t('如 ICP 许可证、软件著作权、商标注册证') },
      { key: 'number', label: t('编号'), kind: 'code' },
      { key: 'holder', label: t('持有人') },
      authority,
      issueDate,
      expires,
    ],
    photos: ['证书'],
    expiry: 'expires',
    subtitle: 'kind',
  },
  {
    id: 'contract',
    label: t('合同'),
    group: 'project',
    fields: [
      { key: 'number', label: t('合同编号'), kind: 'code' },
      { key: 'party', label: t('对方') },
      { key: 'amount', label: t('金额') },
      { key: 'signed', label: t('签订日期'), kind: 'date' },
      { key: 'start', label: t('开始日期'), kind: 'date' },
      { key: 'expires', label: t('到期日期'), kind: 'date' },
      { key: 'contact', label: t('对方联系人') },
    ],
    expiry: 'expires',
    subtitle: 'party',
  },
  {
    id: 'document',
    label: t('文件'),
    group: 'project',
    fields: [
      { key: 'kind', label: t('文件类型'), placeholder: t('如 章程、需求文档、证明') },
      { key: 'number', label: t('文号 / 版本'), kind: 'code' },
      { key: 'date', label: t('日期'), kind: 'date' },
      usage,
    ],
    subtitle: 'kind',
  },
  {
    id: 'certfile',
    label: t('证书'),
    group: 'project',
    fields: [
      { key: 'kind', label: t('证书类型'), placeholder: t('如 Apple 发布证书、SSL 证书') },
      { key: 'subject', label: t('使用者') },
      { key: 'issuer', label: t('颁发者') },
      { key: 'team', label: 'Team ID', kind: 'code' },
      { key: 'serial', label: t('序列号'), kind: 'code' },
      { key: 'password', label: t('证书密码'), kind: 'secret', placeholder: t('p12 导出时设的密码') },
      issueDate,
      { key: 'expires', label: t('有效期至'), kind: 'date' },
      usage,
    ],
    expiry: 'expires',
    subtitle: 'kind',
  },
  {
    id: 'llmkey',
    label: t('大模型 Key'),
    group: 'project',
    fields: [
      { key: 'provider', label: t('服务商'), placeholder: t('OpenAI / Anthropic / Gemini / DeepSeek / 中转站…') },
      { key: 'key', label: 'API Key', kind: 'secret' },
      { key: 'baseUrl', label: t('接口地址 (Base URL)'), kind: 'url' },
      { key: 'model', label: t('常用模型'), placeholder: t('如 claude-opus-5-5、gpt-5') },
      { key: 'org', label: t('组织 / 项目 ID'), kind: 'code' },
      { key: 'account', label: t('登录账号') },
      { key: 'url', label: t('控制台地址'), kind: 'url' },
      { key: 'quota', label: t('额度 / 限额'), placeholder: t('如 每月 $50、余额用完为止') },
      { key: 'issued', label: t('创建日期'), kind: 'date' },
      expires,
      usage,
    ],
    expiry: 'expires',
    subtitle: 'provider',
  },
  {
    id: 'keyfile',
    label: t('密钥文件'),
    group: 'project',
    fields: [
      { key: 'kind', label: t('密钥类型'), placeholder: t('如 APNs 密钥 (.p8)、SSH 私钥、服务账号') },
      { key: 'keyId', label: 'Key ID', kind: 'code' },
      { key: 'team', label: t('Team ID / 账号'), kind: 'code' },
      { key: 'service', label: t('服务 / 平台') },
      { key: 'password', label: t('密钥口令'), kind: 'secret' },
      { key: 'issued', label: t('创建日期'), kind: 'date' },
      expires,
      usage,
    ],
    expiry: 'expires',
    subtitle: 'kind',
  },
  {
    id: 'profile',
    label: t('描述文件'),
    group: 'project',
    fields: [
      { key: 'name', label: t('名称') },
      { key: 'kind', label: t('类型'), placeholder: t('开发 / Ad Hoc / App Store / 企业') },
      { key: 'appId', label: 'App ID / Bundle ID', kind: 'code' },
      { key: 'team', label: t('团队') },
      { key: 'uuid', label: 'UUID', kind: 'code' },
      { key: 'issued', label: t('创建日期'), kind: 'date' },
      { key: 'expires', label: t('有效期至'), kind: 'date' },
      usage,
    ],
    expiry: 'expires',
    subtitle: 'appId',
  },
  {
    id: 'invoice',
    label: t('发票'),
    group: 'project',
    fields: [
      { key: 'number', label: t('发票号码'), kind: 'code' },
      { key: 'date', label: t('开票日期'), kind: 'date' },
      { key: 'amount', label: t('价税合计') },
      { key: 'seller', label: t('销售方') },
      { key: 'buyer', label: t('购买方') },
      { key: 'content', label: t('项目内容') },
      { key: 'status', label: t('状态'), placeholder: t('如 已报销、待报销') },
    ],
    subtitle: 'amount',
  },

  // 项目本身（不在类型选择里出现，在「项目」模块里创建）
  {
    id: 'project',
    label: t('项目||单个'),
    group: 'project',
    fields: [
      { key: 'client', label: t('客户 / 公司') },
      { key: 'status', label: t('状态'), placeholder: t('进行中 / 暂停 / 已结束') },
      { key: 'url', label: t('网址'), kind: 'url' },
      { key: 'repo', label: t('代码仓库'), kind: 'url' },
      { key: 'console', label: t('控制台 / 后台'), kind: 'url' },
      { key: 'start', label: t('开始日期'), kind: 'date' },
    ],
    subtitle: 'client',
  },

  // ---- 其它 ----
  { id: 'note', label: t('安全笔记'), group: 'other', fields: [{ key: 'content', label: t('内容'), kind: 'multiline' }] },
  { id: 'custom', label: t('自定义'), group: 'other', fields: [] },
]

export const typeOf = (id: string) => TYPES.find((t) => t.id === id) ?? TYPES[TYPES.length - 1]

export interface SafeFile {
  id: string
  name: string
  mime: string
  size: number
  /** 证件照片位（如「人像面」）；没有就是普通附件 */
  slot?: string
}

export interface SafeItem {
  id: string
  type: string
  title: string
  /** 分类路径，如「公司A/项目X」；空字符串表示个人、未分类 */
  category: string
  fields: Record<string, string>
  /** 自定义字段 */
  extra: { label: string; value: string; secret?: boolean }[]
  files: SafeFile[]
  notes: string
  favorite?: boolean
  /** 所属项目（项目条目的 id） */
  project?: string
  created?: number
  updated?: number
}

export function blankItem(type: string, category = ''): SafeItem {
  return { id: crypto.randomUUID(), type, title: '', category, fields: {}, extra: [], files: [], notes: '' }
}

/** 到期状态：expired 已过期，soon 60 天内到期 */
export function expiryState(it: SafeItem): { state: 'expired' | 'soon' | null; date?: string } {
  const key = typeOf(it.type).expiry
  const raw = key ? it.fields[key]?.trim() : ''
  if (!raw) return { state: null }
  // 月份（2027-08）按当月最后一天算
  // 到期日当天还算有效：按本地时间那一天的最后一刻算（直接 new Date('2027-08-31') 是 UTC 零点，会提前一天）
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  const d = /^\d{4}-\d{2}$/.test(raw)
    ? new Date(+raw.slice(0, 4), +raw.slice(5, 7), 0, 23, 59, 59)
    : ymd
      ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3], 23, 59, 59)
      : new Date(raw)
  if (isNaN(d.getTime())) return { state: null }
  const days = (d.getTime() - Date.now()) / 86_400_000
  return { state: days < 0 ? 'expired' : days <= 60 ? 'soon' : null, date: raw }
}

/** 卡号、证件号打码：只露后 4 位 */
export function mask(v: string) {
  const s = v.replace(/\s/g, '')
  return s.length <= 4 ? '••••' : '•••• ' + s.slice(-4)
}

/** 按 Key 的前缀认出大模型服务商，顺带给出默认接口地址和控制台 */
const LLM_PREFIX: [RegExp, string, string, string][] = [
  [/^sk-ant-/, 'Anthropic', 'https://api.anthropic.com', 'https://console.anthropic.com/settings/keys'],
  [/^sk-or-/, 'OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/settings/keys'],
  [/^sk-(proj|svcacct|admin)-/, 'OpenAI', 'https://api.openai.com/v1', 'https://platform.openai.com/api-keys'],
  [/^AIza/, 'Google Gemini', 'https://generativelanguage.googleapis.com', 'https://aistudio.google.com/apikey'],
  [/^gsk_/, 'Groq', 'https://api.groq.com/openai/v1', 'https://console.groq.com/keys'],
  [/^xai-/, 'xAI', 'https://api.x.ai/v1', 'https://console.x.ai'],
  [/^hf_/, 'Hugging Face', 'https://api-inference.huggingface.co', 'https://huggingface.co/settings/tokens'],
  [/^r8_/, 'Replicate', 'https://api.replicate.com/v1', 'https://replicate.com/account/api-tokens'],
  [/^pplx-/, 'Perplexity', 'https://api.perplexity.ai', 'https://www.perplexity.ai/settings/api'],
  [/^fw_/, 'Fireworks', 'https://api.fireworks.ai/inference/v1', 'https://fireworks.ai/account/api-keys'],
]
export function detectLlm(key: string) {
  const k = key.trim()
  const hit = LLM_PREFIX.find(([re]) => re.test(k))
  return hit ? { provider: hit[1], baseUrl: hit[2], url: hit[3] } : null
}

const envName = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
const ENV_PREFIX: Record<string, string> = { 'Google Gemini': 'GEMINI', 'Hugging Face': 'HF' }

/** 大模型 Key、接口 Key 可以整条复制成 .env 的格式；其它类型返回空串 */
export function envText(it: SafeItem) {
  const f = it.fields
  const line = (k: string, v?: string) => (v?.trim() ? `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v.trim()) : v.trim()}` : '')
  if (it.type === 'llmkey') {
    const p = ENV_PREFIX[f.provider] ?? (envName(f.provider ?? '') || envName(it.title) || 'LLM')
    return [line(`${p}_API_KEY`, f.key), line(`${p}_BASE_URL`, f.baseUrl), line(`${p}_MODEL`, f.model), line(`${p}_ORG_ID`, f.org)].filter(Boolean).join('\n')
  }
  if (it.type === 'apikey') {
    const p = envName(f.service ?? '') || envName(it.title) || 'API'
    // 只有一个值时叫 API_KEY；Key 和 Secret 都有时分开叫
    const both = !!f.key?.trim() && !!f.secret?.trim()
    return [line(`${p}_APP_ID`, f.appId), line(both ? `${p}_KEY` : `${p}_API_KEY`, f.key), line(both ? `${p}_SECRET` : `${p}_API_KEY`, f.secret), line(`${p}_ENDPOINT`, f.endpoint)]
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
