const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const MAX_HEADER_CHARACTERS = 8_192;

/** Keeps complete quoted values together, recovering at semicolons when a value is malformed. */
function splitParameters(header: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let firstEquals = -1;
  let onlySpacesAfterEquals = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === ';') {
      parts.push(header.slice(start, index).trim());
      start = index + 1;
      firstEquals = -1;
      onlySpacesAfterEquals = false;
      continue;
    }
    if (firstEquals === -1) {
      if (character === '=') {
        firstEquals = index;
        onlySpacesAfterEquals = true;
      }
      continue;
    }
    // A quoted value can begin only at the first non-space character after the first equals sign.
    if (onlySpacesAfterEquals && character === '"' && firstEquals > start) {
      const quoted = /^"(?:[^"\\]|\\.)*"[ \t]*(?=;|$)/.exec(header.slice(index));
      if (quoted) index += quoted[0].length - 1;
    }
    if (character !== ' ' && character !== '\t') onlySpacesAfterEquals = false;
  }
  parts.push(header.slice(start).trim());
  return parts;
}

function parameterValue(raw: string): string | undefined {
  if (!raw.startsWith('"')) return /^[^";]+$/.test(raw) ? raw : undefined;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  // Preserve single backslashes in Windows paths; unescape quoted quotes and doubled backslashes.
  return quoted?.[1]?.replace(/\\(["\\])/g, '$1');
}

function decodeExtendedFilename(raw: string): string | undefined {
  const extended = /^UTF-8'[A-Za-z0-9-]*'((?:[!#$&+.^_`|~0-9A-Za-z-]|%[0-9A-Fa-f]{2})*)$/i.exec(raw);
  const encoded = extended?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function basename(filename: string | undefined): string | undefined {
  if (filename === undefined || CONTROL_CHARACTERS.test(filename)) return undefined;
  const name = filename.split(/[/\\]/).at(-1)?.trim();
  return name && !/^\.+$/.test(name) ? name : undefined;
}

/** Returns a filename for PDF and linked-file captures, without directory components. */
export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (header === null || header.length > MAX_HEADER_CHARACTERS || CONTROL_CHARACTERS.test(header)) return undefined;
  const parts = splitParameters(header);
  const disposition = parts.shift();
  if (disposition === undefined || !TOKEN.test(disposition)) return undefined;

  const parameters = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    const raw = part.slice(equals + 1).trim();
    if (name !== 'filename' && name !== 'filename*') continue;
    if (parameters.has(name)) return undefined;
    // Parse filename* independently so a malformed ordinary filename cannot hide it.
    const value = name === 'filename*' ? raw : parameterValue(raw);
    if (value !== undefined) parameters.set(name, value);
  }

  const extended = parameters.get('filename*');
  return basename(extended === undefined ? undefined : decodeExtendedFilename(extended)) ??
    basename(parameters.get('filename'));
}
