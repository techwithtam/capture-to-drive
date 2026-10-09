// Toolbar badge (spec section 6.5): nothing when empty, a count on the accent color, "!" on the error red.
// Colors are read from assets/tokens.css, never written out here.
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach, describe, expect, it } from 'vitest';
import tokensCss from '../assets/tokens.css?raw';
import { badgeStateFor, BADGE_COLORS, readColorToken, updateBadge } from '../lib/badge';
import type { QueueStatus } from '../lib/queue';
import { rgbaOf } from './helpers/queue-harness';

function items(...statuses: QueueStatus[]): Array<{ status: QueueStatus }> {
  return statuses.map((status) => ({ status }));
}

/** The light-scheme block of tokens.css: everything before the dark-scheme media query. */
const LIGHT_TOKENS = tokensCss.slice(0, tokensCss.indexOf('@media'));
/** The dark-scheme block: from the media query to the end of its braces (the base styles after it are left out). */
const DARK_TOKENS = tokensCss.slice(tokensCss.indexOf('@media'), tokensCss.indexOf('*,'));

function tokenIn(block: string, name: string): string | undefined {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  return match?.[1]?.trim();
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('readColorToken', () => {
  it('reads the first (light-scheme) declaration of a token', () => {
    const css = ':root { --c-error: red; }\n@media (prefers-color-scheme: dark) { :root { --c-error: pink; } }';
    expect(readColorToken(css, '--c-error')).toBe('red');
  });

  it('does not confuse a token with a longer one that starts the same way', () => {
    const css = ':root {\n  --c-text-secondary: gray;\n  --c-text: black;\n}';
    expect(readColorToken(css, '--c-text')).toBe('black');
    expect(readColorToken(css, '--c-text-secondary')).toBe('gray');
  });

  it('ignores mentions that are not declarations', () => {
    const css = '/* Text uses var(--c-bg). */\n:root { --c-bg: white; }';
    expect(readColorToken(css, '--c-bg')).toBe('white');
  });

  it('returns undefined for a token that is not defined', () => {
    expect(readColorToken(':root { --c-bg: white; }', '--c-missing')).toBeUndefined();
  });

  describe('dark scheme', () => {
    const css = [
      ':root { --c-error: red; --c-light-only: tan; }',
      '@media (prefers-color-scheme: dark) { :root { --c-error: pink; } }',
      'body { --c-error: not-a-token; }',
    ].join('\n');

    it('reads the declaration inside the dark-scheme media query', () => {
      expect(readColorToken(css, '--c-error', 'dark')).toBe('pink');
    });

    it('still reads the light value by default and when asked for it', () => {
      expect(readColorToken(css, '--c-error')).toBe('red');
      expect(readColorToken(css, '--c-error', 'light')).toBe('red');
    });

    it('does not fall back to the light value for a token the dark block does not declare', () => {
      expect(readColorToken(css, '--c-light-only', 'dark')).toBeUndefined();
    });

    it('ignores declarations after the closing brace of the dark block', () => {
      const trailing = '@media (prefers-color-scheme: dark) { :root { --c-a: 1; } }\nbody { --c-b: 2; }';
      expect(readColorToken(trailing, '--c-b', 'dark')).toBeUndefined();
    });

    it('returns undefined when there is no dark-scheme block', () => {
      expect(readColorToken(':root { --c-error: red; }', '--c-error', 'dark')).toBeUndefined();
    });
  });
});

describe('BADGE_COLORS', () => {
  it('mirror tokens.css: accent count, the light-scheme error red for "!" (white text reaches 4.5:1), on-primary text', () => {
    expect(BADGE_COLORS.count).toBe(tokenIn(LIGHT_TOKENS, '--c-primary'));
    expect(BADGE_COLORS.attention).toBe(tokenIn(LIGHT_TOKENS, '--c-error'));
    expect(BADGE_COLORS.attention).not.toBe(tokenIn(DARK_TOKENS, '--c-error'));
    expect(BADGE_COLORS.text).toBe(tokenIn(LIGHT_TOKENS, '--c-on-primary'));
  });

  it('use the same accent in both color schemes, so the count badge does not depend on the scheme', () => {
    expect(tokenIn(DARK_TOKENS, '--c-primary')).toBe(BADGE_COLORS.count);
    expect(tokenIn(DARK_TOKENS, '--c-on-primary')).toBe(BADGE_COLORS.text);
  });

  it('are all defined', () => {
    expect(BADGE_COLORS.count).toEqual(expect.any(String));
    expect(BADGE_COLORS.attention).toEqual(expect.any(String));
    expect(BADGE_COLORS.text).toEqual(expect.any(String));
  });
});

describe('badgeStateFor', () => {
  it('shows nothing for an empty queue', () => {
    expect(badgeStateFor([])).toEqual({ text: '' });
  });

  it('counts waiting and uploading items on the accent color', () => {
    expect(badgeStateFor(items('waiting'))).toEqual({ text: '1', color: BADGE_COLORS.count });
    expect(badgeStateFor(items('waiting', 'uploading', 'waiting'))).toEqual({ text: '3', color: BADGE_COLORS.count });
  });

  it('shows "!" on the needs-attention red when any item needs attention', () => {
    expect(badgeStateFor(items('needs_attention'))).toEqual({ text: '!', color: BADGE_COLORS.attention });
    expect(badgeStateFor(items('waiting', 'needs_attention', 'uploading'))).toEqual({
      text: '!',
      color: BADGE_COLORS.attention,
    });
  });
});

describe('updateBadge', () => {
  it('sets the count, the accent background, and the badge text color', async () => {
    await updateBadge(items('waiting', 'waiting'));
    expect(await fakeBrowser.action.getBadgeText({})).toBe('2');
    expect(await fakeBrowser.action.getBadgeBackgroundColor({})).toEqual(rgbaOf(BADGE_COLORS.count));
    expect(await fakeBrowser.action.getBadgeTextColor({})).toBe(BADGE_COLORS.text);
  });

  it('sets "!" on the error-red background', async () => {
    await updateBadge(items('needs_attention'));
    expect(await fakeBrowser.action.getBadgeText({})).toBe('!');
    expect(await fakeBrowser.action.getBadgeBackgroundColor({})).toEqual(rgbaOf(BADGE_COLORS.attention));
  });

  it('clears the badge when the queue empties', async () => {
    await updateBadge(items('waiting'));
    await updateBadge([]);
    expect(await fakeBrowser.action.getBadgeText({})).toBe('');
  });
});
