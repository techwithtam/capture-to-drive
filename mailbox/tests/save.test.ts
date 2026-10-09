// The save action: validation, duplicate guard, size cap, Drive writes, errors (spec section 6.1, steps 4 to 9).
import { describe, expect, it } from 'vitest';
import { TEST_FOLDER_ID, TEST_KEY, bytesOf, filesIn, liveFilesIn, loadMailbox, saveRequest, toBase64 } from './harness';

const MIB = 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 20 * MIB;
// Tests that push 20 MB through the vm harness take a few seconds each, more on a slow machine or CI runner.
const BIG_PAYLOAD_TIMEOUT_MS = 30_000;
const FOLDER_MISSING = 'The Capture folder is missing. Run setup() again.';
const FOLDER_TRASHED = "The Capture folder is in Drive's Trash. Restore it, then press Retry.";
const STORAGE_FULL = 'Drive storage is full.';

describe('doPost: save', () => {
  it('creates the file in the Capture folder and reports its id and name', () => {
    const mailbox = loadMailbox();
    const request = saveRequest();
    const response = mailbox.send(request);

    const [file, ...others] = filesIn(mailbox.world);
    expect(others).toEqual([]);
    expect(file).toBeDefined();
    if (!file) return;
    expect(response).toEqual({
      mimeType: 'JSON',
      body: { ok: true, fileId: file.id, name: request.filename, duplicate: false },
    });
    expect(file.getName()).toBe(request.filename);
    expect(file.getMimeType()).toBe('application/pdf');
    expect(file.getDescription()).toBe(request.description);
    expect(bytesOf(file).toString()).toBe('hello');
  });

  it('keeps every byte of binary data, including bytes above 127', () => {
    const mailbox = loadMailbox();
    const original = Uint8Array.from([0, 1, 127, 128, 200, 255]);
    mailbox.send(saveRequest({ data: toBase64(original) }));
    const [file] = filesIn(mailbox.world);
    expect(file && Array.from(bytesOf(file))).toEqual(Array.from(original));
  });

  it('remembers captureId to fileId in the script cache for 6 hours', () => {
    const mailbox = loadMailbox();
    const response = mailbox.send(saveRequest({ captureId: 'abc-123' }));
    expect(mailbox.world.cache.get('abc-123')).toEqual({ value: response.body.fileId, ttlSeconds: 21_600 });
  });

  it('saves with an empty description when none is sent', () => {
    const mailbox = loadMailbox();
    expect(mailbox.send(saveRequest({ description: undefined })).body).toMatchObject({ ok: true });
    expect(filesIn(mailbox.world)[0]?.getDescription()).toBe('');
  });

  it('rejects a description that is not a string', () => {
    const mailbox = loadMailbox();
    expect(mailbox.send(saveRequest({ description: 42 })).body).toMatchObject({ error: 'bad_request' });
    expect(filesIn(mailbox.world)).toEqual([]);
  });

  it('rejects a save with the wrong key and creates nothing', () => {
    const mailbox = loadMailbox();
    const response = mailbox.send(saveRequest({ key: 'not-the-key' }));
    expect(response.body).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.driveCalls).toBe(0);
  });

  describe.each(['captureId', 'filename', 'mimeType', 'data'])('required field %s', (field) => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['a number', 5],
      ['null', null],
      ['an object', {}],
    ])('answers bad_request when it is %s', (_label, value) => {
      const mailbox = loadMailbox();
      const response = mailbox.send(saveRequest({ [field]: value }));
      expect(response.body).toMatchObject({ ok: false, error: 'bad_request' });
      expect(typeof response.body.message).toBe('string');
      expect(filesIn(mailbox.world)).toEqual([]);
      expect(mailbox.world.cache.size).toBe(0);
    });
  });
});

describe('doPost: duplicate guard', () => {
  it('returns the first file id with duplicate: true and creates no second file', () => {
    const mailbox = loadMailbox();
    const first = mailbox.send(saveRequest({ captureId: 'same-id' }));
    const second = mailbox.send(saveRequest({ captureId: 'same-id' }));

    expect(first.body.duplicate).toBe(false);
    expect(second.body).toMatchObject({ ok: true, fileId: first.body.fileId, duplicate: true });
    expect(filesIn(mailbox.world)).toHaveLength(1);
  });

  it('treats different captureIds as different captures', () => {
    const mailbox = loadMailbox();
    mailbox.send(saveRequest({ captureId: 'one' }));
    const second = mailbox.send(saveRequest({ captureId: 'two' }));
    expect(second.body).toMatchObject({ ok: true, duplicate: false });
    expect(filesIn(mailbox.world)).toHaveLength(2);
  });

  it('still requires the key, so a captureId cannot be used to probe for files', () => {
    const mailbox = loadMailbox();
    mailbox.send(saveRequest({ captureId: 'same-id' }));
    const response = mailbox.send(saveRequest({ captureId: 'same-id', key: 'not-the-key' }));
    expect(response.body).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(response.body.fileId).toBeUndefined();
  });

  it('does not cache a failed save, so the retry creates the file', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: new Error('Service error: Drive') };
    expect(mailbox.send(saveRequest({ captureId: 'retry-me' })).body).toMatchObject({ error: 'server_error' });
    expect(mailbox.world.cache.has('retry-me')).toBe(false);

    const retry = mailbox.send(saveRequest({ captureId: 'retry-me' }));
    expect(retry.body).toMatchObject({ ok: true, duplicate: false });
    expect(filesIn(mailbox.world)).toHaveLength(1);
  });
});

describe('doPost: size cap', () => {
  it('answers too_large when the decoded size exceeds MAX_FILE_BYTES, and creates nothing', () => {
    const mailbox = loadMailbox({
      properties: { MAILBOX_KEY: TEST_KEY, FOLDER_ID: TEST_FOLDER_ID, MAX_FILE_BYTES: '10' },
    });
    const response = mailbox.send(saveRequest({ data: toBase64(Buffer.alloc(11)) }));
    expect(response.body).toMatchObject({ ok: false, error: 'too_large' });
    expect(typeof response.body.message).toBe('string');
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);
  });

  it('measures decoded bytes, not the base64 text: exactly MAX_FILE_BYTES is accepted', () => {
    const mailbox = loadMailbox({
      properties: { MAILBOX_KEY: TEST_KEY, FOLDER_ID: TEST_FOLDER_ID, MAX_FILE_BYTES: '10' },
    });
    const data = toBase64(Buffer.alloc(10));
    expect(data.length).toBeGreaterThan(10);
    expect(mailbox.send(saveRequest({ data })).body).toMatchObject({ ok: true });
  });

  it('defaults MAX_FILE_BYTES to 20 MB when the Script Property is unset', () => {
    const mailbox = loadMailbox();
    const atLimit = mailbox.send(saveRequest({ captureId: 'at-limit', data: toBase64(Buffer.alloc(DEFAULT_MAX_FILE_BYTES)) }));
    expect(atLimit.body).toMatchObject({ ok: true });

    const overLimit = mailbox.send(
      saveRequest({ captureId: 'over-limit', data: toBase64(Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1)) }),
    );
    expect(overLimit.body).toMatchObject({ ok: false, error: 'too_large' });
    expect(filesIn(mailbox.world)).toHaveLength(1);
  }, BIG_PAYLOAD_TIMEOUT_MS);

  it.each(['abc', '', '0', '-5', 'Infinity'])('falls back to the 20 MB default when MAX_FILE_BYTES is %j', (value) => {
    const mailbox = loadMailbox({
      properties: { MAILBOX_KEY: TEST_KEY, FOLDER_ID: TEST_FOLDER_ID, MAX_FILE_BYTES: value },
    });
    expect(mailbox.send(saveRequest({ captureId: 'small' })).body).toMatchObject({ ok: true });
    const overLimit = mailbox.send(
      saveRequest({ captureId: 'big', data: toBase64(Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1)) }),
    );
    expect(overLimit.body).toMatchObject({ error: 'too_large' });
  }, BIG_PAYLOAD_TIMEOUT_MS);

  it('honors a MAX_FILE_BYTES above the default, as set while probing for the real limit', () => {
    const mailbox = loadMailbox({
      properties: { MAILBOX_KEY: TEST_KEY, FOLDER_ID: TEST_FOLDER_ID, MAX_FILE_BYTES: String(100 * MIB) },
    });
    const response = mailbox.send(saveRequest({ data: toBase64(Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1)) }));
    expect(response.body).toMatchObject({ ok: true });
  }, BIG_PAYLOAD_TIMEOUT_MS);
});

describe('doPost: server errors', () => {
  it('answers server_error with a short message when the Capture folder is missing', () => {
    const mailbox = loadMailbox({ existingFolders: [] });
    const response = mailbox.send(saveRequest());
    expect(response.mimeType).toBe('JSON');
    expect(response.body).toEqual({ ok: false, error: 'server_error', message: FOLDER_MISSING });
    expect(String(response.body.message).length).toBeLessThanOrEqual(200);
    expect(mailbox.world.cache.size).toBe(0);
  });

  it('answers server_error when FOLDER_ID was never set', () => {
    const mailbox = loadMailbox({ properties: { MAILBOX_KEY: TEST_KEY } });
    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: FOLDER_MISSING });
  });

  it('asks to restore a Capture folder in the Trash and saves nothing until it is restored', () => {
    const mailbox = loadMailbox();
    const folder = mailbox.world.folders.get(TEST_FOLDER_ID);
    if (folder === undefined) throw new Error('the test folder is missing');
    folder.trashed = true;

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: FOLDER_TRASHED });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);

    folder.trashed = false;
    expect(mailbox.send(saveRequest()).body).toMatchObject({ ok: true, duplicate: false });
    expect(filesIn(mailbox.world)).toHaveLength(1);
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(TEST_FOLDER_ID);
    expect(mailbox.world.createdFolders).toEqual([]);
  });

  it.each([
    'No item with the given ID could be found. Possibly because you have not edited this item or you do not have permission to access it.',
    'NO ITEM WITH THE GIVEN ID could be found.',
    'You DO NOT HAVE PERMISSION to access this folder.',
    'No item with the given ID could be found, or you do not have permission to access it.',
  ])('says the folder is missing when Drive reports %j', (message) => {
    const mailbox = loadMailbox();
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error(message) };

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: FOLDER_MISSING });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);
    expect(mailbox.world.sleepDurations).toEqual([]);
  });

  it('reports a transient folder lookup error with its own message and saves on retry without setup()', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error('Service error: Drive') };

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: 'Service error: Drive' });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);

    expect(mailbox.send(saveRequest()).body).toMatchObject({ ok: true, duplicate: false });
    expect(filesIn(mailbox.world)).toHaveLength(1);
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(TEST_FOLDER_ID);
    expect(mailbox.world.createdFolders).toEqual([]);
  });

  it.each([
    'Unexpected error while getting the method or property getFolderById on object DriveApp.',
    'Folder NOT FOUND.',
    'Limit Exceeded: DriveApp.',
    'An error occurred while reading from storage.',
  ])('reports other folder lookup errors with their own messages: %s', (message) => {
    const mailbox = loadMailbox();
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error(message) };

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.sleepDurations).toEqual([]);
  });

  it('reports an isTrashed() error with its own message and changes nothing', () => {
    const mailbox = loadMailbox();
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextFolderIsTrashedFailure = { thrown: new Error('Service error: Drive') };

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: 'Service error: Drive' });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.sleepDurations).toEqual([]);
  });

  it('maps a storage-quota error during folder lookup to the storage-full message', () => {
    const mailbox = loadMailbox();
    const message = "The user's Drive storage quota has been exceeded.";
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error(message) };

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: STORAGE_FULL });
    expect(filesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.size).toBe(0);
    expect(mailbox.world.logs.join('\n')).toContain(message);
  });

  it.each([
    ["The user's Drive storage quota has been exceeded."],
    ["Exception: The user's Drive storage quota has been exceeded."],
    ['Storage quota exceeded'],
  ])('says Drive storage is full when Drive refuses the file with %j', (driveMessage) => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: new Error(driveMessage) };
    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: STORAGE_FULL });
    // The real reason still goes to the execution log, for whoever looks into it.
    expect(mailbox.world.logs.join('\n')).toContain(driveMessage);
  });

  it.each(['Limit Exceeded: DriveApp.', 'An error occurred while reading from storage.'])('reports a file creation error with its own message: %s', (message) => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: new Error(message) };
    expect(mailbox.send(saveRequest()).body).toEqual({
      ok: false,
      error: 'server_error',
      message,
    });
  });

  it('answers server_error when Drive fails while creating the file', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: new Error('Service error: Drive') };
    const response = mailbox.send(saveRequest());
    expect(response.body).toMatchObject({ ok: false, error: 'server_error', message: 'Service error: Drive' });
  });

  it('still answers JSON when something other than an Error is thrown', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: 'plain string failure' };
    const response = mailbox.send(saveRequest());
    expect(response.mimeType).toBe('JSON');
    expect(response.body).toMatchObject({ ok: false, error: 'server_error', message: 'plain string failure' });
  });

  it('cuts very long error messages short', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: new Error('x'.repeat(5000)) };
    const response = mailbox.send(saveRequest());
    expect(response.body).toMatchObject({ error: 'server_error' });
    expect(String(response.body.message).length).toBeLessThanOrEqual(200);
  });

  it('trashes the new file and answers server_error when its description cannot be set', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextSetDescriptionFailure = { thrown: new Error('Service error: Drive') };
    const response = mailbox.send(saveRequest({ captureId: 'half-done' }));

    expect(response.body).toEqual({ ok: false, error: 'server_error', message: 'Service error: Drive' });
    const [file, ...others] = filesIn(mailbox.world);
    expect(others).toEqual([]);
    expect(file?.isTrashed()).toBe(true);
    expect(liveFilesIn(mailbox.world)).toEqual([]);
    expect(mailbox.world.cache.has('half-done')).toBe(false);
  });

  it('after a failed description, the retry creates exactly one complete file', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextSetDescriptionFailure = { thrown: new Error('Service error: Drive') };
    const request = saveRequest({ captureId: 'half-done' });
    expect(mailbox.send(request).body).toMatchObject({ error: 'server_error' });

    const retry = mailbox.send(request);
    expect(retry.body).toMatchObject({ ok: true, duplicate: false });
    const live = liveFilesIn(mailbox.world);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(retry.body.fileId);
    expect(live[0]?.getDescription()).toBe(request.description);
    expect(mailbox.world.cache.get('half-done')?.value).toBe(retry.body.fileId);

    // A third send is the duplicate guard's job: still one file.
    expect(mailbox.send(request).body).toMatchObject({ ok: true, fileId: retry.body.fileId, duplicate: true });
    expect(liveFilesIn(mailbox.world)).toHaveLength(1);
  });

  it('still answers server_error, with the original reason, when the incomplete file cannot be trashed', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextSetDescriptionFailure = { thrown: new Error('Service error: Drive') };
    mailbox.world.setTrashedFails = true;

    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: 'Service error: Drive' });
    expect(mailbox.world.logs.join('\n')).toContain('Could not trash');
  });

  it('says Drive storage is full when the description fails for lack of space, and trashes the file', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextSetDescriptionFailure = { thrown: new Error("The user's Drive storage quota has been exceeded.") };
    expect(mailbox.send(saveRequest()).body).toEqual({ ok: false, error: 'server_error', message: STORAGE_FULL });
    expect(liveFilesIn(mailbox.world)).toEqual([]);
  });

  it('still reports success when only the duplicate-guard cache write fails', () => {
    const mailbox = loadMailbox();
    mailbox.world.cachePutFails = true;
    const response = mailbox.send(saveRequest());
    expect(response.body).toMatchObject({ ok: true, duplicate: false });
    expect(filesIn(mailbox.world)).toHaveLength(1);
  });

  it('does not put the request data or key in the execution log', () => {
    const mailbox = loadMailbox();
    mailbox.world.nextCreateFileFailure = { thrown: new Error('Service error: Drive') };
    mailbox.send(saveRequest({ data: toBase64('secret file contents') }));
    const logged = mailbox.world.logs.join('\n');
    expect(logged).not.toContain(TEST_KEY);
    expect(logged).not.toContain(toBase64('secret file contents'));
  });
});
