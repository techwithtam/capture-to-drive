# Capture to Drive: Design Spec

- **Date:** 2026-10-07
- **Status:** Implemented. Code comments cite this document's section numbers.
- **Reference experience:** Evernote Web Clipper (one click, capture, optional note, done)

## 1. Summary

A browser extension for Chrome and Edge that captures screenshots, whole pages, PDFs, and local files and saves them into **one Capture folder in the owner's Google Drive**. The owner is the Google account that owns that folder. Several people can send captures to it. Organizing the folder is not part of this project: the owner can sort it by hand, or with their own AI or automation (section 3).

The extension never signs into Google. It sends each capture to a small **Google Apps Script "mailbox"** deployed once under the owner's account, and the mailbox writes the file into the Capture folder.

## 2. Goals and success criteria

1. **One-click capture** from desktop Chrome and Edge, using the same extension build in both.
2. **Four capture types:** select an area, whole page, the PDF currently open in a tab, and files uploaded from the computer. Plus a right-click "Save linked file to Capture" on links.
3. **Everything lands in one folder.** No subfolders, no per-user folders.
4. **Optional note on every capture.** Enter saves, Esc discards. One keystroke when you don't want a note.
5. **Context travels with the file:** note, page title, URL, who captured it, when, capture type. Whoever or whatever sorts the folder later can read all of it.
6. **Nothing is lost.** If an upload fails for a transient reason, it waits in a local queue and retries automatically.
7. **No sign-in screens** in daily use. Setup is a one-time paste of three values.

Success looks like: any sender can capture a receipt in under 5 seconds, and it appears in the Capture folder with a readable name and its context attached.

## 3. Non-goals (this project)

- Sorting, renaming, or moving files in Drive. The project includes no AI. Organizing the folder is out of scope: the owner brings their own way to do it, by hand or with their own AI or automation, and the description format (section 7.2) gives it the context.
- iPhone/iPad capture. The Drive app in the iOS share sheet covers this for now.
- Firefox and Safari builds.
- Reading, listing, moving, or deleting anything in Drive from the extension.
- A Chrome Web Store listing, a hosted service, or multi-tenant support. Each setup is one owner's mailbox and folder, shared with a few senders the owner trusts.
- Editing a capture's note after it is saved.

## 4. Users and environments

Two roles:

| Role | Who | Notes |
|---|---|---|
| **Owner** | The Google account that owns the Capture folder and deploys the mailbox | Every file is created as the owner. The owner can also send captures. |
| **Sender** | Anyone with the extension, the mailbox URL, and the key. There can be any number. | Each sender puts their own name in Settings. It goes into every filename. |

Every sender, the owner included, uses desktop Chrome or Edge with the same extension build. No role is tied to a browser or an operating system. Tested with Chrome and Edge on macOS.

The Capture folder and the mailbox both live in **the owner's** Google account. Whoever does the setup can do it from any computer, in a browser profile signed into only the owner's account. The extension goes into each sender's everyday browser profile.

## 5. Architecture

```
 Owner's browser  ─┐   HTTPS POST (JSON, secret key)   ┌──────────────────────────┐
 Sender's browser ─┼──────────────────────────────────▶│ Apps Script mailbox      │
 More senders     ─┘                                   │ runs as the owner        │
                                                       │ checks key, saves file   │
 Each one: Chrome or Edge,                             └────────────┬─────────────┘
 same extension build                                               ▼
                                                       Capture folder (owner's Drive)
```

Two components, one direction of data flow:

1. **Extension** (`extension/`): captures, collects the optional note, names the file, queues it, and POSTs it to the mailbox.
2. **Mailbox** (`mailbox/`): one Apps Script project. Validates the key, decodes the file, creates it in the Capture folder, sets its description, and returns the new file ID.

### Why the mailbox instead of the Drive API directly

- Edge does not support `chrome.identity.getAuthToken`, so a direct-Drive design needs `launchWebAuthFlow` plus hourly token renewal in Edge.
- A direct design needs a Google Cloud project, an OAuth consent screen, and folder-sharing permissions so every sender can write into the owner's folder.
- With the mailbox, every file is owned by the owner's account, whoever sent it: one owner and one folder.

## 6. Components

### 6.1 Mailbox (Google Apps Script)

**Files:** `mailbox/Code.gs`, `mailbox/appsscript.json`, `mailbox/SETUP.md`.

**Deployment:** Web app, **Execute as: Me** (the owner's account), **Who has access: Anyone**. "Anyone" is required because the extension sends no Google credentials. The secret key is the access control.

**Script Properties** (stored in the Apps Script project, never in the repo):

| Property | Meaning |
|---|---|
| `MAILBOX_KEY` | Shared secret. Generated by `setup()`. |
| `FOLDER_ID` | Drive ID of the Capture folder. |
| `MAX_FILE_BYTES` | Upper bound on decoded file size. Default 20 MB until the size check (risk R2, section 14) measures the real limit. The extension enforces the same value from a constant in `lib/mailbox-client.ts`. |

**Functions:**

- `setup()`: run from the editor as the account that deployed the mailbox. Creates a folder named `Capture` in My Drive if `FOLDER_ID` is unset, generates `MAILBOX_KEY` if unset, and logs both the key and the folder URL. It is safe to run again, and it replaces a folder only when the folder is really gone:
  - A folder in Drive's Trash is never replaced. `setup()` keeps its ID and logs how to restore it (and to restore the folder that contains it if `Capture` is not listed in Trash).
  - A lookup that says "not found or no access" is tried once more after 1.5 s. Only if the second lookup also says so does `setup()` create a new `Capture` folder and store its ID. If the second lookup finds the folder, in Trash or not, it is kept.
  - It then logs the old ID with the recovery steps for a run in the wrong account. Copy the old ID first (if the log is lost, it is the part of the old folder's Drive URL after `/folders/`). Then sign in as the account that deployed the mailbox, set `FOLDER_ID` back to it, and press Retry in the extension popup. Do not run `setup()` again for this. Deleting the extra empty folder, the one on the `Capture folder:` log line, is optional. If the account was right and the old folder was deleted, nothing more is needed.
  - Any other Drive error stops `setup()` before it changes any property. It throws "Could not open the Capture folder (FOLDER_ID ...): ... Nothing was changed."
- `rotateKey()`: generates a new key and logs it. Used if the key ever leaks.
- `doPost(e)`: the only working endpoint (contract in section 7.3).
- `doGet()`: returns `{"ok": false, "error": "not_found"}` so the URL reveals nothing.

**Behavior of `doPost`:**

1. Parse `e.postData.contents` as JSON. On failure: `bad_request`.
2. Check `v === 1`, then compare `key` to `MAILBOX_KEY`. On mismatch: `unauthorized`.
3. `action: "ping"`: return `{ok: true}` without touching Drive (used by "Test connection").
4. `action: "save"`: validate `captureId`, `filename`, `mimeType`, `data` are non-empty strings. `description` is optional (missing or `null` counts as empty), but if present it must be a string. On failure: `bad_request`.
5. **Duplicate guard:** look up `captureId` in `CacheService.getScriptCache()`. If present, return the cached file ID with `duplicate: true`. This prevents double files when a retry follows a request that actually succeeded.
6. Decode base64 with `Utilities.base64Decode`. If decoded length exceeds `MAX_FILE_BYTES`: `too_large`.
7. **Folder lookup**, then create. The mailbox looks up `FOLDER_ID` with `DriveApp.getFolderById` and checks `isTrashed()`. There are five outcomes:
   - **Unset** (no `FOLDER_ID`): `server_error`, "The Capture folder is missing. Run setup() again."
   - **Ok** (found, not in Trash): carry on.
   - **In Trash**: `server_error`, "The Capture folder is in Drive's Trash. Restore it, then press Retry."
   - **Not found or no access** (Drive's message contains "no item with the given id" or "do not have permission"): `server_error`, "The Capture folder is missing. Run setup() again."
   - **Any other error** (for example "Service error: Drive"): rethrown, so step 9 answers it.

   Then `createFile(Utilities.newBlob(bytes, mimeType, filename))` in that folder, then `setDescription(description)`. If `setDescription` fails, the file is incomplete. The mailbox moves that new file to the Trash (if even that fails, it only logs it) and rethrows the error. Step 9 answers `server_error`, the extension retries, and the retry creates one complete file.
8. Cache `captureId → fileId` for 6 hours (21,600 s, the cache maximum). Return `{ok: true, fileId, name, duplicate: false}`.
9. Any thrown error: `server_error` with a short message (cut to 200 characters). If the message matches `/storage quota (?:has been )?exceeded/i`, which is how Drive words a full account, the message is "Drive storage is full." instead. Rate limits such as "Limit Exceeded: DriveApp." do not match and keep their own message.

**Messages the person can act on.** The code stays `server_error`, so the upload keeps retrying. The wording is fixed, and the popup shows it once the upload keeps failing (section 6.5):

| Message | Meaning and fix |
|---|---|
| Drive storage is full. | The owner's Drive is out of space. Free some space, then Retry. |
| The Capture folder is missing. Run setup() again. | `FOLDER_ID` is unset, or the mailbox account cannot open the folder. Run `setup()` as the deploying account. If an earlier `setup()` ran in the wrong account, follow `mailbox/SETUP.md` section 3 instead: running it again makes a third folder. |
| The Capture folder is in Drive's Trash. Restore it, then press Retry. | Restore the folder (or the folder that contains it) from Trash. No `setup()` needed. |

All responses use `ContentService.createTextOutput(JSON.stringify(...)).setMimeType(ContentService.MimeType.JSON)`.

**Updating the mailbox:** code changes require **Deploy > Manage deployments > Edit > New version**. This keeps the same `/exec` URL. Creating a *new* deployment makes a second `/exec` URL. The old URL keeps working but keeps running the old version, so the installed extensions never get the update unless every Settings page is changed.

### 6.2 Extension

**Stack:** WXT (Manifest V3), TypeScript strict, vanilla DOM for UI (the popup, settings, upload, and note UIs are small, so no UI framework), Vitest for tests.

**Single build:** the Chrome MV3 build output is loaded unpacked into both Chrome and Edge.

#### Permissions

| Permission | Why |
|---|---|
| `host_permissions: ["<all_urls>"]` | `captureVisibleTab` on regular web pages, injecting the selection overlay and note card, fetching PDF and linked-file bytes with the user's cookies, and reaching `script.google.com` / `script.googleusercontent.com` (the mailbox response redirects there). |
| `activeTab` | `captureVisibleTab` on restricted pages after the user invokes the extension through its toolbar popup or keyboard shortcut, so failed overlay injection can fall back to visible-area capture. |
| `scripting` | Inject the selection overlay and note card on demand. |
| `debugger` | `Page.printToPDF` for whole-page capture. |
| `contextMenus` | "Save linked file to Capture" on links. |
| `storage`, `unlimitedStorage` | Settings and the IndexedDB queue, without eviction of queued files. |
| `alarms` | Retry timer (service workers cannot hold long timers). |

These are broad. The README explains each one, and the full source is public, so anyone can check how they are used. Moving them to optional runtime permissions is future work (section 15).

#### Entry points

| Entry point | Purpose |
|---|---|
| `background.ts` | Service worker: commands, context menu, capture orchestration, queue processing, badge. |
| `popup/` | Toolbar menu: four capture buttons, queue status, settings link. |
| `options/` | Settings: mailbox URL, key, name, Test connection, shortcut link. |
| `upload/` | Full-tab page with drop zone and file picker. |
| `note/` | Small popup window for the note step when a page cannot host the in-page card. |
| `select-area.content.ts` | Runtime-injected drag-to-select overlay. |
| `note-card.content.ts` | Runtime-injected in-page note card (Shadow DOM). |

#### Keyboard shortcut

- `select-area`: default **Alt+Shift+S** (Option+Shift+S on Mac). Avoids Edge's built-in Web Capture shortcut (Ctrl+Shift+S). Users can change it on the browser's extension shortcuts page.

### 6.3 Capture flows

Every flow ends in the same two steps: **note step** (section 6.4), then **enqueue** (section 6.5).

**A. Select area** (popup button or shortcut)

1. If launched from the popup, the popup closes itself.
2. Background injects `select-area` into the active tab.
3. Overlay dims the viewport with a crosshair cursor. Drag draws a rectangle. **Enter** (no drag in progress) captures the whole visible area instead, so the capture works without a pointer. Esc cancels. The hint reads "Drag to select. Enter for the whole view. Esc to cancel."
4. On mouse-up with a rectangle at least 8×8 CSS px, the overlay removes itself, waits two animation frames so it is not in the screenshot, then sends `{rect, viewportWidth, viewportHeight}`.
5. Background calls `captureVisibleTab` (PNG), then crops with `createImageBitmap` + `OffscreenCanvas`, scaling the rect by `imageWidth / viewportWidth` (covers device pixel ratio and page zoom).
6. Result: PNG, capture type `area`. After Enter the overlay sends `select-area:visible`, the background captures the whole visible area with no crop and capture type `visible`, and the note step shows no fallback notice (the user chose it).
7. **Fallback:** if injection fails (browser pages, extension store, PDF viewer), capture the whole visible area instead. Capture type `visible`, and the note step says "Selection isn't available on this page, so the visible area was captured."

**B. Whole page** (popup button)

1. Popup closes itself.
2. Background attaches `chrome.debugger` (protocol 1.3) to the tab, sends `Page.printToPDF` with `printBackground: true`, and always detaches in `finally`.
3. Result: PDF with selectable text, capture type `page-pdf`.
4. **No image fallback.** The R1 check passed in Chrome and Edge (section 14), so whole page is PDF only. The capture type `page-image` is reserved and unused.
5. Attach failure (restricted page): error toast "This page can't be saved. Try Select area instead."

**C. Save this PDF** (popup button, enabled only on PDF tabs)

1. **PDF detection** (`isPdfTab`), run when the popup opens:
   - URL path ends in `.pdf` (case-insensitive, ignoring query and hash): PDF.
   - Otherwise, for `http(s)` tabs: try reading `document.contentType` via `executeScript`. If injection is blocked, send a `HEAD` request and check `Content-Type: application/pdf`.
   - `file://` tabs are not supported. The button shows the hint "Local file? Use Upload files."
2. Background fetches `tab.url` with `credentials: "include"`, then verifies the response is a PDF (content type **or** the bytes start with `%PDF`).
3. Filename label comes from `Content-Disposition` if present, otherwise the last URL path segment.
4. Result: the original PDF bytes, capture type `pdf`.
5. Failure (login page, 401/403, not a PDF): "Couldn't download this PDF. It may need you to be logged in. Download it, then use Upload files."

When the button is disabled, it shows "Open a PDF in this tab to use this."

**D. Upload files** (popup button)

1. Opens `upload.html` in a new tab (the popup closes as soon as focus moves to Finder, so dragging onto the popup itself is unreliable).
2. Big drop zone plus a "Choose files" button, multiple files allowed.
3. One optional shared note field applies to every file in the batch.
4. Each file shows a row: name, size, status. A new row says `Adding…` (the amber half-filled circle: in progress, not yet safe) until the page has stored that file in the queue, then `Waiting`, and after that `Uploading`, `Saved ✓`, or `Failed: reason`. If storing the file fails, the row says `Failed: Couldn't queue this file. Choose it again.` Screen readers hear the row when it arrives, and then each later change with the file name first. They do not hear `Adding…` turn into `Waiting` (a big batch would read out one line per file); the page message in step 7 says when every file is queued.
5. The page turns some files away on the spot. The row says `Failed: ` and the reason, and the file is never queued:
   - An empty file: "Failed: This file is empty." Queued, it would only fail later with a message that cannot help.
   - A file over the size cap: "Failed: Too big for the mailbox (max N MB). Drag it into Drive directly." (N is `MAX_FILE_BYTES` in MB.)
6. Capture type `upload`. No in-page note card; the shared note field is the note step, and uploads go straight to the queue without a pending record.
7. The page stores the files one at a time and asks the background to start after the first one is stored. A file that is not stored yet (`Adding…`) is lost if the tab closes. A file that is stored uploads without the tab. As soon as the last file is stored, the page message (a polite live region, so it is read out once) says "Every file is queued. You can close this tab." It does not wait for the answer to the final start, which comes only after the uploads have run. Files refused on the spot count as done. The line is not shown when no file was stored, or when a file could not be stored, and it clears when the next batch starts. With overlapping batches it waits until every file on the page is stored. If the final start fails, "Couldn't start the upload. Use Retry now in the extension popup." is added after the line: the files are still safe, so the line stays true, and only the added sentence is read out. When the line is not showing, the message is "Files are queued. Couldn't start the upload. Use Retry now in the extension popup." instead.

**E. Save linked file to Capture** (right-click on any link)

1. Background fetches the link URL with `credentials: "include"`.
2. If the response is `text/html`: error "That link opens a web page, not a file."
3. Otherwise the bytes and content type are kept, and the label comes from `Content-Disposition` or the URL path.
4. Capture type `link`. Note step happens on the page where the link was clicked.

### 6.4 Note step

1. Before showing any note UI, the background writes the capture (bytes + metadata) to the IndexedDB `pending` store under a new `captureId`. The service worker can be stopped while the user types, so nothing is held only in memory.
2. **In-page card** (preferred): inject `note-card` into the tab. Shadow DOM, bottom-right, top z-index. Shows:
   - Thumbnail for images, or a file icon plus filename for PDFs and other files.
   - The final filename (read-only).
   - Text input "Note (optional)", autofocused.
   - Buttons **Save** (primary) and **Discard**.
   - Keys: **Enter** = Save, **Esc** = Discard.
   - No timeout. The card stays until the user acts.
3. **Note window** (fallback when the tab can't be injected): `chrome.windows.create` with `note.html?id=<captureId>`, type `popup`, about 420×380. Same controls.
4. On Save: the note is attached, the pending record moves to the upload queue, and the card shows "Saving…" then "Saved to Capture ✓", or "Still uploading. It will finish on its own." if the first attempt fails transiently, is still running after 30 s, or gets no answer. The capture is in the upload queue either way, so the wording says it is working, not broken. After "Saved to Capture ✓" or "Still uploading", the card disappears 2 s later. An error (`needs_attention`, or a save that never reached the background) stays until the user presses **Close** or Esc (WCAG 2.2.1); focus does not move to the card, as for a message on its own.
5. On Discard: the pending record is deleted.
5a. **Messages on their own** (capture errors and notices, in the card or the note window) have a Close button and Esc. An error stays until the user closes it; an informational message goes after 6 s, paused while the pointer or focus is on it, and starts again from 6 s when they leave (WCAG 2.2.1).
6. Abandoned pending records (tab closed mid-note) older than 24 h are deleted at service-worker startup.

### 6.5 Upload queue

**Storage:** IndexedDB, database `capture-to-drive`, stores `pending` and `queue`.

**Queue item:** `{captureId, createdAt, filename, mimeType, description, blob, attempts, nextAttemptAt, status, lastError, lastMessage}`, where `status ∈ {waiting, uploading, needs_attention}`. `lastError` and `lastMessage` are set after a failed attempt and are optional. `lastError` is the error code. `lastMessage` is the text to show:

- For a waiting item, it is the reason the last attempt failed, in the mailbox's or the client's own words, or "Couldn't reach Drive. Check your internet connection." for a network failure or an empty message. The item keeps this reason until its next attempt replaces it.
- For a `needs_attention` item, it is the fixed wording for the error code (`NEEDS_ATTENTION_MESSAGES` in `lib/queue.ts`). The mailbox's own message is never shown. Retrying the item clears it.

**Processing:**

- An upload is attempted immediately on enqueue.
- The queue is also processed on `runtime.onInstalled`, on the `retry` alarm, and from the popup's "Retry now", which makes every waiting item due at once.
- A browser start (`runtime.onStartup`) retries every waiting item at once, including ones still backing off. Needs-attention items wait for the person.
- One upload at a time, oldest first.
- Successful items are deleted from the queue.

**Retry classification:**

| Result | Action |
|---|---|
| Network error, timeout (60 s plus 10 s per MB of file, `uploadTimeoutMs` in `lib/queue.ts`; Test connection waits 60 s), non-JSON response except HTTP 404 (including HTTP 200, 400, and 5xx), unrecognized JSON response, `server_error` | Retry with backoff |
| `unauthorized` | `needs_attention`, no retry. "Mailbox key was rejected. Check Settings." |
| `not_found`, including HTTP 404 with a non-JSON body | `needs_attention`, no retry. "Mailbox not found. Check the URL in Settings." Google returns 404 HTML for a wrong or deleted deployment, so retrying cannot fix the URL. The mailbox's `doPost` never sends `not_found`. |
| `bad_request` | `needs_attention`, no retry. "This capture couldn't be read. Discard it and capture again." The client also uses it when the stored file cannot be read at all. |
| `too_large` | `needs_attention`, no retry. "Too big for the mailbox." |

A `needs_attention` item is never retried automatically: the `retry` alarm and the browser start skip it, and the popup's "Retry now" covers waiting items only. It is retried with its own Retry, once the cause is fixed, or removed with Discard.

**Backoff:** delay after attempt *n* = `[1, 2, 5, 10, 30]` minutes, then 30 minutes thereafter. The `retry` alarm is set to the earliest `nextAttemptAt`.

**Badge:**

- Empty queue: no badge.
- Waiting items: count on the accent color (`--c-primary`), white text.
- Any `needs_attention`: `!` on the light-scheme error red (`--c-error`, `#c53a3a`), white text (5.2:1; the brighter dark-scheme red gave only 3.5:1). The badge cannot follow the color scheme.

**Popup status line:** "All saved", "2 waiting to upload · Retry now", or "1 needs attention · View". Needs attention wins, because those items do not upload until someone acts.

A waiting item can keep failing for a reason that never clears by itself, such as a full Drive or a deleted Capture folder. After a waiting item has failed 3 times and has a stored reason, the status line adds View next to Retry now, so the person can read the reason and Discard the item.

**The list behind View** is named "Uploads with problems" for screen readers. It holds every needs-attention item and every waiting item that keeps failing, oldest first. Each shows its file name and its reason, with Retry and Discard.

- An item that is uploading again stays in the list with the reason it failed before. Screen readers hear "Uploading now." before that reason. Its row has no Retry or Discard, because a retry adds nothing and a discard cannot stop the upload, so the file would reach Drive after the popup said it was gone. The background also refuses to discard an uploading item (it answers `ok: false` and changes nothing). The buttons come back if the attempt fails, and the row goes away if it works.

### 6.6 Settings

| Field | Validation |
|---|---|
| Mailbox URL | Must match `https://script.google.com/macros/s/<id>/exec`, or the Google Workspace form `https://script.google.com/a/macros/<domain>/s/<id>/exec` |
| Secret key | Non-empty, trimmed |
| Your name | 1 to 30 characters, trimmed; used in filenames, so it must keep something after filename sanitizing (section 7.1) |

- **Test connection** sends `action: "ping"` and shows "Connected ✓" or the specific error.
- **Change keyboard shortcut** opens the browser's extension shortcuts page.
- Stored in `chrome.storage.local`. Never committed, never synced to a server.
- If settings are incomplete, the popup shows a single **Finish setup** button instead of the capture buttons.

## 7. Data formats

### 7.1 Filename

```
{YYYY-MM-DD} {HH.mm} {Name} - {source} - {label}.{ext}
```

- **Date/time:** local time on the capturing machine. `HH.mm` uses a dot because colons are unsafe in synced filenames.
- **Name:** from settings.
- **source:** a web page's hostname without a leading `www.` (http and https only), `browser` for the browser's own and extension pages (`chrome:`, `edge:`, `about:`, `chrome-extension:`, and similar, whose hostname is a settings section or an extension ID), `upload` for uploaded files, else `unknown`.
- **label:** page title (area, visible, whole page), or the original filename without extension (PDF, link, upload). Fallback `capture`.
- **ext:** from MIME type (`image/png` → `png`, `application/pdf` → `pdf`), else from the original filename, else `bin`.
- **Sanitizing:** replace `/ \ : * ? " < > |` and control characters with a space, collapse whitespace, trim, and strip trailing dots. A raw label is cut to 1,000 characters first, because cleaning a very long label (a long URL name) is slow. It is then cleaned, cut to 80 characters, and cleaned again.

Examples:

```
2026-10-07 13.42 Alex - example.com - Your Orders.pdf
2026-10-07 13.45 Alex - store.example.com - Receipt.png
2026-10-07 13.50 Alex - upload - statement-sept.pdf
```

### 7.2 Drive description

Plain `Label: value` lines, so humans can read them in Drive's details panel and a sorting tool can parse them. Lines with empty values are omitted. The URL is cut at 1,000 characters.

```
Note: Receipt, for taxes
Title: Orders | Example Store
URL: https://store.example.com/orders
Captured by: Alex
Captured at: 2026-10-07T13:42:10-07:00
Capture type: area
Capture ID: 6f1c2b0e-5d1a-4a8e-9a43-1d1f2b9c7e11
```

Capture type values: `area`, `visible`, `page-pdf`, `page-image`, `pdf`, `link`, `upload`.

### 7.3 Mailbox contract

**Request:** `POST <mailbox /exec URL>` with `Content-Type: text/plain;charset=utf-8` (a "simple" request, so no CORS preflight) and a JSON body:

```json
{
  "v": 1,
  "action": "save",
  "key": "<secret>",
  "captureId": "<uuid>",
  "filename": "2026-10-07 13.42 Alex - example.com - Your Orders.pdf",
  "mimeType": "application/pdf",
  "description": "Note: ...\nTitle: ...",
  "data": "<base64 bytes>"
}
```

`ping` uses only `v`, `action`, and `key`.

**Responses:**

```json
{ "ok": true, "fileId": "1AbC...", "name": "2026-10-07 ...pdf", "duplicate": false }
{ "ok": true }
{ "ok": false, "error": "unauthorized" | "bad_request" | "too_large" | "server_error" | "not_found", "message": "..." }
```

The extension follows the mailbox's redirect to `script.googleusercontent.com`. A recognizable JSON mailbox answer takes precedence over the HTTP status. HTTP 404 with a non-JSON body means `not_found` (`needs_attention`): Google returns it for a wrong or deleted deployment, so retrying cannot fix the URL. Other non-JSON bodies and unrecognized JSON answers are transient failures.

## 8. Error handling summary

| Situation | What the user sees | System behavior |
|---|---|---|
| Settings missing | Popup: "Finish setup" | No captures allowed |
| Restricted page, Select area | Note step says visible area was captured | Falls back to `visible` |
| Restricted page, Whole page | "This page can't be saved. Try Select area instead." | Nothing queued |
| PDF needs login / not a PDF | "Couldn't download this PDF…" | Nothing queued |
| Linked file is a web page | "That link opens a web page, not a file." | Nothing queued |
| File over size cap | "Too big for the mailbox (max N MB)…" | Rejected before queueing |
| Empty file, Upload files | The file's row says "Failed: This file is empty." | Rejected before queueing |
| Any file the upload page refuses (empty, or over the cap) | The file's row starts with "Failed: " and the reason | Never queued. The other files in the batch are still queued |
| Offline / mailbox down / slow upload | "Still uploading. It will finish on its own." | Queued with backoff |
| Capture folder in Drive's Trash | After 3 failed tries, behind View: "The Capture folder is in Drive's Trash. Restore it, then press Retry." | `server_error`, retried with backoff. Restoring the folder is enough, and `setup()` keeps a trashed folder |
| Capture folder missing | After 3 failed tries, behind View: "The Capture folder is missing. Run setup() again." | `server_error`, retried with backoff. `setup()` makes a new folder only if the old one is really gone (section 6.1) |
| Drive storage full | After 3 failed tries, behind View: "Drive storage is full." | `server_error`, retried with backoff until space is freed |
| Wrong key | Badge `!`, "Mailbox key was rejected. Check Settings." | `needs_attention` |
| Wrong or deleted mailbox deployment URL (HTTP 404 with a non-JSON body) | Badge `!`, "Mailbox not found. Check the URL in Settings." Test connection: "Mailbox not found. Check that the URL ends in /exec." | `not_found`, `needs_attention`, no automatic retry. A wrong or deleted URL needs to be corrected |
| Tab closed during note step | Nothing | Pending record cleaned up after 24 h |

## 9. Security and privacy

- **The key is the only access control.** It lives in Script Properties (mailbox) and `chrome.storage.local` (extensions). It is never in source code, so the public repo holds no secret.
- **The mailbox can only add files to one folder.** There are no endpoints to read, list, update, or delete. The one internal exception: if it creates a file and cannot complete it (setting the description fails), it moves that file to the Trash so the retry leaves one copy. It can trash only a file it has just created in that same request. No request can name a file to trash.
- **Stored settings are kept from web pages.** At every service worker start the extension calls `storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so content scripts, which run inside web pages, cannot read the key in `chrome.storage.local`. No content script of this extension reads storage. A browser without the API (before Chrome 102) keeps the default.
- **Key rotation:** run `rotateKey()`, then paste the new key into every extension's Settings. Rotating is also how the owner cuts off a sender.
- **No third parties:** no analytics, no telemetry, no servers other than Google's.
- **Broad extension permissions** (`<all_urls>`, `debugger`) are accepted because each install is loaded unpacked by people who chose it, and the source is public. They are documented in the README. Narrowing them is future work (section 15).

## 10. UI and accessibility

- **Visual direction:** a quiet, dense product UI: near-black or near-white canvas, depth from faint borders and small surface steps (no shadows except on UI floating over web pages), one indigo accent, compact command-menu rows with keyboard hints, and capture status circles (waiting, uploading, saved, needs attention) as the signature. The system is recorded in `assets/tokens.css` and `assets/components.css`.
- **Design tokens:** one `assets/tokens.css` file defines every color custom property, with light and dark values via `prefers-color-scheme`, declared on `:root, :host` so they also work inside the note card's shadow root. Surfaces: `--c-bg`, `--c-surface`, `--c-surface-raised`, `--c-surface-hover`, `--c-input-bg`. Borders: `--c-border`, `--c-border-subtle`, `--c-border-strong`, `--c-border-control` (resting input border only, 3:1). Text: `--c-text`, `--c-text-secondary`, `--c-text-muted`, `--c-text-faint`. Accent: `--c-primary`, `--c-primary-hover`, `--c-on-primary`, `--c-link`. Feedback: `--c-success`, `--c-error`, `--c-warning`. Status circles: `--c-status-waiting`, `--c-status-uploading`, `--c-status-saved`, `--c-status-attention`. Elevation: `--shadow-float`, only for the note card and selection hint. The same file defines the non-color tokens (`--font-sans`, `--font-mono`, `--fs-*`, `--r-*`, `--sp-*`, `--tap`, `--dur-fast`). No hard-coded colors elsewhere (a test enforces it). The in-page card copies the tokens into its Shadow DOM.
- **Shared components:** `assets/components.css` holds the classes every screen is built from (`.btn`, `.field`, `.input`, `.row`, `.kbd`, `.card`, `.status`); icons are Tabler outline paths in `lib/icons.ts`.
- **Contrast:** text tokens reach WCAG AA 4.5:1 on `--c-bg` and `--c-surface`; status and accent colors reach 3:1, and the input border reaches 3:1 against its surroundings (a test enforces it).
- **Text size:** readable text at 14 px or larger. 12 px only for keyboard hints, filenames in monospace, and minor metadata.
- **Touch/click targets:** at least 44×44 px for popup buttons and card buttons.
- **Keyboard:** everything works by keyboard; visible `:focus-visible` rings; Enter/Esc on the note step; in the selection overlay, Enter captures the whole visible area and Esc cancels (the drag itself needs a pointer).
- **Labels:** every input has a visible label or `aria-label`; status changes use `aria-live="polite"`.
- **Motion:** card fade and overlay transitions are disabled under `prefers-reduced-motion`.
- **Forced colors and contrast:** under Windows high contrast (`forced-colors: active`) the status circles are redrawn with borders and system colors (they also differ by shape), the active popup row is outlined, and the note card and selection hint get a real border; `prefers-contrast: more` strengthens control borders. Screen readers: the popup rows are `role="menuitem"` buttons in a named `role="menu"` with a roving tabindex, the upload list says which file a status change belongs to, and the selection overlay is a named modal dialog whose hint is a status. Error messages stay until closed; `prefers-contrast: more` also gives the note card, the selection hint, and the needs-attention panel a clear edge.
- **Copy:** plain, short, no em dashes.

## 11. Project structure

The public repository:

```
capture-to-drive/
├── README.md
├── SETUP-WITH-AI.md                 setup runbook for AI agents
├── AGENTS.md                        notes for AI coding agents
├── CLAUDE.md                        points to AGENTS.md
├── LICENSE
├── .gitignore
├── docs/
│   ├── design.md                    this document
│   └── acceptance-checklist.md      manual test checklist
├── mailbox/
│   ├── Code.gs
│   ├── appsscript.json
│   ├── SETUP.md
│   ├── tsconfig.json                type-checks the mailbox tests
│   ├── tests/                       vitest, Code.gs loaded in a node:vm harness
│   └── tools/probe-size-limit.mjs
└── extension/
    ├── package.json, package-lock.json
    ├── wxt.config.ts                manifest: name, permissions, shortcut
    ├── tsconfig.json
    ├── vitest.config.ts
    ├── public/icon/                 toolbar icons
    ├── assets/
    │   ├── tokens.css               every color and size
    │   ├── components.css           shared classes
    │   ├── note-view.css            note card and note window
    │   └── select-area.css          selection overlay
    ├── entrypoints/
    │   ├── background.ts            service worker
    │   ├── popup/                   toolbar menu
    │   ├── options/                 Settings
    │   ├── upload/                  upload page
    │   ├── note/                    note window
    │   ├── select-area.content.ts
    │   └── note-card.content.ts
    ├── lib/
    │   ├── capture-area.ts, capture-page.ts, capture-pdf.ts, capture-link.ts, capture-download.ts
    │   ├── note-step.ts, note-view.ts, note-status.ts, note-transport.ts, pending-store.ts, thumbnail.ts
    │   ├── queue.ts, db.ts, mailbox-client.ts, badge.ts, upload-batch.ts
    │   ├── filename.ts, description.ts, content-disposition.ts, crop.ts, selection-rect.ts, pdf-detect.ts
    │   ├── settings.ts, connection-message.ts, popup-model.ts, shortcut-keys.ts
    │   └── messages.ts, icons.ts
    └── tests/                       vitest; DOM tests use happy-dom
```

Conventions: kebab-case filenames, no barrel files, no `any`, TypeScript `strict: true`.

## 12. Setup runbook (summary)

Full steps live in `mailbox/SETUP.md` and `README.md`. `SETUP-WITH-AI.md` is the same setup written as a runbook for an AI agent.

1. **Mailbox**, in a browser profile signed into only the owner's Google account:
   1. Create a new project at script.google.com and paste `Code.gs` and `appsscript.json` from the same version as the extension.
   2. Run `setup()`. Approve the "Google hasn't verified this app" screen if it appears (Advanced > continue). Copy the key and folder URL from the log.
   3. Deploy as a Web app: Execute as **Me**, access **Anyone**. Copy the `/exec` URL.
2. **Extension**, on each computer, in each sender's everyday browser profile:
   1. Download the release's `-chrome.zip` and unzip it, or run `npm ci && npm run build` in `extension/` (or copy the built folder).
   2. Open `chrome://extensions` or `edge://extensions`, turn on Developer mode, then Load unpacked and select `extension/.output/chrome-mv3` (or the unzipped folder).
   3. Open Settings, paste the URL, key, and name, then click Test connection.
3. **Updating:** rebuild (or unzip the new release over the same folder) and click reload on the extensions page. For the mailbox, use Manage deployments > Edit > New version, which keeps the same URL.

## 13. Testing

**Automated (Vitest), runs on every change:**

- `filename.ts`: dates, sanitizing, truncation, extension mapping, `www.` stripping, fallbacks.
- `description.ts`: line order, omitted empties, URL truncation.
- `settings.ts`: URL, key, and name validation.
- `mailbox-client.ts`: response parsing and retry classification (JSON ok, JSON errors, HTML body, network error, timeout).
- `queue.ts`: state transitions and backoff schedule (with `fake-indexeddb` and a fake clock).
- `crop.ts`: rect scaling for device pixel ratio 1, 2, and zoomed pages.
- `pdf-detect.ts`: URL rules (`.pdf`, query strings, hashes, upper case, `file://`).
- `mailbox/Code.gs` (tests in `mailbox/tests/`): loaded in a Node `vm` context with fake `DriveApp`, `PropertiesService`, `CacheService`, `Utilities`, and `ContentService`. Covers:
  - `doPost`: ping, the key check (fails closed when no key is set), request parsing and field validation, duplicate `captureId`, and the size cap.
  - Saving: the folder lookup outcomes and their messages, storage-full matching, a file trashed when its description fails (the retry makes one complete file), a cache write failure that still reports success, and no request data or key in the log.
  - `setup()`, `rotateKey()`, and `doGet`: first run, re-run, replacing a deleted folder, keeping a trashed one, the single lookup retry, and errors that change nothing.
  - The sources hold no key or folder ID and no em dash, and the manifest selects V8 and the Drive scope.
- `mailbox/tools/probe-size-limit.mjs`: its refusals, and the requests and result table of a run.

**Build gate:** `npm run build` and `npm test` must pass before work is called done.

**Manual checklist, in both Chrome and Edge on macOS** (the full version is `docs/acceptance-checklist.md`):

- [ ] Select area on a normal site, then on a high-DPI display and at 125% zoom
- [ ] Select area on `chrome://` / `edge://` page (visible fallback)
- [ ] Whole page on a long receipt page; text in the PDF is selectable
- [ ] Save this PDF on a public PDF and on a logged-in PDF
- [ ] Right-click a PDF link; right-click a normal page link (error)
- [ ] Upload files: several files, one over the cap
- [ ] Note step: Enter saves, Esc discards, note appears in Drive description
- [ ] Wi-Fi off: capture queues, badge shows count, uploads after Wi-Fi returns
- [ ] Wrong key: badge `!`, message points to Settings
- [ ] Files appear in the owner's Capture folder with correct names, owned by the owner

## 14. Risks and early checks

| ID | Question | How to check | If it fails | Result |
|---|---|---|---|---|
| R1 | Does `Page.printToPDF` via `chrome.debugger` work in normal (non-headless) Chrome **and** Edge? | Minimal extension, attach to a tab, call it, open the returned PDF. | Use the full-page screenshot fallback (`page-image`). | **Passed.** Worked in Playwright Chromium (Chrome for Testing 151), Microsoft Edge 154, and branded Chrome 154. A 7-page Letter PDF came back with extractable text, in about 0.2 s warm (one cold run took 12 s). There is no height limit: a 40,000 px page gave 41 pages. The "started debugging this browser" bar appears within about 0.2 s and stays about 5 s after detach. It cannot be shortened. **Decision:** PDF path only, no image fallback. |
| R2 | What is the largest POST body the Apps Script web app accepts reliably? | Save test files of 5, 10, 20, and 30 MB (bodies are about 1.34× larger after base64). | Set `MAX_FILE_BYTES` (decoded file size) to about 80% of the largest file that saved reliably, in both the extension and the mailbox. Until measured, use 20 MB. | **Not measured yet.** The probe is `mailbox/tools/probe-size-limit.mjs` and the procedure is in `mailbox/SETUP.md`. `MAX_FILE_BYTES` stays at 20 MB until someone runs it. After that, record the table here and set the value in Script Properties and in `extension/lib/mailbox-client.ts`. |
| R3 | Does the extension's `fetch` follow the `script.google.com` redirect and read the JSON? | `ping` from the service worker. | Use `redirect: "follow"` explicitly and parse the final response; adjust host permissions if needed. | **Passed**, checked against the real deployed mailbox. Test connection returned "Connected ✓" in Edge on 2026-10-07, with the `<all_urls>` host permission already in the manifest. |
| R4 | Can content scripts run in Chrome's and Edge's built-in PDF viewer tabs? | `executeScript` on an open PDF. | Rely on the HEAD check for detection and the note window for the note step (already designed in). | **Passed.** `executeScript` works on http PDF tabs in all three browsers from R1, and `document.contentType` returns `application/pdf`. A HEAD request also returned `application/pdf` (test server only), so it stays as the fallback. An injected note card renders above the PDF viewer, and bottom-right placement keeps it clear of the viewer's toolbar. |

## 15. Future work

- **iPhone:** an iOS Shortcut that posts to the same mailbox with the same contract.
- **Auto-updates:** an unlisted Chrome Web Store listing ($5 one-time), installable in Edge too.
- **Narrower permissions:** move broad permissions to optional runtime permissions.
- **Mailbox deploys from the command line** with `clasp`.

## 16. Decisions log

| Decision | Reason |
|---|---|
| One Capture folder in the owner's Drive | One place to sort later, by hand or with the owner's own tools; the owner owns every file. |
| Apps Script mailbox, not the Drive API from the extension | No sign-in, identical in Chrome and Edge, no Google Cloud project. |
| Same build loaded in both browsers | Edge runs Chrome MV3 extensions as-is. |
| Whole page saves as a PDF with real text | People and tools can read totals and dates reliably; the brief debugging bar is acceptable. |
| Optional note after every capture, Enter/Esc | Context for whoever sorts the folder later, at the cost of one keystroke. |
| Context stored in the Drive description, not sidecar files | Keeps the folder a clean single list. |
| Upload files in a full tab, not the popup | The popup closes when focus moves to Finder. |
| Vanilla TypeScript UI, no framework | The UIs are four small screens; fewer dependencies. |
| Load unpacked to start | Simplest install for a few people; revisit if updates get tedious (section 15). |
| Public GitHub repo under the MIT license (2026) | Anyone can deploy their own mailbox and load the extension. No key, URL, or account detail is in the source. |
| A Capture folder in Drive's Trash is kept, not replaced (2026-10-08) | Replacing it would start a second Capture folder and leave the files already in it behind. Restoring it from Trash is one step and keeps everything in one place. `setup()` never replaces a trashed folder, and the upload message says to restore it and press Retry. |
| Uploading rows in the popup list have no Retry or Discard | A retry adds nothing while the attempt runs. A discard cannot stop it, so the file would reach Drive after the popup said it was gone. The buttons return if the attempt fails. |
| The note card says "Still uploading. It will finish on its own." when an upload has not finished (2026-10-08) | It replaced "Couldn't reach Drive. It will upload automatically.", which also showed for uploads that were only slow and read like an error. The capture is safe in the queue in every case. |
| A save that ends in an error stays on the note card until Close or Esc (2026-10-08) | It used to disappear after 2 s like a successful save, which broke the rule that an error stays until the user closes it (WCAG 2.2.1); a message on its own already followed it. Saved and "Still uploading" still go after 2 s. The Close button does not take focus, as for a message on its own. |
| Upload rows start as "Adding…" and the page says "Every file is queued. You can close this tab." once the last file is stored (2026-10-08) | Every row said "Waiting" from the drop, so the page never showed when a file became safe, and the README had to say to wait for most of a big batch to upload. Storing is the moment a file survives a closed tab, so the page now shows that moment per file and for the batch. The line follows the last store, not the final start, which answers only after the uploads have run. |
