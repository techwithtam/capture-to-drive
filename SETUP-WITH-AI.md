# Set up Capture to Drive: runbook for AI agents

This file is for an AI agent (Claude Code, Codex, Cursor, or similar) that a person has asked to set up Capture to Drive for them. Follow it phase by phase. It works whether or not you can see and click in the person's browser.

**What you are setting up:** a Chrome or Edge extension, and a small Google Apps Script web app called the **mailbox**, deployed in the Google account that will own the `Capture` folder. That account is **the owner**. The extension sends each capture to the mailbox with a secret key, and the mailbox saves it into the owner's `Capture` folder. Background: [README.md](README.md).

**Scope:** you set up the capture tool only. Capture to Drive fills one inbox folder. It does not sort, rename, or move files, and it includes no AI. Do not offer to build or configure an organizer as part of this setup.

**Reference documents:** [mailbox/SETUP.md](mailbox/SETUP.md) has the click-by-click steps for the Google side, and the README's Troubleshooting section covers the common messages the extension shows. Read `mailbox/SETUP.md` and the `setup()` and `rotateKey()` functions in [mailbox/Code.gs](mailbox/Code.gs) before phase 2, so what you tell the person matches what they will see.

## Hard rules

### The secret key

The key exists in three places: the extension's settings in each browser, the mailbox's Script Properties, and the Apps Script log of each `setup()` or `rotateKey()` run. If you can see the screen, you will see it in that log while you copy it. That is why you must never repeat or store it.

- **Never ask the person to paste the key into the chat.**
- **Never print it, never write it to a file, and never commit it.** That includes logs, notes, scripts, shell history, and environment variables you set.
- **With computer use**, move the key straight from the Apps Script execution log to the extension's **Secret key** field with the clipboard: double-click the key in the log (it is one 64-character word, so a double-click selects all of it), copy, click the Secret key field, paste. Do not read it out, transcribe it, zoom in on it, or repeat it in any message.
- **Without computer use**, tell the person where the key is and where to paste it. They copy and paste it themselves.
- **If the key ever appears in the chat** (for example, the person pastes it by mistake), say so plainly and suggest rotating it once setup works. Run `rotateKey()` only if they say yes.
- Treat the mailbox URL with care too. On its own it cannot add files, but do not write it into files or commits. The person pastes it into Settings.

### Sign-in and approval

- **The person types every Google password and 2-step code.** Never ask for them, type them, or read them out.
- **Explain each permission screen before the person clicks.** Say what it is, why it appears, and what clicking does. With computer use, click a permission button only after the person has said yes.
- **Use only the owner's own Google account.** Do not sign other accounts in or out, change account or security settings, or share the `Capture` folder.
- **Never move the person into a new browser profile without asking.** Their everyday profile is where the extension belongs.

### Keep the same mailbox URL

- **Create exactly one deployment.** Every later update uses **Deploy > Manage deployments > Edit > New version**. Never click **New deployment** after the first one. It creates a second URL. The first URL keeps working but keeps running the old code, so the installed extensions never get the update unless every Settings page is changed.
- **Never run `rotateKey()` unless the person asks.** It replaces the key at once for everyone.
- **Never edit Script Properties by hand**, except for the documented `FOLDER_ID` recovery in section 3 of `mailbox/SETUP.md` (and `MAX_FILE_BYTES` during the optional size check below, if the person asks for it).
- **Never run `doGet` or `doPost` from the editor.** They answer the extension. You only run `setup` and, if asked, `rotateKey`.
- **Never delete the `Capture` folder** or files in it, apart from the size check's test files.

### How to work

- One phase at a time. Each phase ends with a **Done when** check. Do not move on until it passes.
- Before each step that needs the person, say what they will do and what they should see.
- If what the person sees does not match this runbook, stop and tell them. Do not improvise in Google's settings.
- Keep your messages short and plain. Many people doing this are not technical.

## With or without computer use

- **Work in the person's own browser**, in the profile they browse with every day. Do not use a browser that your tools launch for automation: Google often blocks sign-in there, and an extension loaded there is no use to the person.
- **With computer use** (you can see and click in the browser), you can do most of the clicking. The person still signs in, types passwords and codes, and says yes before each permission button.
- **Things many agents cannot do in a browser:** act on `chrome://` or `edge://` pages, use the system file picker, click the extension's toolbar icon or its menu, press the extension's keyboard shortcut, or type into the extension's own pages (addresses starting with `chrome-extension://`). If you cannot, ask the person to do that step.
- **If you control the browser through an extension of your own**, you cannot act in a browser profile where your extension is not installed, such as a new profile. Guide the person through those steps instead.
- **Without computer use**, give the person one small step at a time, with the exact names of the buttons, and ask them to tell you what they see. You can still run commands in a terminal, such as building the extension and copying files to the clipboard.

## If Google or the browser blocks a step

Stop at any of these and tell the person what happened:

- **"This app is blocked" or "Access blocked"** when authorizing. Say: "Google won't let this account run your own script. That usually comes from a work or school admin's policy, or from Google's Advanced Protection. You can use a personal Google account as the owner, or ask your admin." Restart phase 2 with the other account if they choose that.
- **No "Google hasn't verified this app" screen.** This is fine, and common with work or school accounts. Carry on.
- **No "Anyone" option** under **Who has access** when deploying. Say: "Your organization doesn't allow web apps that anyone can reach, and the extension needs that. You can use a personal Google account as the owner, or ask your admin to allow it."
- **`setup()` stops with an error about permissions or authorization.** The Drive permission was not granted, usually because its checkbox was left unticked. Say: "The Drive permission wasn't granted. Let's run setup() again. This time, tick the box next to the Drive permission before you click Allow." Then repeat phase 2 step 7.
- **Developer mode or Load unpacked is greyed out**, or the page says it is managed by an organization. Say: "This browser is managed by your organization, and it blocks extensions loaded this way. You'll need a personal computer, or a browser profile without that policy."

## Phase 0. Interview

Ask, in one short message:

1. **Which browsers and computers** will capture? (Chrome, Edge, or both, and Mac or Windows.) Tell them it has been tested on macOS. Windows should work but has not been tested.
2. **Which Google account will own the `Capture` folder?** All captures are saved there and use its Drive storage. A personal Google account is simplest. A work or school (Workspace) account may block steps this setup needs.
3. **Who else will send captures?** Each person needs the extension on their own computer, plus the mailbox URL and key from the owner.
4. **Has a Capture to Drive mailbox been set up before?** If yes, reuse it. Do not create a second one. Skip phases 2 and 3, and the person pastes the existing URL and key in phase 5.
5. **Is their everyday browser profile signed into any Google account besides the owner's?** This decides how phase 2 starts.

Also tell them what they will do themselves: sign in to Google, approve the permission prompt (which may include a "Google hasn't verified this app" screen, which you will explain), paste the key, and maybe click **Load unpacked**.

Then check the computer yourself: `node --version`, `git --version`, and whether `gh` is installed.

**Done when:** you know the browsers, the owner's account, the other senders, whether a mailbox already exists, and which profile to use.

## Phase 1. Get the extension

**Choose the option:**

- **Option A, the release zip,** if a supported Node.js is not installed. Supported means Node.js 22 (22.12 or newer), 24, or 26 and later.
- **Option B, build from source,** if `node --version` shows a supported version and git is installed, or if the person wants to change the code or raise the size limit.
- If there is no release yet, or it has no `-chrome.zip`, use Option B. If Node.js is missing, ask the person before installing it.

Put the extension in a folder that can stay where it is: the browser loads the extension from that folder every time it starts, and loading from a different folder later counts as a new extension, with empty settings.

**Option A: the release zip.** Download the latest release's file ending in `-chrome.zip` into a new folder, for example `~/capture-to-drive-extension`, and unzip it there. With `gh`:

```sh
mkdir -p ~/capture-to-drive-extension && cd ~/capture-to-drive-extension
gh release download --repo techwithtam/capture-to-drive --pattern '*-chrome.zip'
unzip -o ./*-chrome.zip && rm ./*-chrome.zip
```

Without `gh`, download the file from <https://github.com/techwithtam/capture-to-drive/releases/latest> instead. On Windows, unzip it with `Expand-Archive`.

Phase 2 needs the mailbox files from the same release, so they match the extension. Download the release's source code into another folder, for example with `gh release download --repo techwithtam/capture-to-drive --archive zip`, and unzip it. Its `mailbox` folder has `Code.gs` and `appsscript.json`. (Without `gh`, use **Source code (zip)** on the release page.)

**Option B: build from source.** Ask where to keep the code, or use the home folder:

```sh
git clone https://github.com/techwithtam/capture-to-drive.git
cd capture-to-drive/extension
npm ci
npm run build
```

You may also run `npm test` to check the code. The extension folder is `extension/.output/chrome-mv3`. Print its absolute path for later (`cd .output/chrome-mv3 && pwd`). The path is not a secret.

**Done when:** a `manifest.json` file sits directly inside the extension folder: `extension/.output/chrome-mv3/manifest.json` for Option B, or `manifest.json` at the top of the unzipped folder for Option A. Check with `test -f <folder>/manifest.json` (on Windows, `Test-Path <folder>\manifest.json`). For Option A, `mailbox/Code.gs` also exists in the unzipped source code.

## Phase 2. Create the mailbox

Skip this phase and phase 3 if the person already has a mailbox. These steps match sections 1 to 3 of [mailbox/SETUP.md](mailbox/SETUP.md). Keep the two consistent.

1. **Browser profile.** The owner's account must be the only Google account signed in to the browser profile used for this phase.
   - If the person's everyday profile is signed into only the owner's account, use it.
   - Otherwise, ask whether they want a separate profile just for this setup. If they agree, they create it: in Chrome, profile menu > **Add** > **Continue without an account**; in Edge, the profile picture in the toolbar > **Add profile**. Then they sign into the owner's account there. If you control the browser through an extension, you cannot act in that new profile, so guide them through phases 2 and 3 step by step. They come back to their everyday profile for phase 4.
2. **New project.** Go to <https://script.google.com> and click **New project**. Click the project name at the top and rename it to `Capture mailbox`.
3. **Show the manifest.** In the left sidebar, open **Project Settings** (gear icon) and turn on **Show "appsscript.json" manifest file in editor**. Go back to **Editor**.
4. **Paste `Code.gs`.** Open `Code.gs`, select everything, and replace it with the contents of `mailbox/Code.gs` (from the clone for Option B, or from the release's source code for Option A). If you run on the person's computer, put the file on their clipboard: `pbcopy < mailbox/Code.gs` on a Mac, or `Get-Content mailbox/Code.gs -Raw | Set-Clipboard` on Windows.
5. **Paste `appsscript.json`.** Open `appsscript.json` and replace everything with the contents of `mailbox/appsscript.json`, the same way.
6. **Save.** Click **Save project** (disk icon).

   Check: no error banner, and the function dropdown at the top lists `setup`, `rotateKey`, `doGet`, and `doPost`. (Helper functions end in `_`, which keeps them out of that list.) Only ever run `setup` and `rotateKey`.

7. **Run `setup()`.** Choose **setup** in the function dropdown and click **Run**. Google asks for permission. Explain each screen before the person clicks:
   - **Authorization required:** click **Review permissions** and choose the owner's account.
   - **Google hasn't verified this app** (it may not appear; if not, carry on): say something like "This is normal. The 'app' is your own copy of the mailbox script, running in your own account. Google reviews apps that other people sign into, and this one hasn't been through that review. The word 'unsafe' on the next link is Google's standard wording." Then: **Advanced**, then **Go to Capture mailbox (unsafe)**.
   - **The permission screen** asks to "See, edit, create, and delete all of your Google Drive files". Say: "Apps Script needs this Drive permission to add files to a folder. The script you pasted only adds files to the Capture folder. It never reads, changes, or deletes your other files." If a checkbox is shown next to the permission, tick it. Then **Allow**.
8. **Read the execution log** at the bottom of the editor. Google's own "Execution started" and "Execution completed" lines frame the run. On a first run, the script logs two lines between them:
   - `Mailbox key: ` followed by the key. Do not copy, read out, or repeat it now.
   - `Capture folder: ` followed by a link to the new folder in the owner's My Drive.

   If the script logs anything else (about an old folder or Trash), or the run ends with "Could not open the Capture folder", this is not a first run. Stop and follow section 3 of `mailbox/SETUP.md` with the person. For a permissions error, see "If Google or the browser blocks a step".

   Keep this tab open. If the log is gone by phase 5, running `setup()` again is safe: it keeps the same key and folder and logs both again.

**Done when:** the log shows both lines, and the `Capture folder` link opens a folder named `Capture` in the owner's Drive.

## Phase 3. Deploy as a web app

1. Click **Deploy**, then **New deployment**.
2. Click the gear icon next to **Select type** and choose **Web app**.
3. **Execute as:** **Me** (the owner's account). Explain: "Every file is saved as you, so you own all of them."
4. **Who has access:** **Anyone**. Explain: "The extension doesn't sign into Google, so the web app must accept requests from anyone. The secret key is the lock. Without it, the mailbox refuses the request and reveals nothing." If **Anyone** is not offered, see "If Google or the browser blocks a step".
5. Click **Deploy**. If Google asks to authorize again, explain and approve it as in phase 2.
6. Copy the **Web app URL**. It starts with `https://script.google.com/macros/s/` (or `https://script.google.com/a/macros/` for a Workspace account) and ends with `/exec`. Do not use any URL ending in `/dev`.

**Done when:** opening the `/exec` URL in a browser tab shows `{"ok":false,"error":"not_found"}`, and **Deploy > Manage deployments** lists exactly one deployment.

## Phase 4. Load the extension

Do this in the person's everyday browser profile, in each browser they use on this computer. If phase 2 used a separate profile, switch back first: extensions and their settings belong to one profile. The same extension folder works in both Chrome and Edge.

1. Open the extensions page: `chrome://extensions` in Chrome, `edge://extensions` in Edge.
2. Turn on **Developer mode**: a switch at the top right in Chrome, in the left sidebar in Edge.
3. Click **Load unpacked** and choose the extension folder from phase 1. On a Mac, `.output` is a hidden folder. In the file picker, press `Cmd+Shift+G`, paste the absolute path you printed in phase 1, and press Enter. (Or press `Cmd+Shift+.` to show hidden folders.) On Windows, paste the path into the picker's address bar.
4. Pin the icon: click the puzzle-piece button next to the address bar and pin **Capture to Drive** (Chrome: the pin icon. Edge: the eye icon).

If you cannot act on the extensions page or the file picker, give the person these steps and the folder path, and wait.

**Done when:** the **Capture to Drive** card shows on the extensions page with no **Errors** button, the icon is on the toolbar, and clicking it shows "Set up your mailbox to start saving to Drive." with a **Finish setup** button.

## Phase 5. Enter the settings

1. Click the Capture to Drive icon, then **Finish setup**. The Settings page opens in a tab.
2. **Mailbox URL:** paste the `/exec` URL from phase 3.
3. **Secret key:** paste the key straight from the execution log, following the key rules above. The field hides it.
4. **Your name:** ask the person what name to use. It goes into every file name, so it shows who saved what. Up to 30 characters.
5. Click **Save**. The page says "Saved."
6. Click **Test connection**.

If the test fails, the message under the button (or under a field) says why. Match it against the "Test connection" table in the README's Troubleshooting section.

Then suggest the person store the mailbox URL and key in their password manager, if they have not already. They do this themselves.

**Done when:** the Settings page says **Connected ✓**.

## Phase 6. First capture

1. Open an ordinary web page, for example <https://example.com>.
2. Click the icon and choose **Select area** (or press `Alt+Shift+S`, which is `Option+Shift+S` on a Mac).
3. Drag a box around part of the page. A note card appears at the bottom right.
4. Type a note, for example `First capture`, and press **Enter**.
5. The card says "Saving…", then "Saved to Capture ✓", and goes away.

If it says "Still uploading. It will finish on its own.", wait a minute and check the icon's menu. It should say "All saved".

Then open the `Capture` folder (the link from phase 2). A new picture is there, named like `2026-10-08 14.05 Alex - example.com - Example Domain.png`, with the person's own name. Its details panel in Drive shows `Note: First capture` in the description. The person can delete this test file whenever they like.

**Done when:** the file is in the `Capture` folder and its description includes the note.

## Phase 7. Other people

Each other sender needs phases 1, 4, and 5 on their own computer, with the same mailbox URL and key and their own name. If they use both Chrome and Edge, they do phases 4 and 5 in each browser. For another browser on this computer, repeat phases 4 and 5 here.

- **If you can work on their computer** (the person moves you there, or they run you themselves), do those phases there.
- **Otherwise, hand off.** Give the owner a short message to send each sender, with no key or URL in it. For example: "To send captures to our Capture folder, install Capture to Drive: follow 'Set it up yourself' steps 1, 3, and 4 in the README at https://github.com/techwithtam/capture-to-drive, or ask your AI agent to follow SETUP-WITH-AI.md there and tell it a mailbox already exists. I'll give you the mailbox URL and key privately."
- The owner shares the URL and key privately, for example in person or through a password manager's sharing feature. Never through you, and never in a chat.
- The files belong to the owner. The other person cannot see the `Capture` folder unless the owner shares it in Drive. Ask the owner before sharing anything.

**Done when:** each sender's browsers say **Connected ✓** and a test capture from each is in the `Capture` folder, or you have given the owner the hand-off message for the senders you cannot reach.

## Phase 8. Later updates

**The extension:**

- Option B (source): `git pull`, then `npm ci` and `npm run build` in `extension/`.
- Option A (release): download the new `-chrome.zip` and replace the contents of the same extension folder with the new files. Keep the folder where it is.

Then click the circular **Reload** arrow on the Capture to Drive card on the extensions page, in each browser. Never remove the extension and never load a second copy: either one loses the settings.

**The mailbox**, only when `mailbox/Code.gs` or `mailbox/appsscript.json` changed. To check, compare the `mailbox` folder of the old and new versions: `git diff <old>..<new> -- mailbox/` for Option B, or the two releases' source code for Option A (GitHub's compare view between the two tags works too).

1. In the Apps Script editor, paste the new `Code.gs` (and `appsscript.json`, if it changed) and save. For Option A, take them from the new release's source code.
2. **Deploy > Manage deployments**, click the pencil (**Edit**) on the existing deployment, choose **New version** under **Version**, and click **Deploy**. If Google asks for permission again, explain and approve it as in phase 2.

The URL stays the same, and every extension gets the new code at once. Never **New deployment**: the extensions would stay on the old URL and the old code.

**Done when:** **Test connection** still says **Connected ✓**, with the same mailbox URL as before.

## Phase 9. If something fails

- **Messages in the extension:** the README's Troubleshooting section covers the common ones and what to do. Any other reason behind **View** is Google's or the browser's own wording: the capture keeps retrying, and if it never clears, the person can **Discard** it and capture again.
- **The Google side:** section 3 of `mailbox/SETUP.md` covers a `Capture` folder that is missing or in Trash, a `setup()` run in the wrong account, and blocked authorization. "Settings you can change" there covers Script Properties.
- **A lost key:** run `setup()` again in the owner's account. It logs the same key again and changes nothing.
- **A leaked key:** run `rotateKey()` only if the person agrees, then paste the new key into Settings in every browser.

Do not run `setup()` while signed into any account but the owner's, and do not create a second deployment to "fix" something.

## Optional: measure the real size limit

The mailbox accepts files up to 20 MB by default, which is a cautious guess. Only if the person asks to raise it, follow "Measuring the real size limit" in `mailbox/SETUP.md`. In short:

- It needs Option B (build from source) with a supported Node.js, because the new limit goes into `extension/lib/mailbox-client.ts` as well as the mailbox's `MAX_FILE_BYTES` Script Property.
- The probe (`mailbox/tools/probe-size-limit.mjs`) reads the mailbox URL and key from environment variables. **The person runs those commands in their own terminal**, typing the key into the hidden `read -rs` prompt. Do not run them in your own shell, because the key would then be in your session. The commands are for a Mac or Linux terminal. On Windows, the person runs them in WSL.
- It creates real test files named `TEST size probe ...` in the `Capture` folder. They are the only files you may suggest deleting.
- The person can paste the probe's result table to you. It contains no key. Help them choose the value and set it in both places, then rebuild and reload the extension in every browser.

**Done when:** `MAX_FILE_BYTES` in Script Properties and in `extension/lib/mailbox-client.ts` hold the same value, the extension is rebuilt and reloaded, the `TEST size probe` files are deleted, and the person has closed that terminal (or run `unset MAILBOX_URL MAILBOX_KEY`).
