// Contrast of the design tokens. Text-bearing colors must reach WCAG AA 4.5:1 on the canvas and the card
// surface, and status and icon colors 3:1, in both color schemes. The ratios use the WCAG relative-luminance formula.
// A translucent token (hover fills) is first laid over the surface it sits on.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BADGE_COLORS, readColorToken } from '../lib/badge';
import type { ColorScheme } from '../lib/badge';

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('../assets/tokens.css', import.meta.url)), 'utf8');

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex !== null) {
    const [r = 0, g = 0, b = 0] = hex.slice(1).map((part) => parseInt(part, 16));
    return { r, g, b, a: 1 };
  }
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba !== null) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) };
  }
  throw new Error(`Not a color token value: ${value}`);
}

function token(name: string, scheme: ColorScheme): Rgba {
  const value = readColorToken(TOKENS_CSS, name, scheme);
  if (value === undefined) throw new Error(`${name} is not declared for the ${scheme} scheme`);
  return parseColor(value);
}

/** `top` laid over the opaque `base`. */
function over(top: Rgba, base: Rgba): Rgba {
  const mix = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const SCHEMES: ColorScheme[] = ['light', 'dark'];
const AA_TEXT = 4.5;
const AA_GRAPHIC = 3;

describe.each(SCHEMES)('%s scheme', (scheme) => {
  const t = (name: string) => token(name, scheme);

  const TEXT_TOKENS = [
    '--c-text',
    '--c-text-secondary',
    '--c-text-muted',
    '--c-text-faint',
    '--c-link',
    '--c-success',
    '--c-error',
    '--c-warning',
  ];

  it.each(TEXT_TOKENS)('%s text reaches 4.5:1 on the canvas and on cards', (name) => {
    expect(contrast(t(name), t('--c-bg'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t(name), t('--c-surface'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('placeholder text (--c-text-faint) also reaches 4.5:1 on an input', () => {
    expect(contrast(t('--c-text-faint'), t('--c-input-bg'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('text and muted icons stay readable on a hovered or selected row (--c-surface-raised)', () => {
    expect(contrast(t('--c-text'), t('--c-surface-raised'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t('--c-text-muted'), t('--c-surface-raised'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('secondary text stays readable on the hover fill, over the canvas and over a card', () => {
    for (const base of ['--c-bg', '--c-surface']) {
      const hovered = over(t('--c-surface-hover'), t(base));
      expect(contrast(t('--c-text-secondary'), hovered)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(t('--c-text'), hovered)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('the resting input border (--c-border-control) reaches 3:1 against the card and the input fill', () => {
    // The border is translucent, so check it laid over either surface, against both surfaces.
    for (const under of ['--c-input-bg', '--c-surface']) {
      const drawn = over(t('--c-border-control'), t(under));
      for (const against of ['--c-input-bg', '--c-surface']) {
        expect(contrast(drawn, t(against)), `over ${under}, against ${against}`).toBeGreaterThanOrEqual(AA_GRAPHIC);
      }
    }
  });

  it('button text (--c-on-primary) reaches 4.5:1 on the primary fill and on its hover fill', () => {
    expect(contrast(t('--c-on-primary'), t('--c-primary'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t('--c-on-primary'), t('--c-primary-hover'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(['--c-primary', '--c-status-waiting', '--c-status-uploading', '--c-status-saved', '--c-status-attention'])(
    '%s reaches 3:1 on the canvas and on cards (focus ring and status circles)',
    (name) => {
      expect(contrast(t(name), t('--c-bg'))).toBeGreaterThanOrEqual(AA_GRAPHIC);
      expect(contrast(t(name), t('--c-surface'))).toBeGreaterThanOrEqual(AA_GRAPHIC);
    },
  );

  it('status circles also reach 3:1 on a selected row', () => {
    for (const name of ['--c-status-waiting', '--c-status-uploading', '--c-status-saved', '--c-status-attention']) {
      expect(contrast(t(name), t('--c-surface-raised'))).toBeGreaterThanOrEqual(AA_GRAPHIC);
    }
  });

  it('the check and "!" drawn on the saved and attention circles reach 3:1', () => {
    expect(contrast(t('--c-on-primary'), t('--c-status-saved'))).toBeGreaterThanOrEqual(AA_GRAPHIC);
    expect(contrast(t('--c-on-primary'), t('--c-status-attention'))).toBeGreaterThanOrEqual(AA_GRAPHIC);
  });
});

describe('toolbar badge', () => {
  // The badge cannot follow the color scheme, so its two fixed backgrounds must carry the white text in both.
  it.each(['count', 'attention'] as const)('white text on the %s badge reaches 4.5:1', (which) => {
    const background = BADGE_COLORS[which];
    const text = BADGE_COLORS.text;
    expect(background).toBeDefined();
    expect(text).toBeDefined();
    expect(contrast(parseColor(text ?? ''), parseColor(background ?? ''))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('both schemes', () => {
  it('declare the tokens on ":root, :host", so they also reach elements inside a shadow root', () => {
    const darkStart = TOKENS_CSS.search(/@media\s*\(\s*prefers-color-scheme/);
    expect(TOKENS_CSS.slice(0, darkStart)).toMatch(/:root,\s*:host\s*\{/);
    expect(TOKENS_CSS.slice(darkStart)).toMatch(/:root,\s*:host\s*\{/);
    // A block that names only :root would leave a shadow root without tokens.
    expect(TOKENS_CSS).not.toMatch(/:root\s*\{/);
  });

  it('declare the same color tokens', () => {
    const lightBlock = TOKENS_CSS.slice(0, TOKENS_CSS.search(/@media\s*\(\s*prefers-color-scheme/));
    const names = [...lightBlock.matchAll(/(--(?:c|shadow)-[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? '');
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      expect(readColorToken(TOKENS_CSS, name, 'dark'), `${name} in the dark scheme`).toBeDefined();
    }
  });
});
