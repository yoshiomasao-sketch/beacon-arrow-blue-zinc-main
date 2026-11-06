import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { closeLibraryConnection, commitFolderCopy, readFolderCopySource } from "./db.ts";
import type { Folder, ImageMeta } from "./types.ts";

type Row = Record<string, unknown> & { id?: string; key?: string; original?: Blob; thumb?: Blob | null };

const databases = new Map<string, Map<string, Map<string, Row>>>();
let failBlob = false;
let listDatabases = true;

function rowKey(value: Row): string {
  if (typeof value.id === "string") return value.id;
  if (typeof value.key === "string") return value.key;
  throw new Error("missing key");
}

function installFakeIndexedDb(): void {
  const indexedDB = {
    open(name: string) {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const db = {
        name,
        objectStoreNames: { contains: (store: string) => databases.get(name)?.has(store) ?? false },
        createObjectStore(store: string) {
          databases.get(name)?.set(store, new Map());
          return { createIndex() {} };
        },
        transaction(storeNames: string | string[], mode: string) {
          const ops: { store: string; value: Row }[] = [];
          const tx = {
            error: null as Error | null,
            objectStore(store: string) {
              return {
                getAll() {
                  const result = [...(databases.get(name)?.get(store)?.values() ?? [])];
                  const request = { result, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
                  queueMicrotask(() => request.onsuccess?.());
                  return request;
                },
                put(value: Row) {
                  if (mode !== "readwrite") return;
                  ops.push({ store, value });
                  if (failBlob && store === "imageBlobs") tx.error = new Error("quota");
                },
              };
            },
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
          };
          queueMicrotask(() => {
            if (tx.error) {
              tx.onabort?.();
              tx.onerror?.();
              return;
            }
            if (mode === "readwrite") {
              for (const op of ops) databases.get(name)?.get(op.store)?.set(rowKey(op.value), op.value);
            }
            tx.oncomplete?.();
          });
          return tx;
        },
        close() {},
        onversionchange: null as (() => void) | null,
      };
      const request = {
        result: db,
        onupgradeneeded: null as ((event: { oldVersion: number }) => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (fresh) request.onupgradeneeded?.({ oldVersion: 0 });
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name: string) {
      databases.delete(name);
      const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onblocked: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
    databases() {
      return Promise.resolve([...databases.keys()].map((name) => ({ name, version: 5 })));
    },
  };
  if (!listDatabases) delete (indexedDB as { databases?: unknown }).databases;
  Object.defineProperty(globalThis, "indexedDB", { value: indexedDB, configurable: true });
}

function seed(name: string): Map<string, Map<string, Row>> {
  const stores = new Map<string, Map<string, Row>>();
  for (const store of ["imageMeta", "imageBlobs", "folders", "folderViews", "tags", "tagFolders", "kv"]) stores.set(store, new Map());
  databases.set(name, stores);
  return stores;
}

function meta(id: string, folderId: string): ImageMeta {
  return {
    id,
    name: `${id}.jpg`,
    mime: "image/jpeg",
    width: 8,
    height: 8,
    byteSize: 5,
    addedAt: 1,
    order: 2,
    scale: 1,
    source: "file",
    folderId,
    favorite: true,
    tagIds: [],
    animated: false,
    memo: "元メモ",
  };
}

afterEach(async () => {
  failBlob = false;
  listDatabases = true;
  databases.clear();
  await closeLibraryConnection();
});

describe("folder copy storage", { concurrency: false }, () => {
  it("writes the whole copy in one transaction and keeps an independent blob", async () => {
    installFakeIndexedDb();
    const source = seed("komacho");
    const original = new Blob(["pixels"], { type: "image/jpeg" });
    const thumb = new Blob(["mini"], { type: "image/jpeg" });
    source.get("folders")?.set("docs", { id: "docs", name: "資料", order: 0, createdAt: 1, parentId: null, isParent: false, color: null });
    source.get("imageMeta")?.set("img", meta("img", "docs"));
    source.get("imageBlobs")?.set("img", { id: "img", original, thumb });
    const read = await readFolderCopySource(1, "docs");
    assert.ok(read);
    assert.notEqual(read.blobs.get("img")?.original, original);
    assert.equal(await read.blobs.get("img")?.original.text(), "pixels");
    assert.equal(await read.blobs.get("img")?.thumb?.text(), "mini");
    assert.equal(source.get("imageBlobs")?.get("img")?.original, original);

    const copy = meta("img-copy", "docs-copy");
    await commitFolderCopy({
      folders: [{ id: "docs-copy", name: "資料（1）", order: 1, createdAt: 2, parentId: null, isParent: false, color: null }],
      views: [{ id: "docs-copy", view: { columns: 3, direction: "asc" } }],
      tags: [],
      tagFolders: [],
      images: [{ meta: copy, original: read.blobs.get("img")!.original, thumb: read.blobs.get("img")!.thumb }],
      promoted: null,
      selectId: "docs-copy",
    });
    assert.equal(source.get("folders")?.get("docs")?.name, "資料");
    assert.equal(source.get("folders")?.get("docs-copy")?.name, "資料（1）");
    assert.equal(source.get("imageMeta")?.get("img")?.memo, "元メモ");
    assert.equal(source.get("imageMeta")?.get("img-copy")?.memo, "元メモ");
    assert.notEqual(source.get("imageBlobs")?.get("img-copy")?.original, original);
    assert.equal(source.get("kv")?.get("folder")?.value, "docs-copy");
  });

  it("rolls back every store when the transaction fails", async () => {
    installFakeIndexedDb();
    const source = seed("komacho");
    source.get("folders")?.set("keep", { id: "keep", name: "残す", order: 0, createdAt: 1, parentId: null, isParent: false, color: null });
    failBlob = true;
    await assert.rejects(() =>
      commitFolderCopy({
        folders: [{ id: "docs-copy", name: "資料（1）", order: 1, createdAt: 2, parentId: null, isParent: false, color: null } satisfies Folder],
        views: [{ id: "docs-copy", view: { columns: 4, direction: "desc" } }],
        tags: [{ id: "tag-copy", name: "夏", color: "#e07a5f", order: 0, createdAt: 1, folderId: null }],
        tagFolders: [],
        images: [{ meta: meta("img-copy", "docs-copy"), original: new Blob(["x"]), thumb: null }],
        promoted: null,
        selectId: "docs-copy",
      }),
    );
    assert.equal(source.get("folders")?.has("docs-copy"), false);
    assert.equal(source.get("folders")?.has("keep"), true);
    assert.equal(source.get("imageMeta")?.has("img-copy"), false);
    assert.equal(source.get("imageBlobs")?.has("img-copy"), false);
    assert.equal(source.get("tags")?.has("tag-copy"), false);
    assert.equal(source.get("folderViews")?.has("docs-copy"), false);
    assert.equal(source.get("kv")?.has("folder"), false);
  });

  it("reads another tab without changing it, and stops when the folder is gone", async () => {
    installFakeIndexedDb();
    seed("komacho");
    const other = seed("komacho-2");
    other.get("folders")?.set("away", { id: "away", name: "別タブ", order: 0, createdAt: 1, parentId: null, isParent: false, color: null });
    const read = await readFolderCopySource(2, "away");
    assert.equal(read?.folders[0]?.name, "別タブ");
    assert.equal(other.get("folders")?.get("away")?.name, "別タブ");
    assert.equal(await readFolderCopySource(1, "away"), null);
    assert.equal(databases.has("komacho"), true);
    assert.equal(await readFolderCopySource(3, "away"), null);
    assert.equal(databases.has("komacho-3"), false);

    listDatabases = false;
    installFakeIndexedDb();
    await closeLibraryConnection();
    assert.equal(await readFolderCopySource(3, "away"), null);
    assert.equal(databases.has("komacho-3"), false);
  });
});
