// Request parsing, version and key checks, and ping (spec section 6.1, steps 1 to 3).
import { describe, expect, it } from 'vitest';
import { TEST_KEY, loadMailbox } from './harness';

describe('doPost: ping', () => {
  it('answers a ping with {ok: true} as JSON, without touching Drive', () => {
    const mailbox = loadMailbox();
    const response = mailbox.send({ v: 1, action: 'ping', key: TEST_KEY });
    expect(response).toEqual({ mimeType: 'JSON', body: { ok: true } });
    expect(mailbox.world.driveCalls).toBe(0);
  });

  it('rejects a ping with the wrong key', () => {
    const response = loadMailbox().send({ v: 1, action: 'ping', key: 'not-the-key' });
    expect(response.mimeType).toBe('JSON');
    expect(response.body).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(typeof response.body.message).toBe('string');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 12345],
    ['null', null],
    ['an array', [TEST_KEY]],
  ])('rejects a ping whose key is %s', (_label, key) => {
    const response = loadMailbox().send({ v: 1, action: 'ping', key });
    expect(response.body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it.each([
    ['starts with the real key', `${TEST_KEY}-extra`],
    ['is the start of the real key', TEST_KEY.slice(0, -1)],
    ['is one character of the real key', TEST_KEY.slice(0, 1)],
    ['has different letter case', TEST_KEY.toUpperCase()],
    ['has surrounding spaces', ` ${TEST_KEY} `],
  ])('rejects a key that %s', (_label, key) => {
    const response = loadMailbox().send({ v: 1, action: 'ping', key });
    expect(response.body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('fails closed when MAILBOX_KEY was never set, even for an empty or missing key', () => {
    const mailbox = loadMailbox({ properties: {} });
    expect(mailbox.send({ v: 1, action: 'ping', key: '' }).body).toMatchObject({ error: 'unauthorized' });
    expect(mailbox.send({ v: 1, action: 'ping' }).body).toMatchObject({ error: 'unauthorized' });
    expect(mailbox.send({ v: 1, action: 'ping', key: 'null' }).body).toMatchObject({ error: 'unauthorized' });
  });

  it('checks the key before anything else about the request', () => {
    const response = loadMailbox().send({ v: 1, action: 'nonsense', key: 'not-the-key' });
    expect(response.body).toMatchObject({ error: 'unauthorized' });
  });
});

describe('doPost: request parsing', () => {
  it.each([
    ['not JSON', 'this is not json'],
    ['truncated JSON', '{"v": 1, "action": "ping"'],
    ['an empty body', ''],
    ['JSON null', 'null'],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON string', '"ping"'],
    ['a JSON number', '42'],
  ])('answers bad_request when the body is %s', (_label, contents) => {
    const response = loadMailbox().sendRaw(contents);
    expect(response.mimeType).toBe('JSON');
    expect(response.body).toMatchObject({ ok: false, error: 'bad_request' });
    expect(typeof response.body.message).toBe('string');
  });

  it.each([
    ['an event with no postData', {}],
    ['an undefined event', undefined],
    ['postData without contents', { postData: {} }],
  ])('answers bad_request for %s', (_label, event) => {
    expect(loadMailbox().sendEvent(event).body).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it.each([
    ['missing', undefined],
    ['2', 2],
    ['the string "1"', '1'],
    ['null', null],
  ])('answers bad_request when v is %s', (_label, v) => {
    const response = loadMailbox().send({ v, action: 'ping', key: TEST_KEY });
    expect(response.body).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'delete'],
    ['not a string', 7],
  ])('answers bad_request when the action is %s', (_label, action) => {
    const response = loadMailbox().send({ v: 1, action, key: TEST_KEY });
    expect(response.body).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('never echoes the key back in an error message', () => {
    const response = loadMailbox().send({ v: 1, action: 'delete', key: TEST_KEY });
    expect(JSON.stringify(response.body)).not.toContain(TEST_KEY);
  });
});
