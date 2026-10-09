// Checks on the fakes themselves, so the other mailbox tests can trust them.
import { describe, expect, it } from 'vitest';
import { loadMailbox } from './harness';

const FAKE_SOURCE = `
  function doPost() {
    return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON);
  }
`;

describe('Code.gs vm harness', () => {
  it('runs top-level Apps Script functions against the fakes', () => {
    const mailbox = loadMailbox({ source: FAKE_SOURCE });
    expect(mailbox.send({})).toEqual({ mimeType: 'JSON', body: { ok: true } });
  });

  it('fails with a clear message when Code.gs lacks a required function', () => {
    const mailbox = loadMailbox({ source: FAKE_SOURCE });
    expect(() => mailbox.setup()).toThrow('Code.gs does not define setup()');
  });

  it('does not leak Node globals into the Apps Script context', () => {
    const source = `
      function doPost() {
        return ContentService.createTextOutput(JSON.stringify({
          seen: [typeof require, typeof module, typeof process, typeof Buffer, typeof Logger],
        }));
      }`;
    expect(loadMailbox({ source }).send({}).body).toEqual({
      seen: ['undefined', 'undefined', 'undefined', 'undefined', 'object'],
    });
  });

  it('decodes base64 to signed bytes like Utilities.base64Decode', () => {
    const source = `
      function doPost() {
        const bytes = Utilities.base64Decode('/+4=');
        return ContentService.createTextOutput(JSON.stringify({ bytes: Array.from(bytes) }));
      }`;
    expect(loadMailbox({ source }).send({}).body).toEqual({ bytes: [-1, -18] });
  });

  it('rejects cache expirations above the 21600 second maximum', () => {
    const source = `
      function doPost() {
        CacheService.getScriptCache().put('k', 'v', 21601);
        return ContentService.createTextOutput('{}');
      }`;
    expect(() => loadMailbox({ source }).send({})).toThrow('expirationInSeconds');
  });
});
