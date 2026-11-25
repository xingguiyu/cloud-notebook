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

## License of contributions

The project is published under AGPL-3.0. So that it can also be offered under other terms later (for example a more permissive license, or commercial terms for a hosted or team edition), contributions are accepted on these terms:

- You keep the copyright in what you contribute.
- You license your contribution to everyone under AGPL-3.0, like the rest of the project.
- You also grant the project's copyright holder, Samuel Xing (XING GUIYU), a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and distribute your contribution under any license, including proprietary ones.
- You confirm that you wrote the contribution yourself, or otherwise have the right to submit it on these terms, and that it does not knowingly include code under a license that conflicts with them.

Opening a pull request means you agree to this. If you cannot agree, please open an issue describing the change instead of sending code.

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
- **贡献的许可**：项目以 AGPL-3.0 发布。为了以后还能以其他条款提供（比如更宽松的许可证，或托管版、团队版的商业条款），贡献按以下条件接受：
  - 你保留自己贡献内容的版权。
  - 你的贡献和项目其余部分一样，以 AGPL-3.0 许可给所有人。
  - 你同时授予项目版权人 Samuel Xing (XING GUIYU) 一项永久、全球、非独占、免版税、不可撤销的许可，可以在任何许可证（包括专有许可证）下使用、修改、再许可和分发你的贡献。
  - 你确认贡献是你自己写的，或者你有权按这些条件提交，并且没有故意包含许可证与之冲突的代码。
  
  提交 PR 即表示同意。不能同意的话，请开 issue 描述改动，而不是直接提交代码。
