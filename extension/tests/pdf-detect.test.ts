import { browser } from 'wxt/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPdfBytes, isPdfContentType, isPdfTab, pdfStatusFromUrl } from '../lib/pdf-detect';
import type { PdfProbes } from '../lib/pdf-detect';

const TAB = { id: 42, url: 'https://example.com/download?id=1' };

function makeProbes() {
  return {
    contentTypeViaScript: vi.fn<PdfProbes['contentTypeViaScript']>().mockResolvedValue(undefined),
    contentTypeViaHead: vi.fn<PdfProbes['contentTypeViaHead']>().mockResolvedValue(undefined),
  };
}

function makeClock() {
  return {
    setTimeout: vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
  };
}

// Select the Promise overload so Vitest does not infer executeScript's callback overload as returning void.
function spyOnScript() {
  const scripting: {
    executeScript(injection: { target: { tabId: number }; func: () => string }):
      Promise<{ frameId: number; result?: unknown }[]>;
  } = browser.scripting;
  return vi.spyOn(scripting, 'executeScript');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pdfStatusFromUrl', () => {
  it.each([
    'https://example.com/x.pdf',
    'http://example.com/x.pdf',
    'https://example.com/x.PDF',
    'https://example.com/x.pdf?download=1',
    'https://example.com/x.pdf#page=2',
    'https://example.com/x%2Epdf',
    'https://example.com/x%2ep%64f?download=1#page=2',
    'https://example.com/folder%2Fx.pdf',
  ])('recognizes %s by its decoded path', (url) => {
    expect(pdfStatusFromUrl(url)).toBe('pdf');
  });

  it.each([
    'https://example.com/x.pdf/',
    'https://example.com/download',
    'https://example.com/',
    'https://example.com/?file=x.pdf',
    'https://example.com/#x.pdf',
    'https://example.com/x%252Epdf',
    'https://example.com/bad%ZZ',
    'https://example.com/%C3%28.pdf',
  ])('requires probes for %s', (url) => {
    expect(pdfStatusFromUrl(url)).toBe('unknown');
  });

  it.each(['file:///home/alex/a.pdf', 'file:///home/alex/a.txt', 'FILE:///home/alex/a.pdf'])(
    'marks %s as a local file',
    (url) => {
      expect(pdfStatusFromUrl(url)).toBe('local-file');
    },
  );

  it.each([
    undefined,
    '',
    'garbage',
    '/x.pdf',
    'https://',
    'chrome://settings/x.pdf',
    'edge://settings/x.pdf',
    'about:blank',
    'data:application/pdf,%25PDF',
    'chrome-extension://test/viewer.pdf',
    'blob:https://example.com/test.pdf',
    'ftp://example.com/x.pdf',
  ])('rejects %j without throwing', (url) => {
    expect(pdfStatusFromUrl(url)).toBe('not-pdf');
  });
});

describe('isPdfTab: URL and probe order', () => {
  it.each([
    ['https://example.com/x.pdf', 'pdf'],
    ['file:///home/alex/a.pdf', 'local-file'],
    ['chrome://settings', 'not-pdf'],
    [undefined, 'not-pdf'],
  ] as const)('resolves %j without probing', async (url, expected) => {
    const probes = makeProbes();
    expect(await isPdfTab({ id: 42, url }, probes)).toBe(expected);
    expect(probes.contentTypeViaScript).not.toHaveBeenCalled();
    expect(probes.contentTypeViaHead).not.toHaveBeenCalled();
  });

  it.each(['application/pdf', 'Application/PDF', 'application/pdf; charset=binary', ' APPLICATION/PDF ; charset=binary '])(
    'accepts the script media type %j without HEAD',
    async (contentType) => {
      const probes = makeProbes();
      probes.contentTypeViaScript.mockResolvedValue(contentType);
      expect(await isPdfTab(TAB, probes)).toBe('pdf');
      expect(probes.contentTypeViaScript).toHaveBeenCalledWith(TAB.id);
      expect(probes.contentTypeViaHead).not.toHaveBeenCalled();
    },
  );

  it.each(['text/html', 'application/pdf-extra', 'application/x-pdf', ''])(
    'stops when the script reports the non-PDF media type %j',
    async (contentType) => {
      const probes = makeProbes();
      probes.contentTypeViaScript.mockResolvedValue(contentType);
      probes.contentTypeViaHead.mockResolvedValue('application/pdf');
      expect(await isPdfTab(TAB, probes)).toBe('not-pdf');
      expect(probes.contentTypeViaHead).not.toHaveBeenCalled();
    },
  );

  it('falls back to HEAD when injection throws', async () => {
    const probes = makeProbes();
    probes.contentTypeViaScript.mockRejectedValue(new Error('Injection blocked'));
    probes.contentTypeViaHead.mockResolvedValue('application/pdf; charset=binary');
    expect(await isPdfTab(TAB, probes)).toBe('pdf');
    expect(probes.contentTypeViaHead).toHaveBeenCalledWith(TAB.url);
    expect(probes.contentTypeViaScript.mock.invocationCallOrder[0]).toBeLessThan(
      probes.contentTypeViaHead.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('falls back to HEAD when the script returns undefined', async () => {
    const probes = makeProbes();
    probes.contentTypeViaHead.mockResolvedValue('Application/PDF');
    expect(await isPdfTab(TAB, probes)).toBe('pdf');
    expect(probes.contentTypeViaScript).toHaveBeenCalledTimes(1);
    expect(probes.contentTypeViaHead).toHaveBeenCalledTimes(1);
  });

  it('uses HEAD directly when no tab id is available', async () => {
    const probes = makeProbes();
    probes.contentTypeViaHead.mockResolvedValue('application/pdf');
    expect(await isPdfTab({ url: TAB.url }, probes)).toBe('pdf');
    expect(probes.contentTypeViaScript).not.toHaveBeenCalled();
  });

  it('does not treat tab id zero as missing', async () => {
    const probes = makeProbes();
    probes.contentTypeViaScript.mockResolvedValue('application/pdf');
    expect(await isPdfTab({ ...TAB, id: 0 }, probes)).toBe('pdf');
    expect(probes.contentTypeViaScript).toHaveBeenCalledWith(0);
  });

  it('resolves not-pdf when both probes throw', async () => {
    const probes = makeProbes();
    probes.contentTypeViaScript.mockRejectedValue(new Error('Injection blocked'));
    probes.contentTypeViaHead.mockRejectedValue(new Error('Network failure'));
    await expect(isPdfTab(TAB, probes)).resolves.toBe('not-pdf');
  });

  it.each([undefined, 'text/html', 'application/pdf-extra', ''])('rejects HEAD media type %j', async (contentType) => {
    const probes = makeProbes();
    probes.contentTypeViaHead.mockResolvedValue(contentType);
    expect(await isPdfTab(TAB, probes)).toBe('not-pdf');
  });

  it('handles synchronous probe errors', async () => {
    const probes = makeProbes();
    probes.contentTypeViaScript.mockImplementation(() => {
      throw new Error('Script unavailable');
    });
    probes.contentTypeViaHead.mockImplementation(() => {
      throw new Error('HEAD unavailable');
    });
    await expect(isPdfTab(TAB, probes)).resolves.toBe('not-pdf');
  });
});

describe('isPdfTab: default probes', () => {
  it('calls global timers with a browser-compatible receiver', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const setTimer = vi.fn(function (this: unknown, callback: () => void, delayMs: number) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return originalSetTimeout(callback, delayMs);
    });
    const clearTimer = vi.fn(function (this: unknown, timer: ReturnType<typeof setTimeout>) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      originalClearTimeout(timer);
    });
    vi.stubGlobal('setTimeout', setTimer);
    vi.stubGlobal('clearTimeout', clearTimer);
    spyOnScript().mockResolvedValue([{ frameId: 0, result: 'application/pdf' }]);

    await expect(isPdfTab(TAB)).resolves.toBe('pdf');
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it('injects document.contentType into the requested tab', async () => {
    const script = spyOnScript().mockResolvedValue([
      { frameId: 0, result: 'application/pdf' },
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubGlobal('document', { contentType: 'application/pdf' });

    expect(await isPdfTab(TAB)).toBe('pdf');
    expect(script).toHaveBeenCalledWith({ target: { tabId: TAB.id }, func: expect.any(Function) });
    const injection = script.mock.calls[0]?.[0];
    expect(injection?.func?.()).toBe('application/pdf');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['throws', 'missing result', 'non-string result'] as const)(
    'sends a credentialed HEAD when injection has %s',
    async (failure) => {
      const script = spyOnScript();
      if (failure === 'throws') script.mockRejectedValue(new Error('Injection blocked'));
      else script.mockResolvedValue(failure === 'missing result' ? [] : [{ frameId: 0, result: 123 }]);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { headers: { 'Content-Type': 'application/pdf; charset=binary' } }),
      );
      vi.stubGlobal('fetch', fetchImpl);

      expect(await isPdfTab(TAB)).toBe('pdf');
      expect(fetchImpl).toHaveBeenCalledWith(TAB.url, {
        method: 'HEAD', credentials: 'include', signal: expect.any(AbortSignal),
      });
    },
  );

  it('handles a missing HEAD header', async () => {
    spyOnScript().mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
    expect(await isPdfTab(TAB)).toBe('not-pdf');
  });
});

describe('isPdfTab: one deadline for both probes', () => {
  it('uses the injected clock and fast timeout for a stalled script', async () => {
    vi.useFakeTimers();
    const clock = makeClock();
    const probes = makeProbes();
    probes.contentTypeViaScript.mockImplementation(() => new Promise(() => undefined));
    const result = isPdfTab(TAB, { ...probes, clock, timeoutMs: 5 });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(4);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('not-pdf');
    expect(clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5);
    expect(clock.clearTimeout).toHaveBeenCalledTimes(1);
    expect(probes.contentTypeViaHead).not.toHaveBeenCalled();
  });

  it.each([undefined, 2_000])('caps the budget at 1,000 ms with timeoutMs %j', async (timeoutMs) => {
    vi.useFakeTimers();
    const probes = makeProbes();
    probes.contentTypeViaScript.mockImplementation(() => new Promise(() => undefined));
    const result = isPdfTab(TAB, { ...probes, timeoutMs });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('not-pdf');
  });

  it('keeps the original deadline when the script falls back to a stalled HEAD', async () => {
    vi.useFakeTimers();
    const probes = makeProbes();
    probes.contentTypeViaScript.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(undefined), 3)),
    );
    probes.contentTypeViaHead.mockImplementation(() => new Promise(() => undefined));
    const result = isPdfTab(TAB, { ...probes, clock: makeClock(), timeoutMs: 5 });

    await vi.advanceTimersByTimeAsync(3);
    expect(probes.contentTypeViaHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(result).resolves.toBe('not-pdf');
  });

  it('does not launch HEAD after a timed-out script eventually finishes', async () => {
    vi.useFakeTimers();
    const probes = makeProbes();
    let finishScript: (contentType: string | undefined) => void = () => undefined;
    probes.contentTypeViaScript.mockImplementation(
      () => new Promise((resolve) => { finishScript = resolve; }),
    );
    const result = isPdfTab(TAB, { ...probes, clock: makeClock(), timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBe('not-pdf');

    finishScript(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(probes.contentTypeViaHead).not.toHaveBeenCalled();
  });

  it('clears the deadline when detection finishes early', async () => {
    vi.useFakeTimers();
    const clock = makeClock();
    const probes = makeProbes();
    probes.contentTypeViaScript.mockResolvedValue('application/pdf');
    expect(await isPdfTab(TAB, { ...probes, clock, timeoutMs: 5 })).toBe('pdf');
    expect(clock.clearTimeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts default HEAD at the shared deadline after a delayed script', async () => {
    vi.useFakeTimers();
    spyOnScript().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 600)),
    );
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const result = isPdfTab(TAB);

    await vi.advanceTimersByTimeAsync(600);
    const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(399);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('not-pdf');
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late HEAD result even if the fetch implementation ignores abort', async () => {
    vi.useFakeTimers();
    spyOnScript().mockResolvedValue([]);
    let finishHead: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { finishHead = resolve; }));
    vi.stubGlobal('fetch', fetchImpl);
    const result = isPdfTab(TAB);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('not-pdf');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finishHead(new Response(null, { headers: { 'Content-Type': 'application/pdf' } }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('not-pdf');
  });
});

describe('isPdfContentType', () => {
  it.each(['application/pdf', 'Application/PDF', 'application/pdf; charset=binary', ' APPLICATION/PDF ; charset=binary '])(
    'accepts %j',
    (contentType) => {
      expect(isPdfContentType(contentType)).toBe(true);
    },
  );

  it.each([null, undefined, '', 'text/html', 'application/pdf-extra', 'application/x-pdf'])(
    'rejects %j',
    (contentType) => {
      expect(isPdfContentType(contentType)).toBe(false);
    },
  );
});

describe('isPdfBytes', () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it.each(['%PDF', '%PDF-1.7\nbody', '\uFEFF%PDF-1.7', 'garbage\r\n%PDF-2.0'])(
    'recognizes the header in %j',
    (text) => {
      expect(isPdfBytes(encode(text))).toBe(true);
    },
  );

  it('accepts exactly 1,024 leading bytes', () => {
    expect(isPdfBytes(encode(`${'x'.repeat(1_024)}%PDF`))).toBe(true);
  });

  it('rejects a header after more than 1,024 leading bytes', () => {
    expect(isPdfBytes(encode(`${'x'.repeat(1_025)}%PDF`))).toBe(false);
  });

  it.each(['', '%', '%PD', '%pdf-1.7', 'PDF-1.7', '%PXD', '<html>Login</html>'])(
    'rejects bytes without a complete header in %j',
    (text) => {
      expect(isPdfBytes(encode(text))).toBe(false);
    },
  );

  it('counts bytes rather than decoded characters in the leading data', () => {
    expect(isPdfBytes(encode(`${'é'.repeat(512)}%PDF`))).toBe(true);
    expect(isPdfBytes(encode(`${'é'.repeat(513)}%PDF`))).toBe(false);
  });
});
