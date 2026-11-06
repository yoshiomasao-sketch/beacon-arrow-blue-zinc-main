import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { libraryDbName, selectedLibraryTab, setLibraryPhoneSurface, userWritesOpen } from "./db.ts";
import { bootstrap, createFolder, getPortfolioState, retryBootstrap, saveFavoritesOnly, switchLibraryTab, syncLibrarySurface } from "./store.ts";

const memory = new Map<string, string>();
const databases = new Map<string, Map<string, Map<string, { id?: string; key?: string }>>>();
const failOpen = new Set<string>();
const opened: string[] = [];
const deleted: string[] = [];
const heldWrites: Array<() => void> = [];
let holdWrites = false;

function finishWrite(tx: { listeners: Map<string, Array<() => void>>; oncomplete: (() => void) | null }): void {
  for (const listener of tx.listeners.get("complete") ?? []) listener();
  tx.oncomplete?.();
}

function installBrowser(): void {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
      setItem: (key: string, value: string) => {
        memory.set(key, String(value));
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    value: {
      deleteDatabase(name: string) {
        deleted.push(name);
        databases.delete(name);
        const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onblocked: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
      open(name: string) {
        opened.push(name);
        if (failOpen.has(name)) {
          const request = {
            result: null,
            error: new Error("open failed"),
            onupgradeneeded: null as (() => void) | null,
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onblocked: null as (() => void) | null,
          };
          queueMicrotask(() => request.onerror?.());
          return request;
        }
        let stores = databases.get(name);
        const fresh = !stores;
        if (!stores) {
          stores = new Map();
          databases.set(name, stores);
        }
        const owned = stores;
        const db = {
          name,
          objectStoreNames: { contains: (store: string) => owned.has(store) },
          createObjectStore(store: string) {
            if (!owned.has(store)) owned.set(store, new Map());
            return { createIndex() {} };
          },
          transaction(storeNames: string | string[]) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = {
              error: null,
              listeners: new Map<string, Array<() => void>>(),
              addEventListener(type: string, listener: () => void) {
                const list = this.listeners.get(type) ?? [];
                list.push(listener);
                this.listeners.set(type, list);
              },
              objectStore(store: string) {
                const rows = owned.get(store) ?? new Map<string, { id?: string; key?: string }>();
                owned.set(store, rows);
                return {
                  get(key: string) {
                    const req = { result: rows.get(key), onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
                    queueMicrotask(() => req.onsuccess?.());
                    return req;
                  },
                  getAll() {
                    const req = { result: [...rows.values()], onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
                    queueMicrotask(() => req.onsuccess?.());
                    return req;
                  },
                  put(value: { id?: string; key?: string }) {
                    const id = value.id ?? value.key ?? "";
                    rows.set(id, value);
                  },
                  delete(key: string) {
                    rows.delete(key);
                  },
                  clear() {
                    rows.clear();
                  },
                  count() {
                    const req = { result: rows.size, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
                    queueMicrotask(() => req.onsuccess?.());
                    return req;
                  },
                };
              },
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
            };
            void names;
            if (holdWrites) heldWrites.push(() => finishWrite(tx));
            else queueMicrotask(() => finishWrite(tx));
            return tx;
          },
          close() {},
          onversionchange: null as (() => void) | null,
        };
        const request = {
          result: db,
          error: null,
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
        };
        queueMicrotask(() => {
          if (fresh) request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
    configurable: true,
  });
}

function namesIn(dbName: string): string[] {
  const folders = databases.get(dbName)?.get("folders");
  if (!folders) return [];
  return [...folders.values()].map((row) => (row as { name?: string }).name ?? "");
}

describe("library switch", { concurrency: false }, () => {
  it("keeps each tab's library separate and returns to the saved PC tab", async () => {
    installBrowser();
    setLibraryPhoneSurface(false);
    await bootstrap();
    const first = getPortfolioState();
    assert.equal(first.phase, "ready");
    assert.equal(libraryDbName(), "komacho");
    assert.deepEqual(first.folders.map((folder) => folder.name), ["未分類"]);
    assert.equal(first.items.length, 0);
    await createFolder("タブ1の作品");
    await saveFavoritesOnly(true);
    assert.equal(getPortfolioState().favoritesOnly, true);
    assert.ok(getPortfolioState().folders.some((folder) => folder.name === "タブ1の作品"));

    await switchLibraryTab(2);
    const second = getPortfolioState();
    assert.equal(second.phase, "ready");
    assert.equal(libraryDbName(), "komacho-2");
    assert.equal(selectedLibraryTab(), 2);
    assert.deepEqual(second.folders.map((folder) => folder.name), ["未分類"]);
    assert.equal(second.items.length, 0);
    assert.equal(second.favoritesOnly, false);
    assert.deepEqual(namesIn("komacho"), ["未分類", "タブ1の作品"]);
    assert.ok(!deleted.includes("komacho"));
    assert.ok(!deleted.includes("komacho-b"));

    const early = switchLibraryTab(1);
    const later = switchLibraryTab(3);
    await early;
    await later;
    assert.equal(selectedLibraryTab(), 3);
    assert.equal(libraryDbName(), "komacho-3");
    assert.deepEqual(getPortfolioState().folders.map((folder) => folder.name), ["未分類"]);
    assert.equal(getPortfolioState().items.length, 0);
    assert.ok(!opened.includes("komacho-b"));

    await syncLibrarySurface(true);
    assert.equal(memory.get("komacho-library-tab"), "3");
    assert.equal(selectedLibraryTab(), 3);
    assert.equal(libraryDbName(), "komacho");
    assert.equal(getPortfolioState().favoritesOnly, true);
    assert.ok(getPortfolioState().folders.some((folder) => folder.name === "タブ1の作品"));

    await syncLibrarySurface(false);
    assert.equal(memory.get("komacho-library-tab"), "3");
    assert.equal(libraryDbName(), "komacho-3");
    assert.equal(getPortfolioState().favoritesOnly, false);
    assert.ok(!getPortfolioState().folders.some((folder) => folder.name === "タブ1の作品"));

    await retryBootstrap();
    assert.equal(libraryDbName(), "komacho-3");
    assert.equal(getPortfolioState().phase, "ready");
    assert.equal(getPortfolioState().items.length, 0);
    assert.deepEqual(namesIn("komacho"), ["未分類", "タブ1の作品"]);
    assert.ok(!deleted.includes("komacho"));
    assert.ok(!deleted.includes("komacho-2"));
    assert.ok(!deleted.includes("komacho-3"));

    await switchLibraryTab(1);
    assert.equal(libraryDbName(), "komacho");
    assert.ok(getPortfolioState().folders.some((folder) => folder.name === "タブ1の作品"));
    failOpen.add("komacho-2");
    await switchLibraryTab(2);
    assert.equal(getPortfolioState().phase, "unavailable");
    assert.equal(selectedLibraryTab(), 2);
    assert.equal(libraryDbName(), "komacho-2");
    assert.equal(getPortfolioState().items.length, 0);
    assert.ok(!getPortfolioState().folders.some((folder) => folder.name === "タブ1の作品"));
    assert.deepEqual(namesIn("komacho"), ["未分類", "タブ1の作品"]);
    assert.deepEqual(namesIn("komacho-2"), ["未分類"]);
    assert.ok(!deleted.includes("komacho"));
    failOpen.delete("komacho-2");
    await switchLibraryTab(1);
    assert.equal(getPortfolioState().phase, "ready");
    assert.equal(selectedLibraryTab(), 1);
    assert.equal(libraryDbName(), "komacho");
    assert.equal(getPortfolioState().favoritesOnly, true);
    assert.ok(getPortfolioState().folders.some((folder) => folder.name === "タブ1の作品"));
    assert.ok(!deleted.includes("komacho"));
  });

  it("keeps a save that is still finishing on the tab where it started", async () => {
    setLibraryPhoneSurface(false);
    holdWrites = true;
    const creating = createFolder("遅延作品");
    for (let turn = 0; turn < 20 && heldWrites.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.ok(heldWrites.length > 0);
    const switching = switchLibraryTab(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    holdWrites = false;
    for (let turn = 0; turn < 30; turn += 1) {
      const pending = heldWrites.splice(0);
      for (const finish of pending) finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await creating;
    await switching;
    assert.equal(getPortfolioState().phase, "ready");
    assert.equal(userWritesOpen(), true);
    assert.equal(libraryDbName(), "komacho-2");
    assert.ok(!getPortfolioState().folders.some((folder) => folder.name === "遅延作品"));
    assert.ok(namesIn("komacho").includes("遅延作品"));
    assert.ok(!namesIn("komacho-2").includes("遅延作品"));
    await createFolder("タブ2だけ");
    assert.ok(getPortfolioState().folders.some((folder) => folder.name === "タブ2だけ"));
    assert.ok(!namesIn("komacho").includes("タブ2だけ"));
  });
});
