# Changelog

Notable changes in each version. 中文：[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

## 0.8.0

First public release.

### Notes

- Notes are plain Markdown files in a folder you choose. Live editor with a source mode, outline, tables, task lists, code blocks and `==highlight==`.
- Folders, tags with nesting, pinning, manual ordering, multi-select with batch actions, trash with restore.
- Full-text search across all notes (works for Chinese), find and replace inside a note.
- Version history for every note, with line-by-line comparison and restore. History stays on this Mac.
- Encrypted notes (AES-256-GCM, key derived with Argon2id).
- Export to PDF, Word, HTML and Markdown bundles. Paste from Bear keeps headings, lists and images.
- Seven themes, light and dark appearance, editor zoom, resizable panes.
- English and Simplified Chinese interface, with a built-in user guide in both languages.

### Vault and projects

- Encrypted storage for API keys, LLM keys, accounts, certificates and identity documents, with Touch ID unlock.
- LLM keys are recognized from their prefix. Keys can be copied as `.env` lines. Reminders before keys and documents expire.
- Identity documents are read from a photo on device.

### Project documents for AI coding

- Built-in MCP server (`app mcp`) for Claude Code, Cursor and other MCP clients.
- Documents carry a status: current, draft, superseded or archived. Superseded and archived documents are folded away.
- Scan a repository for Markdown files and import them. Originals are copied, never moved.
- Agents are confined to the document folders of the project they were started in.

### Sync and AI (optional)

- iCloud Drive.
- Google Drive with your own OAuth client (experimental).
- AI assistant with your own API key for OpenAI, Anthropic, Gemini, DeepSeek, Qwen, OpenRouter and compatible endpoints.
- Image hosting on your own S3-compatible storage.

### Updates

- Checks for new versions automatically and installs them after verifying their signature. Can be turned off in Settings → General.
- After an update, the first launch shows what changed; it stays available under the Help menu.

### Security

- Reviewed before release; see [SECURITY.md](SECURITY.md) for how to report problems and for known limitations.
