# Mailbox setup

The mailbox is a small Google Apps Script web app that runs as **the owner**: the Google account that will own the `Capture` folder. The extensions send each capture to it, and it saves the file into that one Drive folder. You set it up once, and everyone who sends captures uses the same mailbox.

You never type a key or URL into a file in this repo. You copy them from Google into each extension's Settings page.

If an AI agent is setting this up for you, it follows [SETUP-WITH-AI.md](../SETUP-WITH-AI.md), which uses the same steps as this page.

## What you need

- The owner's Google sign-in (password and any 2-step prompt) for a few minutes.
- `mailbox/Code.gs` and `mailbox/appsscript.json`, open so you can copy from them. Take them from the same version as your extension:
  - If you built the extension from source, use the files in your copy of the repo.
  - If you downloaded the release zip, open the same release page, download **Source code (zip)**, and use the `mailbox` folder inside it.
  - To copy a file straight from GitHub instead, open it and use the **Copy raw file** button. Make sure the branch menu shows your release's tag, not `main`.

## 1. Use a browser profile with only the owner's account

The mailbox must be created while signed into the owner's account, and that account must be the only Google account signed in to that browser profile. With several accounts signed in, Google can attach the script or its permissions to the wrong one.

If you are the owner and your everyday browser profile is signed into only your own Google account, use it and skip to section 2. Otherwise, make a separate profile just for this setup:

1. In Chrome, open the profile menu (top right) and choose **Add**, then **Continue without an account**. In Edge, click the profile picture in the toolbar and choose **Add profile**.
2. In that new profile, sign into the owner's Google account.
3. Do sections 2 to 4 in that profile.

This profile is only for creating the mailbox. Load the extension later in the profile you browse with every day (README step 3), not in this one.

## 2. Create the project

1. Go to <https://script.google.com> and click **New project**.
2. Click the project name at the top and rename it to `Capture mailbox`.
3. In the left sidebar, open **Project Settings** (gear icon) and turn on **Show "appsscript.json" manifest file in editor**.
4. Go back to **Editor**. Open `Code.gs`, select everything, and paste the contents of `mailbox/Code.gs`.
5. Open `appsscript.json`, select everything, and paste the contents of `mailbox/appsscript.json`.
6. Click **Save project** (disk icon).

The manifest selects the V8 runtime, the Drive permission, and the web app settings (runs as the owner, open to anyone with the URL and the key).

The function dropdown at the top of the editor now lists `setup`, `rotateKey`, `doGet`, and `doPost`. You only ever run `setup` and `rotateKey`. The other two answer the extension; never run them from the editor.

## 3. Run `setup()`

1. In the function dropdown, choose **setup**, then click **Run**.
2. Google asks for permission. Click **Review permissions** and choose the owner's account.
3. You may see **Google hasn't verified this app**. This is expected: the script is the owner's own and has not gone through Google's review for public apps. Click **Advanced**, then **Go to Capture mailbox (unsafe)**. (With a Google Workspace work or school account, this screen may not appear. Carry on.)
4. The next screen asks to let Capture mailbox "See, edit, create, and delete all of your Google Drive files". This is the permission Apps Script needs to add files to a folder. The code only adds files to the `Capture` folder. If the screen shows a checkbox next to the permission, tick it. Click **Allow**.
5. When the run finishes, open the **Execution log** at the bottom of the editor. Between Google's own "Execution started" and "Execution completed" lines, the script logs two lines:
   - `Mailbox key: ...` is the secret key.
   - `Capture folder: ...` is the link to the new `Capture` folder in the owner's My Drive.
6. Copy the key into a password manager. Do not put it in a file, in this repo, or in a chat.

The key may also stay in the project's run history (**Executions** in the left sidebar), which only people with access to the project can open. `setup()` keeps an existing key and logs the key and folder link again, so if you lose the key, run `setup()` again as the owner to see it.

**If Google blocks a step:**

- **"This app is blocked" or "Access blocked".** The account does not allow apps like this, usually because of a Workspace admin's policy or Google's Advanced Protection. Use a personal Google account as the owner, or ask your admin.
- **The run stops with an error about permissions or authorization.** The Drive permission was not granted, for example because its checkbox was left unticked. Run `setup()` again, and this time tick the box before **Allow**.

Run `setup()` and deploy the mailbox while signed in as the Google account that will own the `Capture` folder. `setup()` creates a folder when none is set. It replaces the old folder only if it was deleted forever or this account cannot open it. It retries the lookup once before replacement, then logs the old ID.

If `setup()` replaced the folder, its Execution log shows the old folder ID and what to do next. Which steps apply depends on the account you used:

- **You ran `setup()` in the wrong account.** First copy the old ID from the Execution log, before you switch accounts. Then sign in as the Google account that deployed the mailbox. If you lost the log, open the original `Capture` folder in Drive with that account. The old ID is the end of its web address, after `/folders/`. In **Project Settings > Script Properties**, set `FOLDER_ID` back to the old ID. Press **Retry** in the extension popup. Do not run `setup()` again for this. Optional: delete the extra empty `Capture` folder. It is the one on the `Capture folder:` line of that log. Do not delete the one that holds your files.
- **You used the right account, and the old folder was deleted forever.** Nothing more is needed. Press **Retry** in the extension popup.

If the `Capture` folder is in Drive's Trash, restore it there, then press **Retry** in the popup. If `Capture` is not listed, a folder that contains it may be in Trash. Restore that folder instead. You do not need to run `setup()`. To start over with a fresh folder on purpose, delete the old folder forever from Trash first, then run `setup()`.

## 4. Deploy as a web app

1. Click **Deploy**, then **New deployment**.
2. Click the gear icon next to **Select type** and choose **Web app**.
3. Set **Execute as** to **Me** (the owner's account).
4. Set **Who has access** to **Anyone**. This is required because the extension sends no Google sign-in. The secret key is the lock. (A Google Workspace admin can block this option. If it is missing, use a personal Google account as the owner, or ask your admin.)
5. Click **Deploy**. If Google asks you to authorize again, approve it as in section 3. Then copy the **Web app URL**. It starts with `https://script.google.com/macros/s/` (or `https://script.google.com/a/macros/` for a Workspace account) and ends with `/exec`.

Create this deployment only once. Every later update edits it (see "Updating the mailbox code later").

To check it, open that URL in a browser tab. You should see `{"ok":false,"error":"not_found"}`. That is the correct answer: the URL reveals nothing to a visitor.

## 5. Connect each extension

The mailbox is ready. Go back to the [README](../README.md) and continue at step 3 of "Set it up yourself", in the browser profile you use every day. You will load the extension, then in step 4 paste the `/exec` URL, the key, and that person's own name into its Settings and click **Test connection**. It should say **Connected ✓**.

Everyone who sends captures uses the same URL and key. Share them privately, never in a chat or a public place.

## Updating the mailbox code later

Paste the new `Code.gs` (and `appsscript.json`, if it changed) into the editor and save, then:

1. Click **Deploy**, then **Manage deployments**.
2. Click the pencil (**Edit**) on the existing deployment.
3. Under **Version**, choose **New version**, then click **Deploy**.

The URL stays the same, and every extension gets the new code at once. **Do not** use **New deployment** for an update. It creates a second `/exec` URL. The old URL keeps working, but it keeps running the old code, so extensions that use it never get the update unless every Settings page is changed to the new URL.

## If the key leaks: `rotateKey()`

1. In the editor, choose **rotateKey** in the function dropdown and click **Run**.
2. Copy the new key from the Execution log.
3. Paste the new key into Settings in **every** extension. The old key stops working immediately. Until an extension has the new key, its uploads are rejected and it shows **!**. After you fix its Settings, click the toolbar icon, click **View** on the "needs attention" line, and press Retry on each item.

This is also how you stop someone from sending: rotate the key and give the new one only to the people who should keep it.

## Settings you can change: Script Properties

Open **Project Settings**, then **Script Properties**.

| Property | Meaning |
|---|---|
| `MAILBOX_KEY` | The secret key. Created by `setup()`. Change it only with `rotateKey()`. |
| `FOLDER_ID` | The Capture folder. Created by `setup()`. You may move it in Drive. If it is in Trash, restore it or the folder that contains it, then press **Retry**. If `setup()` ran in the wrong account, follow the account steps in section 3. If the old folder was deleted forever, run `setup()` to make a new one. |
| `MAX_FILE_BYTES` | Largest file the mailbox accepts, in bytes of the original file. If it is not set, the mailbox uses `20971520` (20 MB). |

If `setup()` stops with "Could not open the Capture folder", nothing was changed. Run it again. If it keeps failing, check that `FOLDER_ID` is only the folder ID: the part of the folder's web address after `/folders/`. Fix it there. Deleting the property and running `setup()` starts a new folder and leaves the old files behind in the old one, so do that only if you want a fresh start.

## Measuring the real size limit

The default of 20 MB is a safe guess. This procedure finds out how large a file the web app really accepts. It creates real test files in the Capture folder, so do it once, then clean up.

You need Node.js 22 (22.12 or newer), 24, or 26 and later, and the extension built from source, because step 6 changes the extension too. The commands below are for a Mac or Linux terminal. On Windows, run them in WSL (Windows Subsystem for Linux).

1. **Raise the cap temporarily.** In Script Properties, set `MAX_FILE_BYTES` to `104857600` (100 MB) so the mailbox does not refuse the large test files before Google does.
2. **Give the probe the URL and key** without writing them into any file. In a terminal at the repo root, run the first command, paste the `/exec` URL, and press Enter. Run the second, paste the key (it stays hidden), and press Enter. Then run the third.

   ```sh
   read -r MAILBOX_URL
   read -rs MAILBOX_KEY
   export MAILBOX_URL MAILBOX_KEY
   ```

3. **Preview the run.** This sends nothing and shows what the probe would do:

   ```sh
   node mailbox/tools/probe-size-limit.mjs
   ```

4. **Run it.** The default sends 5, 10, 20, and 30 MB files, 3 times each (12 requests, about 195 MB, several minutes):

   ```sh
   node mailbox/tools/probe-size-limit.mjs --yes
   ```

   To try other sizes, pass `--sizes`, for example `--sizes 2.5,15,25`. Decimal sizes are fine.

5. **Read the table.** Each row is one request: the size in MB, the run number, the HTTP status, the mailbox result (`ok`, `too_large`, `server_error`, `non-JSON`, `timeout`, and so on), and how many seconds it took. The probe ends with the largest size that saved in every run and a suggested value, which is 80% of that size in bytes. Also look at the seconds. The extension waits 60 seconds plus 10 seconds for each MB of the file (260 seconds for a 20 MB file) before it gives up and retries later. The probe itself warns at 60 seconds, which is cautious: a file that takes that long is a poor fit.
6. **Set the real cap.** In Script Properties, set `MAX_FILE_BYTES` to the value you chose, replacing the temporary `104857600`. Then update the `MAX_FILE_BYTES` constant in `extension/lib/mailbox-client.ts` to the same number, rebuild the extension, and click **Reload** on its card in every browser. The mailbox and the extension must agree.
7. **Delete the test files.** In the `Capture` folder in Drive, search for `TEST size probe` and delete every match.
8. **Close the terminal window** (or run `unset MAILBOX_URL MAILBOX_KEY`) so the key does not stay in that session.

The table holds no key. If you want to help improve the default, share it in an issue on the project's GitHub page.
