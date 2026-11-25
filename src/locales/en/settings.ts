/** settings 的英文词条：键是源码里的中文原文 */
const dict: Record<string, string> = {
  // ---- 设置：标签页 ----
  '通用': 'General',
  '排版': 'Typography',
  '主题': 'Theme',
  '项目文档': 'Project Docs',
  '存储与同步': 'Storage & Sync',
  '图床': 'Image Hosting',

  // ---- 设置：通用 ----
  '语言': 'Language',
  '跟随系统': 'System',
  '切换语言会重新加载窗口。': 'Changing the language reloads the window.',
  '新建笔记||设置项': 'New Notes',
  '以一级标题开头': 'Start with a level 1 heading',
  '标签位置': 'Tag Position',
  '笔记末尾': 'End of note',
  '标题下方': 'Below the title',
  '在某个标签下新建笔记时，自动写入的 #标签 放在哪里。': 'Where the #tag is inserted when you create a note under a tag.',
  '加密笔记||设置项': 'Encrypted Notes',
  '修改密码…': 'Change Password…',
  '设置密码…': 'Set Password…',
  '重新生成恢复密钥…': 'Regenerate Recovery Key…',
  '立即锁定': 'Lock Now',
  '自动锁定': 'Auto-Lock',
  '闲置 1 分钟': 'After 1 minute idle',
  '闲置 5 分钟': 'After 5 minutes idle',
  '闲置 15 分钟': 'After 15 minutes idle',
  '闲置 1 小时': 'After 1 hour idle',
  '退出应用前不锁定': 'Never, until the app quits',
  '编辑器': 'Editor',
  '标题左侧显示 H1–H6': 'Show H1–H6 beside headings',
  '缩放': 'Zoom',
  '恢复 100%': 'Reset to 100%',
  '⌘+ 放大 · ⌘- 缩小 · ⌥⌘0 恢复': '⌘+ Zoom In · ⌘- Zoom Out · ⌥⌘0 Reset',

  // ---- 设置：排版 ----
  '字体': 'Font',
  '系统无衬线（苹方）': 'System Sans-Serif',
  '衬线（宋体）': 'Serif',
  '等宽': 'Monospaced',
  '字号': 'Font Size',
  '行高': 'Line Height',
  '段落间距': 'Paragraph Spacing',
  '标题间距': 'Heading Spacing',
  '正文宽度': 'Text Width',
  '标题示例': 'Sample Heading',
  '这是一段正文示例，用来预览字号、行高和段落间距的效果。The quick brown fox jumps over the lazy dog.':
    'This is sample body text for previewing font size, line height, and paragraph spacing. The quick brown fox jumps over the lazy dog.',
  '第二段正文。': 'A second paragraph.',
  '恢复默认': 'Restore Defaults',

  // ---- 设置：主题 ----
  '外观': 'Appearance',
  '浅色': 'Light',
  '深色': 'Dark',
  '浅色外观下侧边栏用深空灰': 'Use a space gray sidebar in light appearance',
  '配色': 'Color Theme',

  // ---- 设置：AI ----
  '按 ⌘J 打开 AI 面板。配置任意一家服务商的 Key 即可使用，Key 存在系统钥匙串里，只在本机直连对应服务商。':
    'Press ⌘J to open the AI panel. Add a key for any provider to get started. Keys are stored in the system keychain, and requests go straight from this Mac to the provider.',
  '提问时只会发送检索到的相关片段，加密笔记永远不会被读取。': 'Only the relevant excerpts found for your question are sent. Encrypted notes are never read.',
  '默认模型': 'Default Model',
  'Key 已加密同步到你的其它设备（用加密笔记的密码保护，云端只存密文）。':
    'Keys are encrypted and synced to your other devices (protected by your encrypted notes password; the cloud only stores ciphertext).',
  '其它设备同步过来了 Key。输入加密笔记的密码（不是证件夹的主密码）后即可使用。':
    'Keys were synced from another device. Enter your encrypted-notes password (not the Vault master password) to use them.',
  '实验性': 'Experimental',
  'Google Drive 同步还在完善中。建议先保留一份笔记库的备份；遇到异常，回收站和版本历史里可以找回内容。':
    'Google Drive sync is still being refined. Keep a backup of your library; if something goes wrong, the Trash and version history let you get content back.',
  '解锁': 'Unlock',
  '解锁加密笔记后，Key 会加密同步到其它设备。': 'Unlock encrypted notes to sync your keys, encrypted, to your other devices.',
  '设置加密密码后，Key 会加密同步到你的其它设备（手机上不用重新填）。':
    'Set an encryption password to sync your keys, encrypted, to your other devices (no need to enter them again on your phone).',
  '设置密码': 'Set Password',
  '已配置': 'Configured',
  '{n} 个模型': '{n} model{s:n}',
  '收起': 'Hide',
  '配置': 'Configure',
  '接口地址': 'Base URL',
  '已保存在钥匙串（留空不修改）': 'Saved in keychain (leave blank to keep)',
  '手动添加': 'Add Manually',
  '接口没列出的模型名，回车添加': 'A model name the API does not list; press Return to add',
  '获取 Key': 'Get a Key',
  '删除 Key': 'Delete Key',
  '刷新模型列表': 'Refresh Model List',
  '处理中…': 'Working…',
  '保存': 'Save',
  '已保存到钥匙串': 'Saved to keychain',
  '获取到 {n} 个模型': 'Found {n} model{s:n}',
  '已删除': 'Deleted',
  '已保存': 'Saved',

  // ---- 设置：项目文档 ----
  '让 AI 编程工具把文档存进来': 'Let AI Coding Tools Save Documents Here',
  '用 Claude Code、Cursor 这类工具写代码时，计划、方案、设计文档会散落在各个仓库里。接入后，AI 可以把它们存进笔记库里对应项目的文件夹，并标明哪一份是当前有效的、哪一份已经被取代。仓库里的原文件不会被移动或删除。':
    'When you code with tools like Claude Code or Cursor, plans, proposals, and design docs end up scattered across repositories. Once connected, the AI can save them to the matching project folder in your library and mark which one is current and which has been superseded. The original files in the repository are never moved or deleted.',
  'AI 只能读写已绑定项目的文档文件夹，读不到其他笔记，也碰不到证件夹里的密钥和证件。':
    'The AI can only read and write the document folders of bound projects. It cannot read your other notes or reach the keys and documents in the Vault.',
  '在终端里运行一次：': 'Run this once in Terminal:',
  '已复制': 'Copied',
  '复制命令': 'Copy Command',
  'Cursor 等其他工具': 'Cursor and Other Tools',
  '把下面这段加进它的 MCP 配置文件：': 'Add this to the tool’s MCP configuration file:',
  '复制配置': 'Copy Configuration',
  '权限': 'Permissions',
  '允许 AI 写入（保存文档、改状态、导入）': 'Allow the AI to write (save documents, change status, import)',
  '关掉后 AI 只能读取项目文档。': 'When off, the AI can only read project documents.',
  '已绑定的项目': 'Bound Projects',
  '还没有。AI 第一次在某个仓库里保存文档时，会自动在「项目文档」下新建同名文件夹并绑定；也可以在侧边栏右键任意文件夹，选「绑定本地项目目录」。':
    'None yet. The first time the AI saves a document in a repository, a folder with the same name is created under “Project Docs” and bound automatically. You can also right-click any folder in the sidebar and choose “Bind Local Project Folder”.',
  '解除后，AI 在这个目录下保存文档时会新建一个项目文件夹。已有的文档保留。':
    'After unbinding, the AI will create a new project folder when it saves documents from this directory. Existing documents are kept.',
  '解除绑定': 'Unbind Project',
  '解除': 'Unbind',
  '取消': 'Cancel',

  // ---- 设置：图床 ----
  '笔记里的图片始终保存在本地。配置图床后，「复制为 Markdown（图床链接）」和导出时会把图片上传，换成网络地址，发给别人也能看到。':
    'Images in your notes are always stored locally. With image hosting set up, “Copy as Markdown (Hosted Image Links)” and export upload the images and use web URLs instead, so others can see them too.',
  '服务商': 'Provider',
  '区域': 'Region',
  '存储桶': 'Bucket',
  'bucket 名称': 'Bucket name',
  '路径前缀': 'Path Prefix',
  '公开访问地址': 'Public URL',
  '可选：CDN 或自定义域名，如 https://img.example.com': 'Optional: CDN or custom domain, e.g. https://img.example.com',
  '路径风格地址（endpoint/bucket/文件）': 'Path-style URLs (endpoint/bucket/file)',
  '清除配置': 'Clear Configuration',
  '测试中…': 'Testing…',
  '保存并测试': 'Save and Test',
  '连接正常，测试文件可公开访问：{url}': 'Connection OK. The test file is publicly accessible: {url}',
  '将删除图床配置和钥匙串里的密钥。已上传的图片不会被删除。':
    'This removes the image hosting configuration and the secret key from the keychain. Images already uploaded are not deleted.',
  '清除图床配置': 'Clear Image Hosting Configuration',
  '清除': 'Clear',

  // ---- 设置：存储与同步 ----
  '笔记库位置': 'Library Location',
  '切换时复制现有笔记': 'Copy existing notes when switching',
  '已在 iCloud Drive': 'Already in iCloud Drive',
  '放到 iCloud Drive': 'Move to iCloud Drive',
  '选择其他文件夹…': 'Choose Another Folder…',
  '放进 iCloud Drive 后，同一 Apple ID 的多台 Mac 会自动同步。': 'In iCloud Drive, the library syncs automatically across Macs signed in with the same Apple ID.',
  '本机没有开启 iCloud Drive。': 'iCloud Drive is not turned on for this Mac.',
  '笔记库将切换到：\n{path}\n\n现有笔记会复制过去，原文件夹保留不动。切换后应用会重启。':
    'The library will move to:\n{path}\n\nExisting notes will be copied there, and the original folder is left untouched. The app will restart after switching.',
  '笔记库将切换到：\n{path}\n\n不复制现有笔记。切换后应用会重启。':
    'The library will move to:\n{path}\n\nExisting notes will not be copied. The app will restart after switching.',
  '切换笔记库位置': 'Change Library Location',
  '切换并重启': 'Switch and Restart',
  '切换失败': 'Couldn’t Switch Library',
  '选择笔记库文件夹': 'Choose Library Folder',
  '填写 Google Cloud 里「iOS」类型 OAuth 客户端的 ID（软件包 ID 为 com.qxsclass.cloudnotebook）。':
    'Enter the ID of an “iOS” type OAuth client from Google Cloud (bundle ID: com.qxsclass.cloudnotebook).',
  'iOS 客户端 ID（xxx.apps.googleusercontent.com）': 'iOS client ID (xxx.apps.googleusercontent.com)',
  '先在': 'In the',
  'Google Cloud 控制台': 'Google Cloud Console',
  '创建 OAuth 客户端（桌面应用），把客户端 ID 和密钥填在下面。详细步骤见笔记「Google Drive / Google 文档接入配置」。':
    'create an OAuth client (Desktop app), then enter its client ID and client secret below. For detailed steps, see the note “Google Drive / Google Docs Setup”.',
  '客户端 ID（xxx.apps.googleusercontent.com）': 'Client ID (xxx.apps.googleusercontent.com)',
  '客户端密钥': 'Client secret',
  '等待浏览器授权…': 'Waiting for Browser Authorization…',
  '登录 Google': 'Sign In with Google',
  'Google 登录失败': 'Google Sign-In Failed',
  '退出': 'Sign Out',
  '退出 Google 账号': 'Sign Out of Google',
  '退出后停止同步。Drive 上的文件和本地笔记都会保留。': 'Syncing stops after you sign out. Files on Drive and your local notes are kept.',
  '自动同步': 'Sync automatically',
  '同步中…': 'Syncing…',
  '立即同步': 'Sync Now',
  '同步失败': 'Sync Failed',
  '同步出错：{error}': 'Sync error: {error}',
  '上次同步：{ago}。': 'Last synced: {ago}.',
  '笔记同步到 Drive 的「Cloud Notebook」文件夹，发布的 Google 文档放在其中的「Cloud Notebook 文档」。':
    'Notes sync to the “Cloud Notebook” folder on Drive. Published Google Docs go in its “Cloud Notebook 文档” subfolder.',
  '飞书云文档': 'Feishu Docs',
  '稍后支持': 'Coming Soon',
  '完成': 'Done',

  // ---- AI 面板 ----
  '问 AI': 'Ask AI',
  '从整个笔记库检索相关内容': 'Search the entire library for relevant content',
  '笔记库': 'Library',
  '只基于当前笔记': 'Use only the current note',
  '当前笔记': 'Current note',
  '整个笔记库': 'Entire library',
  '关闭 Esc': 'Close Esc',
  '基于：{name}': 'Based on: {name}',
  '会话历史': 'Chat History',
  '新会话': 'New Chat',
  '还没有会话': 'No chats yet',
  '未命名会话': 'Untitled Chat',
  '删除会话': 'Delete Chat',
  '先在设置里配置一个模型服务商的 API Key（Claude、OpenAI、DeepSeek、通义、OpenHubs 等都可以），就能基于你的笔记提问了。':
    'Add an API key for a model provider in Settings (Claude, OpenAI, DeepSeek, Qwen, OpenHubs, and others all work) to ask questions about your notes.',
  '去设置': 'Open Settings',
  '会从你的笔记里找相关内容来回答，并标出引用。': 'Answers draw on relevant content found in your notes, with citations.',
  '基于当前这篇笔记（包括里面的图片）回答。': 'Answers are based on the current note, including its images.',
  '可以粘贴截图、附加图片或 PDF。加密笔记不会被读取。': 'You can paste screenshots or attach images and PDFs. Encrypted notes are never read.',
  '附件||单个': 'Attachment',
  '复制': 'Copy',
  '插入到当前笔记光标处': 'Insert at the cursor in the current note',
  '插入笔记': 'Insert into Note',
  '已选中：{text}': 'Selected: {text}',
  '附加图片或 PDF': 'Attach Images or PDFs',
  '图片或 PDF': 'Images or PDFs',
  '最多附加 {n} 个文件': 'You can attach up to {n} file{s:n}',
  '截图 {n}.png': 'Screenshot {n}.png',
  '问点什么…（Enter 发送，Shift+Enter 换行）': 'Ask anything… (Enter to send, Shift+Enter for a new line)',
  '停止': 'Stop',
  '发送': 'Send',
  '总结这篇笔记的要点': 'Summarize the key points of this note',
  '这篇笔记里有哪些待办？': 'What to-dos are in this note?',
  '帮我列一个大纲': 'Draft an outline for me',
  '我最近在关注哪些事情？': 'What have I been focusing on lately?',
  '帮我找找关于某个主题的笔记': 'Help me find notes on a topic',
  '已中断': 'Interrupted',
  '已停止': 'Stopped',

  // ---- AI：快捷操作（标签和发给模型的指令） ----
  '总结': 'Summarize',
  '改写': 'Rewrite',
  '续写': 'Continue',
  '翻译': 'Translate',
  '请看附件': 'Please look at the attachments.',
  '用几条要点总结选中的内容。': 'Summarize the selected content in a few bullet points.',
  '把选中的内容改写得更通顺、更简洁，保持原意。': 'Rewrite the selected content so it reads more smoothly and concisely, keeping the original meaning.',
  '顺着选中内容的风格和思路续写一段。': 'Continue the selected content with one more passage in the same style and line of thought.',
  '把选中的内容翻译成英文（如果原文是英文就翻译成中文）。': 'Translate the selected content into English (or into Chinese if the original is in English).',

  // ---- AI：发给模型的系统提示词和上下文 ----
  '你是 Cloud Notebook 笔记应用里的助手，帮用户基于他们自己的笔记回答问题、整理和写作。':
    'You are the assistant inside the Cloud Notebook notes app. You help users answer questions, organize, and write based on their own notes.',
  '- 用户消息里可能附带若干笔记片段（文档）。问题和这些笔记相关时，以笔记内容为依据回答，并引用对应片段。':
    '- The user message may include several note excerpts (documents). When the question relates to these notes, base your answer on their content and cite the relevant excerpts.',
  '- 笔记里找不到答案时，直接说明「笔记里没有提到」，再视情况用你的通用知识补充，并明确区分哪些来自笔记、哪些是你的补充。':
    '- When the notes do not contain the answer, say plainly that the notes do not mention it, then add from your general knowledge where appropriate, clearly separating what comes from the notes from what you are adding.',
  '- 用户选中了文字时，问题通常是针对这段文字的（总结、改写、续写、解释等）。':
    '- When the user has selected text, the question is usually about that text (summarize, rewrite, continue, explain, and so on).',
  '- 用户可能附上图片、PDF，或笔记里的图片；问题提到「图」「截图」「附件」时，以这些内容为依据。':
    '- The user may attach images or PDFs, or images from the note may be included. When the question mentions a picture, screenshot, or attachment, base your answer on them.',
  '- 用和用户相同的语言回答，用 Markdown 排版，简洁直接，不要寒暄。':
    '- Answer in the language the user writes in, format with Markdown, and be concise and direct, with no pleasantries.',
  '- 资料按 [1]、[2] 编号给出。引用资料时，在相应句子末尾标注编号，如「……[2]」；只使用给出的编号，不要编造。':
    '- The sources are numbered [1], [2], and so on. When you draw on a source, put its number at the end of the sentence, like “… [2]”. Use only the numbers provided and never invent one.',
  '笔记路径：{path}': 'Note path: {path}',
  '笔记中的图片：{name}': 'Image in the note: {name}',
  '我附上的图片：{name}': 'Image I attached: {name}',
  '我在笔记里选中的文字：\n\n{text}': 'The text I selected in the note:\n\n{text}',
  '[{n}] 《{heading}》（{path}）\n{text}': '[{n}] “{heading}” ({path})\n{text}',
  '以下是从我的笔记里找到的资料：\n\n{sources}\n\n': 'Here are the sources found in my notes:\n\n{sources}\n\n',
  '附图：{names}': 'Attached images: {names}',
  '、': ', ',
  '（回答太长，已截断）': '(The answer was too long and has been cut off.)',

  // ---- AI：错误提示 ----
  '这个问题被模型拒绝回答了，换个问法试试。': 'The model declined to answer this question. Try rephrasing it.',
  'API Key 无效或已被撤销，请在「设置 → AI」里重新填写。': 'The API key is invalid or has been revoked. Enter it again in Settings → AI.',
  '这个 API Key 没有调用该模型的权限。': 'This API key does not have permission to use this model.',
  '请求太频繁或额度用完了，请稍后再试，或检查 Anthropic 控制台里的用量。':
    'Too many requests, or your quota has run out. Try again later, or check your usage in the Anthropic Console.',
  '请求有误：{message}': 'Invalid request: {message}',
  '连不上 Anthropic 服务器，请检查网络或代理设置。': 'Couldn’t connect to Anthropic. Check your network or proxy settings.',
  'AI 服务出错（{status}）：{message}': 'AI service error ({status}): {message}',
  '未知的服务商：{provider}': 'Unknown provider: {provider}',
  '还没有设置 {name} 的接口地址，请在「设置 → AI」里填写': 'No base URL is set for {name}. Enter one in Settings → AI.',
  '当前模型不支持直接读取 PDF。请切换到 Claude，或把 PDF 里的文字复制进来。':
    'This model cannot read PDFs directly. Switch to Claude, or paste in the text from the PDF.',
  '{name} 目前不支持图片输入，请切换到其他模型。': '{name} does not support image input yet. Switch to another model.',

  // ---- AI：模型和服务商 ----
  '最强，回答最细致（默认）': 'Most capable, most thorough answers (default)',
  '更快，日常问答足够': 'Faster, plenty for everyday questions',
  '最快最便宜，适合简单任务': 'Fastest and cheapest, good for simple tasks',
  'Claude（Anthropic）': 'Claude (Anthropic)',
  '通义千问（阿里云百炼）': 'Qwen (Alibaba Cloud Bailian)',
  '自定义（OpenAI 兼容）': 'Custom (OpenAI-compatible)',
  '支持原文引用和直接读取 PDF，效果最好。': 'Supports verbatim citations and reads PDFs directly. Best results.',
  '一个 Key 调用 Claude、GPT、Gemini 等多家模型。可用模型见控制台「模型广场」。':
    'One key for Claude, GPT, Gemini, and other models. See the “Model Plaza” in its console for available models.',
  '国内可直连。目前不支持图片输入。': 'Directly reachable from mainland China. Image input is not supported yet.',
  '国内可直连。国际站请把地址改成 dashscope-intl.aliyuncs.com。图片需选带 vl 的模型。':
    'Directly reachable from mainland China. For the international site, change the address to dashscope-intl.aliyuncs.com. For images, pick a model with “vl” in its name.',
  '任何兼容 OpenAI 接口的服务，例如本机的 Ollama、LM Studio。': 'Any service compatible with the OpenAI API, such as Ollama or LM Studio on this Mac.',
  '软件更新': 'Updates',
  '自动检查新版本': 'Check for new versions automatically',
  '正在检查…': 'Checking…',
  '立即检查': 'Check Now',
  '当前版本 {v}。检查更新时会访问 GitHub，不发送任何笔记内容；更新包校验签名后才会安装。': 'Current version {v}. Checking contacts GitHub and sends none of your notes; an update is installed only after its signature is verified.',
}
export default dict
