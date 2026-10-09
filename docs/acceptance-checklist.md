# Acceptance checklist

A manual test of Capture to Drive in a real browser. Run it once in each browser you support, for example once in **Edge** and once in **Chrome**, after setting up the mailbox and loading (or reloading) the extension. It takes about 20 minutes per browser. Tick each box, and note anything that looks off. A screenshot helps.

**Before you start:** the toolbar icon → Settings → **Test connection** says **Connected ✓**. Have the correct secret key at hand (for example in your password manager), because one test changes it.

## Captures

- [ ] **Select area.** On a normal website, click the icon, choose **Select area**, and drag a box. A note card appears in the bottom right. Type a note and press **Enter**. → "Saved to Capture ✓", then the card goes away.
- [ ] **Select area, keyboard.** Start Select area again and press **Enter** without dragging. → It captures the whole visible part of the page.
- [ ] **Select area, zoom.** Zoom the page to 125% (Cmd and + on a Mac, Ctrl and + on Windows). Select a small area. → The saved image shows exactly what you boxed.
- [ ] **Select area on a browser page.** Open `edge://settings` (or `chrome://settings`) and choose Select area. → It captures the visible area and says "Selection isn't available on this page, so the visible area was captured."
- [ ] **Whole page.** On a long page, such as a receipt or an article, choose **Whole page**. → A PDF is saved, and its text can be selected in Drive's preview.
- [ ] **Save this PDF.** Open a public PDF in a tab. → **Save this PDF** is enabled and saves it. On a normal web page the button is greyed out.
- [ ] **Save this PDF, logged in.** Open a PDF that needs your login, such as a bank statement or a utility bill. → It saves.
- [ ] **Right-click a link.** Right-click a link to a PDF and choose **Save linked file to Capture**. → It saves. Then right-click a link to a normal web page. → It says "That link opens a web page, not a file."
- [ ] **Upload files.** Choose **Upload files…** and drop 3 files, including one over 10 MB. → Each row starts as Adding…, then goes Waiting → Uploading → Saved ✓. When the last file is queued, the page says "Every file is queued. You can close this tab." Close the tab at that point and check that the files still reach Drive.
- [ ] **Upload, refused.** Drop an empty file, or one over 20 MB. → It's refused on the spot with a "Failed:" line, and the other files still upload.
- [ ] **Upload, note text.** Drag a word of text from another window into the **Note** field. → The text goes in.

## The note step

- [ ] **Esc discards.** Capture something, then press **Esc** on the note card. → The card goes away, and nothing is saved.
- [ ] **Note in Drive.** In Drive, open a file you saved with a note and look at its details or description. → The note is there, with the page title and address.

## When things go wrong

- [ ] **Wi-Fi off.** Turn Wi-Fi off and capture something. → The card says "Still uploading. It will finish on its own.", and the toolbar badge shows **1**. Turn Wi-Fi back on, then either wait about a minute or click the icon and choose **Retry now**. → The badge clears and the file is in Drive.
- [ ] **Wrong key.** In Settings, change one character of the key and save. Capture something. → The card shows the key-rejected message and **stays until you press Close**. The badge shows a red **!**. Put the right key back, save, then click the icon, choose **View**, and click **Retry** on that item. → It uploads.
- [ ] **Whole page while an error card shows.** While the error card from the previous step is still on screen, run **Whole page**. → The saved PDF does not include the error card.

## The result in Drive

- [ ] **Files.** Every test file is in the owner's **Capture** folder, owned by the owner's account. Names look like `2026-10-08 13.45 Alex - store.example.com - Receipt.png` (date, time, your name, site, title).
- [ ] **Clean-up.** Delete the test files when you're done, by moving them to Drive's Trash.

If something does not match, note what you did and what you saw, and open an issue on the project's GitHub page.
