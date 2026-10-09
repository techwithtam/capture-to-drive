# AGENTS.md

Notes for AI coding agents working in this repo.

## What this is

Capture to Drive is a Chrome and Edge (desktop) extension, built with WXT and TypeScript. It saves screenshots, whole pages as PDF, PDFs, linked files, and uploaded files into one Google Drive folder named `Capture`, each with an optional note. There is no server: the extension POSTs each capture with a secret key to a small Google Apps Script web app (the "mailbox") that the folder's owner deploys in their own Google account. It only fills that folder. It does not sort files and contains no AI.

**If someone asked you to set Capture to Drive up for them, follow [SETUP-WITH-AI.md](SETUP-WITH-AI.md) step by step.** The rest of this file is for changing the code.

## Layout

| Path | What it holds |
|---|---|
| `extension/entrypoints/` | Service worker (`background.ts`), popup, options (Settings), upload page, note window, and the two runtime-injected content scripts (`select-area`, `note-card`). |
| `extension/lib/` | All logic: capture flows (`capture-*.ts`), note step, upload queue, mailbox client, settings, file names, descriptions, badge. |
| `extension/assets/` | `tokens.css` (the only place colors are defined) and `components.css` (shared classes). |
| `extension/tests/` | Vitest tests. DOM helpers are in `tests/helpers/`. |
| `mailbox/` | `Code.gs` and `appsscript.json` (pasted into Apps Script by hand), `SETUP.md`, tests in `mailbox/tests/`, and the size probe in `mailbox/tools/`. |
| `docs/` | The design doc and the manual acceptance checklist. |

The design doc is `docs/design.md`. It is the reference for behavior, formats, and UI wording, and code comments cite its sections ("spec section 6.5"). If you change behavior, update it in the same change.

## Commands

Run everything from `extension/`, with Node.js 22 (22.12 or newer), 24, or 26 and later (the `engines` field in `extension/package.json`):

```sh
cd extension
npm ci
npm test         # tsc for the extension and the mailbox first, then vitest run
npm run build    # production build into .output/chrome-mv3
```

The mailbox tests run in the same `npm test`. `extension/vitest.config.ts` includes `../mailbox/tests/`, and `mailbox/tests/harness.ts` loads `Code.gs` in a `node:vm` context with fake `DriveApp`, `PropertiesService`, `CacheService`, `Utilities`, and `ContentService`.

## Conventions

- **TypeScript strict, no `any`.** Kebab-case file names, no barrel files.
- **Colors only through the `--c-*` tokens** in `extension/assets/tokens.css`. A hex or `rgb()`-style color anywhere else fails `tests/design-guard.test.ts`, and so does a `var(--...)` that no stylesheet declares. Add a token to `tokens.css` first if you need one.
- **No em dashes** in UI strings (several tests check the copy modules) or in docs. Keep UI text short and plain.
- **44px touch targets** (`--tap`) for anything clickable.
- **14px minimum text** (`--fs-body`). The 12px `--fs-meta` is only for key hints, monospace file names, and minor metadata.
- **DOM tests** use happy-dom: start the file with `// @vitest-environment happy-dom` and use `tests/helpers/dom.ts` (`mountPage`, `settle`, `byId`). Other tests run in the node environment.
- **No secrets in the repo.** Never commit a mailbox URL or key. Tests use obvious fakes.
- **Mailbox:** helpers end in `_` so they stay out of the Apps Script Run menu. `MAX_FILE_BYTES` in `extension/lib/mailbox-client.ts` must match the mailbox default.

Every change must keep `npm test` and `npm run build` green.
