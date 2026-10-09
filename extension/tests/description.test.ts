// Drive description builder (spec section 7.2).
//
// Time zones: `toLocalIsoString` reads the machine's zone, so these tests never assume one. Dates are built from
// local fields (`new Date(2026, 9, 7, 13, 42, 10)`), and exact offsets are asserted in two ways:
//   1. against a value derived from `getTimezoneOffset()` plus a parse round trip, which hold on any machine;
//   2. inside `withTimeZone(...)` blocks that pin `process.env.TZ` (Node re-reads it on assignment), so a fixed
//      string such as "2026-10-07T13:42:10-07:00" and a half-hour zone can be checked exactly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDescription, toLocalIsoString } from '../lib/description';
import type { CaptureType, DescriptionInput } from '../lib/description';

function withTimeZone(timeZone: string): void {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.TZ;
    process.env.TZ = timeZone;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
}

/** Expected "+HH:MM" for a date, computed from `getTimezoneOffset()` by a different route than the implementation. */
function expectedOffset(date: Date): string {
  const minutesEastOfUtc = -date.getTimezoneOffset();
  const sign = minutesEastOfUtc < 0 ? '-' : '+';
  const absolute = Math.abs(minutesEastOfUtc);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const CAPTURE_ID = '6f1c2b0e-5d1a-4a8e-9a43-1d1f2b9c7e11';

function input(overrides: Partial<DescriptionInput> = {}): DescriptionInput {
  return {
    note: 'Costco, for taxes',
    title: 'Orders | Costco',
    url: 'https://www.costco.com/OrderStatusCmd',
    capturedBy: 'Alex',
    capturedAt: new Date(2026, 9, 7, 13, 42, 10),
    captureType: 'area',
    captureId: CAPTURE_ID,
    ...overrides,
  };
}

function lines(description: string): string[] {
  return description.split('\n');
}

describe('toLocalIsoString', () => {
  it('formats local fields followed by the local offset, on any machine', () => {
    const date = new Date(2026, 9, 7, 13, 42, 10);
    expect(toLocalIsoString(date)).toBe(`2026-10-07T13:42:10${expectedOffset(date)}`);
  });

  it('round-trips to the same instant, in whatever zone the machine uses', () => {
    const dates = [
      new Date(2026, 0, 5, 0, 0, 0), // midnight, winter
      new Date(2026, 6, 15, 23, 59, 59), // end of day, summer
      new Date(2026, 9, 7, 13, 42, 10),
      new Date(2026, 11, 31, 12, 0, 0),
    ];
    for (const date of dates) {
      const text = toLocalIsoString(date);
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      expect(new Date(text).getTime()).toBe(date.getTime());
    }
  });

  it('zero-pads single-digit months, days, hours, minutes, and seconds', () => {
    const date = new Date(2026, 2, 4, 3, 5, 6);
    expect(toLocalIsoString(date)).toBe(`2026-03-04T03:05:06${expectedOffset(date)}`);
  });

  it('drops milliseconds', () => {
    const date = new Date(2026, 9, 7, 13, 42, 10, 987);
    expect(toLocalIsoString(date)).toBe(`2026-10-07T13:42:10${expectedOffset(date)}`);
  });

  describe('in America/Los_Angeles', () => {
    withTimeZone('America/Los_Angeles');

    it('uses -07:00 during daylight saving time (the spec example)', () => {
      expect(toLocalIsoString(new Date(2026, 9, 7, 13, 42, 10))).toBe('2026-10-07T13:42:10-07:00');
    });

    it('uses -08:00 during standard time', () => {
      expect(toLocalIsoString(new Date(2026, 0, 5, 9, 0, 0))).toBe('2026-01-05T09:00:00-08:00');
    });
  });

  describe('in Asia/Kolkata', () => {
    withTimeZone('Asia/Kolkata');

    it('keeps the half-hour part of a +05:30 offset', () => {
      expect(toLocalIsoString(new Date(2026, 9, 7, 13, 42, 10))).toBe('2026-10-07T13:42:10+05:30');
    });
  });

  describe('in Pacific/Auckland', () => {
    withTimeZone('Pacific/Auckland');

    it('uses a two-digit positive offset east of UTC', () => {
      expect(toLocalIsoString(new Date(2026, 9, 7, 13, 42, 10))).toBe('2026-10-07T13:42:10+13:00');
    });
  });

  describe('in UTC', () => {
    withTimeZone('UTC');

    it('writes +00:00 rather than Z', () => {
      expect(toLocalIsoString(new Date(2026, 9, 7, 13, 42, 10))).toBe('2026-10-07T13:42:10+00:00');
    });
  });
});

describe('buildDescription', () => {
  describe('full block', () => {
    withTimeZone('America/Los_Angeles');

    it('matches the spec example exactly', () => {
      expect(buildDescription(input())).toBe(
        [
          'Note: Costco, for taxes',
          'Title: Orders | Costco',
          'URL: https://www.costco.com/OrderStatusCmd',
          'Captured by: Alex',
          'Captured at: 2026-10-07T13:42:10-07:00',
          'Capture type: area',
          `Capture ID: ${CAPTURE_ID}`,
        ].join('\n'),
      );
    });
  });

  it('writes the lines in order, as "Label: value", with no trailing newline', () => {
    const description = buildDescription(input());
    expect(lines(description).map((line) => line.split(': ')[0])).toEqual([
      'Note',
      'Title',
      'URL',
      'Captured by',
      'Captured at',
      'Capture type',
      'Capture ID',
    ]);
    expect(description.endsWith('\n')).toBe(false);
  });

  it('uses the local ISO string for "Captured at"', () => {
    const capturedAt = new Date(2026, 9, 7, 13, 42, 10);
    expect(lines(buildDescription(input({ capturedAt })))).toContain(`Captured at: ${toLocalIsoString(capturedAt)}`);
  });

  it.each([undefined, '', '   ', '\n\t\n'])('omits the Note line when the note is %j', (note) => {
    const result = lines(buildDescription(input({ note })));
    expect(result).toHaveLength(6);
    expect(result.some((line) => line.startsWith('Note'))).toBe(false);
    expect(result[0]).toBe('Title: Orders | Costco');
  });

  it('omits Title and URL when they are empty', () => {
    const result = lines(buildDescription(input({ title: '', url: '  ' })));
    expect(result.map((line) => line.split(': ')[0])).toEqual([
      'Note',
      'Captured by',
      'Captured at',
      'Capture type',
      'Capture ID',
    ]);
  });

  it('describes an upload with no title and no URL', () => {
    const description = buildDescription({
      capturedBy: 'Alex',
      capturedAt: new Date(2026, 9, 7, 13, 50, 0),
      captureType: 'upload',
      captureId: CAPTURE_ID,
    });
    const result = lines(description);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe('Captured by: Alex');
    expect(result[1]).toMatch(/^Captured at: 2026-10-07T13:50:00[+-]\d{2}:\d{2}$/);
    expect(result[2]).toBe('Capture type: upload');
    expect(result[3]).toBe(`Capture ID: ${CAPTURE_ID}`);
  });

  it('keeps a note on an upload that has no title or URL', () => {
    const result = lines(
      buildDescription({
        note: 'Sept statement',
        capturedBy: 'Alex',
        capturedAt: new Date(2026, 9, 7, 13, 50, 0),
        captureType: 'upload',
        captureId: CAPTURE_ID,
      }),
    );
    expect(result[0]).toBe('Note: Sept statement');
    expect(result).toHaveLength(5);
  });

  describe('URL length', () => {
    it('cuts a 2,000-character URL at 1,000 characters', () => {
      const url = `https://example.com/${'a'.repeat(1980)}`;
      expect(url).toHaveLength(2000);
      const urlLine = lines(buildDescription(input({ url }))).find((line) => line.startsWith('URL: '));
      expect(urlLine).toBe(`URL: ${url.slice(0, 1000)}`);
      expect(urlLine).toHaveLength('URL: '.length + 1000);
    });

    it('keeps a URL of exactly 1,000 characters whole', () => {
      const url = `https://example.com/${'b'.repeat(980)}`;
      expect(url).toHaveLength(1000);
      expect(lines(buildDescription(input({ url }))).find((line) => line.startsWith('URL: '))).toBe(`URL: ${url}`);
    });

    it('keeps the lines after the URL intact when it is cut', () => {
      const result = lines(buildDescription(input({ url: `https://example.com/${'c'.repeat(3000)}` })));
      expect(result).toHaveLength(7);
      expect(result[3]).toBe('Captured by: Alex');
      expect(result[5]).toBe('Capture type: area');
    });
  });

  describe('single-line values', () => {
    it('collapses newlines in the note to single spaces', () => {
      const result = lines(buildDescription(input({ note: 'line one\nline two\r\n\r\nline three' })));
      expect(result[0]).toBe('Note: line one line two line three');
      expect(result).toHaveLength(7);
    });

    it('collapses other line-break characters and the spaces around them', () => {
      const result = lines(buildDescription(input({ note: 'a \n b\u2028c\u2029d\u0085e\vf\fg' })));
      expect(result[0]).toBe('Note: a b c d e f g');
    });

    it('trims the note and leaves spacing inside a line alone', () => {
      const result = lines(buildDescription(input({ note: '  Costco,  for taxes \n' })));
      expect(result[0]).toBe('Note: Costco,  for taxes');
    });

    it('keeps a title on one line too', () => {
      const result = lines(buildDescription(input({ title: 'Orders\n| Costco\r\n' })));
      expect(result[1]).toBe('Title: Orders | Costco');
      expect(result).toHaveLength(7);
    });

    it('keeps the name on one line too', () => {
      const result = lines(buildDescription(input({ capturedBy: 'Alex\nSmith' })));
      expect(result).toContain('Captured by: Alex Smith');
      expect(result).toHaveLength(7);
    });

    it('does not let a note forge another line', () => {
      const result = lines(buildDescription(input({ note: 'hello\nCapture type: link' })));
      expect(result[0]).toBe('Note: hello Capture type: link');
      expect(result.filter((line) => line.startsWith('Capture type: '))).toEqual(['Capture type: area']);
    });
  });

  it.each<CaptureType>(['area', 'visible', 'page-pdf', 'page-image', 'pdf', 'link', 'upload'])(
    'writes the capture type %s as given',
    (captureType) => {
      expect(lines(buildDescription(input({ captureType })))).toContain(`Capture type: ${captureType}`);
    },
  );
});
