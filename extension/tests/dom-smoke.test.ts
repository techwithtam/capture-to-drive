// @vitest-environment happy-dom
// Smoke test for the DOM test setup: the popup's real HTML and main.ts run in happy-dom against WXT's fake
// browser. The screen-by-screen DOM tests build on tests/helpers/dom.ts the same way.
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byId, mountPage, settle, unmountPage } from './helpers/dom';

beforeEach(() => {
  fakeBrowser.reset();
  vi.resetModules();
  mountPage('popup');
});

afterEach(() => {
  vi.restoreAllMocks();
  unmountPage();
});

describe('DOM test setup', () => {
  it('runs in happy-dom', () => {
    expect(typeof window).toBe('object');
    expect(document.querySelector('main.popup')).not.toBeNull();
  });

  it('shows Finish setup in the popup while settings are missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('../entrypoints/popup/main');
    await settle();

    expect(byId('setup').hidden).toBe(false);
    expect(byId('finish-setup').textContent).not.toBe('');
  });
});
