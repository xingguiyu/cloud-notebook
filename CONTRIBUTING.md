# Contributing

Thanks for taking the time. Bug reports, translations and code are all welcome.

中文说明在下面。

## Reporting a problem

Open an issue with the app version (Cloud Notebook → About), your macOS version, what you did, what you expected and what happened. Screenshots help.

For anything security related, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Setting up

Requirements: Rust 1.95+, Node 22+, pnpm 10+, Xcode command line tools.

```sh
pnpm install
pnpm tauri dev
```

A development build keeps its own secrets in a plaintext file (`dev-secrets.json` in the app's config directory) and does not read the keychain of an installed release build. Do not use a development build for real keys.

## Before you open a pull request

Run the same checks CI runs:

```sh
python3 scripts/i18n-check.py   # every interface string has a translation
pnpm test                       # front-end unit tests
pnpm build                      # type check and bundle
cd src-tauri && cargo test      # Rust tests
```

A few conventions that keep the code base consistent:

- **Interface text** goes through `t('中文原文')` (or `$t(...)` in templates). The Chinese source string is the key; add the English translation to the matching file in `src/locales/en/`. See the Translations section of the README.
- **Paths from outside the app** (the interface, sync, MCP tools) are never joined to a directory without validation. Use `vault::resolve` or `docs::no_symlinks`, and add a test for the hostile case.
- **Anything rendered with `v-html`** goes through `src/safeHtml.ts`. Do not post-process rendered HTML with string replacement.
- **A change that can lose user data** (sync, trash, history, file writes) needs a test that shows the old content survives.
- Comments explain why, not what, and are written in Chinese in the existing code. English is fine in new files.
- Keep pull requests focused: one change per pull request.

## Translations

To add a language, follow the four steps in the README's Translations section. A partial translation is fine: missing strings fall back to Chinese, and `scripts/i18n-check.py` lists what is left.

## License

By contributing you agree that your contribution is licensed under AGPL-3.0, the license of the project.

---

## 中文说明

欢迎提交问题、翻译和代码。

- **报告问题**：提 issue 时请写明应用版本、macOS 版本、操作步骤、预期结果和实际结果。安全问题不要公开提，按 [SECURITY.md](SECURITY.md) 的方式私下报告。
- **本地运行**：`pnpm install` 后运行 `pnpm tauri dev`。开发版的密钥存在明文文件里，不要用它保存真实密钥。
- **提交前**：运行上面四条检查命令，和 CI 跑的一样。
- **约定**：
  - 界面文字用 `t('中文原文')`，并在 `src/locales/en/` 里补上英文。
  - 来自界面、同步、MCP 的路径必须先校验再使用，并为恶意输入写测试。
  - 用 `v-html` 渲染的内容必须经过 `src/safeHtml.ts`。
  - 可能丢数据的改动（同步、回收站、历史、写文件）要有测试证明旧内容不会丢。
- **许可**：提交的贡献按项目的 AGPL-3.0 许可发布。
