---
name: cloud-notebook-docs
description: Save plans, designs, specs and reports into the user's Cloud Notebook project instead of leaving loose Markdown files in the repository, and tidy up Markdown files that are already scattered there. Use when you are about to write a planning or design document, when you finish one, or when the user asks which document is current or asks to clean up project docs.
---

# Cloud Notebook project documents

The `cloud-notebook` MCP server stores a project's documents in the user's notes library. Each document has a status, so the user can always tell which one to follow:

| Status | Meaning |
|---|---|
| `current` | The version to follow |
| `draft` | Written but not agreed yet |
| `superseded` | Replaced by a newer document |
| `archived` | Finished or abandoned |

The project is resolved from the working directory. You do not need to pass `dir`.

## Writing a document

1. Call `list_docs` first. Check whether a document on this topic already exists.
2. If it exists and you are revising it, call `save_doc` with the **same title**. The previous content is kept as a version automatically.
3. If you are replacing it with a different document, call `save_doc` with a new title and put the old document's path in `supersedes`. The old one is marked superseded.
4. Set `type` (plan, design, spec, research, report, notes) and use `status: "draft"` until the user has agreed to it.

Do not also leave a copy of the document in the repository unless the user asks for one.

## Tidying up a repository

1. Call `scan_repo`. It lists the Markdown files and whether each is `new`, `same` or `changed` compared with what was imported before.
2. Skip files that belong to the code base itself: README, CHANGELOG, LICENSE, API docs, anything under a package or vendor directory.
3. Read the remaining candidates. Work out which ones cover the same topic and which is the latest.
4. Tell the user what you plan to import and what you consider superseded, and wait for agreement.
5. Call `import_files` once with all of them. For a file that replaces another, list the older file's repository path in `supersedes`. Use `status: "archived"` for documents about work that is finished.

Importing copies files. Never delete or move the originals unless the user asks.

## Limits

- The server only reaches the document folders of bound projects. It cannot read the user's other notes or anything in the vault (keys, accounts, documents).
- If a write is refused, the user has switched off "允许 AI 写入" in Cloud Notebook's settings. Tell them instead of retrying.
