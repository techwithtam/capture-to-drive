// Shortcut display for Settings: one key label per `.kbd`.
import { describe, expect, it } from 'vitest';
import { shortcutKeys } from '../lib/shortcut-keys';

describe('shortcutKeys', () => {
  it('splits the Windows and Linux form on "+"', () => {
    expect(shortcutKeys('Alt+Shift+S')).toEqual(['Alt', 'Shift', 'S']);
    expect(shortcutKeys('Ctrl+Shift+Comma')).toEqual(['Ctrl', 'Shift', 'Comma']);
  });

  it('splits the macOS form into one symbol per key', () => {
    expect(shortcutKeys('⌥⇧S')).toEqual(['⌥', '⇧', 'S']);
  });

  it('keeps a plus key as a key of its own', () => {
    expect(shortcutKeys('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(shortcutKeys('Ctrl+Shift++')).toEqual(['Ctrl', 'Shift', '+']);
  });

  it('returns nothing when no shortcut is assigned', () => {
    expect(shortcutKeys('')).toEqual([]);
    expect(shortcutKeys('   ')).toEqual([]);
    expect(shortcutKeys(undefined)).toEqual([]);
  });
});
