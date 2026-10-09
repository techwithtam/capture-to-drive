// Test connection wording (spec section 6.6). Keyed on the result's `kind` and `error`;
// the raw mailbox `message` is never the main text.
import { describe, expect, it } from 'vitest';
import { describeConnectionResult } from '../lib/connection-message';
import type { MailboxResult } from '../lib/mailbox-client';

const KEY_REJECTED = 'Mailbox key was rejected. Check the key.';
const NOT_FOUND = 'Mailbox not found. Check that the URL ends in /exec.';
const NOT_ACCEPTED = "The mailbox didn't accept the test. Check the URL and key.";
const UNREACHABLE = "Couldn't reach the mailbox. Check the URL and your connection.";
const NOT_A_MAILBOX = "That URL didn't answer like a mailbox. Check that it ends in /exec.";
const PROBLEM = 'The mailbox had a problem. Try again in a minute.';

describe('describeConnectionResult', () => {
  it('reports success as "Connected ✓"', () => {
    expect(describeConnectionResult({ kind: 'success' })).toEqual({ ok: true, text: 'Connected ✓' });
  });

  it('ignores the extra fields of a success', () => {
    expect(describeConnectionResult({ kind: 'success', fileId: 'x', name: 'y', duplicate: true })).toEqual({
      ok: true,
      text: 'Connected ✓',
    });
  });

  describe('needs_attention', () => {
    it('tells the user to check the key when it was rejected', () => {
      expect(describeConnectionResult({ kind: 'needs_attention', error: 'unauthorized' })).toEqual({
        ok: false,
        text: KEY_REJECTED,
      });
    });

    it('says the mailbox was not found, and points at /exec, for not_found', () => {
      expect(describeConnectionResult({ kind: 'needs_attention', error: 'not_found' })).toEqual({
        ok: false,
        text: NOT_FOUND,
      });
    });

    it.each<MailboxResult>([
      { kind: 'needs_attention', error: 'bad_request' },
      { kind: 'needs_attention', error: 'too_large' },
    ])('says the mailbox did not accept the test for $error', (result) => {
      expect(describeConnectionResult(result)).toEqual({ ok: false, text: NOT_ACCEPTED });
    });
  });

  describe('retryable', () => {
    it.each(['network', 'timeout'])('says the mailbox could not be reached for %s', (error) => {
      expect(describeConnectionResult({ kind: 'retryable', error })).toEqual({ ok: false, text: UNREACHABLE });
    });

    it.each(['non_json', 'unexpected_response'])('says the URL is not a mailbox for %s', (error) => {
      expect(describeConnectionResult({ kind: 'retryable', error })).toEqual({ ok: false, text: NOT_A_MAILBOX });
    });

    it.each(['server_error', 'unknown_error', 'something_new'])(
      'falls back to the generic problem text for %s',
      (error) => {
        expect(describeConnectionResult({ kind: 'retryable', error })).toEqual({ ok: false, text: PROBLEM });
      },
    );

    it('does not let a retryable result borrow the wording of a needs_attention error code', () => {
      // `unauthorized` is only ever needs_attention, but the kind decides first, so an odd retryable one stays generic.
      expect(describeConnectionResult({ kind: 'retryable', error: 'unauthorized' })).toEqual({
        ok: false,
        text: PROBLEM,
      });
      expect(describeConnectionResult({ kind: 'retryable', error: 'not_found' })).toEqual({ ok: false, text: PROBLEM });
    });
  });

  it('never shows the raw mailbox message', () => {
    const raw = 'Mailbox did not answer with JSON (HTTP 500).';
    const shown = describeConnectionResult({ kind: 'retryable', error: 'non_json', message: raw });
    expect(shown.text).not.toContain('HTTP');
    expect(shown.text).toBe(NOT_A_MAILBOX);
  });

  it('uses no em dash in any message', () => {
    const results: MailboxResult[] = [
      { kind: 'success' },
      { kind: 'needs_attention', error: 'unauthorized' },
      { kind: 'needs_attention', error: 'not_found' },
      { kind: 'needs_attention', error: 'bad_request' },
      { kind: 'retryable', error: 'network' },
      { kind: 'retryable', error: 'non_json' },
      { kind: 'retryable', error: 'server_error' },
    ];
    for (const result of results) {
      expect(describeConnectionResult(result).text).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
