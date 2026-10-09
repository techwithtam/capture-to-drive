// Mailbox client (spec sections 6.5 and 7.3). Every outcome of a POST to the Apps Script mailbox is classified as
// success, retryable, or needs_attention. All tests use a mocked `fetchImpl`; nothing touches the network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES, pingMailbox, saveToMailbox } from '../lib/mailbox-client';
import type { MailboxSettings, SavePayload } from '../lib/mailbox-client';

const SETTINGS: MailboxSettings = { mailboxUrl: 'https://script.google.com/macros/s/TEST/exec', key: 'test-key' };

function payload(overrides: Partial<SavePayload> = {}): SavePayload {
  return {
    captureId: 'capture-1',
    filename: '2026-10-07 13.42 Alex - amazon.com - Your Orders.pdf',
    mimeType: 'application/pdf',
    description: 'Note: Gift receipt\nTitle: Your Orders',
    blob: new Blob(['hello']),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function htmlResponse(status = 200): Response {
  return new Response('<!DOCTYPE html><html><body>Sorry, unable to open the file at present.</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** A mocked fetch that resolves with whatever `makeResponse` returns (a fresh Response per call, since bodies are single-use). */
function fetchReturning(makeResponse: () => Response) {
  return vi.fn<typeof fetch>(async () => makeResponse());
}

/** A mocked fetch that never answers; it rejects with an AbortError when the request's signal aborts, like real fetch. */
function fetchHanging() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
  );
}

/** The `init` argument of the first call, with the JSON body parsed. */
function firstRequest(fetchImpl: ReturnType<typeof fetchReturning>): { url: unknown; init: RequestInit; body: Record<string, unknown> } {
  const call = fetchImpl.mock.calls[0];
  if (!call) throw new Error('fetch was not called');
  const [url, init = {}] = call;
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MAX_FILE_BYTES', () => {
  it('is 20 MB of decoded file bytes, matching the mailbox default', () => {
    expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('saveToMailbox: request shape', () => {
  it('POSTs to the mailbox URL as text/plain with redirects followed', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1', name: 'n.pdf', duplicate: false }));
    await saveToMailbox(payload(), SETTINGS, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init } = firstRequest(fetchImpl);
    expect(url).toBe(SETTINGS.mailboxUrl);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain;charset=utf-8' });
    expect(init.redirect).toBe('follow');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(typeof init.body).toBe('string');
  });

  it('sends the section 7.3 JSON body: v 1, action save, key, capture fields, and base64 data', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1' }));
    await saveToMailbox(payload(), SETTINGS, { fetchImpl });

    expect(firstRequest(fetchImpl).body).toStrictEqual({
      v: 1,
      action: 'save',
      key: 'test-key',
      captureId: 'capture-1',
      filename: '2026-10-07 13.42 Alex - amazon.com - Your Orders.pdf',
      mimeType: 'application/pdf',
      description: 'Note: Gift receipt\nTitle: Your Orders',
      data: 'aGVsbG8=',
    });
  });

  it('keeps non-ASCII text in the filename and description intact through JSON', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1' }));
    await saveToMailbox(
      payload({ filename: 'Café – menü 日本語.png', description: 'Note: señor “quoted” \u{1F600}' }),
      SETTINGS,
      { fetchImpl },
    );

    const { body } = firstRequest(fetchImpl);
    expect(body.filename).toBe('Café – menü 日本語.png');
    expect(body.description).toBe('Note: señor “quoted” \u{1F600}');
  });
});

describe('saveToMailbox: base64 encoding', () => {
  /** Bytes that cover the whole 0-255 range, so anything above 127 is exercised. */
  function patternBytes(length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 7 + (i >> 8)) % 256;
    return bytes;
  }

  // 24 * 1024 is the encoder's chunk size. Sizes straddle it and its multiples, plus lengths with every remainder mod 3.
  it.each([0, 1, 2, 3, 4, 24575, 24576, 24577, 49152, 49153, 49154, 100_001])(
    'round-trips %i bytes exactly',
    async (length) => {
      const bytes = patternBytes(length);
      const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1' }));
      await saveToMailbox(payload({ blob: new Blob([bytes]) }), SETTINGS, { fetchImpl });

      const { data } = firstRequest(fetchImpl).body;
      expect(data).toBe(base64Of(bytes));
      expect(new Uint8Array(Buffer.from(String(data), 'base64'))).toEqual(bytes);
    },
  );

  it('contains bytes above 127 in the large payload', () => {
    // Guards the test data itself: if the pattern ever stopped covering high bytes, the round trip would prove less.
    const bytes = patternBytes(100_001);
    expect(bytes.some((byte) => byte > 127)).toBe(true);
    expect(bytes.some((byte) => byte === 255)).toBe(true);
  });

  it('encodes a multi-megabyte file without overflowing the call stack', async () => {
    const bytes = patternBytes(3 * 1024 * 1024 + 1);
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1' }));
    const result = await saveToMailbox(payload({ blob: new Blob([bytes]) }), SETTINGS, { fetchImpl });

    expect(result.kind).toBe('success');
    expect(firstRequest(fetchImpl).body.data).toBe(base64Of(bytes));
  });
});

describe('saveToMailbox: success', () => {
  it('returns fileId, name, and duplicate false for a normal save', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1', name: '2026-10-07 ...pdf', duplicate: false }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'success',
      fileId: 'F1',
      name: '2026-10-07 ...pdf',
      duplicate: false,
    });
  });

  it('counts a duplicate as success; the mailbox omits name for a duplicate', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1', duplicate: true }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'success',
      fileId: 'F1',
      duplicate: true,
    });
  });

  it('treats a bare { ok: true } as success with no extra fields', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({ kind: 'success' });
  });
});

describe('saveToMailbox: mailbox error codes', () => {
  it.each(['unauthorized', 'bad_request', 'too_large', 'not_found'] as const)(
    'maps %s to needs_attention and keeps the mailbox message',
    async (error) => {
      const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error, message: `mailbox says ${error}` }));
      expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
        kind: 'needs_attention',
        error,
        message: `mailbox says ${error}`,
      });
    },
  );

  it('maps not_found to needs_attention, not retryable (a wrong URL never fixes itself)', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'not_found' }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({ kind: 'needs_attention', error: 'not_found' });
  });

  it('maps server_error to retryable', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'server_error', message: 'Drive is down' }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'retryable',
      error: 'server_error',
      message: 'Drive is down',
    });
  });

  it('omits message when the mailbox sends none', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'unauthorized' }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({ kind: 'needs_attention', error: 'unauthorized' });
  });

  it('treats an error code it does not know as retryable, keeping the code', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'quota_exceeded', message: 'Try later' }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'retryable',
      error: 'quota_exceeded',
      message: 'Try later',
    });
  });

  it('treats ok:false with no error code as retryable', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false }));
    const result = await saveToMailbox(payload(), SETTINGS, { fetchImpl });
    expect(result.kind).toBe('retryable');
  });

  it('classifies by the body first: a JSON error wins over an HTTP 5xx status', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'unauthorized', message: 'no' }, 500));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'needs_attention',
      error: 'unauthorized',
      message: 'no',
    });
  });

  it.each([
    [{ ok: true, fileId: 'F1' }, { kind: 'success', fileId: 'F1' }],
    [{ ok: false, error: 'unauthorized', message: 'no' }, { kind: 'needs_attention', error: 'unauthorized', message: 'no' }],
    [{ ok: false, error: 'server_error', message: 'Try later' }, { kind: 'retryable', error: 'server_error', message: 'Try later' }],
  ] as const)('keeps the JSON mailbox answer %j even with HTTP 404', async (body, expected) => {
    const fetchImpl = fetchReturning(() => jsonResponse(body, 404));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual(expected);
  });

  it('treats HTTP 404 with an HTML body as needs_attention not_found', async () => {
    const fetchImpl = fetchReturning(() => htmlResponse(404));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({ kind: 'needs_attention', error: 'not_found' });
  });
});

describe('saveToMailbox: transient failures', () => {
  it('treats an HTML body with HTTP 200 as retryable non_json (for example a Google sign-in or error page)', async () => {
    const fetchImpl = fetchReturning(() => htmlResponse(200));
    const result = await saveToMailbox(payload(), SETTINGS, { fetchImpl });
    expect(result).toMatchObject({ kind: 'retryable', error: 'non_json' });
  });

  it.each([400, 500, 502, 503])('treats HTTP %i with an HTML body as retryable', async (status) => {
    const fetchImpl = fetchReturning(() => htmlResponse(status));
    const result = await saveToMailbox(payload(), SETTINGS, { fetchImpl });
    expect(result).toMatchObject({ kind: 'retryable', error: 'non_json' });
    expect(result).toHaveProperty('message', expect.stringContaining(String(status)));
  });

  it('treats an empty body as retryable', async () => {
    const fetchImpl = fetchReturning(() => new Response('', { status: 200 }));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toMatchObject({ kind: 'retryable', error: 'non_json' });
  });

  it.each([['null', 'null'], ['an array', '[]'], ['a string', '"ok"'], ['an object without ok', '{}']])(
    'treats JSON that is %s as retryable',
    async (_label, text) => {
      const fetchImpl = fetchReturning(() => new Response(text, { status: 200 }));
      expect((await saveToMailbox(payload(), SETTINGS, { fetchImpl })).kind).toBe('retryable');
    },
  );

  it('treats a thrown fetch as retryable network, keeping the error text', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'retryable',
      error: 'network',
      message: 'Failed to fetch',
    });
  });

  it('treats a thrown non-Error value as retryable network', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject('offline'));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toMatchObject({ kind: 'retryable', error: 'network' });
  });

  it('treats a request that is aborted as retryable timeout', async () => {
    const fetchImpl = fetchHanging();
    const result = await saveToMailbox(payload(), SETTINGS, { fetchImpl, timeoutMs: 20 });
    expect(result).toMatchObject({ kind: 'retryable', error: 'timeout' });
  });

  it('treats an AbortError thrown by fetch itself as retryable timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
    expect(await saveToMailbox(payload(), SETTINGS, { fetchImpl })).toMatchObject({ kind: 'retryable', error: 'timeout' });
  });

  it('treats an abort that fires while the body is being read as retryable timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const result = await saveToMailbox(payload(), SETTINGS, { fetchImpl, timeoutMs: 20 });
    expect(result).toMatchObject({ kind: 'retryable', error: 'timeout' });
  });

  it('uses a 60 second timeout by default', async () => {
    // Only setTimeout and clearTimeout are faked, so setImmediate still lets the real blob read finish.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = fetchHanging();
    let settled = false;
    const pending = saveToMailbox(payload(), SETTINGS, { fetchImpl }).then((result) => {
      settled = true;
      return result;
    });
    while (fetchImpl.mock.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'retryable', error: 'timeout' });
  });

  it('clears its timeout timer after a response, so nothing is left running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true, fileId: 'F1' }));
    await saveToMailbox(payload(), SETTINGS, { fetchImpl });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('saveToMailbox: unreadable file', () => {
  it('returns needs_attention bad_request without calling the mailbox when the blob cannot be read', async () => {
    const unreadable = {
      size: 5,
      type: '',
      arrayBuffer: () => Promise.reject(new DOMException('The requested file could not be read.', 'NotReadableError')),
    } as unknown as Blob;
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true }));
    const result = await saveToMailbox(payload({ blob: unreadable }), SETTINGS, { fetchImpl });

    expect(result).toMatchObject({ kind: 'needs_attention', error: 'bad_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('saveToMailbox: size is the caller job', () => {
  it('does not reject a file over MAX_FILE_BYTES itself; the mailbox decides', async () => {
    // A Blob that claims to be huge but holds little: sending it must not be blocked client-side.
    const big = new Blob(['x']);
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'too_large', message: 'File is larger than the limit.' }));
    const result = await saveToMailbox(payload({ blob: big }), SETTINGS, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'needs_attention', error: 'too_large' });
  });
});

describe('pingMailbox', () => {
  it('POSTs only v, action, and key', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true }));
    await pingMailbox(SETTINGS, { fetchImpl });

    const { url, init, body } = firstRequest(fetchImpl);
    expect(url).toBe(SETTINGS.mailboxUrl);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain;charset=utf-8' });
    expect(init.redirect).toBe('follow');
    expect(body).toStrictEqual({ v: 1, action: 'ping', key: 'test-key' });
  });

  it('returns success for { ok: true }', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: true }));
    expect(await pingMailbox(SETTINGS, { fetchImpl })).toStrictEqual({ kind: 'success' });
  });

  it('returns needs_attention unauthorized for a rejected key', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'unauthorized', message: 'Mailbox key was rejected.' }));
    expect(await pingMailbox(SETTINGS, { fetchImpl })).toStrictEqual({
      kind: 'needs_attention',
      error: 'unauthorized',
      message: 'Mailbox key was rejected.',
    });
  });

  it('returns needs_attention bad_request for an unsupported protocol version', async () => {
    const fetchImpl = fetchReturning(() => jsonResponse({ ok: false, error: 'bad_request', message: 'Unsupported protocol version.' }));
    expect(await pingMailbox(SETTINGS, { fetchImpl })).toMatchObject({ kind: 'needs_attention', error: 'bad_request' });
  });

  it('returns retryable non_json for an HTML page', async () => {
    const fetchImpl = fetchReturning(() => htmlResponse(200));
    expect(await pingMailbox(SETTINGS, { fetchImpl })).toMatchObject({ kind: 'retryable', error: 'non_json' });
  });

  it('returns needs_attention not_found for HTTP 404 with an HTML body', async () => {
    const fetchImpl = fetchReturning(() => htmlResponse(404));
    expect(await pingMailbox(SETTINGS, { fetchImpl })).toStrictEqual({ kind: 'needs_attention', error: 'not_found' });
  });

  it('returns retryable network for a thrown fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await pingMailbox(SETTINGS, { fetchImpl })).toMatchObject({ kind: 'retryable', error: 'network' });
  });

  it('returns retryable timeout when the request is aborted', async () => {
    const fetchImpl = fetchHanging();
    expect(await pingMailbox(SETTINGS, { fetchImpl, timeoutMs: 20 })).toMatchObject({ kind: 'retryable', error: 'timeout' });
  });
});
