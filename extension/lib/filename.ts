// Builds the Drive filename for a capture (spec section 7.1):
//   {YYYY-MM-DD} {HH.mm} {Name} - {source} - {label}.{ext}
// Pure module: no browser APIs, so it is safe to import from any extension context and from tests.

export interface FilenameInput {
  capturedAt: Date;
  name: string;
  source: string;
  /** Page title, or the original filename already stripped of its extension (see `stripExtension`). */
  label?: string;
  mimeType: string;
  originalFilename?: string;
}

const MAX_LABEL_LENGTH = 80;
/**
 * Labels from URLs (Save this PDF, linked files) have no length limit, and cleaning a long run of dots and spaces takes
 * time that grows with the square of its length (about 5 s for 80,000 characters). The raw label is cut to this many
 * characters first; the 80-character cut still applies after cleaning.
 */
const MAX_RAW_LABEL_LENGTH = 1000;
const FALLBACK_LABEL = 'capture';
const FALLBACK_SOURCE = 'unknown';
const FALLBACK_EXTENSION = 'bin';

const EXTENSION_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['application/pdf', 'pdf'],
]);

// Characters that are unsafe in synced filenames (/ \ : * ? " < > |) plus ASCII and C1 control characters.
const ILLEGAL_CHARACTERS = /[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
const TRAILING_DOTS_AND_SPACES = /[\s.]+$/;
const USABLE_EXTENSION = /^[A-Za-z0-9]+$/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * Replaces illegal characters with a space, collapses whitespace, trims, and strips trailing dots.
 * Exported so Settings can reject a name that would leave nothing in the filename.
 */
export function sanitize(text: string): string {
  return text.replace(ILLEGAL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().replace(TRAILING_DOTS_AND_SPACES, '');
}

/** Cuts by whole characters (code points), so an emoji is never split into a lone surrogate. */
function cut(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // A code point is at most two code units, so this prefix holds at least maxLength characters (or all of them).
  const characters = Array.from(text.slice(0, maxLength * 2));
  return characters.length > maxLength ? characters.slice(0, maxLength).join('') : text.slice(0, maxLength * 2);
}

/** The extension of a filename, or undefined for names like "noextension", ".bashrc", "trailing.", or "my.file name". */
function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = filename.slice(dot + 1);
  return USABLE_EXTENSION.test(extension) ? extension : undefined;
}

function resolveExtension(mimeType: string, originalFilename: string | undefined): string {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    EXTENSION_BY_MIME.get(mime) ??
    (originalFilename === undefined ? undefined : extensionOf(originalFilename)) ??
    FALLBACK_EXTENSION
  );
}

export function buildFilename(input: FilenameInput): string {
  const { capturedAt } = input;
  const date = `${pad(capturedAt.getFullYear(), 4)}-${pad(capturedAt.getMonth() + 1)}-${pad(capturedAt.getDate())}`;
  const time = `${pad(capturedAt.getHours())}.${pad(capturedAt.getMinutes())}`;

  const name = sanitize(input.name);
  const source = sanitize(input.source) || FALLBACK_SOURCE;
  // Cut a huge raw label first (see MAX_RAW_LABEL_LENGTH). Then sanitize, so the 80-character limit counts real
  // characters, and clean up again in case the cut left a dangling space or dot.
  const rawLabel = cut(input.label ?? '', MAX_RAW_LABEL_LENGTH);
  const label = sanitize(cut(sanitize(rawLabel), MAX_LABEL_LENGTH)) || FALLBACK_LABEL;
  const extension = resolveExtension(input.mimeType, input.originalFilename);

  return `${date} ${time} ${name} - ${source} - ${label}.${extension}`;
}

/** Schemes of the browser's own pages and extension pages, whose "hostname" is a settings section or an extension ID. */
const BROWSER_PAGE_PROTOCOLS = new Set(['about:', 'chrome:', 'chrome-extension:', 'devtools:', 'edge:', 'extension:']);
const BROWSER_SOURCE = 'browser';

/**
 * The filename's source for a page URL: a web page's hostname without a leading "www.", "browser" for the browser's own
 * and extension pages, or an empty string for anything else (file:, garbage).
 */
export function sourceFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (BROWSER_PAGE_PROTOCOLS.has(parsed.protocol)) return BROWSER_SOURCE;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const { hostname } = parsed;
  return hostname.startsWith('www.') ? hostname.slice('www.'.length) : hostname;
}

/** Removes the last extension of a filename ("statement.pdf" -> "statement"); names without a usable extension are returned unchanged. */
export function stripExtension(filename: string): string {
  const extension = extensionOf(filename);
  return extension === undefined ? filename : filename.slice(0, -(extension.length + 1));
}
