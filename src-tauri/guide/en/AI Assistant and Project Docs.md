# AI Assistant and Project Docs

![](assets/guide-ai.png)

There are two things here: asking AI inside the app, and letting outside AI coding tools save documents into it. Both only work after you turn them on yourself.

## Ask AI inside the app

First enter a provider's API key in "Settings → AI". OpenAI, Anthropic, Gemini, DeepSeek, Qwen (Tongyi Qianwen) and OpenRouter are supported, as well as other OpenAI-compatible APIs. The key is stored in the system keychain.

Press `⌘J` to open the AI panel. At the top you can choose what it draws on:

- **Entire library**: finds relevant content in your notes to answer with, and shows which notes it cited.
- **Current note**: answers only from the open note, including the images in it.

Select some text before opening the panel, and you can ask it to summarize, rewrite, continue or translate the selection directly.

The relevant text is sent to the provider you chose only when you ask a question.

## Let AI coding tools save documents here

When you write code with tools like Claude Code or Cursor, they leave plans, proposals and design documents in the repository. After a while it is hard to tell which one still counts.

Cloud Notebook has a built-in MCP server that lets these tools save documents straight into the matching project's folder in your library.

### Setup

Open "Settings → Project Docs", copy the command shown there, and run it once in the terminal.

After that, in any repository, say to the AI:

- "Save this plan to Cloud Notebook"
- "Tidy up the documents in this repo and import them into Cloud Notebook"
- "Which documents for this project are current in Cloud Notebook?"

The first time the AI saves a document in a repository, it creates a folder with the same name as the repository under "Project Docs". To use an existing folder instead, right-click it in the sidebar and choose "Bind Local Project Folder".

### Document status

Each document has a status:

| Status | Meaning |
|---|---|
| Current | This is the one to follow now |
| Draft | Written, but not decided yet |
| Superseded | A newer document has replaced it |
| Archived | Finished, or dropped |

When a new document replaces an old one, the old one is marked "Superseded" automatically. Superseded and archived documents are collapsed by default, and a row at the bottom of the list expands them. Right-click a note and choose "Document Status" to change it by hand.

The status is written in a few lines at the start of the file. The editor does not show them, and the file itself is still ordinary Markdown.

### What AI can touch

- It can only read and write the document folders of bound projects.
- It cannot read your other notes or touch the Vault.
- Importing copies files. The originals in the repository are not moved or deleted.
- In "Settings → Project Docs" you can turn off "Allow AI to write". With it off, AI can only read.

## Version history

Every note has a version history, not only the documents saved by AI.

Right-click a note and choose "Version History…". You can see earlier content, compare it with the current version line by line, or restore a version. The content from before the restore is also kept in the history, so you can restore it again.

When a note is modified, the content from before the change is saved automatically. During continuous editing, at most one version is kept every ten minutes. Version history is stored only on this computer and is not synced.

#Cloud-Notebook/Guide
