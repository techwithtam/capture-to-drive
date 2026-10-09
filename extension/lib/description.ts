// Builds the Drive file description (spec section 7.2): plain "Label: value" lines that a person can read in Drive's
// details panel and that any tool that reads the folder later can parse. Pure module: no browser APIs.

export type CaptureType = 'area' | 'visible' | 'page-pdf' | 'page-image' | 'pdf' | 'link' | 'upload';

export interface DescriptionInput {
  note?: string;
  title?: string;
  url?: string;
  capturedBy: string;
  capturedAt: Date;
  captureType: CaptureType;
  captureId: string;
}

const MAX_URL_LENGTH = 1000;

// A line break plus the whitespace around it. U+0085 (NEL) counts as a break here but is not whitespace to `\s`.
const LINE_BREAK_WITH_PADDING = /[\s\u0085]*[\r\n\v\f\u0085\u2028\u2029][\s\u0085]*/g;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local date and time with the machine's UTC offset, e.g. 2026-10-07T13:42:10-07:00 (no milliseconds). */
export function toLocalIsoString(date: Date): string {
  const offsetMinutes = Math.round(-date.getTimezoneOffset()); // minutes east of UTC
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`;

  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day}T${time}${offset}`;
}

/** Keeps a value on one line so it can never be read as a separate "Label: value" line. */
function toSingleLine(text: string | undefined): string {
  return (text ?? '').replace(LINE_BREAK_WITH_PADDING, ' ').trim();
}

/** Cuts by whole characters (code points), so a character outside the BMP is never split in half. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength ? characters.slice(0, maxLength).join('') : text;
}

export function buildDescription(input: DescriptionInput): string {
  const fields: ReadonlyArray<readonly [label: string, value: string]> = [
    ['Note', toSingleLine(input.note)],
    ['Title', toSingleLine(input.title)],
    ['URL', cut(toSingleLine(input.url), MAX_URL_LENGTH)],
    ['Captured by', toSingleLine(input.capturedBy)],
    ['Captured at', toLocalIsoString(input.capturedAt)],
    ['Capture type', input.captureType],
    ['Capture ID', toSingleLine(input.captureId)],
  ];

  return fields
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}
