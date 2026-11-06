import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKUP_MAGIC, BACKUP_VERSION, emptyLibraryBackup } from "./backup.ts";
import {
  deleteTagFolderTree,
  holdLibraryName,
  libraryDbName,
  libraryDbSlots,
  libraryLiveKey,
  libraryPhoneSurface,
  libraryRetireKey,
  librarySlotPlan,
  normalizeLibraryTab,
  releaseRetiredLibrary,
  rememberLibraryTab,
  replaceLibrary,
  replaceLibraryStores,
  resetLiveLibrary,
  restoreLibrary,
  retiredDbToDelete,
  selectedLibraryTab,
  setLibraryPhoneSurface,
  type LibraryTab,
} from "./db.ts";
import type { ParsedBackup } from "./backup.ts";
import type { ImageMeta } from "./types.ts";

const memory = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, String(value));
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
};

const deleted: string[] = [];
const opened: string[] = [];
const ops: string[] = [];
let failOpen = false;
let countValue = 0;

function installFakes(): void {
  Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, configurable: true });
  Object.defineProperty(globalThis, "indexedDB", {
    value: {
      deleteDatabase(name: string) {
        deleted.push(name);
        const request: { onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null } = {
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
      open(name: string) {
        opened.push(name);
        const names = new Set<string>();
        const cleared: string[] = [];
        const db = {
          name,
          cleared,
          objectStoreNames: { contains: (store: string) => names.has(store) },
          createObjectStore(store: string) {
            names.add(store);
            return { createIndex() {} };
          },
          transaction() {
            const tx = {
              error: null,
              objectStore(store: string) {
                return {
                  clear() {
                    cleared.push(store);
                    ops.push(`${name}:${store}:clear`);
                  },
                  put(value: { id?: string; key?: string }) {
                    const key = value && typeof value === "object" ? (value.id ?? value.key ?? "") : "";
                    ops.push(`${name}:${store}:put:${key}`);
                  },
                  delete(key: unknown) {
                    ops.push(`${name}:${store}:delete:${String(key)}`);
                  },
                  count() {
                    const req = { result: countValue, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
                    queueMicrotask(() => req.onsuccess?.());
                    return req;
                  },
                };
              },
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
            };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
          close() {},
          onversionchange: null as (() => void) | null,
        };
        const request = {
          result: db,
          error: new Error("open failed"),
          onupgradeneeded: null as ((event: { oldVersion: number }) => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
        };
        queueMicrotask(() => {
          if (failOpen) {
            request.onerror?.();
            return;
          }
          request.onupgradeneeded?.({ oldVersion: 0 });
          request.onsuccess?.();
        });
        return request;
      },
    },
    configurable: true,
  });
}

function emptyBackup(): ParsedBackup {
  return {
    summary: {
      bytes: 12,
      images: 0,
      videos: 0,
      folders: 0,
      tags: 0,
      tagFolders: 0,
      favorites: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    manifest: {
      format: "komacho-backup",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      images: [],
      folders: [],
      folderViews: [],
      tags: [],
      tagFolders: [],
      settings: [],
    },
    images: [],
  };
}

function slotsOf(tab: LibraryTab): [string, string] {
  return [libraryDbSlots(tab)[0], libraryDbSlots(tab)[1]];
}

afterEach(() => {
  memory.clear();
  deleted.length = 0;
  opened.length = 0;
  ops.length = 0;
  failOpen = false;
  countValue = 0;
  setLibraryPhoneSurface(false);
  holdLibraryName(null);
});

describe("library slots", { concurrency: false }, () => {
  it("opens the selected tab and keeps tab 1 while the phone layout is on", () => {
    installFakes();
    memory.set("komacho-library-db", "komacho");
    memory.set("komacho-library-tab", "3");
    assert.equal(selectedLibraryTab(), 3);
    assert.equal(libraryDbName(), "komacho-3");
    setLibraryPhoneSurface(true);
    assert.equal(libraryPhoneSurface(), true);
    assert.equal(libraryDbName(), "komacho");
    assert.equal(memory.get("komacho-library-tab"), "3");
    setLibraryPhoneSurface(false);
    assert.equal(libraryDbName(), "komacho-3");
    memory.set("komacho-library-tab", "nope");
    assert.equal(selectedLibraryTab(), 1);
    assert.equal(normalizeLibraryTab("9"), 1);
    assert.equal(libraryDbName(), "komacho");
    memory.delete("komacho-library-tab");
    assert.equal(selectedLibraryTab(), 1);
    memory.set("komacho-library-db", "komacho-2");
    assert.equal(libraryDbName(), "komacho");
    rememberLibraryTab(2);
    assert.equal(memory.get("komacho-library-tab"), "2");
    assert.equal(libraryDbName(), "komacho-2");
  });

  it("gives every tab a distinct live and swap pair", () => {
    installFakes();
    const all = [1, 2, 3].flatMap((tab) => slotsOf(tab as LibraryTab));
    assert.equal(new Set(all).size, 6);
    for (const tab of [1, 2, 3] as const) {
      const plan = librarySlotPlan(tab);
      assert.deepEqual(plan.slots, slotsOf(tab));
      assert.equal(plan.live, plan.slots[0]);
      assert.equal(plan.swap, plan.slots[1]);
      assert.equal(plan.slots.includes(plan.swap), true);
      assert.equal(plan.liveKey, libraryLiveKey(tab));
      assert.equal(plan.retireKey, libraryRetireKey(tab));
      memory.set(plan.liveKey, plan.slots[1]);
      const flipped = librarySlotPlan(tab);
      assert.equal(flipped.live, plan.slots[1]);
      assert.equal(flipped.swap, plan.slots[0]);
      memory.delete(plan.liveKey);
    }
    assert.deepEqual(slotsOf(1), ["komacho", "komacho-b"]);
    assert.equal(libraryLiveKey(1), "komacho-library-db");
    assert.equal(libraryRetireKey(1), "komacho-drop-db");
    assert.notEqual(libraryLiveKey(2), libraryLiveKey(1));
    assert.notEqual(libraryRetireKey(2), libraryRetireKey(1));
  });

  it("does not treat another tab's database as a deletion target", () => {
    assert.equal(retiredDbToDelete(1, "komacho-b", "komacho"), "komacho-b");
    assert.equal(retiredDbToDelete(1, "komacho", "komacho"), null);
    assert.equal(retiredDbToDelete(1, "komacho-2", "komacho"), null);
    assert.equal(retiredDbToDelete(1, "komacho-2b", "komacho"), null);
    assert.equal(retiredDbToDelete(1, "komacho-3", "komacho"), null);
    assert.equal(retiredDbToDelete(2, "komacho", "komacho-2"), null);
    assert.equal(retiredDbToDelete(2, "komacho-b", "komacho-2"), null);
    assert.equal(retiredDbToDelete(2, "komacho-2b", "komacho-2"), "komacho-2b");
    assert.equal(retiredDbToDelete(3, "komacho-3b", "komacho-3"), "komacho-3b");
    assert.equal(retiredDbToDelete(3, "komacho", "komacho-3"), null);
  });

  it("drops only a reserved inactive slot of that tab", async () => {
    installFakes();
    memory.set("komacho-library-db", "komacho");
    memory.set("komacho-drop-db", "komacho-2");
    releaseRetiredLibrary();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(deleted, []);
    assert.equal(memory.has("komacho-drop-db"), false);
    assert.equal(memory.get("komacho-library-db"), "komacho");

    memory.set("komacho-drop-db", "komacho-b");
    releaseRetiredLibrary();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(deleted, ["komacho-b"]);
    assert.equal(opened.length, 0);
  });

  it("rolls a failed tab-1 restore back to that tab's swap slot only", async () => {
    installFakes();
    failOpen = false;
    countValue = 1;
    memory.set("komacho-library-db", "komacho");
    memory.set("komacho-library-tab", "2");
    await assert.rejects(() => restoreLibrary(emptyBackup(), undefined, 1), /件数が合いません/);
    assert.deepEqual(deleted, ["komacho-b", "komacho-b"]);
    assert.deepEqual(opened, ["komacho-b"]);
    assert.equal(memory.get("komacho-library-db"), "komacho");
    assert.equal(memory.get("komacho-library-tab"), "2");
    assert.equal(librarySlotPlan(1).live, "komacho");
    assert.equal(libraryDbName(), "komacho-2");
  });

  it("keeps tab 1 when a tab-2 or tab-3 restore fails", async () => {
    installFakes();
    countValue = 1;
    memory.set("komacho-library-db", "komacho-b");
    await assert.rejects(() => restoreLibrary(emptyBackup(), undefined, 2), /件数が合いません/);
    assert.deepEqual(deleted, ["komacho-2b", "komacho-2b"]);
    assert.deepEqual(opened, ["komacho-2b"]);
    assert.equal(memory.get("komacho-library-db"), "komacho-b");
    assert.equal(libraryDbName(), "komacho-b");

    deleted.length = 0;
    opened.length = 0;
    await assert.rejects(() => restoreLibrary(emptyBackup(), undefined, 3), /件数が合いません/);
    assert.deepEqual(deleted, ["komacho-3b", "komacho-3b"]);
    assert.deepEqual(opened, ["komacho-3b"]);
    assert.equal(memory.has("komacho"), false);
    assert.equal(memory.get("komacho-library-db"), "komacho-b");
  });

  it("on success, switches and later deletes only that tab's pair", async () => {
    installFakes();
    countValue = 0;
    memory.set("komacho-library-db", "komacho");
    memory.set("komacho-library-db-2", "komacho-2");
    await restoreLibrary(emptyBackup(), undefined, 2);
    assert.equal(memory.get("komacho-library-db"), "komacho");
    assert.equal(memory.get("komacho-library-db-2"), "komacho-2b");
    assert.equal(memory.get("komacho-drop-db-2"), "komacho-2");
    assert.equal(memory.has("komacho-drop-db"), false);
    assert.deepEqual(deleted, ["komacho-2b"]);
    assert.deepEqual(opened, ["komacho-2b"]);
    assert.equal(libraryDbName(), "komacho");

    deleted.length = 0;
    opened.length = 0;
    releaseRetiredLibrary();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(deleted, ["komacho-2"]);
    assert.deepEqual(opened, []);
    assert.equal(memory.get("komacho-library-db"), "komacho");
    assert.equal(memory.get("komacho-library-db-2"), "komacho-2b");

    memory.clear();
    deleted.length = 0;
    opened.length = 0;
    memory.set("komacho-library-db", "komacho");
    await restoreLibrary(emptyBackup());
    assert.equal(memory.get("komacho-library-db"), "komacho-b");
    assert.equal(memory.get("komacho-drop-db"), "komacho");
    assert.equal(memory.has("komacho-library-db-2"), false);
    assert.equal(memory.has("komacho-drop-db-2"), false);
    assert.deepEqual(deleted, ["komacho-b"]);
    assert.ok(opened.every((name) => name === "komacho-b"));
    assert.equal(libraryDbName(), "komacho-b");

    deleted.length = 0;
    opened.length = 0;
    releaseRetiredLibrary();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(deleted, ["komacho"]);
    assert.deepEqual(opened, []);
    assert.equal(memory.get("komacho-library-db"), "komacho-b");
  });

  it("restores the open tab when the caller does not pass one", async () => {
    installFakes();
    countValue = 1;
    memory.set("komacho-library-tab", "2");
    memory.set("komacho-library-db", "komacho");
    await assert.rejects(() => restoreLibrary(emptyBackup()), /件数が合いません/);
    assert.deepEqual(deleted, ["komacho-2b", "komacho-2b"]);
    assert.deepEqual(opened, ["komacho-2b"]);
    assert.equal(memory.get("komacho-library-db"), "komacho");
    assert.equal(memory.get("komacho-library-tab"), "2");
  });

  it("replaces only the database that was opened", async () => {
    installFakes();
    memory.set("komacho-library-db", "komacho");
    memory.set("komacho-library-tab", "3");
    const backup = emptyBackup();
    const seen: string[] = [];
    await replaceLibraryStores(
      {
        transaction() {
          const tx = {
            objectStore(name: string) {
              return {
                clear() {
                  seen.push(name);
                },
                put() {},
              };
            },
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
          };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        },
      } as unknown as IDBDatabase,
      backup,
    );
    assert.deepEqual(seen, ["imageMeta", "imageBlobs", "imageInk", "folders", "folderViews", "tags", "tagFolders", "kv"]);
    deleted.length = 0;
    opened.length = 0;
    await replaceLibrary(backup);
    assert.deepEqual(opened, ["komacho-3"]);
    assert.deepEqual(deleted, []);
    assert.equal(memory.get("komacho-library-db"), "komacho");
    assert.equal(BACKUP_MAGIC, "KMCHOBK1");
    assert.equal(BACKUP_VERSION, 1);
  });

  it("deletes one tag folder and only the tags that belong to it", async () => {
    installFakes();
    memory.set("komacho-library-tab", "1");
    memory.set("komacho-library-db", "komacho");
    const meta = { id: "img" } as ImageMeta;
    await deleteTagFolderTree({
      folderId: "box",
      tagIds: ["gone"],
      metas: [meta],
      active: ["keep"],
      hidden: [],
    });
    assert.ok(ops.includes("komacho:tagFolders:delete:box"));
    assert.ok(ops.includes("komacho:tags:delete:gone"));
    assert.ok(ops.includes("komacho:imageMeta:put:img"));
    assert.ok(ops.includes("komacho:kv:put:tag"));
    assert.ok(ops.includes("komacho:kv:put:tagHidden"));
    assert.equal(ops.some((line) => line.startsWith("komacho-2:") || line.startsWith("komacho-3:")), false);
    assert.deepEqual(deleted, []);
    assert.equal(memory.get("komacho-library-tab"), "1");
  });

  it("resets the open library in place and leaves other tabs and backup slots alone", async () => {
    installFakes();
    memory.set("komacho-library-tab", "2");
    memory.set("komacho-library-db-2", "komacho-2");
    memory.set("komacho-drop-db-2", "komacho-2b");
    memory.set("komacho-library-db", "komacho");
    memory.set("komacho-lan-token", "secret");
    const backup = emptyLibraryBackup({
      id: "fresh",
      name: "未分類",
      order: 0,
      createdAt: 5,
      parentId: null,
      isParent: false,
      color: null,
    });
    await resetLiveLibrary("komacho-2", backup);
    assert.deepEqual(opened, ["komacho-2"]);
    assert.deepEqual(deleted, []);
    assert.equal(ops.filter((line) => line.endsWith(":clear")).length, 8);
    assert.ok(ops.includes("komacho-2:folders:put:fresh"));
    assert.equal(ops.some((line) => line.startsWith("komacho:") || line.startsWith("komacho-3:")), false);
    assert.equal(memory.get("komacho-library-db-2"), "komacho-2");
    assert.equal(memory.get("komacho-drop-db-2"), "komacho-2b");
    assert.equal(memory.get("komacho-library-tab"), "2");
    assert.equal(memory.get("komacho-lan-token"), "secret");
    await assert.rejects(() => resetLiveLibrary("komacho-3", backup), /library-changed/);
    assert.deepEqual(opened, ["komacho-2"]);
    assert.equal(memory.get("komacho-library-db-3") ?? null, null);
  });
});
