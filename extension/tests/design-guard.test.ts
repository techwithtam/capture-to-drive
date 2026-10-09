// Guards for the design system (spec section 10): colors are defined only in assets/tokens.css, and every
// custom property a stylesheet or script refers to actually exists. New screens build on the shared components, and
// these tests keep a stray hex value or a mistyped token name from slipping in unnoticed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIPPED_DIRS = new Set(['node_modules', '.output', '.wxt', '.git']);
const SOURCE_FILE = /\.(css|ts|html)$/;
const TOKENS_FILE = join('assets', 'tokens.css');

interface SourceFile {
  /** Path relative to the extension folder, with forward slashes. */
  path: string;
  text: string;
}

function collectSources(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...collectSources(full));
    } else if (SOURCE_FILE.test(entry.name)) {
      files.push({ path: relative(ROOT, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  }
  return files;
}

const SOURCES = collectSources(ROOT);
const OUTSIDE_TOKENS = SOURCES.filter((file) => file.path !== TOKENS_FILE.split(sep).join('/'));

// Hex colors (3, 4, 6, or 8 digits; the lookahead keeps ids such as "#add-button" out) and color functions.
const HEX_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

function literalsIn(text: string): string[] {
  return [...(text.match(HEX_COLOR) ?? []), ...(text.match(COLOR_FUNCTION) ?? [])];
}

describe('color literals', () => {
  it('finds the files it is meant to scan', () => {
    const paths = SOURCES.map((file) => file.path);
    expect(paths).toContain('assets/tokens.css');
    expect(paths).toContain('assets/components.css');
    expect(paths).toContain('entrypoints/options/style.css');
    expect(paths).toContain('entrypoints/options/main.ts');
    expect(paths).toContain('lib/badge.ts');
    expect(paths.some((path) => path.startsWith('node_modules/') || path.startsWith('.output/'))).toBe(false);
  });

  // The samples are assembled from parts, so this file does not contain the literals it forbids.
  it('recognises the literals it forbids, and only those', () => {
    const hex = (digits: string) => `#${digits}`;
    const call = (name: string, args: string) => `${name}(${args})`;
    expect(literalsIn(`color: ${hex('fff')};`)).toEqual([hex('fff')]);
    expect(literalsIn(`color: ${hex('FFFFFF80')};`)).toEqual([hex('FFFFFF80')]);
    const functions = ['rgb', 'rgba', 'hsl', 'oklch'].map((name) => call(name, '0 0 0'));
    expect(literalsIn(functions.join(' '))).toHaveLength(4);
    const lookalikes = `${hex('add-button')} { color: var(--c-text) } href="${hex('main')}" id="${hex('face-up')}"`;
    expect(literalsIn(lookalikes)).toEqual([]);
    expect(literalsIn('color-mix(in srgb, var(--c-primary) 35%, transparent)')).toEqual([]);
    expect(literalsIn('rgbaOf(color)')).toEqual([]);
  });

  it('appear only in assets/tokens.css', () => {
    const offenders = OUTSIDE_TOKENS.flatMap((file) =>
      literalsIn(file.text).map((literal) => `${file.path}: ${literal}`),
    );
    expect(offenders).toEqual([]);
  });

  it('are in tokens.css, which defines the palette', () => {
    const tokens = SOURCES.find((file) => file.path === 'assets/tokens.css');
    expect(literalsIn(tokens?.text ?? '').length).toBeGreaterThan(20);
  });
});

describe('custom properties', () => {
  const DECLARATION = /(--[a-z0-9-]+)\s*:/gi;
  const REFERENCE = /var\(\s*(--[a-z0-9-]+)/gi;

  const declared = new Set(
    SOURCES.filter((file) => file.path.endsWith('.css')).flatMap((file) =>
      [...file.text.matchAll(DECLARATION)].map((match) => match[1] ?? ''),
    ),
  );

  it('are all declared somewhere before being used with var()', () => {
    const missing = SOURCES.flatMap((file) =>
      [...file.text.matchAll(REFERENCE)]
        .map((match) => match[1] ?? '')
        // A name ending in "-" is a prefix in prose, such as "var(--c-*)" in a comment, not a reference.
        .filter((name) => !name.endsWith('-') && !declared.has(name))
        .map((name) => `${file.path}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('include the tokens the shared components are built on', () => {
    const names = ['--c-surface-raised', '--c-border-strong', '--c-on-primary', '--c-status-attention', '--sp-4'];
    for (const name of names) expect(declared.has(name)).toBe(true);
  });
});

// Whole page prints the tab with Page.printToPDF, which uses print media. The extension's own in-page UI (the note card,
// its error messages, which stay until closed, and the selection overlay) is fixed-position and would repeat on every
// printed page, so each stylesheet a content script puts in its shadow root hides the host when printing.
describe('in-page UI and printing', () => {
  const PRINT_RULE = /@media\s+print\s*\{\s*:host\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}\s*\}/;
  const RAW_CSS_IMPORT = /from\s+'@\/(assets\/[a-z0-9-]+\.css)\?raw'/g;
  // Shared by every surface; they carry no :host layout of their own.
  const SHARED = new Set(['assets/tokens.css', 'assets/components.css']);

  const contentScripts = SOURCES.filter((file) => /^entrypoints\/[^/]+\.content\.ts$/.test(file.path));
  const inPageSheets = [
    ...new Set(
      contentScripts.flatMap((file) => [...file.text.matchAll(RAW_CSS_IMPORT)].map((match) => match[1] ?? '')),
    ),
  ].filter((path) => !SHARED.has(path));

  it('finds the in-page stylesheets of both content scripts', () => {
    expect(contentScripts.map((file) => file.path).sort()).toEqual([
      'entrypoints/note-card.content.ts',
      'entrypoints/select-area.content.ts',
    ]);
    expect(inPageSheets.sort()).toEqual(['assets/note-view.css', 'assets/select-area.css']);
  });

  it.each(['assets/note-view.css', 'assets/select-area.css'])('%s hides its host when the page is printed', (path) => {
    const sheet = SOURCES.find((file) => file.path === path);
    expect(sheet?.text).toMatch(PRINT_RULE);
    // After the important :host reset, so the later declaration wins.
    const text = sheet?.text ?? '';
    expect(text.search(PRINT_RULE)).toBeGreaterThan(text.indexOf(':host {'));
  });

  it('covers every in-page stylesheet, including any added later', () => {
    const missing = inPageSheets.filter((path) => !PRINT_RULE.test(SOURCES.find((file) => file.path === path)?.text ?? ''));
    expect(missing).toEqual([]);
  });
});
