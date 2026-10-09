// Runs tools/probe-size-limit.mjs as a child process against a local fake mailbox.
// The probe creates real files when pointed at a real mailbox, so the refusal paths matter most.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../tools/probe-size-limit.mjs', import.meta.url));
const KEY = 'test-key';
const MIB = 1024 * 1024;

interface RecordedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  body: string;
}

interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

type Handler = (request: RecordedRequest, response: ServerResponse, count: number) => void;

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
});

async function startFakeMailbox(handler: Handler): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: RecordedRequest = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        contentType: incoming.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      handler(request, response, requests.length);
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/macros/s/TEST/exec`, requests };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Spawns the probe with exactly the given environment (nothing inherited, so real settings never leak in). */
function runProbe(args: string[], env: Record<string, string>): Promise<ProbeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseSave(request: RecordedRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request.body);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Request body is not a JSON object');
  return Object.fromEntries(Object.entries(parsed));
}

describe('probe-size-limit refusals', () => {
  it('refuses without --yes, sends nothing, and never prints the key', async () => {
    const mailbox = await startFakeMailbox((_request, response) => json(response, { ok: true }));
    const run = await runProbe([], { MAILBOX_URL: mailbox.url, MAILBOX_KEY: KEY });

    expect(run.code).toBe(1);
    expect(run.stdout + run.stderr).toContain('--yes');
    expect(run.stdout + run.stderr).not.toContain(KEY);
    expect(mailbox.requests).toEqual([]);
  });

  it('refuses without MAILBOX_URL and MAILBOX_KEY, naming both', async () => {
    const run = await runProbe(['--yes'], {});
    expect(run.code).toBe(1);
    expect(run.stdout + run.stderr).toContain('MAILBOX_URL');
    expect(run.stdout + run.stderr).toContain('MAILBOX_KEY');
  });

  it('refuses with neither --yes nor settings, and says so for each', async () => {
    const run = await runProbe([], {});
    expect(run.code).toBe(1);
    const output = run.stdout + run.stderr;
    expect(output).toContain('--yes');
    expect(output).toContain('MAILBOX_URL');
    expect(output).toContain('MAILBOX_KEY');
  });

  it('refuses a MAILBOX_URL that is not a URL', async () => {
    const run = await runProbe(['--yes'], { MAILBOX_URL: 'not a url', MAILBOX_KEY: KEY });
    expect(run.code).toBe(1);
    expect(run.stdout + run.stderr).toContain('MAILBOX_URL');
  });

  it.each([
    ['--sizes', 'abc'],
    ['--sizes', '5,,10'],
    ['--sizes', '0'],
    ['--sizes', '-5'],
    ['--sizes', '500'],
    ['--runs', '0'],
    ['--runs', 'two'],
    ['--timeout', '0'],
  ])('rejects %s %s without sending anything', async (flag, value) => {
    const mailbox = await startFakeMailbox((_request, response) => json(response, { ok: true }));
    const run = await runProbe(['--yes', flag, value], { MAILBOX_URL: mailbox.url, MAILBOX_KEY: KEY });
    expect(run.code).toBe(2);
    expect(run.stdout + run.stderr).toContain(flag);
    expect(mailbox.requests).toEqual([]);
  });

  it('rejects unknown options', async () => {
    const run = await runProbe(['--yes', '--bogus'], { MAILBOX_URL: 'http://127.0.0.1:1/exec', MAILBOX_KEY: KEY });
    expect(run.code).toBe(2);
  });

  it('prints usage for --help without needing settings', async () => {
    const run = await runProbe(['--help'], {});
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('--sizes');
  });
});

describe('probe-size-limit run', () => {
  const settings = (url: string) => ({ MAILBOX_URL: url, MAILBOX_KEY: KEY });

  it('sends the documented save requests and prints a result table', async () => {
    const mailbox = await startFakeMailbox((_request, response) =>
      json(response, { ok: true, fileId: 'file-1', name: 'x', duplicate: false }),
    );
    const run = await runProbe(['--yes', '--sizes', '0.001,0.002', '--runs', '2'], settings(mailbox.url));

    expect(run.code).toBe(0);
    expect(mailbox.requests).toHaveLength(4);
    const captureIds = new Set<unknown>();
    mailbox.requests.forEach((request, index) => {
      const size = index < 2 ? '0.001' : '0.002';
      const runNumber = (index % 2) + 1;
      const body = parseSave(request);
      expect(request.method).toBe('POST');
      expect(request.contentType).toBe('text/plain;charset=utf-8');
      expect(body).toMatchObject({
        v: 1,
        action: 'save',
        key: KEY,
        filename: `TEST size probe ${size}MB run ${runNumber}.bin`,
        mimeType: 'application/octet-stream',
        description: 'Size probe. Safe to delete.',
      });
      expect(Buffer.from(String(body.data), 'base64')).toHaveLength(Math.round(Number(size) * MIB));
      captureIds.add(body.captureId);
    });
    expect(captureIds.size).toBe(4);

    expect(run.stdout).toMatch(/Size \(MB\)\s+Run\s+HTTP\s+Result\s+Seconds/);
    expect(run.stdout).toMatch(/^\s*0\.001\s+1\s+200\s+ok\s+\d+\.\d\d\s*$/m);
    expect(run.stdout).toMatch(/^\s*0\.002\s+2\s+200\s+ok\s+\d+\.\d\d\s*$/m);
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });

  it('defaults to 5, 10, 20 and 30 MB with 3 runs each', async () => {
    const mailbox = await startFakeMailbox((_request, response) => json(response, { ok: true }));
    // Refusal output lists the plan without sending, so the defaults can be checked cheaply.
    const run = await runProbe([], settings(mailbox.url));
    expect(run.stdout + run.stderr).toMatch(/5, 10, 20, 30 MB/);
    expect(run.stdout + run.stderr).toMatch(/3 runs each/);
    expect(mailbox.requests).toEqual([]);
  });

  it('sends each distinct size once even if it is listed twice', async () => {
    const mailbox = await startFakeMailbox((_request, response) => json(response, { ok: true }));
    const run = await runProbe(['--yes', '--sizes', '0.001,0.001', '--runs', '1'], settings(mailbox.url));
    expect(run.code).toBe(0);
    expect(mailbox.requests).toHaveLength(1);
  });

  it('follows the redirect the real /exec URL answers with', async () => {
    const mailbox = await startFakeMailbox((request, response) => {
      if (request.method === 'POST') {
        response.writeHead(302, { Location: '/macros/echo?user_content_key=TEST' });
        response.end();
      } else {
        json(response, { ok: true, fileId: 'file-1', name: 'x', duplicate: false });
      }
    });
    const run = await runProbe(['--yes', '--sizes', '0.001', '--runs', '1'], settings(mailbox.url));
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\s*0\.001\s+1\s+200\s+ok\s+\d+\.\d\d\s*$/m);
  });

  it('reports mailbox error codes, non-JSON bodies, and HTTP errors per run', async () => {
    const mailbox = await startFakeMailbox((_request, response, count) => {
      if (count === 1) {
        json(response, { ok: false, error: 'too_large', message: 'File is too large.' });
      } else if (count === 2) {
        response.writeHead(500, { 'Content-Type': 'text/html' });
        response.end('<html>Error</html>');
      } else {
        json(response, { ok: true });
      }
    });
    const run = await runProbe(['--yes', '--sizes', '0.001', '--runs', '3'], settings(mailbox.url));

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\s*0\.001\s+1\s+200\s+too_large\s+\d+\.\d\d\s*$/m);
    expect(run.stdout).toMatch(/^\s*0\.001\s+2\s+500\s+non-JSON\s+\d+\.\d\d\s*$/m);
    expect(run.stdout).toMatch(/^\s*0\.001\s+3\s+200\s+ok\s+\d+\.\d\d\s*$/m);
  });

  it('reports a network failure and keeps going', async () => {
    const mailbox = await startFakeMailbox((_request, response) => json(response, { ok: true }));
    const dead = mailbox.url.replace(/:\d+\//, ':1/');
    const run = await runProbe(['--yes', '--sizes', '0.001', '--runs', '1'], settings(dead));
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\s*0\.001\s+1\s+-\s+network-error\s+\d+\.\d\d\s*$/m);
  });

  it('reports a timeout when the mailbox does not answer', async () => {
    const mailbox = await startFakeMailbox(() => undefined); // never responds
    const run = await runProbe(['--yes', '--sizes', '0.001', '--runs', '1', '--timeout', '1'], settings(mailbox.url));
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\s*0\.001\s+1\s+-\s+timeout\s+\d+\.\d\d\s*$/m);
  }, 15_000);

  it('ends with the cleanup reminder and the MAX_FILE_BYTES guidance', async () => {
    const mailbox = await startFakeMailbox((_request, response) => json(response, { ok: true }));
    const run = await runProbe(['--yes', '--sizes', '0.001,0.002', '--runs', '1'], settings(mailbox.url));
    expect(run.stdout).toContain('TEST size probe');
    expect(run.stdout).toMatch(/delete/i);
    expect(run.stdout).toMatch(/MAX_FILE_BYTES/);
  });
});
