// Splits the shortcut the browser reports for a command into one label per key, so Settings can show each key as a
// `.kbd` hint. Chrome and Edge report "Alt+Shift+S" on Windows and Linux and "⌥⇧S" on macOS (no separators).

export function shortcutKeys(shortcut: string | undefined): string[] {
  const text = shortcut?.trim() ?? '';
  if (text === '') return [];
  if (text.includes('+')) {
    // A trailing "+" separator pair, as in "Ctrl++", means the plus key itself.
    const keys = text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
    return keys.filter((key) => key !== '');
  }
  return Array.from(text);
}
