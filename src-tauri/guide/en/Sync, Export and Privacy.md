# Sync, Export and Privacy

![](assets/guide-sync.png)

If you change no settings, your notes stay on this computer only. Everything below is optional.

## Where notes are kept

By default, in "Documents / Cloud Notebook". You can change the location in "Settings → Storage & Sync".

## iCloud Drive

In "Settings → Storage & Sync", put the library in iCloud Drive. The system then syncs it automatically between Macs that use the same Apple ID. This is the easiest way.

## Google Drive

You need to create an OAuth client in your own Google Cloud project, enter the client ID and secret in "Settings → Storage & Sync", and then sign in. This is so that data travels only between your computer and your own Google Drive, without passing through any third-party server.

- The app can only access the files it created in your Drive. It cannot read other files.
- When the same note is changed on both sides, a conflict copy is kept and nothing is overwritten.
- Notes or folders you don't want to upload can be marked "This Mac only": click the "Publish & Share" button at the top right of the editor and choose it under the sync location.

From the same button you can also publish a note as a Google Doc, to send to people who don't use Markdown.

## Encrypted notes

Right-click a note and choose "Encrypt…". An encrypted note is ciphertext both on disk and in the cloud, and you need to enter the password to view it.

- Encrypted notes have their own password, separate from the Vault password. Set and change it in "Settings → General". It also comes with a recovery key that you need to keep safe.
- `⌥⌘L` locks all encrypted notes immediately. You can also set up auto-lock in "Settings → General".
- Encrypted notes are not included in full-text search.

## Export

Right-click a note and choose "Export…", or use the menu "File → Export As".

| Format | Good for |
|---|---|
| PDF | Printing and sending, with several layout templates |
| Word | People who need to edit the draft |
| HTML | A single web page file with images embedded |
| Markdown archive | `.md` plus images, packed into a zip |
| Markdown (Hosted Images) | Pasting into a blog or WeChat Official Account editor |

`⌘P` prints directly.

## Image hosting

In "Settings → Image Hosting", enter your own object storage (S3, Alibaba Cloud OSS, Tencent Cloud COS and so on). After that, right-click a note and choose "Copy as Markdown (Hosted Images)". The images are uploaded and replaced with public links, which is handy for pasting the note elsewhere.

## Where your data goes

| Feature | What is sent | Who it goes to |
|---|---|---|
| Sync | Note files | Your own Google Drive or iCloud |
| AI assistant | The relevant text when you ask a question | The provider whose key you entered |
| Image hosting | The images you choose to upload | Your own object storage |
| AI coding tools | Project documents, read and written only on this Mac | The app itself uploads nothing |
| Update checks | An ordinary web request with no note content | GitHub (can be turned off in Settings) |
| Analytics | None | None |

#Cloud-Notebook/Guide
