# Security Policy

Cloud Notebook stores API keys, accounts and identity documents, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Include the app version, macOS version, and steps to reproduce.

You can expect a first reply within 7 days. Once a fix is released, the report is credited in the release notes unless you prefer otherwise.

## Scope

In scope:

- Reading vault contents or encrypted notes without the password
- Weaknesses in key derivation or encryption (`src/crypto.ts`, `src-tauri/src/kdf.rs`)
- Leaking keys, tokens or note contents to a third party
- Code execution through a crafted note, pasted content or imported file

Out of scope:

- Attacks that need an already unlocked app on a compromised Mac
- Issues in the third-party services you connect (Google Drive, AI providers, object storage)

## Known limitations

These are design limits of the current version, not undiscovered bugs. Reports that improve on them are welcome.

- **Offline guessing.** The wrapped keys for encrypted notes and for the vault are stored next to the data and sync with it. Anyone who obtains those files can try passwords offline, slowed only by Argon2id (64 MiB, 3 passes). Use a strong password.
- **Touch ID is a convenience, not a second lock.** The vault key is kept in the macOS keychain as an ordinary item for this app. The fingerprint check happens in the app before reading it; the keychain item itself is not bound to biometrics.
- **Encrypted notes keep their title and images in the clear.** The first heading stays readable so the note can be listed, and images are stored as ordinary files.
- **History is local and unencrypted.** Earlier versions of notes live in `.history` inside the library. Encrypting a note deletes its history, but copies that a cloud service kept in its own revision history are out of the app's reach.
- **Changing a password does not rotate the data key.** An old copy of the key file, opened with the old password, still unlocks the data.
- **The app window is trusted.** Back-end commands accept file paths from the interface (export, import). The interface is protected by a Content Security Policy and by sanitizing everything it renders, but a script that did run in the window would have the user's file access.
- **MCP agents can read the documents of bound projects.** That is the feature. They cannot reach other notes, the vault, or directories outside the project they were started in.
- **Debug builds are not for real data.** They keep secrets in a plaintext file (`dev-secrets.json` in the app's config directory) instead of the keychain.

## 中文说明

发现安全问题请不要提公开 issue。请在本仓库的 **Security** 页面点 **Report a vulnerability** 私下报告，并附上应用版本、系统版本和复现步骤。7 天内会有首次回复。
