# Google Drive / Google 文档接入配置

Cloud Notebook 用 OAuth 登录 Google 账号。每个组织需要在自己的 Google Cloud 项目里创建一个 OAuth 客户端，把「客户端 ID」和「客户端密钥」填进应用的「设置 → 云端同步 → Google Drive」。

整个过程约 10 分钟。

## 1. 创建 Google Cloud 项目

1. 打开 <https://console.cloud.google.com/>，用要管理这个应用的账号登录（国际部门建议用公司 Workspace 管理员账号）。
2. 顶部项目选择器 →「新建项目」，名称填 `Cloud Notebook`，组织选公司（如果有）→「创建」。

## 2. 启用 Google Drive API

1. 左侧菜单「API 和服务 → 库」。
2. 搜索 **Google Drive API** →「启用」。

> 发布为 Google 文档用的也是 Drive API（上传 HTML 并转换成文档、导出 Markdown），不需要额外启用 Google Docs API。

## 3. 配置 OAuth 同意屏幕

左侧「API 和服务 → OAuth 同意屏幕」（新版控制台叫「Google Auth Platform」）：

1. **用户类型**
   - **内部（Internal）**：只有公司 Workspace 里的账号能登录，**不需要 Google 审核**。国际部门用 Workspace 的话选这个。
   - **外部（External）**：任何 Google 账号都能用。测试阶段要在「测试用户」里逐个添加允许登录的邮箱（最多 100 个）；正式对外发布才需要提交审核。
2. 应用名称填 `Cloud Notebook`，用户支持邮箱和开发者联系邮箱填自己的。
3. **数据访问 / 范围**：添加以下三个范围
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/drive.file`

   `drive.file` 只允许应用访问**它自己创建的文件**，属于非敏感范围，外部应用正式发布时也不用走敏感范围审核。
4. 保存。

## 4. 创建 OAuth 客户端

1. 左侧「API 和服务 → 凭据」（或 Google Auth Platform 里的「客户端」）→「创建凭据 → OAuth 客户端 ID」。
2. **应用类型选「桌面应用」**，名称随意，如 `Cloud Notebook Desktop`。
3. 创建后会显示**客户端 ID**（形如 `123-abc.apps.googleusercontent.com`）和**客户端密钥**，复制下来。

> 桌面应用的客户端密钥按 Google 的说明不算机密信息（会随应用分发），但仍建议只在组织内部传递。

## 5. 在应用里登录

1. 打开 Cloud Notebook，按 ⌘, 打开设置。
2. 在「云端同步 → Google Drive」填入客户端 ID 和客户端密钥 →「保存」。
3. 点「登录 Google」，浏览器会打开 Google 登录页，授权后页面显示「登录成功」，回到应用即可。
4. 登录后会自动进行第一次同步。

## 同步规则

- 笔记库同步到 Drive「我的云端硬盘 / Cloud Notebook」，文件夹结构、.md 文件和 `assets/` 里的图片原样保留。
- 本地改动 5 秒后自动上传；云端改动每 2 分钟拉取一次；侧边栏底部可以看到同步状态，点击可立即同步。
- 两边同时改了同一篇笔记：云端版本另存为「笔记名 (Google Drive 冲突).md」，不会覆盖任何一方。
- 删除都进回收站：本地是笔记库里的 `.trash`，云端是 Drive 回收站（30 天内可恢复）。
- 因为只用了 `drive.file` 权限，**在 Drive 网页里手动放进 Cloud Notebook 文件夹的文件，应用看不到**。要放笔记请在应用里新建或拖进笔记库文件夹。

## Google 文档

编辑区右上角的「分享」按钮：

- **发布为 Google 文档**：把当前笔记转换成 Google 文档（图片、表格、代码块都会保留），放在 Drive「Cloud Notebook / Cloud Notebook 文档」里。以后点「用当前内容更新」会覆盖同一篇文档，链接不变。分享权限在 Google 文档里设置。
- **双向同步**：开启后，笔记保存 5 秒后自动更新文档；在 Google 文档里的修改会随同步拉回笔记。复杂格式（批注、建议修改、多栏排版等）拉回 Markdown 时会丢失。笔记和文档同时改过时，文档内容另存为「笔记名 (Google 文档冲突).md」。

## 常见问题

| 现象 | 处理 |
|---|---|
| 登录页提示「已屏蔽访问权限：此应用未经验证」 | 同意屏幕是「外部」且账号没加进测试用户；把邮箱加到测试用户，或改用「内部」 |
| 提示 `access_denied` / `org_internal` | 同意屏幕是「内部」，但用的不是本组织的 Workspace 账号 |
| 提示「登录已失效」 | 外部应用在测试状态下，refresh token 7 天过期；重新登录，或把应用发布为正式版 |
| 一直显示「等待浏览器授权」 | 授权页被关掉了；5 分钟后自动超时，重新点登录即可 |
