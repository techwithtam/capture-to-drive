// Toolbar badge for the upload queue (spec section 6.5): nothing when the queue is empty, the item count on the accent
// color while items wait or upload, and "!" on the needs-attention red when any item needs attention.
//
// The badge API needs concrete colors, and tokens.css must stay the only place colors are defined, so the token file
// is bundled as text (Vite `?raw`, resolved at build time) and the values are read from it here. The badge sits on the
// browser toolbar, outside any page theme, and a service worker has no `matchMedia`, so it cannot follow the color
// scheme anyway. Both backgrounds are therefore fixed colors that keep white text (`--c-on-primary`) at 4.5:1 or more:
// the accent (`--c-primary`, the same in both schemes) and the light-scheme error red (`--c-error`). The brighter
// dark-scheme red would give the "!" only 3.5:1, and the red badge stays visible on light and dark toolbars alike.

import { browser } from 'wxt/browser';
import tokensCss from '../assets/tokens.css?raw';
import type { QueueStatus } from './queue';

export interface BadgeState {
  text: string;
  color?: string;
}

export type ColorScheme = 'light' | 'dark';

const DARK_SCHEME_QUERY = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/;

/** The dark-scheme media block of a stylesheet (the query and its braces), or an empty string when there is none. */
function darkSchemeBlock(css: string): string {
  const query = DARK_SCHEME_QUERY.exec(css);
  if (query === null) return '';
  const open = css.indexOf('{', query.index);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(query.index, i + 1);
    }
  }
  return css.slice(query.index);
}

/**
 * The value of the first declaration of a custom property in `css`, or undefined if it is not declared. Only real
 * declarations count (`--c-bg: ...`), not mentions such as `var(--c-bg)`, and `--c-text` never matches
 * `--c-text-secondary`. The light scheme is the default and the first declaration; `'dark'` reads the declaration
 * inside the `prefers-color-scheme: dark` block instead.
 */
export function readColorToken(css: string, name: string, scheme: ColorScheme = 'light'): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = scheme === 'dark' ? darkSchemeBlock(css) : css;
  const match = new RegExp(`(?:^|[\\s;{])${escaped}\\s*:\\s*([^;}]+)`).exec(source);
  const value = match?.[1]?.trim();
  return value === '' ? undefined : value;
}

export const BADGE_COLORS = {
  count: readColorToken(tokensCss, '--c-primary'),
  attention: readColorToken(tokensCss, '--c-error'),
  text: readColorToken(tokensCss, '--c-on-primary'),
} as const;

export function badgeStateFor(items: ReadonlyArray<{ status: QueueStatus }>): BadgeState {
  if (items.length === 0) return { text: '' };
  if (items.some((item) => item.status === 'needs_attention')) return { text: '!', color: BADGE_COLORS.attention };
  return { text: String(items.length), color: BADGE_COLORS.count };
}

/** Shows the badge for these queue items. Only the background service worker calls this. */
export async function updateBadge(items: ReadonlyArray<{ status: QueueStatus }>): Promise<void> {
  const state = badgeStateFor(items);
  await browser.action.setBadgeText({ text: state.text });
  if (state.text === '') return;
  // A color missing from tokens.css (tests guard against it) falls back to the browser's default badge color.
  if (state.color !== undefined) await browser.action.setBadgeBackgroundColor({ color: state.color });
  if (BADGE_COLORS.text !== undefined) await browser.action.setBadgeTextColor({ color: BADGE_COLORS.text });
}
