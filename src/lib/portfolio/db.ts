import { descendantFolderIds, normalizeFolderView, normalizeFolders, normalizeMeta, normalizeTag, normalizeTagFolder, sortByOrder } from "./logic.ts";
import type { AppStorageUsage, BrowserStorageUsage, StorageSnapshot } from "./storage-usage.ts";
import type { Folder, FolderView, ImageMeta, Tag, TagFolder } from "./types.ts";
import type { BackupSetting, BackupView, LibraryDump, ParsedBackup } from "./backup.ts";
import { CANVAS_BOARD_ID, CANVAS_FLAT_PREFIX, CANVAS_PLACEMENTS_KEY, canvasFlatId, isCanvasInkId, parsePlacements } from "./canvas.ts";
import { batchImageIndexes, RestoreFailure } from "./backup.ts";

/**
 * Pixel bytes live only in IndexedDB (`imageBlobs`).
 * Names, order, and dimensions live in `imageMeta`.
 * localStorage is intentionally unused — image bodies must not go there.
 */

const DB_VERSION = 6;

/** Tab 1 keeps the original names. Tabs 2 and 3 have their own swap pairs. */
const TAB_SLOTS = {
  1: ["komacho", "komacho-b"],
  2: ["komacho-2", "komacho-2b"],
  3: ["komacho-3", "komacho-3b"],
} as const;

const LIVE_KEYS = {
  1: "komacho-library-db",
  2: "komacho-library-db-2",
  3: "komacho-library-db-3",
} as const;

const RETIRE_KEYS = {
  1: "komacho-drop-db",
  2: "komacho-drop-db-2",
  3: "komacho-drop-db-3",
} as const;

const SELECTED_TAB_KEY = "komacho-library-tab";

export type LibraryTab = 1 | 2 | 3;

export function normalizeLibraryTab(value: unknown): LibraryTab {
  if (value === 2 || value === "2") return 2;
  if (value === 3 || value === "3") return 3;
  return 1;
}

export function libraryDbSlots(tab: LibraryTab = 1): readonly [string, string] {
  return TAB_SLOTS[normalizeLibraryTab(tab)];
}

export function libraryLiveKey(tab: LibraryTab = 1): string {
  return LIVE_KEYS[normalizeLibraryTab(tab)];
}

export function libraryRetireKey(tab: LibraryTab = 1): string {
  return RETIRE_KEYS[normalizeLibraryTab(tab)];
}

export type LibrarySlotPlan = {
  tab: LibraryTab;
  live: string;
  swap: string;
  liveKey: string;
  retireKey: string;
  slots: readonly [string, string];
};

function readStorage(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Which database is live, and which empty slot a restore may replace, for one tab. */
export function librarySlotPlan(tab: LibraryTab = 1): LibrarySlotPlan {
  const target = normalizeLibraryTab(tab);
  const slots = TAB_SLOTS[target];
  const saved = readStorage(LIVE_KEYS[target]);
  const live = saved === slots[0] || saved === slots[1] ? saved : slots[0];
  return {
    tab: target,
    live,
    swap: live === slots[0] ? slots[1] : slots[0],
    liveKey: LIVE_KEYS[target],
    retireKey: RETIRE_KEYS[target],
    slots,
  };
}

let phoneSurface = false;
let heldLibraryName: string | null = null;
let writesOpen = true;
let userWrites = true;
let connectionEpoch = 0;
let writeDepth = 0;
const writeWaiters: (() => void)[] = [];

/** Phone layout reads tab 1. It does not change the saved PC tab. */
export function setLibraryPhoneSurface(phone: boolean): void {
  phoneSurface = phone;
}

export function libraryPhoneSurface(): boolean {
  return phoneSurface;
}

/** The tab whose database should be open. Phone always uses tab 1. */
export function activeLibraryTab(): LibraryTab {
  return phoneSurface ? 1 : selectedLibraryTab();
}

export function rememberLibraryTab(tab: LibraryTab): void {
  const next = normalizeLibraryTab(tab);
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SELECTED_TAB_KEY, String(next));
  } catch {
    /* private mode */
  }
}

/**
 * Database opened for ordinary reads and writes.
 * A switch can hold the previous name until its writes have finished.
 * Restore still chooses its own pair through `librarySlotPlan`.
 */
export function libraryDbName(): string {
  return heldLibraryName ?? librarySlotPlan(activeLibraryTab()).live;
}

export function holdLibraryName(name: string | null): void {
  heldLibraryName = name;
}

export function suspendLibraryWrites(): void {
  writesOpen = false;
}

export function resumeLibraryWrites(): void {
  writesOpen = true;
}

/** User actions may write. A tab switch turns this off so a late save cannot land in the next library. */
export function userWritesOpen(): boolean {
  return userWrites;
}

export function setUserWritesOpen(open: boolean): void {
  userWrites = open;
}

/**
 * Waits until readwrite transactions, and the next save those transactions schedule, have finished.
 * The held database name stays in place while this runs.
 */
export async function drainLibraryWrites(): Promise<void> {
  for (let turn = 0; turn < 10000; turn += 1) {
    await writesSettled();
    if (writeDepth !== 0) continue;
    await Promise.resolve();
    if (writeDepth === 0) return;
  }
}

export function libraryConnectionEpoch(): number {
  return connectionEpoch;
}

/** Saved PC tab. Unset or invalid values are tab 1. Phone layout does not read this. */
export function selectedLibraryTab(): LibraryTab {
  return normalizeLibraryTab(readStorage(SELECTED_TAB_KEY));
}

/**
 * A name recorded for later deletion. Only the inactive slot of this same tab qualifies.
 * Another tab's database, or the live database, is never returned.
 */
export function retiredDbToDelete(tab: LibraryTab, stored: string | null, live: string): string | null {
  if (!stored) return null;
  const slots = libraryDbSlots(tab);
  if (stored !== slots[0] && stored !== slots[1]) return null;
  if (stored === live) return null;
  return stored;
}

type BlobRow = {
  id: string;
  original: Blob;
  thumb: Blob | null;
};

type InkRow = {
  id: string;
  png: Blob;
};

type KvRow = {
  key: string;
  value: number | string;
};

let dbPromise: Promise<IDBDatabase> | null = null;
let boundName: string | null = null;
const openedFresh = new WeakMap<IDBDatabase, boolean>();

function trackWrite(tx: IDBTransaction): void {
  if (typeof tx.addEventListener !== "function") return;
  writeDepth += 1;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    writeDepth -= 1;
    if (writeDepth === 0) {
      const waiting = writeWaiters.splice(0);
      for (const resolve of waiting) resolve();
    }
  };
  tx.addEventListener("complete", done);
  tx.addEventListener("abort", done);
  tx.addEventListener("error", done);
}

function openWrite(db: IDBDatabase, stores: string | string[]): IDBTransaction {
  const tx = db.transaction(stores, "readwrite");
  trackWrite(tx);
  return tx;
}

/** Resolves when readwrite transactions that already started have finished. */
export function writesSettled(): Promise<void> {
  if (writeDepth === 0) return Promise.resolve();
  return new Promise((resolve) => writeWaiters.push(resolve));
}

export async function closeLibraryConnection(): Promise<void> {
  connectionEpoch += 1;
  const pending = dbPromise;
  dbPromise = null;
  boundName = null;
  if (!pending) return;
  try {
    const db = await pending;
    db.close();
  } catch {
    /* the open failed or was already closed */
  }
}

function upgradeLibrary(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains("imageMeta")) {
    const meta = db.createObjectStore("imageMeta", { keyPath: "id" });
    meta.createIndex("byOrder", "order");
  }
  if (!db.objectStoreNames.contains("imageBlobs")) {
    db.createObjectStore("imageBlobs", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("kv")) {
    db.createObjectStore("kv", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("folders")) {
    db.createObjectStore("folders", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("folderViews")) {
    db.createObjectStore("folderViews", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("tags")) {
    db.createObjectStore("tags", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("tagFolders")) {
    db.createObjectStore("tagFolders", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("imageInk")) {
    db.createObjectStore("imageInk", { keyPath: "id" });
  }
}

function openNamed(name: string, track: boolean): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    let created = false;
    request.onupgradeneeded = (event) => {
      created = (event as IDBVersionChangeEvent).oldVersion === 0;
      upgradeLibrary(request.result);
    };
    request.onsuccess = () => {
      const db = request.result;
      openedFresh.set(db, created);
      db.onversionchange = () => {
        db.close();
        if (track) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    request.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

function getDb(): Promise<IDBDatabase> {
  if (!writesOpen) return Promise.reject(new Error("library-changed"));
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB unavailable"));
  }
  const wanted = libraryDbName();
  const epoch = connectionEpoch;
  if (!dbPromise || boundName !== wanted) {
    if (dbPromise) {
      const stale = dbPromise;
      dbPromise = null;
      boundName = null;
      void stale.then((db) => db.close()).catch(() => undefined);
    }
    boundName = wanted;
    dbPromise = openNamed(wanted, true)
      .then((db) => {
        if (epoch !== connectionEpoch || libraryDbName() !== wanted) {
          db.close();
          throw new Error("library-changed");
        }
        return db;
      })
      .catch((error) => {
        if (boundName === wanted) {
          dbPromise = null;
          boundName = null;
        }
        throw error;
      });
  }
  return dbPromise.then((db) => {
    if (!writesOpen || epoch !== connectionEpoch || db.name !== wanted) {
      throw new Error("library-changed");
    }
    return db;
  });
}

export function allocateOrders(count: number): Promise<number> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (count <= 0) {
          resolve(0);
          return;
        }
        const tx = openWrite(db, "kv");
        const store = tx.objectStore("kv");
        const getReq = store.get("orderSeq");
        let start = 1;
        getReq.onsuccess = () => {
          const row = getReq.result as KvRow | undefined;
          const current = row && typeof row.value === "number" ? row.value : 0;
          start = current + 1;
          store.put({ key: "orderSeq", value: current + count } satisfies KvRow);
        };
        tx.oncomplete = () => resolve(start);
        tx.onerror = () => reject(tx.error ?? new Error("order allocate failed"));
        tx.onabort = () => reject(tx.error ?? new Error("order allocate aborted"));
      }),
  );
}

export function saveImage(meta: ImageMeta, original: Blob, thumb: Blob | null): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, ["imageMeta", "imageBlobs"]);
        tx.objectStore("imageMeta").put(meta);
        const row: BlobRow = { id: meta.id, original, thumb };
        tx.objectStore("imageBlobs").put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("save aborted"));
      }),
  );
}

export function deleteImage(id: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, ["imageMeta", "imageBlobs", "imageInk"]);
        tx.objectStore("imageMeta").delete(id);
        tx.objectStore("imageBlobs").delete(id);
        tx.objectStore("imageInk").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("delete aborted"));
      }),
  );
}

export function readInk(id: string): Promise<Blob | null> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("imageInk", "readonly");
        const req = tx.objectStore("imageInk").get(id);
        req.onsuccess = () => {
          const row = req.result as InkRow | undefined;
          resolve(row?.png instanceof Blob && row.png.size > 0 ? row.png : null);
        };
        req.onerror = () => reject(req.error ?? new Error("ink read failed"));
      }),
  );
}

export function saveInk(id: string, png: Blob): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "imageInk");
        tx.objectStore("imageInk").put({ id, png } satisfies InkRow);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("ink save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("ink save aborted"));
      }),
  );
}

export function deleteInk(id: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "imageInk");
        tx.objectStore("imageInk").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("ink delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("ink delete aborted"));
      }),
  );
}

export function listInkIds(): Promise<string[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("imageInk", "readonly");
        const req = tx.objectStore("imageInk").openCursor();
        const ids: string[] = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const row = cursor.value as InkRow;
          if (row && typeof row.id === "string" && !isCanvasInkId(row.id) && row.png instanceof Blob && row.png.size > 0) ids.push(row.id);
          cursor.continue();
        };
        tx.oncomplete = () => resolve(ids);
        tx.onerror = () => reject(tx.error ?? new Error("ink list failed"));
        tx.onabort = () => reject(tx.error ?? new Error("ink list aborted"));
      }),
  );
}

export function listPrefixedInkIds(prefix: string): Promise<string[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("imageInk", "readonly");
        const req = tx.objectStore("imageInk").openCursor();
        const ids: string[] = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const row = cursor.value as InkRow;
          if (row && typeof row.id === "string" && row.id.startsWith(prefix) && row.png instanceof Blob && row.png.size > 0) ids.push(row.id);
          cursor.continue();
        };
        tx.oncomplete = () => resolve(ids);
        tx.onerror = () => reject(tx.error ?? new Error("ink list failed"));
        tx.onabort = () => reject(tx.error ?? new Error("ink list aborted"));
      }),
  );
}

export function listMeta(): Promise<ImageMeta[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("imageMeta", "readonly");
        const req = tx.objectStore("imageMeta").getAll();
        req.onsuccess = () => {
          const rows = ((req.result as unknown[]) ?? [])
            .map((row) => normalizeMeta(row))
            .filter((row): row is ImageMeta => row !== null);
          resolve(sortByOrder(rows));
        };
        req.onerror = () => reject(req.error ?? new Error("list failed"));
      }),
  );
}

export function putMeta(meta: ImageMeta): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "imageMeta");
        tx.objectStore("imageMeta").put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("meta save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("meta save aborted"));
      }),
  );
}

export function writeMetaOrders(entries: { id: string; order: number }[]): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "imageMeta");
        const store = tx.objectStore("imageMeta");
        for (const entry of entries) {
          const req = store.get(entry.id);
          req.onsuccess = () => {
            const meta = normalizeMeta(req.result);
            if (!meta) return;
            store.put({ ...meta, order: entry.order });
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("order save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("order save aborted"));
      }),
  );
}

export function readKv(key: string, fallback: number): Promise<number> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const req = tx.objectStore("kv").get(key);
        req.onsuccess = () => {
          const value = (req.result as KvRow | undefined)?.value;
          resolve(typeof value === "number" ? value : fallback);
        };
        req.onerror = () => reject(req.error ?? new Error("setting read failed"));
      }),
  );
}

export function readColumns(): Promise<number> {
  return readKv("columns", 4);
}

export function readKvString(key: string, fallback: string): Promise<string> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const req = tx.objectStore("kv").get(key);
        req.onsuccess = () => {
          const value = (req.result as KvRow | undefined)?.value;
          resolve(typeof value === "string" && value ? value : fallback);
        };
        req.onerror = () => reject(req.error ?? new Error("setting read failed"));
      }),
  );
}

export function listFolders(): Promise<Folder[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("folders", "readonly");
        const req = tx.objectStore("folders").getAll();
        req.onsuccess = () => {
          resolve(normalizeFolders((req.result as unknown[]) ?? []));
        };
        req.onerror = () => reject(req.error ?? new Error("folder list failed"));
      }),
  );
}

export function putFolder(folder: Folder): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "folders");
        tx.objectStore("folders").put(folder);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("folder save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("folder save aborted"));
      }),
  );
}

export function deleteFolderRecord(id: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "folders");
        tx.objectStore("folders").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("folder delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("folder delete aborted"));
      }),
  );
}

export const INITIAL_FOLDER_NAME = "未分類";

/** Creates the first folder when needed and stamps older images without copying pixels. */
export async function ensureLibrary(items: ImageMeta[]): Promise<{ folders: Folder[]; items: ImageMeta[] }> {
  let folders = await listFolders();
  if (folders.length === 0) {
    const folder: Folder = {
      id: crypto.randomUUID(),
      name: INITIAL_FOLDER_NAME,
      order: 0,
      createdAt: Date.now(),
      parentId: null,
      isParent: false,
      color: null,
    };
    await putFolder(folder);
    folders = [folder];
  }
  const known = new Set(folders.map((folder) => folder.id));
  const fallback = folders[0]!.id;
  const next = items.map((item) =>
    item.folderId && known.has(item.folderId) ? item : { ...item, folderId: fallback },
  );
  for (let index = 0; index < next.length; index += 1) {
    if (next[index]!.folderId !== items[index]!.folderId) await putMeta(next[index]!);
  }
  return { folders, items: next };
}

export function listFolderViews(): Promise<Record<string, FolderView>> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("folderViews", "readonly");
        const req = tx.objectStore("folderViews").getAll();
        req.onsuccess = () => {
          const views: Record<string, FolderView> = {};
          for (const row of (req.result as { id?: string }[]) ?? []) {
            if (!row || typeof row.id !== "string" || !row.id) continue;
            views[row.id] = normalizeFolderView(row);
          }
          resolve(views);
        };
        req.onerror = () => reject(req.error ?? new Error("view list failed"));
      }),
  );
}

export function putFolderView(id: string, view: FolderView): Promise<void> {
  const row = { id, ...normalizeFolderView(view) };
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "folderViews");
        tx.objectStore("folderViews").put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("view save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("view save aborted"));
      }),
  );
}

export function deleteFolderView(id: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "folderViews");
        tx.objectStore("folderViews").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("view delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("view delete aborted"));
      }),
  );
}

export function listTagFolders(): Promise<TagFolder[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("tagFolders")) {
          resolve([]);
          return;
        }
        const tx = db.transaction("tagFolders", "readonly");
        const req = tx.objectStore("tagFolders").getAll();
        req.onsuccess = () => {
          const folders = ((req.result as unknown[]) ?? [])
            .map((row) => normalizeTagFolder(row))
            .filter((row): row is TagFolder => row !== null)
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
          resolve(folders);
        };
        req.onerror = () => reject(req.error ?? new Error("tag folder list failed"));
      }),
  );
}

export function putTagFolder(folder: TagFolder): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "tagFolders");
        tx.objectStore("tagFolders").put(folder);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("tag folder save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("tag folder save aborted"));
      }),
  );
}

export function deleteTagFolderRecord(id: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "tagFolders");
        tx.objectStore("tagFolders").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("tag folder delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("tag folder delete aborted"));
      }),
  );
}

/**
 * Deletes one tag folder, the tags that belong to it, and those tags on images.
 * One transaction: a failure leaves the previous records in place.
 */
export function deleteTagFolderTree(input: {
  folderId: string;
  tagIds: readonly string[];
  metas: readonly ImageMeta[];
  active: readonly string[] | null;
  hidden: readonly string[] | null;
}): Promise<void> {
  const stores = ["tagFolders", "tags", "imageMeta"];
  if (input.active || input.hidden) stores.push("kv");
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, stores);
        tx.objectStore("tagFolders").delete(input.folderId);
        for (const id of input.tagIds) tx.objectStore("tags").delete(id);
        for (const meta of input.metas) tx.objectStore("imageMeta").put(meta);
        if (input.active) tx.objectStore("kv").put({ key: "tag", value: JSON.stringify(input.active) } satisfies KvRow);
        if (input.hidden) tx.objectStore("kv").put({ key: "tagHidden", value: JSON.stringify(input.hidden) } satisfies KvRow);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("tag folder delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("tag folder delete aborted"));
      }),
  );
}

export function listTags(): Promise<Tag[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("tags", "readonly");
        const req = tx.objectStore("tags").getAll();
        req.onsuccess = () => {
          const tags = ((req.result as unknown[]) ?? [])
            .map((row) => normalizeTag(row))
            .filter((row): row is Tag => row !== null)
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
          resolve(tags);
        };
        req.onerror = () => reject(req.error ?? new Error("tag list failed"));
      }),
  );
}

export function putTag(tag: Tag): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "tags");
        tx.objectStore("tags").put(tag);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("tag save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("tag save aborted"));
      }),
  );
}

export function deleteTagRecord(id: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "tags");
        tx.objectStore("tags").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("tag delete failed"));
        tx.onabort = () => reject(tx.error ?? new Error("tag delete aborted"));
      }),
  );
}

export function writeKv(key: string, value: number | string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, "kv");
        tx.objectStore("kv").put({ key, value } satisfies KvRow);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("setting save failed"));
        tx.onabort = () => reject(tx.error ?? new Error("setting save aborted"));
      }),
  );
}

export async function measureAppStorage(): Promise<AppStorageUsage> {
  const db = await getDb();
  const originals = { bytes: 0, images: 0 };
  const thumbs = { bytes: 0 };
  await new Promise<void>((resolve, reject) => {
    if (!db.objectStoreNames.contains("imageBlobs")) {
      resolve();
      return;
    }
    const tx = db.transaction("imageBlobs", "readonly");
    const req = tx.objectStore("imageBlobs").openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const row = cursor.value as BlobRow;
      if (row.original instanceof Blob) {
        originals.bytes += row.original.size;
        originals.images += 1;
      }
      if (row.thumb instanceof Blob && row.thumb !== row.original) thumbs.bytes += row.thumb.size;
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("storage measure failed"));
    tx.onabort = () => reject(tx.error ?? new Error("storage measure aborted"));
  });
  const meta = await measureMetaBytes(db);
  return { originals: originals.bytes, thumbs: thumbs.bytes, meta, images: originals.images };
}

async function measureMetaBytes(db: IDBDatabase): Promise<number | null> {
  const names = ["imageMeta", "folders", "folderViews", "tags", "kv"].filter((name) => db.objectStoreNames.contains(name));
  if (names.length === 0) return null;
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction(names, "readonly");
    const found: unknown[] = [];
    let pending = names.length;
    for (const name of names) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => {
        const value = req.result;
        if (Array.isArray(value)) found.push(...value);
        pending -= 1;
        if (pending === 0) resolve(found);
      };
      req.onerror = () => reject(req.error ?? new Error("meta measure failed"));
    }
    tx.onerror = () => reject(tx.error ?? new Error("meta measure failed"));
    tx.onabort = () => reject(tx.error ?? new Error("meta measure aborted"));
  });
  try {
    return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
  } catch {
    return null;
  }
}

async function measureBrowserStorage(): Promise<BrowserStorageUsage> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return { usage: null, quota: null };
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === "number" ? estimate.usage : null,
      quota: typeof estimate.quota === "number" ? estimate.quota : null,
    };
  } catch {
    return { usage: null, quota: null };
  }
}

/** Reads stored sizes without writing or converting image data. */
export async function measureStorage(): Promise<StorageSnapshot> {
  const measuredAt = Date.now();
  const [app, browser] = await Promise.all([measureAppStorage().catch(() => null), measureBrowserStorage()]);
  return { measuredAt, app, browser };
}

function listKv(): Promise<BackupSetting[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const req = tx.objectStore("kv").getAll();
        req.onsuccess = () => {
          const settings = ((req.result as KvRow[]) ?? []).flatMap((row) =>
            row && typeof row.key === "string" && row.key && (typeof row.value === "string" || typeof row.value === "number")
              ? [{ key: row.key, value: row.value }]
              : [],
          );
          resolve(settings);
        };
        req.onerror = () => reject(req.error ?? new Error("setting list failed"));
      }),
  );
}

function listViewRows(): Promise<BackupView[]> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("folderViews", "readonly");
        const req = tx.objectStore("folderViews").getAll();
        req.onsuccess = () => {
          const views = ((req.result as { id?: string }[]) ?? []).flatMap((row) => {
            if (!row || typeof row.id !== "string" || !row.id) return [];
            return [{ id: row.id, ...normalizeFolderView(row) }];
          });
          resolve(views);
        };
        req.onerror = () => reject(req.error ?? new Error("view list failed"));
      }),
  );
}

/** Reads the library for a backup. Does not write or delete anything. */
export async function readLibraryDump(onProgress?: (done: number, total: number) => void): Promise<LibraryDump> {
  const db = await getDb();
  const [metas, folders, tags, tagFolders, views, settings] = await Promise.all([
    listMeta(),
    listFolders(),
    listTags(),
    listTagFolders(),
    listViewRows(),
    listKv(),
  ]);
  const wanted = new Set(metas.map((meta) => meta.id));
  const blobs = new Map<string, { original: Blob; thumb: Blob | null }>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("imageBlobs", "readonly");
    const req = tx.objectStore("imageBlobs").openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const row = cursor.value as BlobRow;
      if (row && wanted.has(row.id) && row.original instanceof Blob) {
        blobs.set(row.id, { original: row.original, thumb: row.thumb instanceof Blob ? row.thumb : null });
        onProgress?.(blobs.size, metas.length);
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("blob read failed"));
    tx.onabort = () => reject(tx.error ?? new Error("blob read aborted"));
  });
  const inks = new Map<string, Blob>();
  const flats = new Map<string, Blob>();
  const placementSetting = settings.find((setting) => setting.key === CANVAS_PLACEMENTS_KEY)?.value;
  const flatWanted = new Set(
    parsePlacements(typeof placementSetting === "string" ? placementSetting : "").flatMap((placement) => (placement.flat ? [placement.id] : [])),
  );
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("imageInk", "readonly");
    const req = tx.objectStore("imageInk").openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const row = cursor.value as InkRow;
      if (row && row.png instanceof Blob && row.png.size > 0 && typeof row.id === "string") {
        if (wanted.has(row.id)) inks.set(row.id, row.png);
        else if (row.id.startsWith(CANVAS_FLAT_PREFIX)) {
          const placementId = row.id.slice(CANVAS_FLAT_PREFIX.length);
          if (flatWanted.has(placementId)) flats.set(placementId, row.png);
        }
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("ink read failed"));
    tx.onabort = () => reject(tx.error ?? new Error("ink read aborted"));
  });
  return { metas, blobs, folders, views, tags, tagFolders, settings, inks, canvas: await readInk(CANVAS_BOARD_ID), flats };
}

export type RestoreProgress = {
  stage: "draft" | "save" | "check" | "switch";
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  elapsedMs: number;
};

function yieldUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deleteNamed(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (error) {
      reject(error);
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("indexedDB delete failed"));
    request.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

function deleteTabDatabase(tab: LibraryTab, name: string): Promise<void> {
  const slots = libraryDbSlots(tab);
  if (name !== slots[0] && name !== slots[1]) {
    return Promise.reject(new Error("このタブ以外の保存先は削除できません。"));
  }
  return deleteNamed(name);
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error("indexedDB failed"));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error ?? new Error("indexedDB aborted"));
  });
}

function countStore(db: IDBDatabase, name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const req = tx.objectStore(name).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("count failed"));
  });
}

async function ownBlob(source: Blob, type: string): Promise<Blob> {
  const bytes = await source.arrayBuffer();
  return new Blob([bytes], { type: type || source.type || "application/octet-stream" });
}

export type FolderCopySnapshot = {
  rootId: string;
  folders: Folder[];
  items: ImageMeta[];
  blobs: Map<string, { original: Blob; thumb: Blob | null }>;
  tags: Tag[];
  tagFolders: TagFolder[];
  views: Record<string, FolderView>;
  hiddenIds: string[];
};

function readStore<T>(db: IDBDatabase, name: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(name)) {
      resolve([]);
      return;
    }
    const tx = db.transaction(name, "readonly");
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("indexedDB read failed"));
  });
}

async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true;
  const listed = await indexedDB.databases();
  return listed.some((entry) => entry.name === name);
}

function hiddenIdsInBranch(raw: unknown, branch: ReadonlySet<string>): string[] {
  if (typeof raw !== "string" || !raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of parsed) {
      if (typeof id !== "string" || !branch.has(id) || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    return next;
  } catch {
    return [];
  }
}

/** Reads one folder tree from a tab without switching the open library. Bytes are copied out of IndexedDB. */
export async function readFolderCopySource(tab: LibraryTab, folderId: string): Promise<FolderCopySnapshot | null> {
  const plan = librarySlotPlan(tab);
  const same = plan.live === libraryDbName();
  if (!same && !(await databaseExists(plan.live))) return null;
  const db = same ? await getDb() : await openNamed(plan.live, false);
  let folderMissing = false;
  try {
    const [folderRows, itemRows, blobRows, tagRows, tagFolderRows, viewRows, settingRows] = await Promise.all([
      readStore<unknown>(db, "folders"),
      readStore<unknown>(db, "imageMeta"),
      readStore<{ id?: string; original?: Blob; thumb?: Blob | null }>(db, "imageBlobs"),
      readStore<unknown>(db, "tags"),
      readStore<unknown>(db, "tagFolders"),
      readStore<{ id?: string }>(db, "folderViews"),
      readStore<{ key?: string; value?: unknown }>(db, "kv"),
    ]);
    const folders = normalizeFolders(folderRows);
    if (!folders.some((folder) => folder.id === folderId)) {
      folderMissing = true;
      return null;
    }
    const branch = new Set([folderId, ...descendantFolderIds(folders, folderId)]);
    const items = itemRows.flatMap((row) => {
      const meta = normalizeMeta(row);
      return meta && branch.has(meta.folderId) ? [meta] : [];
    });
    const blobs = new Map<string, { original: Blob; thumb: Blob | null }>();
    const blobById = new Map(blobRows.filter((row) => typeof row.id === "string").map((row) => [row.id as string, row]));
    for (const item of items) {
      const row = blobById.get(item.id);
      if (!row?.original) continue;
      const original = await ownBlob(row.original, row.original.type || item.mime);
      const thumb = row.thumb instanceof Blob && row.thumb !== row.original ? await ownBlob(row.thumb, row.thumb.type || "image/jpeg") : null;
      blobs.set(item.id, { original, thumb });
    }
    const views: Record<string, FolderView> = {};
    for (const row of viewRows) {
      if (!row || typeof row.id !== "string" || !branch.has(row.id)) continue;
      views[row.id] = normalizeFolderView(row);
    }
    return {
      rootId: folderId,
      folders: folders.filter((folder) => branch.has(folder.id)),
      items,
      blobs,
      tags: tagRows.flatMap((row) => {
        const tag = normalizeTag(row);
        return tag ? [tag] : [];
      }),
      tagFolders: tagFolderRows.flatMap((row) => {
        const folder = normalizeTagFolder(row);
        return folder ? [folder] : [];
      }),
      views,
      hiddenIds: hiddenIdsInBranch(settingRows.find((row) => row.key === "folderHidden")?.value, branch),
    };
  } finally {
    if (!same) {
      const fresh = openedFresh.get(db) === true;
      db.close();
      if (folderMissing && fresh) await deleteTabDatabase(tab, plan.live).catch(() => undefined);
    }
  }
}

/** Writes a prepared copy in one transaction. A failure leaves none of it behind. */
export function commitFolderCopy(input: {
  folders: Folder[];
  views: { id: string; view: FolderView }[];
  tags: Tag[];
  tagFolders: TagFolder[];
  images: { meta: ImageMeta; original: Blob; thumb: Blob | null }[];
  promoted: Folder | null;
  selectId: string;
  hiddenIds?: string[] | null;
}): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = openWrite(db, ["folders", "folderViews", "tags", "tagFolders", "imageMeta", "imageBlobs", "kv"]);
        if (input.promoted) tx.objectStore("folders").put(input.promoted);
        for (const folder of input.folders) tx.objectStore("folders").put(folder);
        for (const view of input.views) tx.objectStore("folderViews").put({ id: view.id, ...normalizeFolderView(view.view) });
        for (const folder of input.tagFolders) tx.objectStore("tagFolders").put(folder);
        for (const tag of input.tags) tx.objectStore("tags").put(tag);
        for (const image of input.images) {
          tx.objectStore("imageMeta").put(image.meta);
          tx.objectStore("imageBlobs").put({ id: image.meta.id, original: image.original, thumb: image.thumb } satisfies BlobRow);
        }
        tx.objectStore("kv").put({ key: "folder", value: input.selectId } satisfies KvRow);
        if (input.hiddenIds) tx.objectStore("kv").put({ key: "folderHidden", value: JSON.stringify(input.hiddenIds) } satisfies KvRow);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("folder copy failed"));
        tx.onabort = () => reject(tx.error ?? new Error("folder copy aborted"));
      }),
  );
}

/** Drops a retired slot only when the reserved name belongs to that same tab. */
export function releaseRetiredLibrary(): void {
  if (typeof localStorage === "undefined" || typeof indexedDB === "undefined") return;
  for (const tab of [1, 2, 3] as const) releaseRetiredTab(tab);
}

function releaseRetiredTab(tab: LibraryTab): void {
  const plan = librarySlotPlan(tab);
  let drop = "";
  try {
    drop = localStorage.getItem(plan.retireKey) ?? "";
    if (!drop) return;
    const target = retiredDbToDelete(tab, drop, plan.live);
    localStorage.removeItem(plan.retireKey);
    if (!target) return;
    void deleteTabDatabase(tab, target).catch(() => {
      try {
        localStorage.setItem(plan.retireKey, target);
      } catch {
        /* the old copy remains until a later restore reuses that slot */
      }
    });
  } catch {
    /* private mode */
  }
}

/**
 * Writes the backup into the unused slot of one tab, and switches to it
 * only after the counts match. Other tabs' databases are never opened or deleted.
 * Omitting `tab` restores the database that is open now.
 */
export async function restoreLibrary(backup: ParsedBackup, onProgress?: (progress: RestoreProgress) => void, tab?: LibraryTab): Promise<void> {
  const started = performance.now();
  const total = backup.images.length;
  const bytesTotal = backup.images.reduce((sum, image) => sum + image.original.size + (image.thumb?.size ?? 0) + (image.ink?.size ?? 0), 0);
  const fileBytes = backup.summary.bytes;
  let saved = 0;
  let stage = "下書きの準備";
  const fail = (cause: unknown, detail = "") =>
    new RestoreFailure(stage, fileBytes, saved, total, performance.now() - started, cause, detail);
  const report = (name: RestoreProgress["stage"], done: number, bytesDone: number) => {
    onProgress?.({ stage: name, done, total, bytesDone, bytesTotal, elapsedMs: performance.now() - started });
  };
  const plan = librarySlotPlan(tab === undefined ? activeLibraryTab() : tab);
  const next = plan.swap;
  let staging: IDBDatabase | null = null;
  let flipped = false;
  try {
    if (typeof indexedDB === "undefined") throw new Error("indexedDB unavailable");
    stage = "下書きの準備";
    report("draft", 0, 0);
    await yieldUi();
    await deleteTabDatabase(plan.tab, next);
    staging = await openNamed(next, false);
    const metaTx = staging.transaction(["folders", "folderViews", "tags", "tagFolders", "kv"], "readwrite");
    for (const folder of backup.manifest.folders) metaTx.objectStore("folders").put(folder);
    for (const view of backup.manifest.folderViews) metaTx.objectStore("folderViews").put(view);
    for (const tag of backup.manifest.tags) metaTx.objectStore("tags").put(tag);
    for (const folder of backup.manifest.tagFolders) metaTx.objectStore("tagFolders").put(folder);
    for (const setting of backup.manifest.settings) {
      metaTx.objectStore("kv").put({ key: setting.key, value: setting.value } satisfies KvRow);
    }
    await txDone(metaTx);
    stage = "画像の保存";
    const sizes = backup.images.map((image) => image.original.size + (image.thumb?.size ?? 0) + (image.ink?.size ?? 0));
    let bytesDone = 0;
    for (const indexes of batchImageIndexes(sizes)) {
      report("save", saved, bytesDone);
      await yieldUi();
      const rows: { meta: ImageMeta; original: Blob; thumb: Blob | null; ink: Blob | null }[] = [];
      for (const index of indexes) {
        const image = backup.images[index];
        if (!image) continue;
        let original: Blob;
        let thumb: Blob | null = null;
        let ink: Blob | null = null;
        try {
          original = await ownBlob(image.original, image.original.type || image.meta.mime);
          if (image.thumb) thumb = await ownBlob(image.thumb, image.thumb.type || "image/jpeg");
          if (image.ink) ink = await ownBlob(image.ink, image.ink.type || "image/png");
        } catch (error) {
          throw fail(error, `「${image.meta.name}」のデータを読み出せませんでした。`);
        }
        if (original.size !== image.original.size || (image.thumb && thumb?.size !== image.thumb.size) || (image.ink && ink?.size !== image.ink.size)) {
          throw fail(new Error("size mismatch"), `「${image.meta.name}」の長さが記録と一致しません。`);
        }
        rows.push({ meta: image.meta, original, thumb, ink });
      }
      const tx = staging.transaction(["imageMeta", "imageBlobs", "imageInk"], "readwrite");
      for (const row of rows) {
        tx.objectStore("imageMeta").put(row.meta);
        tx.objectStore("imageBlobs").put({ id: row.meta.id, original: row.original, thumb: row.thumb } satisfies BlobRow);
        if (row.ink) tx.objectStore("imageInk").put({ id: row.meta.id, png: row.ink } satisfies InkRow);
      }
      try {
        await txDone(tx);
      } catch (error) {
        const name = rows[0]?.meta.name ?? "";
        throw fail(error, name ? `「${name}」付近の保存に失敗しました。` : "");
      }
      saved += rows.length;
      bytesDone += rows.reduce((sum, row) => sum + row.original.size + (row.thumb?.size ?? 0) + (row.ink?.size ?? 0), 0);
      rows.length = 0;
      report("save", saved, bytesDone);
      await yieldUi();
    }
    if (backup.canvas) {
      const png = await ownBlob(backup.canvas, "image/png");
      if (png.size !== backup.canvas.size) throw fail(new Error("size mismatch"), "キャンバスの長さが記録と一致しません。");
      const canvasTx = staging.transaction("imageInk", "readwrite");
      canvasTx.objectStore("imageInk").put({ id: CANVAS_BOARD_ID, png } satisfies InkRow);
      await txDone(canvasTx);
    }
    if (backup.flats && backup.flats.length > 0) {
      const rows: InkRow[] = [];
      for (const flat of backup.flats) {
        const png = await ownBlob(flat.png, "image/png");
        if (png.size !== flat.png.size) throw fail(new Error("size mismatch"), "キャンバス配置画像の長さが記録と一致しません。");
        rows.push({ id: canvasFlatId(flat.id), png });
      }
      const flatTx = staging.transaction("imageInk", "readwrite");
      for (const row of rows) flatTx.objectStore("imageInk").put(row);
      await txDone(flatTx);
    }
    stage = "件数の照合";
    report("check", saved, bytesDone);
    const [images, blobs, folders, views, tags, tagFolders, settings] = await Promise.all([
      countStore(staging, "imageMeta"),
      countStore(staging, "imageBlobs"),
      countStore(staging, "folders"),
      countStore(staging, "folderViews"),
      countStore(staging, "tags"),
      countStore(staging, "tagFolders"),
      countStore(staging, "kv"),
    ]);
    if (
      images !== total ||
      blobs !== total ||
      folders !== backup.manifest.folders.length ||
      views !== backup.manifest.folderViews.length ||
      tags !== backup.manifest.tags.length ||
      tagFolders !== backup.manifest.tagFolders.length ||
      settings !== backup.manifest.settings.length
    ) {
      throw fail(
        new Error("count mismatch"),
        `件数が合いません。画像 ${images}/${total}、本体 ${blobs}、フォルダ ${folders}、タグ ${tags}。`,
      );
    }
    stage = "ライブラリの切り替え";
    report("switch", saved, bytesDone);
    const previous = plan.live;
    try {
      localStorage.setItem(plan.liveKey, next);
    } catch (error) {
      throw fail(error, "このブラウザは復元先を覚えておけません。");
    }
    flipped = true;
    try {
      localStorage.setItem(plan.retireKey, previous);
    } catch {
      /* the previous library stays until a later restore replaces that slot */
    }
    staging.close();
    staging = null;
    if (plan.tab === activeLibraryTab()) {
      const live = await getDb().catch(() => null);
      live?.close();
      dbPromise = null;
      boundName = null;
      connectionEpoch += 1;
    }
  } catch (error) {
    staging?.close();
    if (!flipped) await deleteTabDatabase(plan.tab, next).catch(() => undefined);
    if (error instanceof RestoreFailure) throw error;
    throw fail(error);
  }
}

const LIBRARY_STORES = ["imageMeta", "imageBlobs", "imageInk", "folders", "folderViews", "tags", "tagFolders", "kv"] as const;

/** Rewrites the library stores of the given database. It does not open or choose a database. */
export function replaceLibraryStores(db: IDBDatabase, backup: ParsedBackup): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = openWrite(db, [...LIBRARY_STORES]);
    for (const name of LIBRARY_STORES) tx.objectStore(name).clear();
    for (const image of backup.images) {
      tx.objectStore("imageMeta").put(image.meta);
      const row: BlobRow = { id: image.meta.id, original: image.original, thumb: image.thumb };
      tx.objectStore("imageBlobs").put(row);
      if (image.ink) tx.objectStore("imageInk").put({ id: image.meta.id, png: image.ink } satisfies InkRow);
    }
    if (backup.canvas) tx.objectStore("imageInk").put({ id: CANVAS_BOARD_ID, png: backup.canvas } satisfies InkRow);
    for (const flat of backup.flats ?? []) {
      if (flat.png instanceof Blob && flat.png.size > 0) tx.objectStore("imageInk").put({ id: canvasFlatId(flat.id), png: flat.png } satisfies InkRow);
    }
    for (const folder of backup.manifest.folders) tx.objectStore("folders").put(folder);
    for (const view of backup.manifest.folderViews) tx.objectStore("folderViews").put(view);
    for (const tag of backup.manifest.tags) tx.objectStore("tags").put(tag);
    for (const folder of backup.manifest.tagFolders) tx.objectStore("tagFolders").put(folder);
    for (const setting of backup.manifest.settings) {
      tx.objectStore("kv").put({ key: setting.key, value: setting.value } satisfies KvRow);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("restore failed"));
    tx.onabort = () => reject(tx.error ?? new Error("restore aborted"));
  });
}

/** Replaces the seven stores of the database that is open now. */
export function replaceLibrary(backup: ParsedBackup): Promise<void> {
  if (!userWrites) return Promise.reject(new Error("library-changed"));
  return getDb().then((db) => replaceLibraryStores(db, backup));
}

/**
 * Clears the open library and writes a fresh one in the same database.
 * Does not open another tab, and does not touch the swap or retire slot.
 * Aborts without writing when the open database is no longer the one requested.
 */
export async function resetLiveLibrary(expectedName: string, backup: ParsedBackup): Promise<void> {
  if (!userWrites) throw new Error("library-changed");
  const db = await getDb();
  if (!userWrites || db.name !== expectedName) throw new Error("library-changed");
  await replaceLibraryStores(db, backup);
}

export function readPixels(id: string, kind: "thumb" | "original"): Promise<Blob | null> {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("imageBlobs", "readonly");
        const req = tx.objectStore("imageBlobs").get(id);
        req.onsuccess = () => {
          const row = req.result as BlobRow | undefined;
          if (!row) {
            resolve(null);
            return;
          }
          resolve(kind === "original" ? row.original : (row.thumb ?? row.original));
        };
        req.onerror = () => reject(req.error ?? new Error("read failed"));
      }),
  );
}
