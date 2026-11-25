# Vault and Project Keys

![](assets/guide-vault.png)

"Vault" and "Projects" in the sidebar store things that should not be written in ordinary notes: keys, accounts and ID documents. Everything in them is encrypted, and you need your password or Touch ID to unlock and view it.

## First use

The first time you open it, you are asked to set a password and are given a recovery key.

**Write the recovery key down and keep it somewhere else.** If you forget the password and don't have the recovery key, nobody can open the contents, including us.

## Projects: keys and files kept by project

Create a project in "Projects" and put everything the project uses into it:

- **LLM key**: paste the key. The app recognizes the provider from the prefix and fills in the API endpoint and console link automatically.
- **API key**: you can record the environment (test, production), App ID and documentation URL.
- **Accounts**: admin consoles, servers, databases.
- **Certificates and key files**: drag in files such as `.p12`, `.pem` or `.mobileprovision`. The app reads out the expiry date, Team ID and other details.

### Copy as .env

Open an LLM key or API key and click the ".env" button. It is copied like this:

```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

Paste it straight into the project's `.env` file.

### Expiry reminders

Fill in "Expires" for a key or certificate. Within 30 days before it expires, the app sends a system notification to remind you, at most once a day. The project list shows an exclamation mark when something in a project is about to expire.

## Vault: personal ID documents

There are ready-made templates for ID cards, passports, bank cards, academic certificates and more.

Take a photo of a document and drag it in. The app recognizes the text on this Mac and fills in the name, number and expiry date automatically. Recognition uses a feature built into the system, and the photo is not uploaded.

## How security works

- Contents are encrypted with AES-256-GCM.
- The encryption key is derived from your password with Argon2id and exists only on this computer.
- Unlocking with Touch ID is supported.
- Neither the AI assistant nor MCP can read what is in the Vault.

#Cloud-Notebook/Guide
