// The note step's pure logic, shared by the in-page card and the note window: status text per save outcome, the
// editing -> saving -> done state machine (double Save, Esc during save, an error that stays until closed), and the wait for the background's answer,
// which tells a request that never left the page (extension reloaded) from one sent but never answered.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSaveAnswer,
  DISMISS_AFTER_SAVE_MS,
  isNotDeliveredError,
  isSaveKey,
  MESSAGE_DISMISS_MS,
  messageDismissDelay,
  MessageDismissTimer,
  NoteNotSentError,
  NoteSession,
  SAVE_FAILED_TEXT,
  saveDismissDelay,
  SAVE_RESPONSE_TIMEOUT_MS,
  SAVED_TEXT,
  SAVING_STATUS,
  settleWithin,
  statusForSaveResponse,
  statusForSaveResult,
  WILL_RETRY_TEXT,
} from '../lib/note-status';

describe('status text', () => {
  it('uses the spec strings', () => {
    expect(SAVING_STATUS).toEqual({ text: 'Saving…', tone: 'uploading' });
    expect(SAVED_TEXT).toBe('Saved to Capture ✓');
    expect(WILL_RETRY_TEXT).toBe('Still uploading. It will finish on its own.');
  });

  it('maps saved to the saved circle', () => {
    expect(statusForSaveResponse({ outcome: 'saved' })).toEqual({ text: 'Saved to Capture ✓', tone: 'saved' });
  });

  it('maps will_retry to the waiting circle', () => {
    expect(statusForSaveResponse({ outcome: 'will_retry' })).toEqual({
      text: 'Still uploading. It will finish on its own.',
      tone: 'waiting',
    });
  });

  it("shows the item's own message for needs_attention", () => {
    expect(
      statusForSaveResponse({ outcome: 'needs_attention', message: 'Mailbox key was rejected. Check Settings.' }),
    ).toEqual({ text: 'Mailbox key was rejected. Check Settings.', tone: 'attention' });
  });

  it('falls back to a generic line when needs_attention arrives without a message', () => {
    const status = statusForSaveResponse({ outcome: 'needs_attention' });
    expect(status.tone).toBe('attention');
    expect(status.text).toBe("Couldn't save this capture. Capture it again.");
  });

  it.each([[undefined], [null], [{}], [{ outcome: 'lost' }], ['saved']])(
    'treats a missing or malformed answer (%j) as will_retry: the worker may have restarted',
    (response) => {
      expect(statusForSaveResponse(response)).toEqual({ text: WILL_RETRY_TEXT, tone: 'waiting' });
    },
  );

  it('contains no em dash in any string', () => {
    const texts = [SAVING_STATUS.text, SAVED_TEXT, WILL_RETRY_TEXT, statusForSaveResponse({ outcome: 'needs_attention' }).text];
    for (const text of texts) expect(text).not.toContain('\u2014');
  });
});

describe('timing', () => {
  it('dismisses 2 s after a saved or still-uploading status and 6 s after information, and waits 30 s for an answer', () => {
    expect(DISMISS_AFTER_SAVE_MS).toBe(2000);
    expect(MESSAGE_DISMISS_MS).toBe(6000);
    expect(SAVE_RESPONSE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('messageDismissDelay', () => {
  it('keeps an error until the user closes it, and dismisses information after 6 s', () => {
    expect(messageDismissDelay('error')).toBeNull();
    expect(messageDismissDelay('info')).toBe(MESSAGE_DISMISS_MS);
  });
});

describe('saveDismissDelay', () => {
  it('lets saved and still-uploading go after 2 s', () => {
    expect(saveDismissDelay({ text: SAVED_TEXT, tone: 'saved' })).toBe(DISMISS_AFTER_SAVE_MS);
    expect(saveDismissDelay({ text: WILL_RETRY_TEXT, tone: 'waiting' })).toBe(DISMISS_AFTER_SAVE_MS);
  });

  it('keeps an error until the user closes it (WCAG 2.2.1)', () => {
    expect(saveDismissDelay({ text: SAVE_FAILED_TEXT, tone: 'attention' })).toBeNull();
    expect(saveDismissDelay({ text: 'Mailbox key was rejected. Check Settings.', tone: 'attention' })).toBeNull();
  });

  it.each([
    ['saved', { outcome: 'saved' }, DISMISS_AFTER_SAVE_MS],
    ['will_retry', { outcome: 'will_retry' }, DISMISS_AFTER_SAVE_MS],
    ['needs_attention with its message', { outcome: 'needs_attention', message: 'Mailbox key was rejected.' }, null],
    ['needs_attention without a message', { outcome: 'needs_attention' }, null],
    ['no recognisable answer', { outcome: 'lost' }, DISMISS_AFTER_SAVE_MS],
  ])('applies to what the background answers: %s', (_name, answer, delay) => {
    expect(saveDismissDelay(statusForSaveResult({ kind: 'answered', answer }))).toBe(delay);
  });

  it('goes with how a save ended: no answer is still uploading, a save that never left the page is an error', () => {
    expect(saveDismissDelay(statusForSaveResult({ kind: 'no_answer' }))).toBe(DISMISS_AFTER_SAVE_MS);
    expect(saveDismissDelay(statusForSaveResult({ kind: 'not_sent' }))).toBeNull();
  });
});

describe('MessageDismissTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(delayMs: number | null) {
    const onExpire = vi.fn();
    const timer = new MessageDismissTimer<ReturnType<typeof setTimeout>>(delayMs, onExpire, {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    });
    return { timer, onExpire };
  }

  it('expires once after the delay', () => {
    const { timer, onExpire } = setup(6000);
    timer.start();
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(timer.running).toBe(false);
  });

  it('never runs for an error (null delay), however long it waits or whatever the pointer and focus do', () => {
    const { timer, onExpire } = setup(messageDismissDelay('error'));
    timer.start();
    timer.setHovered(true);
    timer.setHovered(false);
    timer.setFocused(true);
    timer.setFocused(false);
    expect(timer.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('pauses while hovered and starts again from the full delay when the pointer leaves', () => {
    const { timer, onExpire } = setup(6000);
    timer.start();
    vi.advanceTimersByTime(4000);
    timer.setHovered(true);
    expect(timer.running).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.setHovered(false);
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('pauses while focused, and stays paused while either the pointer or focus is still on it', () => {
    const { timer, onExpire } = setup(6000);
    timer.start();
    timer.setFocused(true);
    timer.setHovered(true);
    timer.setFocused(false);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.setHovered(false);
    vi.advanceTimersByTime(6000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('never has two countdowns running, so repeated pointer events do not shorten or double it', () => {
    const { timer, onExpire } = setup(6000);
    timer.start();
    timer.start();
    timer.setHovered(false);
    timer.setFocused(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(6000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('does nothing after stop, including when the pointer leaves later', () => {
    const { timer, onExpire } = setup(6000);
    timer.start();
    timer.stop();
    expect(vi.getTimerCount()).toBe(0);
    timer.setHovered(true);
    timer.setHovered(false);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('does not run again after it expired when the pointer enters and leaves', () => {
    const { timer, onExpire } = setup(6000);
    timer.start();
    vi.advanceTimersByTime(6000);
    timer.setHovered(true);
    timer.setHovered(false);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).toHaveBeenCalledOnce();
  });
});

// The Enter that started a capture (Select area's Enter for the whole view, or a held key) can still be down when
// the card takes focus. Its repeats must not save an empty note before the user has typed anything.
describe('isSaveKey', () => {
  const enter = { key: 'Enter', isComposing: false, isTrusted: true, repeat: false };

  it('saves on a fresh, trusted Enter', () => {
    expect(isSaveKey(enter)).toBe(true);
  });

  it('ignores a held Enter (key repeat)', () => {
    expect(isSaveKey({ ...enter, repeat: true })).toBe(false);
  });

  it('ignores Enter that confirms composed text, Enter a script dispatched, and other keys', () => {
    expect(isSaveKey({ ...enter, isComposing: true })).toBe(false);
    expect(isSaveKey({ ...enter, isTrusted: false })).toBe(false);
    expect(isSaveKey({ ...enter, key: 'a' })).toBe(false);
    expect(isSaveKey({ ...enter, key: 'NumpadEnter' })).toBe(false);
  });

  it('is what the note field uses (the in-page card and the note window share lib/note-view.ts)', () => {
    const source = readFileSync(new URL('../lib/note-view.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/input\.addEventListener\('keydown', \(event\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(!isSaveKey\(event\)\) return;/);
  });
});

describe('NoteSession', () => {
  it('starts editing', () => {
    expect(new NoteSession().phase).toBe('editing');
  });

  it('lets Save start once: a second Save (double click, Enter twice) is ignored', () => {
    const session = new NoteSession();
    expect(session.beginSave()).toBe(true);
    expect(session.phase).toBe('saving');
    expect(session.beginSave()).toBe(false);
    expect(session.phase).toBe('saving');
  });

  it('ignores Discard (Esc) once saving has started', () => {
    const session = new NoteSession();
    session.beginSave();
    expect(session.beginDiscard()).toBe(false);
    expect(session.phase).toBe('saving');
  });

  it('discards only while editing, and only once', () => {
    const session = new NoteSession();
    expect(session.beginDiscard()).toBe(true);
    expect(session.phase).toBe('done');
    expect(session.beginDiscard()).toBe(false);
    expect(session.beginSave()).toBe(false);
  });

  it('finishes a save once, and ignores a finish that arrives without a save', () => {
    const idle = new NoteSession();
    expect(idle.finishSave()).toBe(false);
    expect(idle.phase).toBe('editing');

    const session = new NoteSession();
    session.beginSave();
    expect(session.finishSave()).toBe(true);
    expect(session.phase).toBe('done');
    expect(session.finishSave()).toBe(false);
  });

  it('reports whether the user still has an unsent note', () => {
    const session = new NoteSession();
    expect(session.isEditing).toBe(true);
    session.beginSave();
    expect(session.isEditing).toBe(false);
  });

  it('waits for the user after an error: the save finishes as failed, and only then can it be closed', () => {
    const session = new NoteSession();
    session.beginSave();
    expect(session.finishSave(true)).toBe(true);
    expect(session.phase).toBe('failed');
    expect(session.isEditing).toBe(false);
    expect(session.finishSave()).toBe(false);
    expect(session.beginDiscard()).toBe(false);
    expect(session.beginSave()).toBe(false);
    expect(session.phase).toBe('failed');

    expect(session.beginClose()).toBe(true);
    expect(session.phase).toBe('done');
    expect(session.beginClose()).toBe(false);
  });

  it('cannot be closed before an error: not while editing, saving, or after a save that went through', () => {
    const editing = new NoteSession();
    expect(editing.beginClose()).toBe(false);
    expect(editing.phase).toBe('editing');

    const saving = new NoteSession();
    saving.beginSave();
    expect(saving.beginClose()).toBe(false);
    expect(saving.phase).toBe('saving');

    const saved = new NoteSession();
    saved.beginSave();
    saved.finishSave();
    expect(saved.beginClose()).toBe(false);
    expect(saved.phase).toBe('done');

    const discarded = new NoteSession();
    discarded.beginDiscard();
    expect(discarded.beginClose()).toBe(false);
  });
});

describe('settleWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when it arrives in time', async () => {
    await expect(settleWithin(Promise.resolve({ outcome: 'saved' }), 1000)).resolves.toEqual({ outcome: 'saved' });
  });

  it('resolves undefined when the promise rejects (for example, the worker restarted and the port closed)', async () => {
    await expect(settleWithin(Promise.reject(new Error('The message port closed.')), 1000)).resolves.toBeUndefined();
  });

  it('resolves undefined when nothing arrives in time, and ignores a late answer', async () => {
    let answer: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const settled = settleWithin(late, 1000);
    await vi.advanceTimersByTimeAsync(999);
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBeUndefined();
    answer('too late');
    await expect(settled).resolves.toBeUndefined();
  });

  it('clears its timer once the value arrives', async () => {
    await settleWithin(Promise.resolve(1), 1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('isNotDeliveredError', () => {
  it.each([
    [new NoteNotSentError('The extension was reloaded.')],
    [new Error('Extension context invalidated.')],
    [new Error('Could not establish connection. Receiving end does not exist.')],
  ])('recognizes %s as a request that never reached the background', (error) => {
    expect(isNotDeliveredError(error)).toBe(true);
  });

  it.each([
    [new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')],
    [new Error('The message port closed before a response was received.')],
    ['Extension context invalidated.'],
    [undefined],
  ])('treats %s as possibly delivered', (error) => {
    expect(isNotDeliveredError(error)).toBe(false);
  });
});

describe('awaitSaveAnswer', () => {
  it('reports the answer', async () => {
    await expect(awaitSaveAnswer(async () => ({ outcome: 'saved' }), 1000)).resolves.toEqual({
      kind: 'answered',
      answer: { outcome: 'saved' },
    });
  });

  it('reports not_sent when sending throws synchronously (extension context invalidated)', async () => {
    const send = () => {
      throw new Error('Extension context invalidated.');
    };
    await expect(awaitSaveAnswer(send, 1000)).resolves.toEqual({ kind: 'not_sent' });
  });

  it('reports not_sent when sending throws anything synchronously', async () => {
    const send = () => {
      throw new TypeError('Cannot read properties of undefined');
    };
    await expect(awaitSaveAnswer(send, 1000)).resolves.toEqual({ kind: 'not_sent' });
  });

  it('reports not_sent when the transport says the request never left', async () => {
    await expect(awaitSaveAnswer(() => Promise.reject(new NoteNotSentError('no runtime')), 1000)).resolves.toEqual({
      kind: 'not_sent',
    });
  });

  it('reports no_answer when the port closed after sending (the worker stopped mid-save)', async () => {
    const send = () => Promise.reject(new Error('The message port closed before a response was received.'));
    await expect(awaitSaveAnswer(send, 1000)).resolves.toEqual({ kind: 'no_answer' });
  });

  it('reports no_answer when nothing arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const waiting = awaitSaveAnswer(() => new Promise<unknown>(() => undefined), 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(waiting).resolves.toEqual({ kind: 'no_answer' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('statusForSaveResult', () => {
  it('maps an answer through statusForSaveResponse', () => {
    expect(statusForSaveResult({ kind: 'answered', answer: { outcome: 'saved' } })).toEqual({
      text: SAVED_TEXT,
      tone: 'saved',
    });
  });

  it('maps no_answer to will_retry: the request reached the background, which queues it', () => {
    expect(statusForSaveResult({ kind: 'no_answer' })).toEqual({ text: WILL_RETRY_TEXT, tone: 'waiting' });
  });

  it('maps not_sent to the save-failed line: nothing reached the background, so nothing will upload', () => {
    expect(statusForSaveResult({ kind: 'not_sent' })).toEqual({ text: SAVE_FAILED_TEXT, tone: 'attention' });
    expect(SAVE_FAILED_TEXT).toBe("Couldn't save this capture. Capture it again.");
  });
});
