// doGet, setup(), rotateKey(), the manifest, and checks that no secrets are baked into the source.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEST_FOLDER_ID, TEST_KEY, UNCONFIGURED, filesIn, loadMailbox, saveRequest } from './harness';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

function readMailboxFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('doGet', () => {
  it('answers not_found as JSON and reveals nothing else', () => {
    const mailbox = loadMailbox();
    expect(mailbox.doGet()).toEqual({ mimeType: 'JSON', body: { ok: false, error: 'not_found' } });
    expect(mailbox.world.driveCalls).toBe(0);
  });

  it('answers the same before setup() has run', () => {
    expect(loadMailbox(UNCONFIGURED).doGet().body).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('setup()', () => {
  it('creates a Capture folder, generates a key, stores both, and logs both', () => {
    const mailbox = loadMailbox(UNCONFIGURED);
    mailbox.setup();

    const { world } = mailbox;
    expect(world.createdFolders).toHaveLength(1);
    expect(world.sleepDurations).toEqual([]);
    const folder = world.createdFolders[0];
    expect(folder?.getName()).toBe('Capture');
    expect(world.properties.get('FOLDER_ID')).toBe(folder?.getId());

    const key = world.properties.get('MAILBOX_KEY');
    expect(key).toMatch(KEY_PATTERN);

    const log = world.logs.join('\n');
    expect(log).toContain(key);
    expect(log).toContain(folder?.getUrl());
  });

  it('produces a key and folder the mailbox then accepts', () => {
    const mailbox = loadMailbox(UNCONFIGURED);
    mailbox.setup();
    const key = mailbox.world.properties.get('MAILBOX_KEY');
    const folderId = mailbox.world.properties.get('FOLDER_ID');

    expect(mailbox.send({ v: 1, action: 'ping', key })).toEqual({ mimeType: 'JSON', body: { ok: true } });
    expect(mailbox.send(saveRequest({ key })).body).toMatchObject({ ok: true });
    expect(filesIn(mailbox.world, folderId)).toHaveLength(1);
  });

  it('does not leave a default key or folder behind: nothing works until setup() runs', () => {
    const mailbox = loadMailbox(UNCONFIGURED);
    expect(mailbox.send({ v: 1, action: 'ping', key: TEST_KEY }).body).toMatchObject({ error: 'unauthorized' });
  });

  it('is safe to run again: no second folder, same key, both logged again', () => {
    const mailbox = loadMailbox(UNCONFIGURED);
    mailbox.setup();
    const key = mailbox.world.properties.get('MAILBOX_KEY');
    const folderId = mailbox.world.properties.get('FOLDER_ID');
    mailbox.world.logs.length = 0;

    mailbox.setup();

    expect(mailbox.world.createdFolders).toHaveLength(1);
    expect(mailbox.world.properties.get('MAILBOX_KEY')).toBe(key);
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(folderId);
    const log = mailbox.world.logs.join('\n');
    expect(log).toContain(key);
    expect(log).toContain(`https://drive.google.com/drive/folders/${folderId}`);
  });

  it('keeps an existing FOLDER_ID instead of creating a folder', () => {
    const mailbox = loadMailbox({ properties: { FOLDER_ID: TEST_FOLDER_ID }, existingFolders: [TEST_FOLDER_ID] });
    mailbox.setup();

    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.sleepDurations).toEqual([]);
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(TEST_FOLDER_ID);
    expect(mailbox.world.properties.get('MAILBOX_KEY')).toMatch(KEY_PATTERN);
    expect(mailbox.world.logs.join('\n')).toContain(`https://drive.google.com/drive/folders/${TEST_FOLDER_ID}`);
  });

  it('keeps an existing MAILBOX_KEY instead of replacing it', () => {
    const mailbox = loadMailbox({ properties: { MAILBOX_KEY: TEST_KEY }, existingFolders: [] });
    mailbox.setup();

    expect(mailbox.world.properties.get('MAILBOX_KEY')).toBe(TEST_KEY);
    expect(mailbox.world.logs.join('\n')).toContain(TEST_KEY);
    expect(mailbox.world.createdFolders).toHaveLength(1);
  });

  it('replaces a Capture folder that no longer exists, so saving works again', () => {
    const mailbox = loadMailbox({ properties: { MAILBOX_KEY: TEST_KEY, FOLDER_ID: 'deleted-folder' }, existingFolders: [] });
    expect(mailbox.send(saveRequest()).body).toMatchObject({ error: 'server_error' });

    mailbox.setup();

    expect(mailbox.world.createdFolders).toHaveLength(1);
    const folder = mailbox.world.createdFolders[0];
    expect(folder?.getName()).toBe('Capture');
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(folder?.getId());
    expect(mailbox.world.properties.get('MAILBOX_KEY')).toBe(TEST_KEY);
    const log = mailbox.world.logs.join('\n');
    expect(log).toContain('The old Capture folder (ID deleted-folder) could not be opened, so a new one was made.');
    expect(log).toContain('Copy the ID first.');
    expect(log).toContain("it is the part of the old folder's Drive URL after /folders/");
    expect(log).toContain('If you ran setup() in the wrong account: sign in as the Google account that deployed the mailbox');
    expect(log).toContain('set FOLDER_ID back to that ID in Project Settings > Script Properties, then press Retry in the extension popup');
    expect(log).toContain('Do not run setup() again.');
    expect(log).toContain('Optional, wrong account only: delete the extra empty Capture folder (the Capture folder: line below)');
    expect(log).toContain('Do not delete the one that holds your files.');
    expect(log).toContain('If you used the right account and the old folder was deleted, nothing more is needed. Press Retry in the extension popup.');
    expect(log).toContain('Capture folder: ' + folder?.getUrl());
    expect(mailbox.world.sleepDurations).toEqual([1500]);

    expect(mailbox.send(saveRequest({ captureId: 'after-setup' })).body).toMatchObject({ ok: true });
    expect(filesIn(mailbox.world, folder?.getId())).toHaveLength(1);
  });

  it('keeps a Capture folder that is in the Trash and logs how to restore it', () => {
    const mailbox = loadMailbox();
    const trashed = mailbox.world.folders.get(TEST_FOLDER_ID);
    if (trashed === undefined) throw new Error('the test folder is missing');
    trashed.trashed = true;

    mailbox.setup();

    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(TEST_FOLDER_ID);
    expect(mailbox.world.properties.get('MAILBOX_KEY')).toBe(TEST_KEY);
    expect(trashed.trashed).toBe(true);
    expect(mailbox.world.logs).toContainEqual(expect.stringContaining(TEST_KEY));
    const instruction = mailbox.world.logs.find((line) => line.includes('Trash'));
    expect(instruction).toContain(trashed.getUrl());
    expect(instruction).toContain('Restore');
    expect(instruction).toContain('press Retry in the extension popup');
    expect(instruction).toContain('a folder that contains it may be in Trash');
    expect(instruction).toContain('Restore that folder instead');
    expect(mailbox.world.sleepDurations).toEqual([]);
    expect(filesIn(mailbox.world)).toEqual([]);
  });

  it('still creates and logs a missing key when the Capture folder is in the Trash', () => {
    const mailbox = loadMailbox({ properties: { FOLDER_ID: TEST_FOLDER_ID } });
    const folder = mailbox.world.folders.get(TEST_FOLDER_ID);
    if (folder === undefined) throw new Error('the test folder is missing');
    folder.trashed = true;

    mailbox.setup();

    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(TEST_FOLDER_ID);
    const key = mailbox.world.properties.get('MAILBOX_KEY');
    expect(key).toMatch(KEY_PATTERN);
    expect(mailbox.world.logs.join('\n')).toContain(key);
  });

  it.each([
    'No item with the given ID could be found. Possibly because you have not edited this item or you do not have permission to access it.',
    'NO ITEM WITH THE GIVEN ID could be found.',
    'You DO NOT HAVE PERMISSION to access this folder.',
    'No item with the given ID could be found, or you do not have permission to access it.',
  ])('replaces a folder only after two not-found lookups: %s', (message) => {
    const mailbox = loadMailbox({ existingFolders: [] });
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error(message) };

    mailbox.setup();

    expect(mailbox.world.createdFolders).toHaveLength(1);
    const newFolderId = mailbox.world.createdFolders[0]?.getId();
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(newFolderId);
    expect(newFolderId).not.toBe(TEST_FOLDER_ID);
    expect(mailbox.world.properties.get('MAILBOX_KEY')).toBe(TEST_KEY);
    expect(mailbox.world.sleepDurations).toEqual([1500]);
    expect(mailbox.world.driveCalls).toBe(3);
    const warning = mailbox.world.logs.find((line) => line.startsWith('The old Capture folder (ID '));
    expect(warning).toContain('(ID ' + TEST_FOLDER_ID + ')');
    expect(warning).toContain('Copy the ID first.');
    const recovery = mailbox.world.logs.join('\n');
    expect(recovery).toContain('sign in as the Google account that deployed the mailbox');
    expect(recovery).toContain('set FOLDER_ID back to that ID in Project Settings > Script Properties');
    expect(recovery).toContain('delete the extra empty Capture folder');
    expect(recovery).toContain('Do not run setup() again.');
  });

  it('keeps the folder when a one-time not-found lookup succeeds on retry', () => {
    const mailbox = loadMailbox();
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error('No item with the given ID could be found.') };

    mailbox.setup();

    expect(mailbox.world.sleepDurations).toEqual([1500]);
    expect(mailbox.world.driveCalls).toBe(2);
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.logs.join('\n')).not.toContain('so a new one was made');
  });

  it('keeps the folder when the lookup retry finds it in the Trash', () => {
    const mailbox = loadMailbox();
    const folder = mailbox.world.folders.get(TEST_FOLDER_ID);
    if (folder === undefined) throw new Error('the test folder is missing');
    folder.trashed = true;
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error('No item with the given ID could be found.') };

    mailbox.setup();

    expect(mailbox.world.sleepDurations).toEqual([1500]);
    expect(mailbox.world.driveCalls).toBe(2);
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.logs).toContainEqual(expect.stringContaining("The Capture folder is in Drive's Trash: " + folder.getUrl()));
  });

  it('reports an error from the lookup retry without changing anything', () => {
    const mailbox = loadMailbox({ properties: { FOLDER_ID: TEST_FOLDER_ID } });
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error('No item with the given ID could be found.') };
    mailbox.world.nextFolderIsTrashedFailure = { thrown: new Error('Service error: Drive') };

    expect(() => mailbox.setup()).toThrow('Could not open the Capture folder (FOLDER_ID ' + TEST_FOLDER_ID + '): Service error: Drive. Nothing was changed.');

    expect(mailbox.world.sleepDurations).toEqual([1500]);
    expect(mailbox.world.driveCalls).toBe(2);
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties).toEqual(originalProperties);
  });

  it.each([TEST_KEY, undefined])('explains a Drive lookup error without changing properties (key: %s)', (key) => {
    const mailbox = loadMailbox({
      properties: { FOLDER_ID: TEST_FOLDER_ID, ...(key === undefined ? {} : { MAILBOX_KEY: key }) },
    });
    const originalProperties = new Map(mailbox.world.properties);
    const failure = new Error('Service error: Drive');
    mailbox.world.nextGetFolderByIdFailure = { thrown: failure };
    expect(() => mailbox.setup()).toThrow('Could not open the Capture folder (FOLDER_ID ' + TEST_FOLDER_ID +
      '): Service error: Drive. Nothing was changed. If this keeps happening, check FOLDER_ID in Project Settings > Script Properties.');
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.sleepDurations).toEqual([]);
  });

  it.each([
    'Invalid argument: id',
    'Unexpected error while getting the method or property getFolderById on object DriveApp.',
    'Folder NOT FOUND.',
  ])('reports a folder lookup error instead of replacing the folder: %s', (message) => {
    const mailbox = loadMailbox({ properties: { FOLDER_ID: 'wrong-folder-id' } });
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextGetFolderByIdFailure = { thrown: new Error(message) };

    expect(() => mailbox.setup()).toThrow('Could not open the Capture folder (FOLDER_ID wrong-folder-id): ' + message);
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.sleepDurations).toEqual([]);
  });

  it('reports an isTrashed() error without changing anything', () => {
    const mailbox = loadMailbox({ properties: { FOLDER_ID: TEST_FOLDER_ID } });
    const originalProperties = new Map(mailbox.world.properties);
    mailbox.world.nextFolderIsTrashedFailure = { thrown: new Error('Service error: Drive') };

    expect(() => mailbox.setup()).toThrow('Could not open the Capture folder (FOLDER_ID ' + TEST_FOLDER_ID +
      '): Service error: Drive. Nothing was changed. If this keeps happening, check FOLDER_ID in Project Settings > Script Properties.');
    expect(mailbox.world.createdFolders).toEqual([]);
    expect(mailbox.world.properties).toEqual(originalProperties);
    expect(mailbox.world.sleepDurations).toEqual([]);
  });

  it('generates a different key for every mailbox', () => {
    const keys = new Set<string | undefined>();
    for (let i = 0; i < 5; i++) {
      const mailbox = loadMailbox(UNCONFIGURED);
      mailbox.setup();
      keys.add(mailbox.world.properties.get('MAILBOX_KEY'));
    }
    expect(keys.size).toBe(5);
  });
});

describe('rotateKey()', () => {
  it('stores and logs a new key, and the old key stops working', () => {
    const mailbox = loadMailbox();
    mailbox.rotateKey();

    const newKey = mailbox.world.properties.get('MAILBOX_KEY');
    expect(newKey).toMatch(KEY_PATTERN);
    expect(newKey).not.toBe(TEST_KEY);
    expect(mailbox.world.logs.join('\n')).toContain(newKey);

    expect(mailbox.send({ v: 1, action: 'ping', key: TEST_KEY }).body).toMatchObject({ error: 'unauthorized' });
    expect(mailbox.send({ v: 1, action: 'ping', key: newKey })).toEqual({ mimeType: 'JSON', body: { ok: true } });
  });

  it('gives a new key every time', () => {
    const mailbox = loadMailbox();
    mailbox.rotateKey();
    const first = mailbox.world.properties.get('MAILBOX_KEY');
    mailbox.rotateKey();
    expect(mailbox.world.properties.get('MAILBOX_KEY')).not.toBe(first);
  });

  it('leaves the folder and the size cap alone', () => {
    const mailbox = loadMailbox({
      properties: { MAILBOX_KEY: TEST_KEY, FOLDER_ID: TEST_FOLDER_ID, MAX_FILE_BYTES: '12345' },
    });
    mailbox.rotateKey();
    expect(mailbox.world.properties.get('FOLDER_ID')).toBe(TEST_FOLDER_ID);
    expect(mailbox.world.properties.get('MAX_FILE_BYTES')).toBe('12345');
    expect(mailbox.world.createdFolders).toEqual([]);
  });
});

describe('mailbox sources', () => {
  it('Code.gs holds no key, folder id, or deployment id', () => {
    const source = readMailboxFile('Code.gs');
    // Folder ids are 33 characters and deployment ids are longer; no identifier or string in Code.gs comes close.
    expect(source.match(/[A-Za-z0-9_-]{25,}/g) ?? []).toEqual([]);
    expect(source).not.toMatch(/script\.google\.com\/macros\/s\//);
  });

  it.each(['Code.gs', 'SETUP.md', 'tools/probe-size-limit.mjs'])('%s has no em dash', (file) => {
    expect(readMailboxFile(file)).not.toContain('\u2014');
  });

  it('appsscript.json selects V8, the Drive scope, and an anonymous web app that runs as the owner', () => {
    const manifest: unknown = JSON.parse(readMailboxFile('appsscript.json'));
    expect(manifest).toMatchObject({
      runtimeVersion: 'V8',
      oauthScopes: ['https://www.googleapis.com/auth/drive'],
      webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
    });
  });
});
