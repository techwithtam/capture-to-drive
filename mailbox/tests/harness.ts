// Loads mailbox/Code.gs into a node:vm context populated with fakes of the Apps Script
// services it may use (DriveApp, PropertiesService, CacheService, Utilities, ContentService,
// Logger). Code.gs is plain top-level functions, so nothing here imports or wraps it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

export const TEST_KEY = 'test-key';
export const TEST_FOLDER_ID = 'test-folder-id';

// CacheService documents 21600 s (6 h) as the largest allowed expiration.
const CACHE_MAX_TTL_SECONDS = 21_600;
const CACHE_DEFAULT_TTL_SECONDS = 600;

export interface FakeBlob {
  bytes: ArrayLike<number>;
  contentType: string;
  name: string;
}

export class FakeFile {
  description = '';
  trashed = false;

  constructor(
    readonly id: string,
    readonly blob: FakeBlob,
    private readonly world?: World,
  ) {}

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.blob.name;
  }

  getMimeType(): string {
    return this.blob.contentType;
  }

  setDescription(description: string): FakeFile {
    const failure = this.world?.nextSetDescriptionFailure;
    if (this.world && failure) {
      this.world.nextSetDescriptionFailure = null;
      throw failure.thrown;
    }
    if (typeof description !== 'string') {
      throw new Error('Invalid argument: description');
    }
    this.description = description;
    return this;
  }

  getDescription(): string {
    return this.description;
  }

  setTrashed(trashed: boolean): FakeFile {
    if (this.world?.setTrashedFails) {
      throw new Error('Service error: Drive');
    }
    if (typeof trashed !== 'boolean') {
      throw new Error('Invalid argument: trashed');
    }
    this.trashed = trashed;
    return this;
  }

  isTrashed(): boolean {
    return this.trashed;
  }
}

export class FakeFolder {
  readonly files: FakeFile[] = [];
  /** Set by a test to put the folder in the Drive trash. */
  trashed = false;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly world: World,
  ) {}

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getUrl(): string {
    return `https://drive.google.com/drive/folders/${this.id}`;
  }

  isTrashed(): boolean {
    const failure = this.world.nextFolderIsTrashedFailure;
    if (failure) {
      this.world.nextFolderIsTrashedFailure = null;
      throw failure.thrown;
    }
    return this.trashed;
  }

  createFile(blob: FakeBlob): FakeFile {
    const failure = this.world.nextCreateFileFailure;
    if (failure) {
      this.world.nextCreateFileFailure = null;
      throw failure.thrown;
    }
    const file = new FakeFile(`file-${this.world.fileCounter++}`, blob, this.world);
    this.files.push(file);
    return file;
  }
}

export class FakeTextOutput {
  private mimeType: string | null = null;

  constructor(private readonly text: string) {}

  setMimeType(mimeType: string): FakeTextOutput {
    this.mimeType = mimeType;
    return this;
  }

  getContent(): string {
    return this.text;
  }

  getMimeType(): string | null {
    return this.mimeType;
  }
}

/** Everything the fakes record, so tests can assert on side effects. */
export interface World {
  properties: Map<string, string>;
  cache: Map<string, { value: string; ttlSeconds: number }>;
  folders: Map<string, FakeFolder>;
  /** Folders created through DriveApp.createFolder (what setup() does). */
  createdFolders: FakeFolder[];
  logs: string[];
  /** Pauses requested through Utilities.sleep, in milliseconds. The fake does not wait. */
  sleepDurations: number[];
  /** Number of DriveApp calls, so tests can prove an action never touched Drive. */
  driveCalls: number;
  fileCounter: number;
  /** One-shot: the next DriveApp.getFolderById call throws `thrown`, then it clears itself. */
  nextGetFolderByIdFailure: { thrown: unknown } | null;
  /** One-shot: the next Folder.isTrashed call throws `thrown`, then it clears itself. */
  nextFolderIsTrashedFailure: { thrown: unknown } | null;
  /** One-shot: the next createFile call throws `thrown` (any value), then it clears itself. */
  nextCreateFileFailure: { thrown: unknown } | null;
  /** When true, CacheService.put throws, as it does when the cache service is unavailable. */
  cachePutFails: boolean;
  /** One-shot: the next File.setDescription call throws `thrown`, then it clears itself. */
  nextSetDescriptionFailure: { thrown: unknown } | null;
  /** When true, File.setTrashed throws. */
  setTrashedFails: boolean;
}

export interface LoadOptions {
  /** Initial Script Properties. Defaults to a configured mailbox (key and folder id set). */
  properties?: Record<string, string>;
  /** Folder ids that already exist in the fake Drive. Defaults to the configured folder. */
  existingFolders?: string[];
  /** Overrides the text of Code.gs, for harness tests. */
  source?: string;
}

/** A mailbox that has never run setup(): no Script Properties and no Capture folder. */
export const UNCONFIGURED: LoadOptions = { properties: {}, existingFolders: [] };

export interface ParsedResponse {
  mimeType: string | null;
  body: Record<string, unknown>;
}

export interface Mailbox {
  world: World;
  /** Calls doPost with a web app event whose body is the JSON encoding of `request`. */
  send(request: unknown): ParsedResponse;
  /** Calls doPost with `contents` as the raw POST body. */
  sendRaw(contents: string): ParsedResponse;
  /** Calls doPost with an arbitrary event object (for events without postData). */
  sendEvent(event: unknown): ParsedResponse;
  doGet(): ParsedResponse;
  setup(): void;
  rotateKey(): void;
}

type AppsScriptFunction = (...args: unknown[]) => unknown;

export function loadMailbox(options: LoadOptions = {}): Mailbox {
  const world: World = {
    properties: new Map(
      Object.entries(options.properties ?? { MAILBOX_KEY: TEST_KEY, FOLDER_ID: TEST_FOLDER_ID }),
    ),
    cache: new Map(),
    folders: new Map(),
    createdFolders: [],
    logs: [],
    sleepDurations: [],
    driveCalls: 0,
    fileCounter: 1,
    nextGetFolderByIdFailure: null,
    nextFolderIsTrashedFailure: null,
    nextCreateFileFailure: null,
    cachePutFails: false,
    nextSetDescriptionFailure: null,
    setTrashedFails: false,
  };
  for (const id of options.existingFolders ?? [TEST_FOLDER_ID]) {
    world.folders.set(id, new FakeFolder(id, 'Capture', world));
  }

  const sandbox = createContext({
    DriveApp: createDriveApp(world),
    PropertiesService: createPropertiesService(world),
    CacheService: createCacheService(world),
    Utilities: createUtilities(world),
    ContentService: createContentService(),
    Logger: { log: (message: unknown): void => void world.logs.push(String(message)) },
  });
  runInContext(options.source ?? readFileSync(new URL('../Code.gs', import.meta.url), 'utf8'), sandbox, {
    filename: 'Code.gs',
  });

  function lookup(name: string): AppsScriptFunction {
    const value: unknown = Reflect.get(sandbox, name);
    if (typeof value !== 'function') {
      throw new Error(`Code.gs does not define ${name}()`);
    }
    return value as AppsScriptFunction;
  }

  function parse(output: unknown): ParsedResponse {
    if (!(output instanceof FakeTextOutput)) {
      throw new Error('Expected a ContentService text output');
    }
    const body: unknown = JSON.parse(output.getContent());
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Expected the response body to be a JSON object');
    }
    return { mimeType: output.getMimeType(), body: Object.fromEntries(Object.entries(body)) };
  }

  function sendEvent(event: unknown): ParsedResponse {
    return parse(lookup('doPost')(event));
  }

  function sendRaw(contents: string): ParsedResponse {
    return sendEvent({
      postData: { contents, length: contents.length, name: 'postData', type: 'text/plain' },
    });
  }

  return {
    world,
    send: (request) => sendRaw(JSON.stringify(request)),
    sendRaw,
    sendEvent,
    doGet: () => parse(lookup('doGet')({ parameter: {} })),
    setup: () => void lookup('setup')(),
    rotateKey: () => void lookup('rotateKey')(),
  };
}

function createDriveApp(world: World) {
  return {
    getFolderById(id: string): FakeFolder {
      world.driveCalls++;
      const failure = world.nextGetFolderByIdFailure;
      if (failure) {
        world.nextGetFolderByIdFailure = null;
        throw failure.thrown;
      }
      const folder = world.folders.get(id);
      if (!folder) {
        throw new Error(`No item with the given ID could be found: ${id}`);
      }
      return folder;
    },
    createFolder(name: string): FakeFolder {
      world.driveCalls++;
      const folder = new FakeFolder(`created-folder-${world.folders.size + 1}`, name, world);
      world.folders.set(folder.id, folder);
      world.createdFolders.push(folder);
      return folder;
    },
  };
}

function createPropertiesService(world: World) {
  const scriptProperties = {
    getProperty: (key: string): string | null => world.properties.get(key) ?? null,
    setProperty(key: string, value: string) {
      if (typeof value !== 'string') {
        throw new Error('Invalid argument: value');
      }
      world.properties.set(key, value);
      return scriptProperties;
    },
  };
  return { getScriptProperties: () => scriptProperties };
}

function createCacheService(world: World) {
  const scriptCache = {
    get: (key: string): string | null => world.cache.get(key)?.value ?? null,
    put(key: string, value: string, ttlSeconds: number = CACHE_DEFAULT_TTL_SECONDS): void {
      if (world.cachePutFails) {
        throw new Error('Service error: Cache');
      }
      if (typeof key !== 'string' || key.length === 0 || key.length > 250) {
        throw new Error('Invalid argument: key');
      }
      if (typeof value !== 'string') {
        throw new Error('Invalid argument: value');
      }
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > CACHE_MAX_TTL_SECONDS) {
        throw new Error('Invalid argument: expirationInSeconds');
      }
      world.cache.set(key, { value, ttlSeconds });
    },
  };
  return { getScriptCache: () => scriptCache };
}

function createUtilities(world: World) {
  return {
    sleep: (milliseconds: number): void => void world.sleepDurations.push(milliseconds),
    // Apps Script returns signed bytes (-128..127), so the fake does too.
    base64Decode: (data: string): Int8Array => new Int8Array(Buffer.from(data, 'base64')),
    newBlob(data: ArrayLike<number>, contentType: string, name: string): FakeBlob {
      if (typeof contentType !== 'string' || typeof name !== 'string') {
        throw new Error('Invalid argument: newBlob(data, contentType, name)');
      }
      return { bytes: data, contentType, name };
    },
    getUuid: (): string => randomUUID(),
  };
}

function createContentService() {
  return {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput: (text: string): FakeTextOutput => new FakeTextOutput(text),
  };
}

/** Files saved into a folder of the fake Drive (the configured folder by default), trashed ones included. */
export function filesIn(world: World, folderId: string = TEST_FOLDER_ID): FakeFile[] {
  return world.folders.get(folderId)?.files ?? [];
}

/** Files in a folder that are not in the trash: what the user sees in Drive. */
export function liveFilesIn(world: World, folderId: string = TEST_FOLDER_ID): FakeFile[] {
  return filesIn(world, folderId).filter((file) => !file.isTrashed());
}

export function toBase64(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64');
}

/** The bytes of a saved file as unsigned bytes, to compare with what the test sent. */
export function bytesOf(file: FakeFile): Buffer {
  return Buffer.from(Uint8Array.from(file.blob.bytes));
}

/** A valid save request. Pass `undefined` for a field to leave it out of the JSON body. */
export function saveRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    action: 'save',
    key: TEST_KEY,
    captureId: 'capture-1',
    filename: '2026-10-07 13.42 Alex - example.com - Receipt.pdf',
    mimeType: 'application/pdf',
    description: 'Note: for taxes\nCapture ID: capture-1',
    data: toBase64('hello'),
    ...overrides,
  };
}
