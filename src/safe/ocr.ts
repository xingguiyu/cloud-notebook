import { invoke } from '@tauri-apps/api/core'

/**
 * 证件照片自动识别填写：
 * 1. Rust 调系统 Vision 框架识别文字（本机完成，图片不出设备，也不发给 AI）
 * 2. 这里按证件类型用规则把文字对应到字段：号码靠格式和校验位，其余靠「姓名」「住址」这类标签
 */

export interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** 拉丁字母专用识别得到的行（只用来读机读码） */
  latin?: boolean
}

export async function recognize(file: File, latin = false): Promise<OcrLine[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lines = await invoke<OcrLine[]>('ocr_image', bytes)
  ready = true
  // 第一遍读出机读码就返回，省掉第二遍（大图每遍要几秒）
  if (!latin || mrz(rows(lines.map((l) => ({ ...l, text: norm(l.text) }))))) return lines
  // 护照、签证、准证底部的机读码：再用拉丁字母模式识别一遍，比中英混合模式准得多
  const extra = await invoke<OcrLine[]>('ocr_image', bytes, { headers: { 'x-latin': '1' } }).catch(() => [])
  return [...lines, ...extra.map((l) => ({ ...l, latin: true }))]
}

/**
 * 预热：系统第一次识别中文要把模型载入内存（十几秒），之后每次 1 秒左右。
 * 证件夹解锁时就在后台用一张小图跑一遍；Rust 那边识别是排队的，真正的识别会等预热完成再跑。
 */
let warmed: Promise<unknown> | null = null
let ready = false
export const isWarm = () => ready
export function warmup() {
  if (warmed) return warmed
  const c = document.createElement('canvas')
  c.width = 240
  c.height = 60
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#000'
  ctx.font = '28px sans-serif'
  ctx.fillText('证件 ABC123', 10, 40)
  warmed = new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
    .then(async (b) => invoke('ocr_image', new Uint8Array(await b.arrayBuffer())))
    .then(() => (ready = true))
    .catch(() => (warmed = null))
  return warmed
}

/** 哪些类型需要额外识别机读码 */
export const needsLatin = (type: string) => type === 'passport' || type === 'visa' || type === 'travel'

// ---------------- 通用工具 ----------------

/** 全角转半角，统一冒号 */
function norm(s: string) {
  return s
    // 兼容字符（PDF 里常见的「⼈⼝⺠」部首字、全角字母数字）统一成标准字符
    .normalize('NFKC')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/：/g, ':')
    .trim()
}

const pad = (n: string | number) => String(n).padStart(2, '0')

/** 2027年8月3日 / 2027.08.03 / 2027-8-3 / 20270803 → 2027-08-03 */
export function ymd(s: string): string {
  const m = s.match(/((?:19|20)\d{2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/) ?? s.match(/((?:19|20)\d{2})(\d{2})(\d{2})/)
  if (!m) return ''
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''
  return `${y}-${pad(mo)}-${pad(d)}`
}

/** 有效期限：2015.03.01-2035.03.01 / 2015.03.01至长期 → [起, 止]（长期为空） */
function range(s: string): [string, string] | null {
  const m = s.match(/((?:19|20)\d{2}[.\-/年]\d{1,2}[.\-/月]\d{1,2}日?)\s*[-—–~至到]+\s*((?:19|20)\d{2}[.\-/年]\d{1,2}[.\-/月]\d{1,2}日?|长期)/)
  if (!m) return null
  return [ymd(m[1]), m[2] === '长期' ? '' : ymd(m[2])]
}

/** 像不像一个字段标签（双语证件的「出生地点/Place of birth」，或常见英文标签） */
// 标签的英文部分有小写（Place of birth），值是全大写（四川/SICHUAN、女/F），以此区分
const LABEL_BILINGUAL = /[\u4e00-\u9fa5]{1,8}\s*\/\s*[A-Z]?[a-z]{2}/
const LABEL_EN = /^(?:Type|Country\s*Code|Passport\s*No|Surname|Given\s*names?|Sex|Nationality|Date\s+of|Place\s+of|Authority|Bearer)\b/i
export const isLabel = (s: string) => LABEL_BILINGUAL.test(s) || LABEL_EN.test(s.trim())

/** 去掉标签，取同一行后面的内容；同一行没有就取下一行（下一行本身是标签就不算） */
function after(lines: string[], label: RegExp, stop?: RegExp): string {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label)
    if (!m) continue
    // 双语证件的英文标签（如「姓名/Name」）一起去掉
    let rest = lines[i]
      .slice(m.index! + m[0].length)
      .replace(/^\s*\/\s*[A-Za-z][A-Za-z .']*/, '')
      .replace(/^[\s:]+/, '')
    if (stop) rest = rest.split(stop)[0]
    if (rest.trim()) return rest.trim()
    const next = lines[i + 1]
    if (next && !(stop && stop.test(next)) && !isLabel(next)) return next.trim()
  }
  return ''
}

/** 标签后面跨多行的内容（如住址），直到遇到下一个标签 */
function block(lines: string[], label: RegExp, stop: RegExp): string {
  const i = lines.findIndex((l) => label.test(l))
  if (i < 0) return ''
  const parts = [lines[i].replace(new RegExp('^.*?' + label.source), '').replace(/^[\s:]+/, '')]
  for (let j = i + 1; j < lines.length && !stop.test(lines[j]); j++) parts.push(lines[j])
  return parts.join('').replace(/\s+/g, '').trim()
}

const compact = (s: string) => s.replace(/\s+/g, '')

/**
 * 按位置找值：标签正下方、左边对齐的那几行（护照资料页这类「标签在上、值在下」的双栏版式）。
 * 返回最多 n 行，遇到下一个标签就停。
 */
function below(boxes: OcrLine[], label: RegExp, n = 1): string[] {
  const L = boxes.find((b) => !b.latin && label.test(b.text))
  if (!L) return []
  const out: OcrLine[] = []
  const cands = boxes
    .filter((b) => !b.latin && b !== L && b.y > L.y + L.h * 0.5 && b.y < L.y + L.h * (2.2 + n * 1.6))
    // 左边缘相近，或水平方向有重叠
    // （标签的中文部分可能没认出来，只剩英文，所以值可以比标签靠左一点）
    .filter((b) => Math.abs(b.x - L.x) < 0.05 || (Math.min(b.x + b.w, L.x + L.w) - Math.max(b.x, L.x) > 0 && b.x > L.x - 0.08))
    .sort((a, b) => a.y - b.y)
  for (const c of cands) {
    if (isLabel(c.text)) break
    out.push(c)
    if (out.length >= n) break
  }
  return out.map((b) => b.text.trim())
}

/** 把同一水平线上的识别块拼成一行（机读码常被拆成几段） */
function rows(boxes: OcrLine[]): string[] {
  const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
  const out: OcrLine[][] = []
  for (const b of sorted) {
    const row = out[out.length - 1]
    const c = b.y + b.h / 2
    if (row && Math.abs(row[0].y + row[0].h / 2 - c) < Math.min(row[0].h, b.h) * 0.6) row.push(b)
    else out.push([b])
  }
  return out.map((r) => r.sort((a, b) => a.x - b.x).map((b) => b.text).join(''))
}

/** 身份证号校验位 */
export function validId(id: string) {
  if (!/^\d{17}[\dX]$/.test(id)) return false
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const sum = w.reduce((s, x, i) => s + x * +id[i], 0)
  return '10X98765432'[sum % 11] === id[17]
}

function findId(text: string) {
  const all = compact(text).toUpperCase().match(/\d{17}[\dX]/g) ?? []
  return all.find(validId) ?? all[0] ?? ''
}

/** 银行卡号 Luhn 校验 */
export function luhn(num: string) {
  let sum = 0
  for (let i = 0; i < num.length; i++) {
    let d = +num[num.length - 1 - i]
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

const BANKS = [
  '中国工商银行', '中国建设银行', '中国农业银行', '中国银行', '交通银行', '招商银行', '中国邮政储蓄银行', '邮储银行',
  '浦发银行', '中信银行', '中国光大银行', '光大银行', '华夏银行', '中国民生银行', '民生银行', '广发银行', '平安银行',
  '兴业银行', '浙商银行', '渤海银行', '恒丰银行', '北京银行', '上海银行', '江苏银行', '宁波银行', '南京银行',
  '成都银行', '杭州银行', '徽商银行', '重庆银行', '四川农信', '农村商业银行', '农商银行', '汇丰银行', '花旗银行',
]

// ---------------- 各类证件 ----------------

type Parser = (lines: string[], text: string, boxes: OcrLine[]) => Record<string, string>

const idcard: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  const id = findId(text)
  if (id) {
    out.number = id
    out.birth = `${id.slice(6, 10)}-${id.slice(10, 12)}-${id.slice(12, 14)}`
    out.gender = +id[16] % 2 ? '男' : '女'
  }
  out.name = after(lines, /姓\s*名/, /性\s*别/)
  const g = text.match(/性\s*别\s*:?\s*([男女])/)
  if (g) out.gender = g[1]
  out.ethnicity = after(lines, /民\s*族/, /出\s*生/)
  out.address = block(lines, /住\s*址/, /公民身份|号码|\d{17}/)
  // 国徽面
  out.authority = after(lines, /签\s*发\s*机\s*关/)
  const r = range(text.replace(/\s/g, ''))
  if (r) [out.issued, out.expires] = r
  return out
}

/** 机读码里容易认错的字符 */
const MRZ_CHARS = (s: string) =>
  s
    .toUpperCase()
    .replace(/[«‹〈く＜<]/g, '<')
    .replace(/\s/g, '')
const DIGIT = (s: string) => s.replace(/[OQD]/g, '0').replace(/[IL|]/g, '1').replace(/Z/g, '2').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6')

/** 护照底部两行机读码（MRZ）：P<CHNZHANG<<SAN<<<…  /  E12345678<CHN9001011F3001018… */
export function mrz(rowsText: string[]) {
  const rs = rowsText.map(MRZ_CHARS).filter((r) => r.length >= 28)
  // 第二行：护照号(9) 校验(1) 国籍(3) 出生(6) 校验(1) 性别(1) 到期(6)
  let l2 = ''
  for (const r of rs) {
    const m = r.match(/([A-Z0-9<]{9})([0-9OIL<])([A-Z<]{3})([0-9OQDILSZBG]{6})([0-9OIL<])([MF<])([0-9OQDILSZBG]{6})/)
    if (m) {
      l2 = m[0]
      break
    }
  }
  if (!l2) return null
  const yy = (raw: string, future: boolean) => {
    const s = DIGIT(raw)
    const y = +s.slice(0, 2)
    const now = new Date().getFullYear() % 100
    const century = future ? 2000 : y > now ? 1900 : 2000
    const [mo, d] = [+s.slice(2, 4), +s.slice(4, 6)]
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''
    return `${century + y}-${s.slice(2, 4)}-${s.slice(4, 6)}`
  }
  const nat = l2.slice(10, 13).replace(/</g, '')
  const out: Record<string, string> = {
    number: l2.slice(0, 9).replace(/</g, ''),
    nationality: nat === 'CHN' ? '中国' : nat,
    birth: yy(l2.slice(13, 19), false),
    expires: yy(l2.slice(21, 27), true),
  }
  // 中国护照号：E/G 开头，后面是数字（第二位可能是字母）
  if (/^[EG]/.test(out.number)) out.number = out.number[0] + (/[A-Z]/.test(out.number[1]) && !/[OIL]/.test(out.number[1]) ? out.number[1] + DIGIT(out.number.slice(2)) : DIGIT(out.number.slice(1)))
  // 新版护照第一行以「PP」开头（PPCHN…），旧版是「P<」
  const l1 = rs.find((r) => /^P[A-Z<0]/.test(r) && r.includes('<<'))
  if (l1) {
    const [sur, given] = l1.slice(5).split('<<')
    const clean = (x: string) => x.replace(/[^A-Z<]/g, '').replace(/</g, ' ').trim()
    if (sur) out.nameEn = [clean(sur), clean(given ?? '')].filter(Boolean).join(' ')
  }
  return out
}

/** 中文和拼音各占一行的值：「四川/SICHUAN」取中文部分 */
const cn = (v: string) => v.split('/')[0].trim()

const passport: Parser = (lines, _text, boxes) => {
  const out: Record<string, string> = {}
  // 资料页：标签在上、值在下
  const sur = below(boxes, /姓\s*\/?\s*Surname|^姓$/i, 2)
  const given = below(boxes, /名\s*\/?\s*Given/i, 2)
  if (sur[0] || given[0]) out.name = cn(sur[0] ?? '') + cn(given[0] ?? '')
  const pinyin = [sur[1], given[1]].filter((x) => x && /^[A-Z ,]+$/i.test(x))
  if (pinyin.length === 2) out.nameEn = pinyin.join(' ').toUpperCase()
  const pick = (re: RegExp) => below(boxes, re)[0] ?? ''
  out.number = compact(pick(/护照号|Passport\s*No/i)).toUpperCase()
  out.birthPlace = cn(pick(/出生地点|Place\s*of\s*birth/i))
  out.issuePlace = cn(pick(/签发地点|Place\s*of\s*[iT]ssu/i))
  // 和同一行右边的「有效期至」日期粘在一起时，去掉日期
  out.authority = pick(/签发机关|Authority/i).replace(/\s+\d{1,2}\s*\d{0,2}\s*月.*$|\s+\d{1,2}\s+[A-Z]{3}\s+\d{4}.*$/i, '')
  out.birth = anyDate(pick(/出生日期|Dat[ec]\s*o[fr]\s*birth/i))
  out.issued = anyDate(pick(/签发日期|Dat[ec]\s*o[fr]\s*issu/i))
  out.expires = anyDate(pick(/有效期至|Dat[ec]\s*o[fr]\s*expir/i))
  // 新版护照：「姓名/Name」下面一行中文、一行拼音（WEN, QINGYA）
  if (!out.name) {
    const nm = below(boxes, /姓\s*名\s*\/?\s*Name|^姓\s*名/i, 2)
    if (nm[0]) out.name = compact(cn(nm[0]))
    if (nm[1] && /^[A-Z ,./]+$/i.test(nm[1])) out.nameEn = nm[1].replace(/\s*,\s*/, ' ').replace(/[^A-Z ]/gi, '').toUpperCase()
  }
  if (!out.number) out.number = lines.map((l) => compact(l).toUpperCase().match(/(?:^|[^A-Z0-9])(E[A-Z0-9]\d{7}|[EG]\d{8})(?![A-Z0-9])/)?.[1]).find(Boolean) ?? ''
  // 机读码最可靠：有就覆盖号码、日期、英文名
  const m = mrz([...rows(boxes.filter((b) => b.latin)), ...rows(boxes.filter((b) => !b.latin))])
  if (m) {
    for (const [k, v] of Object.entries(m)) if (v && (['number', 'birth', 'expires', 'nameEn'].includes(k) || !out[k])) out[k] = v
  }
  return out
}

const travel: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  out.number = compact(text).match(/\b(C[A-Z0-9]\d{7}|[CHMW]\d{8})\b/)?.[1] ?? ''
  out.name = after(lines, /姓\s*名/)
  out.authority = after(lines, /签发机关/)
  const r = range(compact(text))
  if (r) [out.issued, out.expires] = r
  return out
}

const driver: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  out.number = findId(text)
  out.name = after(lines, /姓\s*名/, /性\s*别/)
  out.class = text.match(/准驾车型\s*:?\s*([A-DFMNP][1-3]?(?:\s*[A-DFMNP][1-3]?)*)/)?.[1].replace(/\s/g, '') ?? ''
  out.first = ymd(after(lines, /初次领证日期/))
  out.file = compact(text).match(/档案编号:?(\d{12})/)?.[1] ?? ''
  const r = range(compact(text))
  if (r) out.expires = r[1]
  return out
}

const vehicle: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  const c = compact(text).toUpperCase()
  out.plate = c.match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}/)?.[0] ?? ''
  out.vin = c.match(/[A-HJ-NPR-Z0-9]{17}/)?.[0] ?? ''
  out.owner = after(lines, /所\s*有\s*人/)
  out.model = after(lines, /品牌型号/, /车辆识别/)
  out.engine = after(lines, /发动机号码?/)
  out.registered = ymd(after(lines, /注册日期/))
  return out
}

const bankcard: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  // 卡号常被识别成 4 个一组，先在每一行里拼起来再找
  for (const l of lines) {
    const digits = l.replace(/[\s-]/g, '')
    const m = digits.match(/\d{16,19}/)
    if (m && luhn(m[0])) {
      out.number = m[0]
      break
    }
  }
  // 校验位对不上（识别错一位或特殊卡号）时，仍然填上最像卡号的一串，交给用户核对
  if (!out.number) out.number = lines.map((l) => l.replace(/[\s-]/g, '').match(/\d{16,19}/)?.[0]).find(Boolean) ?? ''
  const e = text.match(/(?:VALID\s*THRU|有效期|GOOD\s*THRU|EXP)[^\d]{0,12}(\d{2})\s*\/\s*(\d{2})/i) ?? text.match(/\b(0[1-9]|1[0-2])\s*\/\s*(\d{2})\b/)
  if (e) out.expires = `20${e[2]}-${e[1]}`
  out.bank = BANKS.find((b) => text.includes(b)) ?? lines.find((l) => /银行/.test(l))?.replace(/\s/g, '') ?? ''
  if (/信用卡|CREDIT/i.test(text)) out.kind = '信用卡'
  else if (/借记卡|DEBIT|储蓄卡/i.test(text)) out.kind = '借记卡'
  const cvv = text.match(/(?:CVV2?|CVC2?|安全码)\s*:?\s*(\d{3,4})\b/i)
  if (cvv) out.cvv = cvv[1]
  return out
}

const bizlicense: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  out.uscc = compact(text).toUpperCase().match(/[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}/)?.[0] ?? ''
  out.company = after(lines, /^名\s*称/, /类\s*型/)
  out.kind = after(lines, /^类\s*型/, /法定代表人|负责人/)
  out.legal = after(lines, /法定代表人|负责人|经营者/, /经营范围|注册资本/)
  out.capital = after(lines, /注册资本/, /成立日期/)
  out.founded = ymd(after(lines, /成立日期|注册日期/))
  const term = compact(text).match(/营业期限:?(.{0,40})/)?.[1] ?? ''
  const r = range(term)
  if (r) out.expires = r[1]
  out.address = block(lines, /住\s*所|经营场所|主要经营场所/, /登记机关|^\d{4}年|国家企业信用/)
  out.scope = block(lines, /经营范围/, /注册资本|成立日期|营业期限|住\s*所/)
  return out
}

const degree: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  out.number = compact(text).match(/(?:证书编号|编号)[:]?([0-9A-Z]{8,20})/)?.[1] ?? compact(text).match(/\b\d{16,18}\b/)?.[0] ?? ''
  out.school = lines.find((l) => /大学|学院|学校/.test(l) && l.length <= 20)?.replace(/\s/g, '') ?? ''
  out.kind = text.match(/(博士|硕士|学士)学位/)?.[0] ?? (/毕业证/.test(text) ? '毕业证书' : '')
  out.name = after(lines, /^(?:姓名|学生)/)
  out.major = text.match(/在(.{2,20}?)专业/)?.[1] ?? after(lines, /专\s*业/)
  const d = text.match(/((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/g)
  if (d) out.date = ymd(d[d.length - 1])
  return out
}

const social: Parser = (lines, text) => ({
  name: after(lines, /姓\s*名/),
  number: findId(text) || (compact(text).match(/\b[A-Z0-9]{9,12}\b/)?.[0] ?? ''),
  bank: BANKS.find((b) => text.includes(b)) ?? '',
})

const generic: Parser = (lines, text) => {
  const out: Record<string, string> = {}
  out.name = after(lines, /姓\s*名/)
  out.number = after(lines, /(?:证件|证书)?(?:号码|编号)/).replace(/\s/g, '')
  out.authority = after(lines, /签发机关|发证机关/)
  const r = range(compact(text))
  if (r) [out.issued, out.expires] = r
  return out
}

const birth: Parser = (lines, text) => ({
  name: after(lines, /新生儿姓名|姓\s*名/),
  number: compact(text).match(/[A-Z]\d{9}/)?.[0] ?? '',
  birth: ymd(after(lines, /出生时间|出生日期/)),
  place: after(lines, /出生地点/),
})

/** 户口簿首页：户别、户主姓名、户号、住址；签发机关取派出所印章 */
const household: Parser = (lines, text) => ({
  head: after(lines, /户主姓名/, /户\s*号/),
  number: compact(text).match(/户号[:]?([0-9A-Z]{6,12})/)?.[1] ?? '',
  kind: after(lines, /户\s*别/, /户主/),
  address: block(lines, /住\s*址/, /承办人|签章|户口专用章|(?:19|20)\d{2}年/),
  // 印章那一行，优先取完整的「……派出所」
  authority:
    lines.map((l) => compact(l).match(/([\u4e00-\u9fa5]{2,30}派出所)/)?.[1]).find(Boolean) ??
    lines.map((l) => compact(l).match(/([\u4e00-\u9fa5]{2,30}(?:分局|公安局))/)?.[1]).find(Boolean) ??
    '',
})

/** 证件上的英文日期：12 Mar 2027 / 12-03-2027 / 2027-03-12 */
function anyDate(raw: string): string {
  // 中国护照：「05 1月/JAN 2016」，去掉中文月份
  // 识别时常把「05 1月」粘成「051月」：护照上的日总是两位
  const s = raw.replace(/(\d{2})\s*\d{1,2}\s*月\s*\/?/, '$1 ').replace(/\d{1,2}\s*月\s*\/?/, ' ')
  const iso = ymd(raw)
  if (iso) return iso
  const M = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC'
  const m = s.toUpperCase().match(new RegExp(`(\\d{1,2})\\s*[- ]?\\s*(${M})[A-Z]*\\s*[- ]?\\s*((?:19|20)\\d{2})`))
  if (m) return `${m[3]}-${pad(M.split('|').indexOf(m[2]) + 1)}-${pad(m[1])}`
  const d = s.match(/(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})/)
  return d ? `${d[3]}-${pad(d[2])}-${pad(d[1])}` : ''
}

/** 工作准证：新加坡 EP / S Pass / WP（FIN 号）、中国外国人工作许可证等 */
const workpermit: Parser = (lines, text) => {
  const c = compact(text).toUpperCase()
  const out: Record<string, string> = {}
  out.number = c.match(/\b[FGMST]\d{7}[A-Z]\b/)?.[0] ?? after(lines, /(?:FIN|证件号码|许可证号|证号|Permit\s*No\.?|No\.)/i).replace(/\s/g, '')
  out.name = after(lines, /姓\s*名|^Name/i)
  out.employer = after(lines, /工作单位|用人单位|Employer/i)
  out.position = after(lines, /职\s*位|Occupation|Position/i)
  if (/EMPLOYMENT\s*PASS/i.test(text)) out.kind = 'Employment Pass'
  else if (/S\s*PASS/i.test(text)) out.kind = 'S Pass'
  else if (/WORK\s*PERMIT/i.test(text)) out.kind = 'Work Permit'
  else if (/外国人工作许可/.test(text)) out.kind = '外国人工作许可证'
  if (/SINGAPORE|MINISTRY OF MANPOWER/i.test(text)) out.country = '新加坡'
  out.issued = anyDate(after(lines, /签发日期|Date of Issue/i))
  out.expires = anyDate(after(lines, /有效期至|Date of Expiry|Expiry Date|Valid Till/i))
  const r = range(c)
  if (r && !out.expires) [out.issued, out.expires] = r
  return out
}

const visa: Parser = (lines) => {
  const out: Record<string, string> = {}
  out.name = after(lines, /姓\s*名|Surname|^Name/i)
  out.number = after(lines, /签证号码|Visa\s*No|Control\s*Number|编号/i).replace(/\s/g, '')
  out.passport = after(lines, /护照号码|Passport\s*No/i).replace(/\s/g, '')
  out.kind = after(lines, /签证类型|Visa\s*Type|Type\s*of\s*Visa|Class/i)
  out.entries = after(lines, /入境次数|Entries|Number of entries/i)
  out.stay = after(lines, /停留期|Duration of Stay/i)
  out.issued = anyDate(after(lines, /签发日期|Issue\s*Date|Date of Issue/i))
  out.expires = anyDate(after(lines, /有效期至|Expiration Date|Expiry|Until/i))
  return out
}

const PARSERS: Record<string, Parser> = {
  workpermit, visa,
  idcard, passport, travel, driver, vehicle, bankcard, social, birth, degree, bizlicense,
  household, cert: generic, qualification: generic,
}

export const canRecognize = (type: string) => type in PARSERS

/** 识别结果 → 字段（只返回识别到内容的字段） */
export function parse(type: string, ocr: OcrLine[]): Record<string, string> {
  const boxes = ocr.map((l) => ({ ...l, text: norm(l.text) })).filter((l) => l.text)
  // 按行的规则只用常规识别结果；拉丁字母那一遍只给机读码用
  const lines = boxes.filter((b) => !b.latin).map((b) => b.text)
  const text = lines.join('\n')
  const out = (PARSERS[type] ?? generic)(lines, text, boxes)
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()]))
}
