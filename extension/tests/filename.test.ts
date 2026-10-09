// Filename builder (spec section 7.1). Dates are built from local fields, so none of these tests depend on the machine's time zone.
import { describe, expect, it } from 'vitest';
import { buildFilename, sanitize, sourceFromUrl, stripExtension } from '../lib/filename';
import type { FilenameInput } from '../lib/filename';

const CAPTURED_AT = new Date(2026, 9, 7, 13, 42); // 2026-10-07 13:42 local

function build(overrides: Partial<FilenameInput> = {}): string {
  return buildFilename({
    capturedAt: CAPTURED_AT,
    name: 'Alex',
    source: 'amazon.com',
    label: 'Your Orders',
    mimeType: 'application/pdf',
    ...overrides,
  });
}

describe('buildFilename: spec examples', () => {
  it('builds a PDF capture of a page', () => {
    expect(build()).toBe('2026-10-07 13.42 Alex - amazon.com - Your Orders.pdf');
  });

  it('builds a PNG capture of an area', () => {
    const filename = build({
      capturedAt: new Date(2026, 9, 7, 13, 45),
      source: 'costco.com',
      label: 'Receipt',
      mimeType: 'image/png',
    });
    expect(filename).toBe('2026-10-07 13.45 Alex - costco.com - Receipt.png');
  });

  it('builds an upload, using the original filename without its extension as the label', () => {
    const filename = build({
      capturedAt: new Date(2026, 9, 7, 13, 50),
      source: 'upload',
      label: stripExtension('statement-sept.pdf'),
      mimeType: 'application/pdf',
      originalFilename: 'statement-sept.pdf',
    });
    expect(filename).toBe('2026-10-07 13.50 Alex - upload - statement-sept.pdf');
  });
});

describe('buildFilename: date and time', () => {
  it('uses a dot between hours and minutes, never a colon', () => {
    expect(build()).toContain(' 13.42 ');
    expect(build()).not.toContain(':');
  });

  it('keeps midnight as 00.00', () => {
    expect(build({ capturedAt: new Date(2026, 0, 5, 0, 0) })).toMatch(/^2026-01-05 00\.00 /);
  });

  it('keeps the last minute of the day as 23.59', () => {
    expect(build({ capturedAt: new Date(2026, 11, 31, 23, 59) })).toMatch(/^2026-12-31 23\.59 /);
  });

  it('zero-pads single-digit months, days, hours, and minutes', () => {
    expect(build({ capturedAt: new Date(2026, 2, 4, 3, 5) })).toMatch(/^2026-03-04 03\.05 /);
  });

  it('ignores seconds', () => {
    expect(build({ capturedAt: new Date(2026, 9, 7, 13, 42, 59) })).toMatch(/^2026-10-07 13\.42 /);
  });
});

describe('buildFilename: label', () => {
  it('replaces each illegal character with a space and collapses the result', () => {
    const filename = build({ label: 'a/b\\c:d*e?f"g<h>i|j' });
    expect(filename).toBe('2026-10-07 13.42 Alex - amazon.com - a b c d e f g h i j.pdf');
  });

  it('replaces control characters with a space', () => {
    const filename = build({ label: 'tab\there\nnewline\u0000nul\u007fdel\u001fus' });
    expect(filename).toBe('2026-10-07 13.42 Alex - amazon.com - tab here newline nul del us.pdf');
  });

  it('collapses runs of whitespace and trims both ends', () => {
    expect(build({ label: '   hello \t  world   ' })).toBe('2026-10-07 13.42 Alex - amazon.com - hello world.pdf');
  });

  it('strips trailing dots, including dots mixed with spaces', () => {
    expect(build({ label: 'Quarterly report...' })).toBe('2026-10-07 13.42 Alex - amazon.com - Quarterly report.pdf');
    expect(build({ label: 'Title. . .' })).toBe('2026-10-07 13.42 Alex - amazon.com - Title.pdf');
  });

  it('keeps dots inside the label', () => {
    expect(build({ label: 'v2.0 notes' })).toBe('2026-10-07 13.42 Alex - amazon.com - v2.0 notes.pdf');
  });

  it('cuts a 200-character title at 80 characters', () => {
    const filename = build({ label: 'x'.repeat(200) });
    expect(filename).toBe(`2026-10-07 13.42 Alex - amazon.com - ${'x'.repeat(80)}.pdf`);
  });

  it('keeps a label of exactly 80 characters whole', () => {
    expect(build({ label: 'y'.repeat(80) })).toBe(`2026-10-07 13.42 Alex - amazon.com - ${'y'.repeat(80)}.pdf`);
  });

  it('removes a space or dot left dangling by the cut', () => {
    expect(build({ label: `${'a'.repeat(79)} bbbb` })).toBe(`2026-10-07 13.42 Alex - amazon.com - ${'a'.repeat(79)}.pdf`);
    expect(build({ label: `${'a'.repeat(79)}.bbbb` })).toBe(`2026-10-07 13.42 Alex - amazon.com - ${'a'.repeat(79)}.pdf`);
  });

  it('cuts by whole characters so an emoji is never split in half', () => {
    const filename = build({ label: '\u{1F600}'.repeat(100) });
    expect(filename).toBe(`2026-10-07 13.42 Alex - amazon.com - ${'\u{1F600}'.repeat(80)}.pdf`);
    expect(filename.isWellFormed()).toBe(true);
  });

  it('counts the 80-character limit after sanitizing', () => {
    // 100 slashes become one collapsed space, then trimmed away, so the real label is only the trailing text.
    expect(build({ label: `${'/'.repeat(100)}Receipt` })).toBe('2026-10-07 13.42 Alex - amazon.com - Receipt.pdf');
  });

  // Labels from URLs (Save this PDF, linked files) have no length limit, and cleaning a long run of dots and spaces
  // took about 5 s for 80,000 characters. The raw label is cut to 1,000 characters first.
  it.each([
    ['80,000 dots then a letter', `${'.'.repeat(80_000)}x`],
    ['40,000 space-dot pairs then a letter', `${' .'.repeat(40_000)}x`],
    ['80,000 letters', 'x'.repeat(80_000)],
  ])('cleans a label of %s in well under a second', (_name, label) => {
    const started = performance.now();
    const filename = build({ label });
    expect(performance.now() - started).toBeLessThan(250);
    expect(filename).toMatch(/^2026-10-07 13\.42 Alex - amazon\.com - (capture|x{80})\.pdf$/);
  });

  it('still keeps the first 80 characters of a very long label', () => {
    const label = `Invoice ${'1234567890'.repeat(10_000)}`;
    expect(build({ label })).toBe(`2026-10-07 13.42 Alex - amazon.com - ${label.slice(0, 80)}.pdf`);
  });

  it('cuts by whole characters before cleaning too, so an emoji past 1,000 code units is never split', () => {
    const filename = build({ label: `${' '.repeat(999)}\u{1F600}${'z'.repeat(2000)}` });
    expect(filename).toBe('2026-10-07 13.42 Alex - amazon.com - \u{1F600}.pdf');
    expect(filename.isWellFormed()).toBe(true);
  });

  it.each([undefined, '', '   ', '\t\n', '///', '...', ' . . '])('falls back to "capture" for label %j', (label) => {
    expect(build({ label })).toBe('2026-10-07 13.42 Alex - amazon.com - capture.pdf');
  });

  it('does not cut the name or the source', () => {
    const longName = 'N'.repeat(100);
    const longSource = `${'s'.repeat(100)}.example.com`;
    expect(build({ name: longName, source: longSource })).toBe(
      `2026-10-07 13.42 ${longName} - ${longSource} - Your Orders.pdf`,
    );
  });
});

describe('buildFilename: name and source', () => {
  it('sanitizes the name the same way as the label', () => {
    expect(build({ name: 'Alex/Smith: Jr.' })).toBe('2026-10-07 13.42 Alex Smith Jr - amazon.com - Your Orders.pdf');
  });

  it('sanitizes the source the same way as the label', () => {
    expect(build({ source: 'upload*' })).toBe('2026-10-07 13.42 Alex - upload - Your Orders.pdf');
  });

  it('falls back to "unknown" when the source is empty, so the separators never collapse', () => {
    expect(build({ source: '' })).toBe('2026-10-07 13.42 Alex - unknown - Your Orders.pdf');
    expect(build({ source: '  ' })).toBe('2026-10-07 13.42 Alex - unknown - Your Orders.pdf');
  });
});

describe('buildFilename: extension', () => {
  it('maps the MIME types the extension produces', () => {
    expect(build({ mimeType: 'image/png' })).toMatch(/\.png$/);
    expect(build({ mimeType: 'image/jpeg' })).toMatch(/\.jpg$/);
    expect(build({ mimeType: 'image/webp' })).toMatch(/\.webp$/);
    expect(build({ mimeType: 'image/gif' })).toMatch(/\.gif$/);
    expect(build({ mimeType: 'application/pdf' })).toMatch(/\.pdf$/);
  });

  it('ignores MIME case and parameters', () => {
    expect(build({ mimeType: 'Application/PDF' })).toMatch(/\.pdf$/);
    expect(build({ mimeType: 'image/png; charset=binary' })).toMatch(/\.png$/);
  });

  it('prefers the MIME type over the original filename', () => {
    expect(build({ mimeType: 'image/png', originalFilename: 'photo.heic' })).toMatch(/\.png$/);
  });

  it('uses the original filename extension when the MIME type is unknown', () => {
    expect(build({ mimeType: 'application/x-unknown', originalFilename: 'report.xlsx' })).toMatch(/\.xlsx$/);
  });

  it('uses the original filename extension when the MIME type is empty', () => {
    expect(build({ mimeType: '', originalFilename: 'notes.docx' })).toMatch(/\.docx$/);
  });

  it('uses the last extension of a multi-part filename', () => {
    expect(build({ mimeType: 'application/octet-stream', originalFilename: 'backup.tar.gz' })).toMatch(/\.gz$/);
  });

  it('falls back to "bin" when the MIME type is unknown and there is no original filename', () => {
    expect(build({ mimeType: 'application/x-unknown' })).toMatch(/\.bin$/);
  });

  it.each(['noextension', 'trailing.', '.bashrc', 'my.file name', ''])(
    'falls back to "bin" when the original filename %j has no usable extension',
    (originalFilename) => {
      expect(build({ mimeType: 'application/octet-stream', originalFilename })).toMatch(/\.bin$/);
    },
  );
});

describe('sourceFromUrl', () => {
  it('returns the hostname without a leading www.', () => {
    expect(sourceFromUrl('https://www.amazon.com/gp/css/order-history')).toBe('amazon.com');
    expect(sourceFromUrl('https://www.costco.com/OrderStatusCmd')).toBe('costco.com');
  });

  it('keeps hostnames that have no www. prefix', () => {
    expect(sourceFromUrl('https://amazon.com/orders')).toBe('amazon.com');
  });

  it('keeps subdomains other than a leading www.', () => {
    expect(sourceFromUrl('https://smile.amazon.com/x')).toBe('smile.amazon.com');
    expect(sourceFromUrl('https://mail.google.com/mail/u/0/')).toBe('mail.google.com');
  });

  it('strips only the leading www., not one further along or a lookalike', () => {
    expect(sourceFromUrl('https://www.www.example.com/')).toBe('www.example.com');
    expect(sourceFromUrl('https://shop.www.example.com/')).toBe('shop.www.example.com');
    expect(sourceFromUrl('https://www2.example.com/')).toBe('www2.example.com');
    expect(sourceFromUrl('https://wwwexample.com/')).toBe('wwwexample.com');
  });

  it('drops the port, credentials, path, query, and fragment', () => {
    expect(sourceFromUrl('http://localhost:3000/a?b=c#d')).toBe('localhost');
    expect(sourceFromUrl('https://user:pass@www.example.com:8443/path')).toBe('example.com');
  });

  it('lowercases the hostname', () => {
    expect(sourceFromUrl('HTTPS://WWW.Example.COM/Path')).toBe('example.com');
  });

  it.each(['', 'not a url', 'file:///home/alex/statement.pdf', 'ftp://files.example.com/statement.pdf'])(
    'returns an empty string when %j is not a web or browser page',
    (url) => {
      expect(sourceFromUrl(url)).toBe('');
    },
  );

  // These hostnames identify an extension or browser settings section.
  it.each([
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
    'extension://abcdefghijklmnopabcdefghijklmnop/options.html',
    'edge://settings/privacy',
    'chrome://extensions/',
    'about:blank',
    'devtools://devtools/bundled/inspector.html',
  ])('labels the browser page %j as "browser"', (url) => {
    expect(sourceFromUrl(url)).toBe('browser');
  });
});

describe('stripExtension', () => {
  it('removes the last extension', () => {
    expect(stripExtension('statement-sept.pdf')).toBe('statement-sept');
    expect(stripExtension('archive.tar.gz')).toBe('archive.tar');
  });

  it('leaves a name without an extension alone', () => {
    expect(stripExtension('noextension')).toBe('noextension');
    expect(stripExtension('')).toBe('');
  });

  it('does not treat a leading dot, a trailing dot, or a dotted phrase as an extension', () => {
    expect(stripExtension('.bashrc')).toBe('.bashrc');
    expect(stripExtension('trailing.')).toBe('trailing.');
    expect(stripExtension('my.file name')).toBe('my.file name');
  });

  it('agrees with the extension buildFilename reads from the same original filename', () => {
    const originalFilename = 'Quarterly Report.final.xlsx';
    const filename = build({
      label: stripExtension(originalFilename),
      mimeType: 'application/octet-stream',
      originalFilename,
    });
    expect(filename).toBe('2026-10-07 13.42 Alex - amazon.com - Quarterly Report.final.xlsx');
  });
});

describe('sanitize', () => {
  it('replaces illegal characters with a space and collapses whitespace', () => {
    expect(sanitize('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(sanitize('  Alex \t\n Smith  ')).toBe('Alex Smith');
  });

  it('strips trailing dots and spaces', () => {
    expect(sanitize('Alex...')).toBe('Alex');
    expect(sanitize('Alex . .')).toBe('Alex');
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(sanitize('///')).toBe('');
    expect(sanitize('...')).toBe('');
    expect(sanitize('  ')).toBe('');
    expect(sanitize('')).toBe('');
  });
});
