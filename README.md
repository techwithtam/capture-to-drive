# Capture to Drive

Save screenshots, web pages, PDFs, and files into one inbox folder in Google Drive, each with an optional note. A browser extension for Chrome and Edge. There is no service to sign up for: it sends everything to a small Google Apps Script that you deploy in your own Google account.

**Get started:** [set it up with your AI](#set-it-up-with-your-ai-fastest), or [set it up yourself](#set-it-up-yourself).

## What it does

Click the toolbar icon, pick what to capture, type a note if you want one, and press Enter.

| Capture | What it saves |
|---|---|
| **Select area** | A picture of the part of the page you drag a box around, or the whole visible part of the page. |
| **Whole page** | The entire page, top to bottom, as a PDF whose text you can select and search. |
| **Save this PDF** | The PDF open in the current tab, exactly as it is, including many that need you to be logged in. |
| **Save linked file** | Right-click a link to a PDF, picture, or other file to save that file. |
| **Upload files** | Files from your computer, several at once, with one note for the batch. |

After each capture, a small **note card** appears on the page. Type why you saved it, or leave it empty. Enter saves, Esc throws the capture away. The note goes into the file's description in Drive, along with the page title, the web address, who saved it, and when.

Every file lands in one folder named `Capture`, with a readable name:

```
2026-10-07 13.42 Alex - example.com - Your Orders.pdf
```

## Why

One folder works as an inbox. You capture in a second and decide later what to do with it.

Capture to Drive only fills that inbox. It does not sort, rename, or move files, and it includes no AI. Organizing the folder is up to you: by hand, or with your own AI or automation. Because every file carries its note and context in its Drive description, whatever you use later has something to go on.

## How it works

```
 Your browser                  Your mailbox                      Your Google Drive
 (Chrome or Edge)              (Google Apps Script,              (the owner's account)
                                in the owner's account)

 Capture to Drive  -- file --> checks the secret key  -- save --> "Capture" folder
 extension            + note   and saves the file
```

- **No third-party server.** You deploy your own small Google Apps Script web app, called the **mailbox**, in the Google account that will own the files. These docs call that account **the owner**.
- **The extension never signs into Google.** It sends each capture to the mailbox's web address, together with a secret key.
- **The mailbox can only add files.** It runs as the owner, so every file belongs to the owner. It adds files to the one `Capture` folder and cannot read, list, change, or delete anything. (One exception: if it cannot finish a file it has just created, it moves that file to the trash, so the automatic retry does not leave a duplicate.)
- **The secret key is the lock.** Only someone with the web address and the key can add files. The key is stored in each browser's extension settings and in the owner's Apps Script project: in its Script Properties, and in the logs of the `setup()` and `rotateKey()` runs. It is never in this repo.
- **Several people can share one folder.** For example, a family can all send captures to the owner's `Capture` folder.

## Set it up with your AI (fastest)

If you use an AI coding agent such as Claude Code or Codex, paste this into it:

```
Set up Capture to Drive for me by following SETUP-WITH-AI.md in https://github.com/techwithtam/capture-to-drive. Ask me before each step that needs me.
```

The agent follows [SETUP-WITH-AI.md](SETUP-WITH-AI.md), one step at a time, and checks each step before moving on. It only sets up the capture tool. It does not organize your folder.

**What the agent does:**

- gets the extension (downloads the release or builds it from source);
- tells you exactly what to click in Google Apps Script, or clicks it for you if it can control your browser;
- checks the connection, then checks that your first capture reached Drive.

**What you do yourself:**

- **Sign in to Google** with the owner's account. You type every password and 2-step code. The agent never asks for them.
- **Approve Google's permission prompt.** Google may show a screen that says "Google hasn't verified this app". That is expected. The "app" is your own copy of the mailbox script, running in your own account. Google's review is for apps that other people sign into, and this one has not been through it. The agent explains each screen before you click.
- **Click Load unpacked** in your browser's extensions page, if the agent cannot control your browser.
- **Keep the secret key private.** The agent never asks you to paste it into the chat. If the agent can see your screen, it sees the key while it copies it into Settings. It is told never to repeat or store it. If that bothers you, run `rotateKey()` after setup (see [mailbox/SETUP.md](mailbox/SETUP.md)) and paste the new key yourself.

It works with or without computer use (an agent that can see and click in your browser). Without it, the agent tells you each click and waits for you to say what you see.

## Set it up yourself

You need:

- Chrome or Edge on a desktop computer, in the browser profile you use every day.
- The owner's Google account, signed in, for about ten minutes.
- Only for Option B below: Node.js 22 (22.12 or newer), 24, or 26 and later. Check with `node --version`.

### 1. Get the extension

Use Option A if you don't have Node.js. Use Option B if you do, or if you want to change the code.

**Option A: download the release zip.** Open the [latest release](https://github.com/techwithtam/capture-to-drive/releases/latest) and download the file whose name ends in `-chrome.zip`. Unzip it (double-click it on a Mac; on Windows, right-click it and choose **Extract All**). You get a folder with a file named `manifest.json` directly inside. Move that folder somewhere it can stay, such as your Documents folder. No release listed yet, or no `-chrome.zip` in it? Use Option B.

**Option B: build it from source.** In a terminal:

```sh
git clone https://github.com/techwithtam/capture-to-drive.git
cd capture-to-drive/extension
npm ci
npm run build
```

The extension is the folder `extension/.output/chrome-mv3`. On a Mac, `.output` is hidden in Finder. When you choose the folder in step 3, press `Cmd+Shift+G` in the file picker and paste the full path. To get it, run `pwd` in the `extension` folder and add `/.output/chrome-mv3` to the end. (Or press `Cmd+Shift+.` in the picker to show hidden folders.) On Windows the folder is not hidden.

Either way, the browser loads the extension from that folder every time it starts, so do not move or delete it later. The same folder works in Chrome and Edge. It holds no key or web address, so it is safe to copy to another computer.

### 2. Create the mailbox (once)

Do sections 1 to 4 of [mailbox/SETUP.md](mailbox/SETUP.md), signed in as the owner. You finish with two things:

- the mailbox **web address**, which ends in `/exec`;
- the **secret key**.

Keep them in a password manager. Do not save them in a file in this repo, and do not send them in a chat.

If you used Option A, take the mailbox code from the same release, so the two match: on the release page, download **Source code (zip)** and use the `mailbox` folder inside it.

### 3. Load the extension

Do this in each browser you will use, in the profile you browse with every day. Extensions and their settings belong to one browser profile. If you set up the mailbox in a separate profile, switch back to your everyday one first.

1. Open the extensions page. In Chrome, type `chrome://extensions` in the address bar. In Edge, type `edge://extensions`.
2. Turn on **Developer mode**. In Chrome it is a switch at the top right. In Edge it is a switch in the left sidebar.
3. Click **Load unpacked** and choose the folder from step 1.
4. Pin the icon: click the puzzle-piece button next to the address bar, find **Capture to Drive**, and pin it (Chrome: the pin icon. Edge: the eye icon).

**Capture to Drive** now shows in the list, and its icon sits on the toolbar.

### 4. Enter the settings

1. Click the **Capture to Drive** icon. It says "Set up your mailbox to start saving to Drive." Click **Finish setup**. (Or right-click the icon and choose **Options**. Edge calls it **Extension options**.)
2. Fill in the three fields:
   - **Mailbox URL**: the web address that ends in `/exec`.
   - **Secret key**: the key from the mailbox setup. The field hides it.
   - **Your name**: up to 30 characters. It goes into every file name, so everyone can see who saved what.
3. Click **Save**. You see "Saved."
4. Click **Test connection**. You want to see **Connected ✓**.

The settings are stored only in that browser profile. Each browser needs them once.

### 5. Make your first capture

Open any web page and press `Alt+Shift+S` (`Option+Shift+S` on a Mac). Drag a box around something, type a note, and press Enter. The card says "Saving…", then "Saved to Capture ✓". Open the `Capture` folder in the owner's Google Drive: the picture is there.

## Sharing with family or a team

Everyone sends to the same mailbox, with the same web address and key, and their own name.

- Each person does steps 1, 3, and 4 above on their own computer, in each browser they use.
- **Share the web address and key privately**, for example in person or through your password manager's sharing feature. Treat the key like a password: anyone who has both can add files to the folder.
- The files belong to the owner and count against the owner's Drive storage. Other people cannot see the `Capture` folder unless the owner shares it with them in Drive.
- **To cut someone off**, run `rotateKey()` in the mailbox (see [mailbox/SETUP.md](mailbox/SETUP.md)). The old key stops working at once. Then give the new key to the people who should keep sending.

## Using it

### The toolbar menu

Click the icon to see four rows, a status line, and a **Settings** button. The arrow keys move between rows.

| Row | What it does |
|---|---|
| **Select area** | Drag a box around part of the page. Press Enter instead to take the whole visible part of the page (no mouse needed). Press Esc to cancel. If you select nothing for 2 minutes, it cancels by itself. |
| **Whole page** | Saves the entire page as one PDF. |
| **Save this PDF** | Saves the PDF open in this tab. It is greyed out unless the tab shows a PDF, and it then says "Open a PDF in this tab to use this." For a PDF that is a file on your computer, it says "Local file? Use Upload files." |
| **Upload files…** | Opens the upload page in a new tab. |

**The keyboard shortcut.** Press `Alt+Shift+S` to start **Select area** without opening the menu. On a Mac that is `Option+Shift+S`, which the browser shows as ⌥⇧S. To change it, open Settings and click **Change keyboard shortcut**, or go to `chrome://extensions/shortcuts` (Chrome) or `edge://extensions/shortcuts` (Edge).

**Right-click a link** and choose **Save linked file to Capture** to save the file it points to: a PDF, a picture, or another file. A link that opens an ordinary web page shows "That link opens a web page, not a file." and saves nothing.

### The note card

After every capture except uploads, a small card appears at the bottom right of the page. It shows a preview and the file name.

- Type a note if you want one. It is optional.
- Press **Enter** (or click **Save**) to save.
- Press **Esc** (or click **Discard**) to throw the capture away.

The card waits as long as you like. When you save, it says "Saving…" and then "Saved to Capture ✓", and it goes away by itself. If the upload has not finished yet, it says "Still uploading. It will finish on its own." The capture is safe in the upload queue either way. An error stays on the card until you click **Close** or press Esc.

On pages that cannot show a card, such as the browser's own pages, a small window opens instead. If you close the tab before pressing Enter or Esc, the capture is not saved. It is deleted once it is more than 24 hours old.

### The upload page

**Upload files…** opens a page in a new tab. Type a note first if you want one. It applies to every file you choose or drop next. Then drop files on the page or click **Choose files**.

Each file gets a row that shows Adding… until the file is safely queued, then goes from Waiting to Uploading to Saved ✓. An empty file, or a file over the size limit (20 MB by default), is refused on the spot with a "Failed:" line, and the other files still upload. Once the page says "Every file is queued. You can close this tab.", the tab can be closed, and the files keep uploading without it. Closing it sooner loses any file still marked Adding….

### Status, badge, and retries

The same four circles appear on the note card, the upload page, and the menu.

| Circle | Meaning |
|---|---|
| Dashed gray ring | Waiting its turn |
| Half-filled amber ring | Adding or uploading now |
| Indigo circle with a check | Saved to Drive |
| Red circle with "!" | Needs your attention |

The toolbar icon shows a small badge:

- No badge: everything is saved.
- A number on indigo: that many captures are waiting to upload.
- A red `!`: at least one capture needs your attention.

The menu's status line reads "All saved", "2 waiting to upload", or "1 needs attention".

- **Retry now** appears while captures are waiting to upload. It tries every waiting capture at once. When something needs attention, the line says so instead and offers **View**.
- **View** appears when a capture needs attention, or when a waiting capture has failed three times. It opens a list of those captures, each with the reason, a **Retry** button, and a **Discard** button. While a capture is uploading again, its row has no Retry or Discard. They come back if that try fails, and the row goes away if it works.

Failed uploads also retry by themselves, after 1, 2, 5, and 10 minutes, then every 30 minutes, and again whenever the browser starts.

### What you get in Drive

Each file is named like this:

```
2026-10-07 13.42 Alex - example.com - Your Orders.pdf
```

That is the date, the time, who captured it, the website, and the page title (or the original file name). Uploads use `upload` in place of the website.

Open the file's details panel in Drive to see its description:

```
Note: Order history, for taxes
Title: Your Orders
URL: https://example.com/orders
Captured by: Alex
Captured at: 2026-10-07T13:42:10-07:00
Capture type: page-pdf
Capture ID: 6f1c2b0e-5d1a-4a8e-9a43-1d1f2b9c7e11
```

Lines with nothing in them are left out. These plain lines are easy to read, and easy for any tool you use later to parse.

## Privacy and permissions

**What goes where:**

- **Your captures** (the file, its name, your note, the page title, the web address, your name, and the time) go from your browser to your mailbox at `script.google.com`, which hands off to `script.googleusercontent.com`, and from there into the owner's Drive. Nothing goes anywhere else.
- **No analytics and no tracking.** Besides your mailbox, the extension talks only to the sites you capture from: it downloads a PDF or a linked file from the site, using your logged-in session there.
- **Captures that are waiting** stay in the browser's storage on your computer until they upload or you discard them. A capture you never saved or discarded (you closed the tab) is deleted after 24 hours.
- **Settings, including the key,** are in the extension's local storage (`chrome.storage.local`) in that browser profile. The extension limits that storage to its own pages, so scripts running in web pages cannot read it. Nothing is synced to a server.
- **On Google's side**, the key, the folder ID, and the size limit are Script Properties in the owner's Apps Script project. The key also appears in the log of every `setup()` and `rotateKey()` run in that project.
- **The mailbox's Drive permission.** When you set up the mailbox, Google asks the owner to let it "See, edit, create, and delete all of your Google Drive files". That is the permission Apps Script needs to add files to a folder. The code, in [mailbox/Code.gs](mailbox/Code.gs), only adds files to the `Capture` folder.

**Why the extension needs each permission.** These are broad, because a capture can happen on any page. All the code is in this repo, so you can check what it does with them. You can also see them yourself: on the extensions page, click **Details** on the Capture to Drive card.

| Permission | Why the extension needs it |
|---|---|
| Access to all sites (`<all_urls>`) | Take pictures of any page, put the selection overlay and the note card onto any page, fetch PDFs and linked files using your logged-in session, and reach your mailbox at `script.google.com`. |
| `activeTab` | Lets a capture that you start from the toolbar icon or the shortcut work on restricted pages, such as `chrome://` and `edge://` pages. That is how Select area can still save the visible part of them. |
| `scripting` | Puts the selection overlay and the note card onto a page only when you start a capture. |
| `debugger` | Prints a whole page to PDF through the browser's debugging interface. While it runs, the browser shows a bar saying the extension "started debugging this browser". |
| `contextMenus` | Adds **Save linked file to Capture** to the right-click menu on links. |
| `storage` and `unlimitedStorage` | Keep your settings, and keep captures that are waiting to upload without the browser deleting them to free space. |
| `alarms` | Wake the extension up to retry failed uploads, because the browser puts it to sleep between jobs. |

## Updating

**The extension.**

- **Built from source (Option B):** run `git pull`, then `npm ci` and `npm run build` in the `extension` folder.
- **From a release (Option A):** download the new `-chrome.zip` and unzip it. Replace the contents of your existing extension folder with the new files. Keep the folder itself where it is.

Then open `chrome://extensions` or `edge://extensions` and click the circular **Reload** arrow on the Capture to Drive card, in each browser. Your settings stay as long as you reload from the same folder. Do not load the new copy as a second extension: a different folder counts as a new extension, and you would paste the settings again. Removing the extension (not reloading it) also erases its settings.

**The mailbox.** Only when `mailbox/Code.gs` or `mailbox/appsscript.json` changes. To check, compare the `mailbox` folder of your old and new versions (`git diff`, or GitHub's compare view between two release tags). If you use releases, take the new files from the new release's **Source code (zip)**.

1. Paste the new code into the Apps Script editor and save.
2. Click **Deploy > Manage deployments**, click the pencil (**Edit**) on the existing deployment, choose **New version** under **Version**, then click **Deploy**.

The web address stays the same, and every extension gets the new code at once. Never use **New deployment** for an update. It creates a second web address. The old address keeps working, but it keeps running the old code, so extensions that use it never get the update unless you change every Settings page. Details are in [mailbox/SETUP.md](mailbox/SETUP.md).

**If the secret key leaks,** run `rotateKey()` in the Apps Script editor, then paste the new key into Settings in every browser. See [mailbox/SETUP.md](mailbox/SETUP.md).

## Troubleshooting

These tables cover the common messages. Each one quotes the extension's exact words.

**The badge shows a number.** Those captures could not reach Drive yet, usually because the internet is down. Nothing is lost. They retry by themselves (see above). To try right now, click the icon and choose **Retry now**. If a capture has failed three times, **View** shows the last reason:

| Reason behind View | What to do |
|---|---|
| Couldn't reach Drive. Check your internet connection. | The connection dropped. It clears by itself once you are back online. |
| The mailbox did not answer in time. / The upload did not finish in time. | A slow connection or a large file. It retries by itself. If it never finishes, **Discard** it and drag the file into Drive yourself. |
| Drive storage is full. | The owner's Google Drive is out of space. Free some space (or add storage), then click **Retry now**. |
| The Capture folder is in Drive's Trash. Restore it, then press Retry. | In Drive, open **Trash**, right-click the `Capture` folder, and choose **Restore**. If `Capture` is not listed, a folder that contains it may be in Trash. Restore that folder instead. Then press **Retry**. No `setup()` needed. |
| The Capture folder is missing. Run setup() again. | If the folder was deleted forever, run `setup()` as the owner, then press **Retry**. But if `setup()` was run in the wrong Google account, do not run it again, even though the message says to. Set `FOLDER_ID` back to the old folder instead, as described in section 3 of [mailbox/SETUP.md](mailbox/SETUP.md). |
| Mailbox did not answer with JSON (HTTP …). / Mailbox answered with something unexpected (HTTP …). | The **Mailbox URL** in Settings is probably wrong, or its deployment was archived. Open Settings, click **Test connection**, and fix the URL. Then press **Retry now**. |
| Anything else | Google's or the browser's own wording. The capture keeps retrying. If it never clears, **Discard** it and capture again. |

**The badge shows a red `!`.** Click the icon, choose **View**, and read the message next to each item. Then use **Retry** or **Discard**.

| Message | What to do |
|---|---|
| Mailbox key was rejected. Check Settings. | The key is wrong, or it was rotated. Open Settings, paste the right key, click **Save**, then press **Retry** on the item. |
| Mailbox not found. Check the URL in Settings. | The mailbox URL is wrong, or that deployment was deleted. Copy the `/exec` URL from **Deploy > Manage deployments** into Settings, click **Save**, then **Test connection**, then press **Retry** on the item. |
| Too big for the mailbox. | The file is over the size limit (see Limits). Press **Discard** and drag the file into Drive yourself. |
| This capture couldn't be read. Discard it and capture again. | Press **Discard**, then capture it again. |
| Upload needs attention. | Press **Retry**. If it comes back, press **Discard** and capture it again. |

**Test connection does not say Connected ✓.** Read the message under the button, or under the field it points to.

| Message | What it means |
|---|---|
| Enter the mailbox URL. / Enter the secret key. | That field is empty. |
| That doesn't look like a mailbox URL. It should start with https://script.google.com/ and end in /exec. | The web address is not a mailbox address. Copy the **Web app URL** from the deployment again. |
| Mailbox key was rejected. Check the key. | The key is wrong. Paste it again. |
| Mailbox not found. Check that the URL ends in /exec. | The mailbox URL is wrong, or that deployment was deleted. Copy the `/exec` URL from **Deploy > Manage deployments** into Settings and test again. |
| That URL didn't answer like a mailbox. Check that it ends in /exec. | The web address is wrong (a typo, or a deployment that was archived), or it is not the mailbox. |
| The mailbox didn't accept the test. Check the URL and key. | Check both the web address and the key. |
| Couldn't reach the mailbox. Check the URL and your connection. | No internet, or a typo in the address. |
| The mailbox had a problem. Try again in a minute. | Google's side hiccuped. Wait a minute and test again. |

**Save does not say Saved.** The message is under the field it points to, or under the buttons.

| Message | What it means |
|---|---|
| Settings not saved. Check the fields above. | A field has a problem. Its message is under it. |
| Enter your name. / Use 30 characters or fewer. / Use letters or numbers in your name. | The name is empty, too long, or made only of characters that cannot go in a file name. |
| Couldn't save your settings. Try again. | The browser could not store them. Try again. |
| Couldn't load your saved settings. Reload this page. | Reload the page. |

**Messages on the note card:**

| Message | What to do |
|---|---|
| This page can't be saved. Try Select area instead. | Whole page does not work on browser pages (addresses starting with `chrome://` or `edge://`), on the extension store, or on a page another tool is already inspecting. Use **Select area**. On browser pages and the extension store, it saves the visible part and says "Selection isn't available on this page, so the visible area was captured." |
| This page can't be captured. | The browser would not take a picture of the tab. Try again, or use **Whole page**. |
| Couldn't download this PDF. It may need you to be logged in. Download it, then use Upload files. | The extension could not fetch the PDF. Download it yourself, then use **Upload files…**. |
| Couldn't download that file. It may need you to be logged in. | The same problem for **Save linked file to Capture**. Download the file, then use **Upload files…**. |
| Too big for the mailbox (max 20 MB). Drag it into Drive directly. | The file is over the size limit. Drag it into the `Capture` folder in Drive yourself. |
| Couldn't save this capture. Capture it again. | Something went wrong before the capture was queued, for example because the extension was reloaded. Capture it again. |
| This capture is no longer available. Capture it again. | The capture was already saved, discarded, or cleaned up. Capture it again if it is not in Drive. |

**Messages on the upload page and in the menu:**

| Message | What to do |
|---|---|
| Set up your mailbox in Settings to upload files. | Settings are not complete yet. Click **Open Settings**. |
| Failed: This file is empty. | The file has no content. It was not uploaded. |
| Failed: Couldn't queue this file. Choose it again. | The browser could not store the file. Choose or drop it again. |
| Files are queued. Couldn't start the upload. Use Retry now in the extension popup. | The files are stored but did not start. Click the toolbar icon and choose **Retry now**. |
| Couldn't check the upload queue. (in the menu) | Close the menu and open it again. If it keeps happening, click **Reload** on the extension's card on the extensions page. |

**Whole page shows a bar saying the extension "started debugging this browser".** This is normal. It appears at once and goes away about five seconds after the capture. It cannot be shortened or hidden, so do not click its **Cancel** button while a capture is running. The first Whole page after the browser starts can take up to about twelve seconds. After that it takes a fraction of a second.

**The icon is missing, or Settings are empty.** Extensions belong to one browser profile. Check that you are in the profile where you loaded it. Loading the extension from a different folder also counts as a new extension, with empty settings.

**Developer mode or Load unpacked is greyed out.** The computer or browser is managed by an organization that blocks unpacked extensions. Use a personal computer or browser profile instead.

**The shortcut does nothing.** Another extension or app may use the same keys. Pick different ones on the shortcuts page.

**Problems while setting up the mailbox** (such as "This app is blocked", or no **Anyone** option when you deploy): see [mailbox/SETUP.md](mailbox/SETUP.md). It covers the Google side in detail, including how to recover the key or the folder.

## Limits

- **Desktop Chrome and Edge only.** No Firefox, Safari, or phones. Other Chromium-based browsers have not been tested.
- **Tested on macOS** with Chrome and Edge. Nothing in the code is Mac-only, so Windows and Linux should work, but they have not been tested.
- **An unpacked install.** It is not in the Chrome Web Store, so you load it with Developer mode on, and updates are manual (see Updating). The browser may now and then ask whether to turn off developer-mode extensions. Keep it on.
- **20 MB per file by default.** This is a cautious limit (`MAX_FILE_BYTES`), not a measured one. [mailbox/SETUP.md](mailbox/SETUP.md) explains how to measure what your mailbox really accepts and raise it.
- **Google's Apps Script quotas apply.** Each upload is one run of the mailbox script, and Google limits how long a run can take and how much a script can do per day. Everyday use stays well below these. If a big batch hits a limit, the uploads wait and retry. See Google's [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas).
- **Whole page** does not work on browser pages, the extension store, or a page another tool is already inspecting. Use Select area there.

## Development

Everything runs from the `extension` folder, with Node.js 22 (22.12 or newer), 24, or 26 and later.

```sh
cd extension
npm ci
npm test         # type-checks the extension and the mailbox, then runs all tests
npm run build    # production build into .output/chrome-mv3
npm run dev      # WXT dev mode: rebuilds when you change a file
npm run zip      # the release zip, in .output/
```

`npm test` and `npm run build` must both pass before a change is done.

`npm ci` may report a few vulnerabilities. They come from WXT's own development tools (the runners it uses to launch Firefox and Android for testing), not from the extension. None of that code is in the built extension, and you don't need `npm audit fix`.

| Path | What it holds |
|---|---|
| `extension/entrypoints/` | The service worker (`background.ts`), the menu (popup), Settings (options), the upload page, the note window, and the two scripts injected into pages. |
| `extension/lib/` | Everything else: file names, descriptions, settings, the mailbox client, the upload queue, the note step, and the capture flows. |
| `extension/assets/` | `tokens.css` (every color and size) and `components.css` (shared button, field, and status styles). |
| `extension/tests/` | The extension's tests. |
| `mailbox/` | `Code.gs` and `appsscript.json` (pasted into Apps Script), [SETUP.md](mailbox/SETUP.md), the mailbox's tests in `mailbox/tests/` (run by the same `npm test`), and the size probe in `mailbox/tools/`. |
| `docs/` | The design doc and the manual test checklist. |

The design doc is [docs/design.md](docs/design.md). It is the reference for behavior, formats, and wording, and code comments cite its sections. Before a release, run the manual checks in [docs/acceptance-checklist.md](docs/acceptance-checklist.md) in Chrome and Edge. AI coding agents: start with [AGENTS.md](AGENTS.md).

## Contributing

Issues and pull requests are welcome. Keep `npm test` and `npm run build` passing, follow the conventions in [AGENTS.md](AGENTS.md), and match the existing style: TypeScript strict, colors only from the design tokens, and short, plain UI text.

## License

MIT. See [LICENSE](LICENSE).
