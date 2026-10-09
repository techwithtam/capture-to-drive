/**
 * Capture to Drive: Apps Script mailbox.
 *
 * Deployed once as a Web app (Execute as: Me, Who has access: Anyone). The browser extensions POST
 * captures here; the secret key in Script Properties is the only access control. This script can only
 * add files to one Drive folder. It has no way to read, list, update, or delete anything, except that it
 * trashes a file it has just created when that file could not be completed (so a retry leaves one copy).
 *
 * Script Properties (never stored in this file):
 *   MAILBOX_KEY     Shared secret. Created by setup(), replaced by rotateKey().
 *   FOLDER_ID       Drive ID of the Capture folder. Created by setup().
 *   MAX_FILE_BYTES  Optional. Largest decoded file accepted. Defaults to 20 MB.
 *
 * Contract (spec section 7.3): POST text/plain with a JSON body. Every response is JSON:
 *   { ok: true }                                         ping
 *   { ok: true, fileId, name, duplicate }                save
 *   { ok: false, error, message }                        error is one of: unauthorized, bad_request,
 *                                                        too_large, server_error, not_found
 *
 * Trailing underscores mark helpers, which keeps them out of the editor's Run menu.
 */

const PROTOCOL_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CACHE_SECONDS = 21600; // 6 hours, the longest CacheService allows
const FOLDER_NAME = 'Capture';
const MAX_MESSAGE_LENGTH = 200;
const REQUIRED_SAVE_FIELDS = ['captureId', 'filename', 'mimeType', 'data'];

// server_error messages the extension shows after repeated failures. The code stays server_error (the upload keeps
// retrying); the message tells the person what to fix.
const STORAGE_FULL_MESSAGE = 'Drive storage is full.';
const FOLDER_MISSING_MESSAGE = 'The Capture folder is missing. Run setup() again.';
const FOLDER_TRASHED_MESSAGE = "The Capture folder is in Drive's Trash. Restore it, then press Retry.";
// How Drive words a full account ("The user's Drive storage quota has been exceeded."). Rate limits such as
// "Limit Exceeded: DriveApp." pass by themselves and keep their own message.
const STORAGE_FULL_PATTERN = /storage quota (?:has been )?exceeded/i;
// DriveApp: "No item with the given ID could be found, or you do not have permission to access it."
const FOLDER_NOT_FOUND_PATTERN = /no item with the given id|do not have permission/i;

/** Anything that opens the /exec URL in a browser sees only this. */
function doGet() {
  return jsonResponse_({ ok: false, error: 'not_found' });
}

function doPost(e) {
  try {
    return handlePost_(e);
  } catch (err) {
    const message = errorMessage_(err);
    Logger.log('doPost failed: ' + message);
    return errorResponse_('server_error', STORAGE_FULL_PATTERN.test(message) ? STORAGE_FULL_MESSAGE : message);
  }
}

/**
 * Run from the editor as the account that deployed the mailbox. Creates a missing folder or key, then logs both.
 * Keeps a folder in Drive's Trash. Retries a not-found lookup once before replacing the folder and logging its old ID.
 * Other Drive lookup errors stop setup before any properties change and explain how to check FOLDER_ID.
 */
function setup() {
  const properties = PropertiesService.getScriptProperties();

  const existingFolderId = properties.getProperty('FOLDER_ID');
  let lookup;
  try {
    lookup = lookupCaptureFolder_();
    if (lookup.status === 'not_found') {
      Utilities.sleep(1500);
      lookup = lookupCaptureFolder_();
    }
  } catch (err) {
    const message = errorMessage_(err);
    throw new Error('Could not open the Capture folder (FOLDER_ID ' + existingFolderId + '): ' + message +
      (message.endsWith('.') ? ' ' : '. ') + 'Nothing was changed. If this keeps happening, check FOLDER_ID ' +
      'in Project Settings > Script Properties.');
  }
  let folder = lookup.folder;
  if (lookup.status === 'unset' || lookup.status === 'not_found') {
    folder = DriveApp.createFolder(FOLDER_NAME);
    properties.setProperty('FOLDER_ID', folder.getId());
    if (lookup.status === 'not_found') {
      Logger.log('The old Capture folder (ID ' + existingFolderId + ') could not be opened, so a new one was made. ' +
        "Copy the ID first. If you lose it, it is the part of the old folder's Drive URL after /folders/.");
      Logger.log('If you ran setup() in the wrong account: sign in as the Google account that deployed the mailbox, ' +
        'set FOLDER_ID back to that ID in Project Settings > Script Properties, then press Retry in the extension popup. ' +
        'Do not run setup() again.');
      Logger.log('Optional, wrong account only: delete the extra empty Capture folder (the Capture folder: line below). ' +
        'Do not delete the one that holds your files.');
      Logger.log('If you used the right account and the old folder was deleted, nothing more is needed. ' +
        'Press Retry in the extension popup.');
    }
  } else if (lookup.status === 'trashed') {
    Logger.log("The Capture folder is in Drive's Trash: " + folder.getUrl() +
      '. Restore it (Drive > Trash > right-click > Restore), then press Retry in the extension popup. ' +
      'If Capture is not listed, a folder that contains it may be in Trash. Restore that folder instead. The folder ID was kept.');
  }

  let key = properties.getProperty('MAILBOX_KEY');
  if (!key) {
    key = generateKey_();
    properties.setProperty('MAILBOX_KEY', key);
  }

  Logger.log('Mailbox key: ' + key);
  Logger.log('Capture folder: ' + folder.getUrl());
}

/** Run from the editor if the key ever leaks. Every extension then needs the new key in its Settings. */
function rotateKey() {
  const key = generateKey_();
  PropertiesService.getScriptProperties().setProperty('MAILBOX_KEY', key);
  Logger.log('New mailbox key: ' + key);
  Logger.log('The old key no longer works. Paste the new key into Settings in every extension.');
}

function handlePost_(e) {
  const request = parseRequest_(e);
  if (request === null) {
    return errorResponse_('bad_request', 'Request body must be a JSON object.');
  }
  if (request.v !== PROTOCOL_VERSION) {
    return errorResponse_('bad_request', 'Unsupported protocol version.');
  }
  if (!isAuthorized_(request.key)) {
    return errorResponse_('unauthorized', 'Mailbox key was rejected.');
  }

  if (request.action === 'ping') {
    return jsonResponse_({ ok: true });
  }
  if (request.action === 'save') {
    return saveFile_(request);
  }
  return errorResponse_('bad_request', 'Unknown action.');
}

/** Returns the parsed JSON object, or null when the body is missing, malformed, or not an object. */
function parseRequest_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(e.postData.contents);
  } catch (err) {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

/** Fails closed: a missing, empty, or non-string key never matches, even when MAILBOX_KEY is unset. */
function isAuthorized_(providedKey) {
  const expectedKey = PropertiesService.getScriptProperties().getProperty('MAILBOX_KEY');
  if (!expectedKey || typeof providedKey !== 'string' || providedKey.length === 0) {
    return false;
  }
  return constantTimeEquals_(providedKey, expectedKey);
}

/** Compares every character so the time taken does not reveal how much of a guess was right. */
function constantTimeEquals_(a, b) {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

function saveFile_(request) {
  for (let i = 0; i < REQUIRED_SAVE_FIELDS.length; i++) {
    const field = REQUIRED_SAVE_FIELDS[i];
    if (typeof request[field] !== 'string' || request[field].length === 0) {
      return errorResponse_('bad_request', 'Missing or invalid field: ' + field + '.');
    }
  }
  const description = request.description === undefined || request.description === null ? '' : request.description;
  if (typeof description !== 'string') {
    return errorResponse_('bad_request', 'Invalid field: description.');
  }

  // A retry that follows a request that actually succeeded must not create a second file.
  const cache = CacheService.getScriptCache();
  const existingFileId = cache.get(request.captureId);
  if (existingFileId) {
    return jsonResponse_({ ok: true, fileId: existingFileId, duplicate: true });
  }

  const bytes = Utilities.base64Decode(request.data);
  const maxFileBytes = getMaxFileBytes_();
  if (bytes.length > maxFileBytes) {
    return errorResponse_('too_large', 'File is larger than the limit of ' + maxFileBytes + ' bytes.');
  }

  const lookup = lookupCaptureFolder_();
  if (lookup.status === 'trashed') {
    return errorResponse_('server_error', FOLDER_TRASHED_MESSAGE);
  }
  if (lookup.status !== 'ok') {
    return errorResponse_('server_error', FOLDER_MISSING_MESSAGE);
  }
  const folder = lookup.folder;
  const file = folder.createFile(Utilities.newBlob(bytes, request.mimeType, request.filename));
  try {
    file.setDescription(description);
  } catch (err) {
    // A file without its description is incomplete, and the server_error below makes the extension retry, which
    // creates a complete one. Trash this copy so the folder never keeps an undescribed duplicate.
    try {
      file.setTrashed(true);
    } catch (trashErr) {
      Logger.log('Could not trash an incomplete file: ' + errorMessage_(trashErr));
    }
    throw err;
  }

  // The file is complete now. If the cache write fails, report success anyway: a server_error here
  // would make the extension retry and create a second copy.
  try {
    cache.put(request.captureId, file.getId(), CACHE_SECONDS);
  } catch (err) {
    Logger.log('Could not record the capture for duplicate detection: ' + errorMessage_(err));
  }

  return jsonResponse_({ ok: true, fileId: file.getId(), name: file.getName(), duplicate: false });
}

/** Distinguishes unset, not_found, trashed, and ok. Other Drive errors pass to the caller unchanged. */
function lookupCaptureFolder_() {
  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId) {
    return { status: 'unset' };
  }
  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (err) {
    const message = errorMessage_(err);
    if (!FOLDER_NOT_FOUND_PATTERN.test(message)) {
      throw err;
    }
    Logger.log('Could not open the Capture folder: ' + message);
    return { status: 'not_found' };
  }
  return { status: folder.isTrashed() ? 'trashed' : 'ok', folder: folder };
}

function getMaxFileBytes_() {
  const configured = Number(PropertiesService.getScriptProperties().getProperty('MAX_FILE_BYTES'));
  return isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_BYTES;
}

/** 64 hex characters from two UUIDs: easy to paste, safe in JSON, and not guessable. */
function generateKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function errorMessage_(err) {
  const text = String(err && err.message ? err.message : err);
  return text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
}

function errorResponse_(error, message) {
  return jsonResponse_({ ok: false, error: error, message: message });
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
