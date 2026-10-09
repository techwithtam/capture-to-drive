// Wording for the Settings page's "Test connection" result (spec section 6.6). The text is chosen from the result's
// `kind` and `error` code; the raw mailbox `message` is for debugging and is never shown as the main text.
// Pure module: no browser APIs, so it is easy to test.

import type { MailboxResult } from './mailbox-client';

export interface ConnectionMessage {
  /** True only for a successful ping. */
  ok: boolean;
  text: string;
}

const CONNECTED = 'Connected ✓';
const KEY_REJECTED = 'Mailbox key was rejected. Check the key.';
const NOT_FOUND = 'Mailbox not found. Check that the URL ends in /exec.';
const NOT_ACCEPTED = "The mailbox didn't accept the test. Check the URL and key.";
const UNREACHABLE = "Couldn't reach the mailbox. Check the URL and your connection.";
const NOT_A_MAILBOX = "That URL didn't answer like a mailbox. Check that it ends in /exec.";
const MAILBOX_PROBLEM = 'The mailbox had a problem. Try again in a minute.';

function describeNeedsAttention(error: 'unauthorized' | 'bad_request' | 'too_large' | 'not_found'): string {
  switch (error) {
    case 'unauthorized':
      return KEY_REJECTED;
    case 'not_found':
      return NOT_FOUND;
    case 'bad_request':
    case 'too_large':
      return NOT_ACCEPTED;
  }
}

function describeRetryable(error: string): string {
  switch (error) {
    case 'network':
    case 'timeout':
      return UNREACHABLE;
    case 'non_json':
    case 'unexpected_response':
      return NOT_A_MAILBOX;
    default:
      return MAILBOX_PROBLEM;
  }
}

/** The kind decides first, then the error code, so a code means the same thing only within its own kind. */
export function describeConnectionResult(result: MailboxResult): ConnectionMessage {
  switch (result.kind) {
    case 'success':
      return { ok: true, text: CONNECTED };
    case 'needs_attention':
      return { ok: false, text: describeNeedsAttention(result.error) };
    case 'retryable':
      return { ok: false, text: describeRetryable(result.error) };
  }
}
