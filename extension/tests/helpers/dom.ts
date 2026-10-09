// DOM test helpers. Test files that use them start with `// @vitest-environment happy-dom`; every other test
// file keeps the node environment.
//
// An extension page's main.ts looks up its elements when it is imported, so a test mounts the page's real index.html
// first and then imports main.ts fresh (vi.resetModules), the way the browser loads it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type PageName = 'popup' | 'options' | 'upload' | 'note';

/** Puts the body of entrypoints/<page>/index.html into the document, without its <script> tags. */
export function mountPage(page: PageName): void {
  // Vitest runs from the extension folder (where vitest.config.ts is). import.meta.url is not a file URL under happy-dom.
  const path = resolve(process.cwd(), 'entrypoints', page, 'index.html');
  const parsed = new DOMParser().parseFromString(readFileSync(path, 'utf8'), 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.title = parsed.title;
  document.body.innerHTML = parsed.body.innerHTML;
}

/** Clears what a previous test mounted. Listeners on removed elements go with them. */
export function unmountPage(): void {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
}

/** Lets pending promise callbacks and zero-delay timers run, so a render that waits on the browser can finish. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** The element with this id, or a test failure that names it. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`No element with id "${id}"`);
  return element as T;
}
