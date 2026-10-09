import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'node',
    // The default 5 s is tight for the DOM and queue tests (about 2.5 s each under full parallel load on a fast
    // laptop), so a slower machine or CI runner would see random timeouts. A hung test still fails, just later.
    testTimeout: 15_000,
    // The mailbox (Apps Script) lives outside the extension, so its tests are pulled in from ../mailbox.
    include: ['tests/**/*.test.ts', '../mailbox/tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Vitest replaces CSS imports with empty strings. Keep `?raw` CSS imports real, because lib/badge.ts reads its
    // colors from tokens.css that way; plain stylesheet imports stay empty.
    css: { include: [/\.css\?raw$/] },
  },
});
