import { describe, expect, it } from 'vitest';
import { filenameFromContentDisposition } from '../lib/content-disposition';

describe('filenameFromContentDisposition', () => {
  it.each([
    ['attachment; filename="a b.pdf"', 'a b.pdf'],
    ['attachment; filename=a.pdf', 'a.pdf'],
    ['inline; filename="receipt.pdf"', 'receipt.pdf'],
    ['ATTACHMENT; FILENAME="A.PDF"', 'A.PDF'],
    [' \t attachment \t; \t filename \t= \t "a b.pdf" \t ', 'a b.pdf'],
    ['attachment; filename= a.pdf \t', 'a.pdf'],
    ['attachment; filename=x file.pdf', 'x file.pdf'],
    ['attachment; filename= my file.pdf ; size=123', 'my file.pdf'],
    ['attachment; filename="a;b.pdf"', 'a;b.pdf'],
    [String.raw`attachment; filename="a \"quoted\" file.pdf"`, 'a "quoted" file.pdf'],
    ['attachment; filename="../x.pdf"', 'x.pdf'],
    ['attachment; filename=../x.pdf', 'x.pdf'],
    ['attachment; filename="/home/user/x.pdf"', 'x.pdf'],
    [String.raw`attachment; filename="C:\x.pdf"`, 'x.pdf'],
    [String.raw`attachment; filename="C:\\folder\\x.pdf"`, 'x.pdf'],
    [String.raw`attachment; filename=C:\x.pdf`, 'x.pdf'],
    [String.raw`attachment; filename="../folder\x.pdf"`, 'x.pdf'],
    ['attachment; filename="  x.pdf  "', 'x.pdf'],
    ['attachment; size=123; filename="x.pdf";', 'x.pdf'],
    ['attachment; example="filename=wrong.pdf"; filename=right.pdf', 'right.pdf'],
    ["attachment; filename*=UTF-8''na%C3%AFve%20file.pdf", 'naïve file.pdf'],
    ["inline; FILENAME*=utf-8'en'na%C3%AFve.pdf", 'naïve.pdf'],
    ["attachment; filename*=UTF-8''a+b.pdf", 'a+b.pdf'],
    ["attachment; filename*=UTF-8''..%2Fx.pdf", 'x.pdf'],
    ["attachment; filename*=UTF-8''C%3A%5Cx.pdf", 'x.pdf'],
    ["attachment; filename=plain.pdf; filename*=UTF-8''na%C3%AFve.pdf", 'naïve.pdf'],
    ["attachment; filename*=UTF-8''na%C3%AFve.pdf; filename=plain.pdf", 'naïve.pdf'],
    ["attachment; filename=fallback.pdf; filename*=UTF-8''bad%ZZ.pdf", 'fallback.pdf'],
    ["attachment; filename=fallback.pdf; filename*=unsupported''x.pdf", 'fallback.pdf'],
    ["attachment; filename=my file.pdf; filename*=UTF-8''my%20file.pdf", 'my file.pdf'],
    ["attachment; filename=wrong name.pdf; filename*=UTF-8''right%20name.pdf", 'right name.pdf'],
    ["attachment; filename=; filename*=UTF-8''my%20file.pdf", 'my file.pdf'],
    ["attachment; filename; filename*=UTF-8''my%20file.pdf", 'my file.pdf'],
    ['attachment; filename="broken.pdf"garbage; filename*=UTF-8\'\'my%20file.pdf', 'my file.pdf'],
    ['attachment; filename="unterminated; filename*=UTF-8\'\'my%20file.pdf', 'my file.pdf'],
    ['attachment; filename="broken.pdf"garbage; size=1', undefined],
    ['attachment; ignored; filename=valid.pdf', 'valid.pdf'],
    ['attachment; ignored=; filename=valid.pdf', 'valid.pdf'],
    ['attachment; ignored="unterminated; filename=valid.pdf', 'valid.pdf'],
    ['attachment; ignored="filename*=UTF-8\'\'wrong.pdf"; filename=valid.pdf', 'valid.pdf'],
    ['attachment; size=1; size=2; filename=valid.pdf', 'valid.pdf'],
    ['attachment; filename=.hidden.pdf', '.hidden.pdf'],
    ["attachment; filename=valid.pdf; filename*=UTF-8''..", 'valid.pdf'],
  ])('extracts a basename from %j', (header, expected) => {
    expect(filenameFromContentDisposition(header)).toBe(expected);
  });

  it.each([
    null,
    '',
    ' \t ',
    'attachment',
    'inline;',
    'attachment; size=123',
    'filename=x.pdf',
    '; filename=x.pdf',
    'attachment; filename',
    'attachment; filename=',
    'attachment; filename=""',
    'attachment; filename=" \t "',
    'attachment; filename="../"',
    'attachment; filename="x.pdf',
    'attachment; filename=x.pdf"',
    'attachment; filename="x.pdf"garbage',
    'attachment; filename="x.pdf"\r\nInjected: value',
    'attachment; filename="x\u0000.pdf"',
    'attachment; filename=x.pdf; filename=y.pdf',
    "attachment; filename*=UTF-8''x.pdf; FILENAME*=UTF-8''y.pdf",
    "attachment; filename*=UTF-8''",
    "attachment; filename*=UTF-8''%20%20",
    "attachment; filename*=UTF-8''..%2F",
    "attachment; filename*=UTF-8''bad%",
    "attachment; filename*=UTF-8''bad%ZZ.pdf",
    "attachment; filename*=UTF-8''%C3%28.pdf",
    "attachment; filename*=UTF-8'",
    "attachment; filename*=x.pdf",
    "attachment; filename*=unsupported''x.pdf",
    'attachment; filename*="UTF-8\'\'x.pdf"',
    'attachment; filename=.',
    'attachment; filename=..',
    'attachment; filename=...',
    'attachment; filename="  .....  "',
    'attachment; filename="../.."',
    'attachment; filename="/folder/..."',
    String.raw`attachment; filename="C:\folder\.."`,
    "attachment; filename*=UTF-8''%2E",
    "attachment; filename*=UTF-8''%2E%2E",
    "attachment; filename*=UTF-8''%2E%2E%2E",
    "attachment; filename*=UTF-8''..%2F%2E%2E",
  ])('returns undefined without throwing for %j', (header) => {
    expect(() => filenameFromContentDisposition(header)).not.toThrow();
    expect(filenameFromContentDisposition(header)).toBeUndefined();
  });
});

describe('Content-Disposition header length and parsing time', () => {
  const maxHeaderCharacters = 8_192;

  it.each([8_191, 8_192])('accepts a valid header with at most 8,192 characters (%i)', (length) => {
    const prefix = 'attachment; filename=';
    const filename = `${'x'.repeat(length - prefix.length - 4)}.pdf`;
    const header = `${prefix}${filename}`;
    expect(header).toHaveLength(length);
    expect(filenameFromContentDisposition(header)).toBe(filename);
  });

  it('rejects a valid header that exceeds the cap by one character', () => {
    const prefix = 'attachment; filename=';
    const header = `${prefix}${'x'.repeat(maxHeaderCharacters - prefix.length - 4)}.pdf `;
    expect(header).toHaveLength(maxHeaderCharacters + 1);
    expect(filenameFromContentDisposition(header)).toBeUndefined();
  });

  it.each([
    ['64,000 quotes', '"'.repeat(64_000)],
    ['128,000 alternating characters', 'x"'.repeat(64_000)],
  ])('rejects an oversized header with %s within 200 ms', (label, payload) => {
    const header = `attachment; ${payload}`;
    const started = performance.now();
    const filename = filenameFromContentDisposition(header);
    const elapsedMs = performance.now() - started;
    console.info(`Content-Disposition ${label}: ${elapsedMs.toFixed(3)} ms`);
    expect(filename).toBeUndefined();
    expect(elapsedMs).toBeLessThan(200);
  });

  it('splits 8,000 quotes below the cap with filename recovery 20 times within 200 ms', () => {
    const header = `attachment; ${'"'.repeat(8_000)}; filename=valid.pdf`;
    expect(header.length).toBeLessThan(maxHeaderCharacters);
    const started = performance.now();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(filenameFromContentDisposition(header)).toBe('valid.pdf');
    }
    const elapsedMs = performance.now() - started;
    console.info(`Content-Disposition 8,000 quotes below cap, 20 parses: ${elapsedMs.toFixed(3)} ms`);
    expect(elapsedMs).toBeLessThan(200);
  });
});
