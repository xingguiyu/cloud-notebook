/** templates 的英文词条：键是源码里的中文原文 */
const dict: Record<string, string> = {
  // ---- 分组 ----
  '个人证件': 'Personal IDs',
  '银行与金融': 'Banking & Finance',
  '账号与密钥': 'Accounts & Keys',
  '公司证照': 'Company Documents',
  '项目文件': 'Project Files',
  '其它': 'Other',

  // ---- 通用字段 ----
  '姓名': 'Name',
  '签发日期': 'Issue Date',
  '有效期至': 'Expires',
  '长期有效可留空': 'Leave blank if valid indefinitely',
  '签发机关': 'Issuing Authority',
  '用途 / 说明': 'Notes',
  '这个文件是干什么用的、在哪里配置': 'What this is for and where it is configured',

  // ---- 身份证 ----
  '身份证': 'Resident ID Card',
  '公民身份号码': 'ID Number',
  '性别': 'Sex',
  '民族': 'Ethnicity',
  '出生日期': 'Date of Birth',
  '住址': 'Address',

  // ---- 护照 ----
  '护照': 'Passport',
  '英文姓名': 'Name (Latin)',
  '护照号码': 'Passport No.',
  '国籍': 'Nationality',
  '出生地点': 'Place of Birth',
  '签发地点': 'Place of Issue',

  // ---- 港澳台通行证 ----
  '港澳台通行证': 'Exit-Entry Permit (HK/Macau/Taiwan)',
  '证件号码': 'Document No.',
  '签注': 'Endorsements',

  // ---- 工作准证 ----
  '工作准证 / 工作许可': 'Work Pass / Work Permit',
  '准证类型': 'Pass Type',
  '如 EP / S Pass / 外国人工作许可证': "e.g. EP / S Pass / Foreigner's Work Permit",
  '如 FIN、许可证号': 'e.g. FIN, permit number',
  '雇主 / 工作单位': 'Employer',
  '职位': 'Position',
  '签发国家 / 地区': 'Issuing Country / Region',

  // ---- 签证 ----
  '签证 / 居留许可': 'Visa / Residence Permit',
  '国家 / 地区': 'Country / Region',
  '签证类型': 'Visa Type',
  '如 商务 B1/B2、申根 C、居留许可': 'e.g. Business B1/B2, Schengen C, residence permit',
  '签证号码': 'Visa No.',
  '对应护照号': 'Passport No.',
  '入境次数': 'Entries',
  '单次 / 多次': 'Single / Multiple',
  '每次停留': 'Duration of Stay',
  '如 90 天': 'e.g. 90 days',

  // ---- 驾驶证 ----
  '驾驶证': "Driver's License",
  '证号': 'License No.',
  '档案编号': 'File No.',
  '准驾车型': 'Vehicle Class',
  '初次领证日期': 'First Issue Date',

  // ---- 行驶证 ----
  '行驶证': 'Vehicle License',
  '号牌号码': 'Plate No.',
  '所有人': 'Owner',
  '品牌型号': 'Make & Model',
  '车辆识别代号': 'VIN',
  '发动机号码': 'Engine No.',
  '注册日期': 'Registration Date',
  '检验有效期至': 'Inspection Valid Until',

  // ---- 学历学位证书 ----
  '学历学位证书': 'Diploma / Degree Certificate',
  '证书类型': 'Certificate Type',
  '毕业证 / 学士学位 / 硕士学位…': "Diploma / Bachelor's / Master's…",
  '证书编号': 'Certificate No.',
  '学校': 'School',
  '专业': 'Major',
  '授予日期': 'Date Awarded',
  '学信网验证码': 'CHSI Verification Code',

  // ---- 出生医学证明 ----
  '出生医学证明': 'Birth Certificate',
  '证明编号': 'Certificate No.',
  '父母': 'Parents',

  // ---- 户口簿 ----
  '户口簿': 'Household Register',
  '户主': 'Head of Household',
  '户别': 'Household Type',
  '家庭户 / 集体户': 'Family / Collective',
  '户号': 'Household No.',

  // ---- 社保卡 ----
  '社保卡 / 医保卡': 'Social Security Card / Medical Insurance Card',
  '卡号': 'Card Number',
  '金融账户所属银行': 'Linked Bank',
  '密码': 'Password',
  '其它证件': 'Other ID',

  // ---- 银行卡 ----
  '银行卡': 'Bank Card',
  '发卡行': 'Issuing Bank',
  '持卡人': 'Cardholder',
  '卡类型': 'Card Type',
  '借记卡 / 信用卡': 'Debit / Credit',
  '有效期': 'Expiry',
  '安全码（CVV）': 'Security Code (CVV)',
  '取款 / 支付密码': 'PIN',
  '开户网点': 'Branch',
  '预留手机号': 'Registered Phone',

  // ---- 银行账户（对公） ----
  '银行账户（对公）': 'Bank Account (Corporate)',
  '户名': 'Account Name',
  '账号': 'Account Number',
  '开户行': 'Bank',
  'SWIFT / 联行号': 'SWIFT / CNAPS Code',
  'U 盾 / 网银密码': 'USB Key / Online Banking Password',

  // ---- 保险单 ----
  '保险单': 'Insurance Policy',
  '保险公司': 'Insurer',
  '保单号': 'Policy No.',
  '被保险人': 'Insured',
  '险种': 'Coverage Type',
  '保额': 'Sum Insured',
  '生效日期': 'Effective Date',
  '客服电话': 'Customer Service Phone',

  // ---- 网站登录 ----
  '网站登录': 'Website Login',
  '网址': 'URL',
  '用户名 / 邮箱': 'Username / Email',
  '两步验证密钥': 'Two-Factor Secret',
  '网站给的 TOTP 密钥（Base32）': 'TOTP secret from the website (Base32)',

  // ---- 接口 API Key ----
  '接口 API Key': 'API Key',
  '服务': 'Service',
  '如 高德地图、Stripe、阿里云短信、SendGrid': 'e.g. Amap, Stripe, Alibaba Cloud SMS, SendGrid',
  '环境': 'Environment',
  '生产 / 测试 / 沙箱': 'Production / Test / Sandbox',
  'App ID / 应用': 'App ID / App',
  '控制台地址': 'Console URL',
  '接口文档': 'API Docs',

  // ---- 服务器 ----
  '服务器': 'Server',
  '主机': 'Host',
  '端口': 'Port',
  '用户名': 'Username',
  '私钥': 'Private Key',
  '面板地址': 'Panel URL',

  // ---- Wi-Fi ----
  '网络名称': 'Network Name',
  '加密方式': 'Security',

  // ---- 软件授权 ----
  '软件授权': 'Software License',
  '软件': 'Software',
  '授权码': 'License Key',
  '注册邮箱': 'Registered Email',
  '订单号': 'Order No.',

  // ---- 营业执照 ----
  '营业执照': 'Business License',
  '名称': 'Name',
  '统一社会信用代码': 'Unified Social Credit Code',
  '类型': 'Type',
  '法定代表人': 'Legal Representative',
  '注册资本': 'Registered Capital',
  '成立日期': 'Date of Establishment',
  '营业期限至': 'Business Term Until',
  '长期可留空': 'Leave blank if indefinite',
  '住所': 'Registered Address',
  '经营范围': 'Business Scope',

  // ---- 资质证照 ----
  '资质证照': 'Qualifications & Permits',
  '证照名称': 'Certificate Name',
  '如 ICP 许可证、软件著作权、商标注册证': 'e.g. ICP license, software copyright, trademark certificate',
  '编号': 'Number',
  '持有人': 'Holder',

  // ---- 合同 ----
  '合同': 'Contract',
  '合同编号': 'Contract No.',
  '对方': 'Counterparty',
  '金额': 'Amount',
  '签订日期': 'Date Signed',
  '开始日期': 'Start Date',
  '到期日期': 'End Date',
  '对方联系人': 'Counterparty Contact',

  // ---- 文件 ----
  '文件类型': 'Document Type',
  '如 章程、需求文档、证明': 'e.g. articles of association, requirements doc, certificate',
  '文号 / 版本': 'Reference No. / Version',
  '日期': 'Date',

  // ---- 证书 ----
  '证书': 'Certificate',
  '如 Apple 发布证书、SSL 证书': 'e.g. Apple distribution certificate, SSL certificate',
  '使用者': 'Subject',
  '颁发者': 'Issuer',
  '序列号': 'Serial Number',
  '证书密码': 'Certificate Password',
  'p12 导出时设的密码': 'Password set when exporting the .p12',

  // ---- 大模型 Key ----
  '大模型 Key': 'LLM Key',
  '服务商': 'Provider',
  'OpenAI / Anthropic / Gemini / DeepSeek / 中转站…': 'OpenAI / Anthropic / Gemini / DeepSeek / proxy…',
  '接口地址 (Base URL)': 'Base URL',
  '常用模型': 'Default Model',
  '如 claude-opus-5-5、gpt-5': 'e.g. claude-opus-5-5, gpt-5',
  '组织 / 项目 ID': 'Organization / Project ID',
  '登录账号': 'Login Account',
  '额度 / 限额': 'Quota / Limit',
  '如 每月 $50、余额用完为止': 'e.g. $50 per month, until the balance runs out',
  // ---- 密钥文件 ----
  '密钥文件': 'Key File',
  '密钥类型': 'Key Type',
  '如 APNs 密钥 (.p8)、SSH 私钥、服务账号': 'e.g. APNs key (.p8), SSH private key, service account',
  'Team ID / 账号': 'Team ID / Account',
  '服务 / 平台': 'Service / Platform',
  '密钥口令': 'Passphrase',

  // ---- 描述文件 ----
  '描述文件': 'Provisioning Profile',
  '开发 / Ad Hoc / App Store / 企业': 'Development / Ad Hoc / App Store / Enterprise',
  '团队': 'Team',

  // ---- 发票 ----
  '发票': 'Invoice',
  '发票号码': 'Invoice No.',
  '开票日期': 'Invoice Date',
  '价税合计': 'Total (incl. Tax)',
  '销售方': 'Seller',
  '购买方': 'Buyer',
  '项目内容': 'Items',
  '状态': 'Status',
  '如 已报销、待报销': 'e.g. reimbursed, pending reimbursement',

  // ---- 项目 ----
  '项目||单个': 'Project',
  '客户 / 公司': 'Client / Company',
  '进行中 / 暂停 / 已结束': 'Active / Paused / Ended',
  '代码仓库': 'Repository',
  '控制台 / 后台': 'Console / Admin',

  // ---- 其它 ----
  '安全笔记': 'Secure Note',
  '内容': 'Content',
  '自定义': 'Custom',
}
export default dict
