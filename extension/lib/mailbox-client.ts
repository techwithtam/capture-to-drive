// Mailbox client (spec sections 6.5 and 7.3): POSTs a capture to the Apps Script mailbox and classifies every outcome
// as success, retryable, or needs_attention. It never throws; the upload queue acts on the returned `kind`.
// JSON mailbox answers take precedence. A non-JSON HTTP 404 means `not_found`: Google returns it for a wrong or
// deleted deployment, so retrying cannot fix the URL. Other non-JSON replies remain retryable.
// Pure fetch and Blob code with no extension APIs, so it runs in any context and in tests with a mocked `fetchImpl`.

/** Largest file, in decoded bytes, that the mailbox accepts by default. Callers check this before enqueueing. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface MailboxSettings {
  mailboxUrl: string;
  key: string;
}

export interface SavePayload {
  captureId: string;
  filename: string;
  mimeType: string;
  description: string;
  blob: Blob;
}

export type MailboxResult =
  | { kind: 'success'; fileId?: string; name?: string; duplicate?: boolean }
  | { kind: 'retryable'; error: string; message?: string }
  | { kind: 'needs_attention'; error: 'unauthorized' | 'bad_request' | 'too_large' | 'not_found'; message?: string };

interface MailboxOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type NeedsAttentionError = Extract<MailboxResult, { kind: 'needs_attention' }>['error'];

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Bytes read per base64 chunk. A multiple of 3, so every chunk but the last encodes to whole 4-character groups with
 * no `=` padding and the pieces can simply be concatenated. Also keeps each `String.fromCharCode` call small.
 */
const BASE64_CHUNK_BYTES = 24 * 1024;

// Errors that no retry can fix. Anything else (server_error, or a code this version does not know) is treated as
// transient. The client uses `not_found` for a wrong or deleted deployment; the mailbox's doPost never sends it.
const NEEDS_ATTENTION_ERRORS: ReadonlySet<string> = new Set<NeedsAttentionError>([
  'unauthorized',
  'bad_request',
  'too_large',
  'not_found',
]);

function isNeedsAttentionError(error: string): error is NeedsAttentionError {
  return NEEDS_ATTENTION_ERRORS.has(error);
}

/** Base64 of a Blob in fixed-size chunks, so a 20 MB file never goes through one huge `String.fromCharCode` call. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    parts.push(btoa(String.fromCharCode(...chunk)));
  }
  return parts.join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text === '' ? undefined : text;
}

/** An object with `message` only when there is one, so results compare cleanly and carry no undefined fields. */
function withMessage<T extends object>(result: T, message: string | undefined): T & { message?: string } {
  return message === undefined ? result : { ...result, message };
}

/** Turns a parsed JSON body into a result, or null when the body is not a recognizable mailbox response. */
function classifyBody(body: unknown): MailboxResult | null {
  if (!isRecord(body)) return null;
  const message = typeof body.message === 'string' ? body.message : undefined;

  if (body.ok === true) {
    const result: Extract<MailboxResult, { kind: 'success' }> = { kind: 'success' };
    if (typeof body.fileId === 'string') result.fileId = body.fileId;
    if (typeof body.name === 'string') result.name = body.name;
    if (typeof body.duplicate === 'boolean') result.duplicate = body.duplicate;
    return result;
  }

  if (body.ok === false) {
    const error = typeof body.error === 'string' && body.error !== '' ? body.error : 'unknown_error';
    if (isNeedsAttentionError(error)) {
      return withMessage({ kind: 'needs_attention' as const, error }, message);
    }
    return withMessage({ kind: 'retryable' as const, error }, message);
  }

  return null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Sends one request body and classifies whatever comes back. The JSON mailbox answer wins over the HTTP status.
 * If the body is not JSON, HTTP 404 means `not_found` (needs attention): Google returns it when the deployment URL
 * is wrong or deleted. Other non-JSON bodies and unrecognized JSON answers are transient (spec 7.3).
 */
async function postToMailbox(
  requestBody: Record<string, unknown>,
  settings: MailboxSettings,
  options: MailboxOptions,
): Promise<MailboxResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    // `text/plain` keeps this a "simple" request (no CORS preflight). The /exec URL answers with a 302 to
    // script.googleusercontent.com; `redirect: 'follow'` lands on the JSON body there.
    const response = await fetchImpl(settings.mailboxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(requestBody),
      redirect: 'follow',
      signal: controller.signal,
    });
    // The timer stays armed through the body read: a response that stalls mid-stream must time out too.
    const text = await response.text();

    const parsed = parseJson(text);
    if (!parsed.ok) {
      if (response.status === 404) return { kind: 'needs_attention', error: 'not_found' };
      return { kind: 'retryable', error: 'non_json', message: `Mailbox did not answer with JSON (HTTP ${response.status}).` };
    }
    return (
      classifyBody(parsed.value) ?? {
        kind: 'retryable',
        error: 'unexpected_response',
        message: `Mailbox answered with something unexpected (HTTP ${response.status}).`,
      }
    );
  } catch (error) {
    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      return { kind: 'retryable', error: 'timeout', message: 'The mailbox did not answer in time.' };
    }
    return withMessage({ kind: 'retryable' as const, error: 'network' }, errorText(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function saveToMailbox(
  payload: SavePayload,
  settings: MailboxSettings,
  options: MailboxOptions = {},
): Promise<MailboxResult> {
  let data: string;
  try {
    data = await blobToBase64(payload.blob);
  } catch {
    // The stored bytes cannot be read at all. Retrying cannot help, so hand it to the user (who can discard it).
    return { kind: 'needs_attention', error: 'bad_request', message: 'The file could not be read.' };
  }

  return postToMailbox(
    {
      v: PROTOCOL_VERSION,
      action: 'save',
      key: settings.key,
      captureId: payload.captureId,
      filename: payload.filename,
      mimeType: payload.mimeType,
      description: payload.description,
      data,
    },
    settings,
    options,
  );
}

export function pingMailbox(settings: MailboxSettings, options: MailboxOptions = {}): Promise<MailboxResult> {
  return postToMailbox({ v: PROTOCOL_VERSION, action: 'ping', key: settings.key }, settings, options);
}
