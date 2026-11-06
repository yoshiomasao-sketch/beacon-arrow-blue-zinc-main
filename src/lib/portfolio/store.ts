import { useSyncExternalStore } from "react";
import { isCanvasInkId } from "@/lib/portfolio/canvas";
import {
  activeLibraryTab,
  allocateOrders,
  closeLibraryConnection,
  commitFolderCopy,
  deleteFolderRecord,
  deleteFolderView,
  deleteImage,
  deleteTagFolderTree,
  deleteTagRecord,
  ensureLibrary,
  holdLibraryName,
  INITIAL_FOLDER_NAME,
  libraryConnectionEpoch,
  libraryDbName,
  librarySlotPlan,
  type LibraryTab,
  readFolderCopySource,
  listFolderViews,
  listMeta,
  listInkIds,
  listTagFolders,
  listTags,
  normalizeLibraryTab,
  putFolder,
  putFolderView,
  putMeta,
  putTag,
  putTagFolder,
  readKv,
  readKvString,
  releaseRetiredLibrary,
  rememberLibraryTab,
  resetLiveLibrary,
  resumeLibraryWrites,
  saveImage,
  setLibraryPhoneSurface,
  setUserWritesOpen,
  suspendLibraryWrites,
  userWritesOpen,
  writeKv,
  writeMetaOrders,
  writesSettled,
  drainLibraryWrites,
} from "./db.ts";
import {
  assignVisibleOrders,
  baseName,
  classifyImageInput,
  descendantFolderIds,
  folderWouldCycle,
  imageFolderChoices,
  importNotice,
  pickParentColor,
  settleParentFolders,
  normalizeFolderView,
  normalizeMemo,
  normalizeTagMatch,
  pasteParentId,
  planFolderCopy,
  planTagFolderRemoval,
  parseActiveTagIds,
  storageErrorMessage,
  type ImportStats,
  type TagMatch,
} from "./logic.ts";
import { releaseAllOriginals, releaseOriginal } from "./export-file.ts";
import { emptyLibraryBackup } from "./backup.ts";
import { ImagePrepareError, prepareImage } from "./prepare.ts";
import { forgetAllThumbs, forgetThumb } from "./thumbs.ts";
import { clearInkHistories } from "./ink.ts";
import { ALL_FOLDERS, DEFAULT_FOLDER_VIEW, TAG_COLORS, type DisplayScale, type Folder, type FolderView, type ImageMeta, type ImageSource, type Tag, type TagFolder } from "./types.ts";

export type PendingAdd = {
  files: File[];
  source: ImageSource;
  parentId: string;
};

export type SortDirection = "asc" | "desc";

export type Notice = {
  id: string;
  message: string;
};

export type PortfolioState = {
  phase: "boot" | "ready" | "unavailable";
  items: ImageMeta[];
  notices: Notice[];
  importing: { done: number; total: number } | null;
  bootError: string | null;
  columns: number;
  direction: SortDirection;
  folders: Folder[];
  folderId: string;
  views: Record<string, FolderView>;
  folderWidth: number;
  folderPane: number;
  folderOpen: boolean;
  favoritesOnly: boolean;
  tags: Tag[];
  tagFolders: TagFolder[];
  activeTagIds: string[];
  hiddenTagIds: string[];
  hiddenFolderIds: string[];
  tagMatch: TagMatch;
  tagOpen: boolean;
  tagWidth: number;
  /** Gallery's share of the canvas-mode center, not including the side rails. */
  canvasSplit: number;
  pendingAdd: PendingAdd | null;
  libraryEpoch: number;
  /** Image ids that currently have a pen layer. */
  inkIds: string[];
  /** Bumps when a pen layer is saved so the gallery overlay reloads that id. */
  inkRev: Record<string, number>;
};

const SERVER_SNAPSHOT: PortfolioState = {
  phase: "boot",
  items: [],
  notices: [],
  importing: null,
  bootError: null,
  columns: 4,
  direction: DEFAULT_FOLDER_VIEW.direction,
  folders: [],
  folderId: ALL_FOLDERS,
  views: { [ALL_FOLDERS]: DEFAULT_FOLDER_VIEW },
  folderWidth: 240,
  folderPane: 360,
  folderOpen: true,
  favoritesOnly: false,
  tags: [],
  tagFolders: [],
  activeTagIds: [],
  hiddenTagIds: [],
  hiddenFolderIds: [],
  tagMatch: "all",
  tagOpen: true,
  tagWidth: 220,
  canvasSplit: 0.5,
  pendingAdd: null,
  libraryEpoch: 0,
  inkIds: [],
  inkRev: {},
};

let state: PortfolioState = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();
let bootPromise: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();
let switchChain: Promise<void> = Promise.resolve();
let stateLocked = false;
let viewEpoch = 0;
const deleting = new Set<string>();
let persistedKey = "";

function orderKey(items: ImageMeta[]): string {
  return items.map((item) => `${item.id}:${item.order}:${item.scale}:${item.folderId}`).join("|");
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(update: (current: PortfolioState) => PortfolioState): void {
  if (stateLocked) return;
  state = update(state);
  emit();
}

function forceState(update: (current: PortfolioState) => PortfolioState): void {
  state = update(state);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPortfolioState(): PortfolioState {
  return state;
}

export function usePortfolio<T>(select: (current: PortfolioState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(SERVER_SNAPSHOT),
  );
}

function pushNotice(message: string | null): void {
  if (!message) return;
  const notice: Notice = { id: crypto.randomUUID(), message };
  setState((current) => ({ ...current, notices: [...current.notices, notice].slice(-4) }));
}

export function notify(message: string): void {
  pushNotice(message);
}

export function dismissNotice(id: string): void {
  setState((current) => ({
    ...current,
    notices: current.notices.filter((notice) => notice.id !== id),
  }));
}

export function dismissNotices(): void {
  if (state.notices.length === 0) return;
  setState((current) => ({ ...current, notices: [] }));
}

let viewerLock = false;

export function setViewerLock(locked: boolean): void {
  viewerLock = locked;
}

export function viewerLocked(): boolean {
  return viewerLock;
}

function isQuota(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "QuotaExceededError") ||
    (error instanceof Error && error.name === "QuotaExceededError")
  );
}

async function loadLibraryIntoState(epoch: number): Promise<void> {
  clearInkHistories();
  const [items, folder, width, open, pane, favoritesOnly, tags, tag, tagHidden, tagMatch, tagOpen, tagWidth, tagFolders, folderHidden, inkIdList, canvasSplit] = await Promise.all([
    listMeta(),
    readKvString("folder", ALL_FOLDERS),
    readKv("folderWidth", 240),
    readKv("folderOpen", 1),
    readKv("folderPane", 360),
    readKv("favoritesOnly", 0),
    listTags(),
    readKvString("tag", ""),
    readKvString("tagHidden", ""),
    readKvString("tagMatch", "all"),
    readKv("tagOpen", 1),
    readKv("tagWidth", 220),
    listTagFolders(),
    readKvString("folderHidden", ""),
    listInkIds(),
    readKv("canvasSplit", 0.5),
  ]);
  if (epoch !== viewEpoch) return;
  const library = await ensureLibrary(items);
  if (epoch !== viewEpoch) return;
  const folders = settleParentFolders(library.folders, library.items);
  for (const entry of folders) {
    const previous = library.folders.find((item) => item.id === entry.id);
    if (!previous || previous.isParent !== entry.isParent || previous.color !== entry.color) await putFolder(entry);
  }
  if (epoch !== viewEpoch) return;
  const views = await listFolderViews();
  if (epoch !== viewEpoch) return;
  const ids = [ALL_FOLDERS, ...folders.map((entry) => entry.id)];
  for (const id of ids) {
    if (views[id]) continue;
    views[id] = DEFAULT_FOLDER_VIEW;
    await putFolderView(id, DEFAULT_FOLDER_VIEW);
  }
  if (epoch !== viewEpoch) return;
  const knownFolders = new Set(folders.map((entry) => entry.id));
  const hiddenFolderIds = parseActiveTagIds(folderHidden, knownFolders);
  const folderId = folder === ALL_FOLDERS || knownFolders.has(folder) ? folder : ALL_FOLDERS;
  const active = views[folderId] ?? DEFAULT_FOLDER_VIEW;
  const knownTags = new Set(tags.map((entry) => entry.id));
  const cleaned = library.items.map((item) => {
    const tagIds = item.tagIds.filter((id) => knownTags.has(id));
    return tagIds.length === item.tagIds.length ? item : { ...item, tagIds };
  });
  for (const item of cleaned) {
    if (item.tagIds.join("|") !== library.items.find((entry) => entry.id === item.id)?.tagIds.join("|")) {
      await putMeta(item);
    }
  }
  if (epoch !== viewEpoch) return;
  const knownFolderIds = new Set(tagFolders.map((entry) => entry.id));
  const filed = tags.map((entry) => (entry.folderId && !knownFolderIds.has(entry.folderId) ? { ...entry, folderId: null } : entry));
  for (const entry of filed) {
    if (entry.folderId !== tags.find((tagItem) => tagItem.id === entry.id)?.folderId) await putTag(entry);
  }
  if (epoch !== viewEpoch) return;
  const activeTagIds = parseActiveTagIds(tag, knownTags);
  const hiddenTagIds = parseActiveTagIds(tagHidden, knownTags).filter((id) => !activeTagIds.includes(id));
  persistedKey = orderKey(cleaned);
  forceState((current) => ({
    ...current,
    phase: "ready",
    libraryEpoch: epoch,
    items: cleaned,
    folders,
    folderId,
    views,
    folderWidth: Math.min(420, Math.max(180, width || 240)),
    folderPane: Math.min(720, Math.max(140, pane || 360)),
    folderOpen: open !== 0,
    favoritesOnly: favoritesOnly === 1,
    tags: filed,
    tagFolders,
    activeTagIds,
    hiddenTagIds,
    hiddenFolderIds,
    tagMatch: normalizeTagMatch(tagMatch),
    tagOpen: tagOpen !== 0,
    tagWidth: Math.min(320, Math.max(180, tagWidth || 220)),
    canvasSplit: canvasSplit > 0 && canvasSplit < 1 ? canvasSplit : 0.5,
    columns: active.columns,
    direction: active.direction,
    bootError: null,
    pendingAdd: null,
    importing: null,
    inkIds: inkIdList.filter((id) => cleaned.some((item) => item.id === id)),
    inkRev: {},
  }));
}

export function bootstrap(): Promise<void> {
  if (state.phase === "ready") return Promise.resolve();
  if (!bootPromise) {
    releaseRetiredLibrary();
    const epoch = viewEpoch;
    bootPromise = loadLibraryIntoState(epoch)
      .catch((error: unknown) => {
        if (epoch !== viewEpoch) return;
        forceState((current) => ({
          ...current,
          phase: "unavailable",
          bootError: storageErrorMessage(error, "open"),
        }));
      })
      .finally(() => {
        if (state.phase !== "ready") bootPromise = null;
      });
  }
  return bootPromise;
}

export function retryBootstrap(): Promise<void> {
  bootPromise = null;
  forceState((current) => ({ ...current, phase: "boot", bootError: null }));
  return bootstrap();
}

function scheduleReload(): Promise<void> {
  viewEpoch += 1;
  const ticket = viewEpoch;
  const run = switchChain.then(() => applyRetarget(ticket));
  switchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function applyRetarget(ticket: number): Promise<void> {
  if (ticket !== viewEpoch) return;
  stateLocked = true;
  deleting.clear();
  try {
    await queue.catch(() => undefined);
    if (ticket !== viewEpoch) return;
    await drainLibraryWrites();
    if (ticket !== viewEpoch) return;
    suspendLibraryWrites();
    await writesSettled();
    if (ticket !== viewEpoch) return;
    await closeLibraryConnection();
    forgetAllThumbs();
    releaseAllOriginals();
    if (ticket !== viewEpoch) return;
    holdLibraryName(null);
    resumeLibraryWrites();
    bootPromise = null;
    persistedKey = "";
    forceState((current) => ({
      ...current,
      phase: "boot",
      libraryEpoch: ticket,
      items: [],
      folders: [],
      folderId: ALL_FOLDERS,
      views: { [ALL_FOLDERS]: DEFAULT_FOLDER_VIEW },
      columns: DEFAULT_FOLDER_VIEW.columns,
      direction: DEFAULT_FOLDER_VIEW.direction,
      favoritesOnly: false,
      tags: [],
      tagFolders: [],
      activeTagIds: [],
      hiddenTagIds: [],
      hiddenFolderIds: [],
      tagMatch: "all",
      folderWidth: 240,
      folderPane: 360,
      folderOpen: true,
      tagOpen: true,
      tagWidth: 220,
      canvasSplit: 0.5,
      pendingAdd: null,
      importing: null,
      bootError: null,
      inkIds: [],
      inkRev: {},
    }));
    await loadLibraryIntoState(ticket);
  } catch (error) {
    if (ticket !== viewEpoch) return;
    holdLibraryName(null);
    resumeLibraryWrites();
    forceState((current) => ({
      ...current,
      phase: "unavailable",
      bootError: storageErrorMessage(error, "open"),
      libraryEpoch: ticket,
    }));
  } finally {
    resumeLibraryWrites();
    if (ticket === viewEpoch) {
      setUserWritesOpen(true);
      stateLocked = false;
    }
  }
}

/** Opens one PC library. Safe to call again before the previous switch finishes. */
export function switchLibraryTab(tab: unknown): Promise<void> {
  const before = libraryDbName();
  rememberLibraryTab(normalizeLibraryTab(tab));
  const after = librarySlotPlan(activeLibraryTab()).live;
  const started = state.phase === "ready" || state.phase === "unavailable" || bootPromise !== null;
  // Before the first open, only remember the tab. A failed open must still be able to move to another tab.
  if (!started) return Promise.resolve();
  if (state.phase === "ready" && after === before) return Promise.resolve();
  setUserWritesOpen(false);
  holdLibraryName(before);
  return scheduleReload();
}

/**
 * Follows the existing phone layout flag.
 * Does not rewrite the saved PC tab. No-op until the library has started opening.
 */
export function syncLibrarySurface(phone: boolean): Promise<void> {
  const before = libraryDbName();
  setLibraryPhoneSurface(phone);
  const after = librarySlotPlan(activeLibraryTab()).live;
  if (after === before) return Promise.resolve();
  if (state.phase !== "ready" && !bootPromise) return Promise.resolve();
  setUserWritesOpen(false);
  holdLibraryName(before);
  return scheduleReload();
}

function inboxFolderId(): string {
  if (state.folderId !== ALL_FOLDERS && state.folders.some((folder) => folder.id === state.folderId)) {
    return state.folderId;
  }
  return state.folders.find((folder) => folder.name === INITIAL_FOLDER_NAME)?.id ?? state.folders[0]?.id ?? "";
}

async function importBatch(files: File[], source: ImageSource, folderId = inboxFolderId()): Promise<void> {
  if (state.phase !== "ready") {
    pushNotice(state.bootError ?? "まだ画像ライブラリの準備ができていません。");
    return;
  }

  const destination = state.folders.find((folder) => folder.id === folderId);
  if (!destination) {
    pushNotice("フォルダを用意してから画像を追加してください。");
    return;
  }
  if (destination.isParent) {
    pushNotice("親フォルダには画像を入れられません。子フォルダを選んで追加してください。");
    return;
  }

  const stats: ImportStats = {
    added: 0,
    skippedType: 0,
    skippedEmpty: 0,
    failedDecode: 0,
    failedSave: 0,
    quota: false,
  };
  const accepted: { file: File; mime: ImageMeta["mime"] }[] = [];

  for (const file of files) {
    const result = classifyImageInput(file);
    if (!result.ok) {
      if (result.reason === "empty") stats.skippedEmpty += 1;
      else stats.skippedType += 1;
      continue;
    }
    accepted.push({ file, mime: result.mime });
  }

  if (accepted.length === 0) {
    pushNotice(importNotice(stats));
    return;
  }

  setState((current) => ({ ...current, importing: { done: 0, total: accepted.length } }));

  try {
    let start = 1;
    try {
      start = await allocateOrders(accepted.length);
    } catch (error) {
      stats.failedSave = accepted.length;
      stats.quota = isQuota(error);
      return;
    }

    for (let index = 0; index < accepted.length; index += 1) {
      const { file, mime } = accepted[index]!;
      if (stats.quota) {
        stats.failedSave += 1;
      } else {
        try {
          const prepared = await prepareImage(file, mime);
          const meta: ImageMeta = {
            id: crypto.randomUUID(),
            name: baseName(file.name),
            mime,
            width: prepared.width,
            height: prepared.height,
            byteSize: prepared.original.size,
            addedAt: Date.now(),
            order: start + index,
            scale: 1,
            source,
            folderId,
            favorite: false,
            tagIds: [],
            animated: prepared.animated,
            memo: "",
          };
          await saveImage(meta, prepared.original, prepared.thumb);
          stats.added += 1;
          setState((current) => ({ ...current, items: [...current.items, meta] }));
        } catch (error) {
          if (error instanceof ImagePrepareError) stats.failedDecode += 1;
          else {
            stats.failedSave += 1;
            if (isQuota(error)) stats.quota = true;
          }
        }
      }
      const done = index + 1;
      setState((current) => ({
        ...current,
        importing: current.importing ? { done, total: accepted.length } : null,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    setState((current) => ({ ...current, importing: null }));
    persistedKey = orderKey(state.items);
    pushNotice(importNotice(stats));
  }
}

export function addFiles(list: FileList | readonly File[], source: ImageSource = "file"): Promise<void> {
  if (viewerLock || !userWritesOpen()) return Promise.resolve();
  const files = Array.from(list);
  const folderId = inboxFolderId();
  const destination = state.folders.find((folder) => folder.id === folderId);
  if (destination?.isParent) {
    if (imageFolderChoices(state.folders, destination.id).length === 0) {
      pushNotice("親フォルダには画像を入れられません。先に子フォルダを作ってから、その中へ追加してください。");
      return Promise.resolve();
    }
    setState((current) => ({ ...current, pendingAdd: { files, source, parentId: destination.id } }));
    return Promise.resolve();
  }
  const job = queue.then(() => importBatch(files, source, folderId));
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

export function cancelPendingAdd(): void {
  setState((current) => ({ ...current, pendingAdd: null }));
}

export function confirmPendingAdd(folderId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return Promise.resolve();
  const pending = state.pendingAdd;
  const destination = state.folders.find((folder) => folder.id === folderId);
  if (!pending || !destination || destination.isParent) return Promise.resolve();
  if (!imageFolderChoices(state.folders, pending.parentId).some((folder) => folder.id === folderId)) return Promise.resolve();
  setState((current) => ({ ...current, pendingAdd: null }));
  const job = queue.then(() => importBatch(pending.files, pending.source, folderId));
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

export async function favoriteImages(ids: readonly string[]): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const wanted = new Set(ids);
  const changed = state.items.filter((item) => wanted.has(item.id) && !item.favorite);
  if (changed.length === 0) return;
  const previous = state.items;
  const nextItems = state.items.map((item) => (wanted.has(item.id) ? { ...item, favorite: true } : item));
  setState((current) => ({ ...current, items: nextItems }));
  try {
    for (const item of changed) await putMeta({ ...item, favorite: true });
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function removeImages(ids: readonly string[]): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const unique = [...new Set(ids)].filter((id) => !deleting.has(id) && state.items.some((item) => item.id === id));
  unique.forEach((id) => deleting.add(id));
  const removed: string[] = [];
  try {
    for (const id of unique) {
      try {
        await deleteImage(id);
        forgetThumb(id);
        releaseOriginal(id);
        removed.push(id);
      } catch (error) {
        pushNotice(storageErrorMessage(error, "delete"));
      }
    }
    if (removed.length === 0) return;
    const gone = new Set(removed);
    setState((current) => ({ ...current, items: current.items.filter((item) => !gone.has(item.id)) }));
    persistedKey = orderKey(state.items);
  } finally {
    unique.forEach((id) => deleting.delete(id));
  }
}

export async function moveImagesToFolder(ids: readonly string[], folderId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const destination = state.folders.find((folder) => folder.id === folderId);
  if (!destination) return;
  if (destination.isParent) {
    pushNotice("親フォルダには画像を入れられません。子フォルダへドロップしてください。");
    return;
  }
  const wanted = new Set(ids);
  const moving = state.items.filter((item) => wanted.has(item.id) && item.folderId !== folderId);
  if (moving.length === 0) return;
  const movingIds = new Set(moving.map((item) => item.id));
  const previous = state.items;
  const nextItems = state.items.map((item) => (movingIds.has(item.id) ? { ...item, folderId } : item));
  setState((current) => ({ ...current, items: nextItems }));
  try {
    for (const item of nextItems) {
      if (movingIds.has(item.id)) await putMeta(item);
    }
    persistedKey = orderKey(state.items);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    persistedKey = orderKey(previous);
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function assignTagToImages(ids: readonly string[], tagId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  if (!state.tags.some((tag) => tag.id === tagId)) return;
  const wanted = new Set(ids);
  const changed: ImageMeta[] = [];
  const nextItems = state.items.map((item) => {
    if (!wanted.has(item.id) || item.tagIds.includes(tagId)) return item;
    const next = { ...item, tagIds: [...item.tagIds, tagId] };
    changed.push(next);
    return next;
  });
  if (changed.length === 0) return;
  const previous = state.items;
  setState((current) => ({ ...current, items: nextItems }));
  try {
    for (const item of changed) await putMeta(item);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function toggleFavorite(id: string, options?: { fromLightbox?: boolean }): Promise<void> {
  if (!userWritesOpen()) return;
  if (viewerLock && !options?.fromLightbox) return;
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const next = { ...item, favorite: !item.favorite };
  const previous = state.items;
  setState((current) => ({
    ...current,
    items: current.items.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putMeta(next);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function setImageMemo(id: string, memo: string): Promise<void> {
  if (!userWritesOpen()) return;
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const nextMemo = normalizeMemo(memo);
  if (item.memo === nextMemo) return;
  const next = { ...item, memo: nextMemo };
  const previous = state.items;
  setState((current) => ({
    ...current,
    items: current.items.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putMeta(next);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

/** Shows or hides one image's pen layer. The drawing itself is left in place. */
export async function setInkVisible(id: string, visible: boolean): Promise<void> {
  if (!userWritesOpen()) return;
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  if ((item.inkVisible !== false) === visible) return;
  const next = { ...item, inkVisible: visible };
  const previous = state.items;
  setState((current) => ({
    ...current,
    items: current.items.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putMeta(next);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

/** Gallery learns that a pen layer was saved or removed. Does not touch the pixels. */
export function noteInkPresence(id: string, present: boolean): void {
  if (!id || isCanvasInkId(id)) return;
  setState((current) => {
    const has = current.inkIds.includes(id);
    const inkIds = present ? (has ? current.inkIds : [...current.inkIds, id]) : has ? current.inkIds.filter((entry) => entry !== id) : current.inkIds;
    return {
      ...current,
      inkIds,
      inkRev: { ...current.inkRev, [id]: (current.inkRev[id] ?? 0) + 1 },
    };
  });
}

function tagTaken(name: string, exceptId?: string): boolean {
  return state.tags.some((tag) => tag.id !== exceptId && tag.name === name);
}

export async function createTag(name: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return;
  if (tagTaken(trimmed)) {
    pushNotice("同じ名前のタグがあります。");
    return;
  }
  const tag: Tag = {
    id: crypto.randomUUID(),
    name: trimmed,
    color: TAG_COLORS[state.tags.length % TAG_COLORS.length] ?? TAG_COLORS[0],
    order: state.tags.length,
    createdAt: Date.now(),
    folderId: null,
  };
  const previous = state.tags;
  setState((current) => ({ ...current, tags: [...current.tags, tag] }));
  try {
    await putTag(tag);
  } catch (error) {
    setState((current) => ({ ...current, tags: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

function tagFolderTaken(name: string): boolean {
  return state.tagFolders.some((folder) => folder.name === name);
}

export async function createTagFolder(name: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return;
  if (tagFolderTaken(trimmed)) {
    pushNotice("同じ名前のフォルダがあります。");
    return;
  }
  const folder: TagFolder = {
    id: crypto.randomUUID(),
    name: trimmed,
    order: state.tagFolders.length,
    createdAt: Date.now(),
    open: true,
  };
  const previous = state.tagFolders;
  setState((current) => ({ ...current, tagFolders: [...current.tagFolders, folder] }));
  try {
    await putTagFolder(folder);
  } catch (error) {
    setState((current) => ({ ...current, tagFolders: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function toggleTagFolder(id: string): Promise<void> {
  if (!userWritesOpen()) return;
  const folder = state.tagFolders.find((entry) => entry.id === id);
  if (!folder) return;
  const next = { ...folder, open: !folder.open };
  const previous = state.tagFolders;
  setState((current) => ({
    ...current,
    tagFolders: current.tagFolders.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putTagFolder(next);
  } catch (error) {
    setState((current) => ({ ...current, tagFolders: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function placeTag(tagId: string, folderId: string | null, beforeId: string | null): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const source = state.tags.find((entry) => entry.id === tagId);
  if (!source) return;
  if (folderId && !state.tagFolders.some((entry) => entry.id === folderId)) return;
  const byOrder = (a: Tag, b: Tag) => a.order - b.order || a.createdAt - b.createdAt;
  const siblings = state.tags
    .filter((entry) => entry.id !== tagId && (entry.folderId ?? null) === folderId)
    .sort(byOrder);
  if (beforeId !== null && !siblings.some((entry) => entry.id === beforeId)) return;
  const ids = siblings.map((entry) => entry.id);
  ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, tagId);
  const sameFolder = (source.folderId ?? null) === folderId;
  const currentIds = state.tags
    .filter((entry) => (entry.folderId ?? null) === folderId)
    .sort(byOrder)
    .map((entry) => entry.id);
  if (sameFolder && currentIds.join("|") === ids.join("|")) return;
  const orderOf = new Map(ids.map((id, index) => [id, index]));
  const previous = state.tags;
  const next = previous.map((entry) => {
    const order = orderOf.get(entry.id);
    if (order === undefined) return entry;
    if (entry.id === tagId) return { ...entry, folderId, order };
    return order === entry.order ? entry : { ...entry, order };
  });
  setState((current) => ({
    ...current,
    tags: next.slice().sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
  }));
  try {
    for (const tag of next) {
      const before = previous.find((entry) => entry.id === tag.id);
      if (!before || before.order !== tag.order || before.folderId !== tag.folderId) await putTag(tag);
    }
  } catch (error) {
    setState((current) => ({ ...current, tags: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function moveTagToFolder(tagId: string, folderId: string | null): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const tag = state.tags.find((entry) => entry.id === tagId);
  if (!tag) return;
  if (folderId && !state.tagFolders.some((entry) => entry.id === folderId)) return;
  if (tag.folderId === folderId) return;
  const next = { ...tag, folderId };
  const previous = state.tags;
  setState((current) => ({
    ...current,
    tags: current.tags.map((entry) => (entry.id === tagId ? next : entry)),
  }));
  try {
    await putTag(next);
  } catch (error) {
    setState((current) => ({ ...current, tags: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function deleteTagFolder(id: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  if (!state.tagFolders.some((entry) => entry.id === id)) return;
  const epoch = libraryConnectionEpoch();
  const plan = planTagFolderRemoval({
    folderId: id,
    tags: state.tags,
    items: state.items,
    activeTagIds: state.activeTagIds,
    hiddenTagIds: state.hiddenTagIds,
  });
  const doomed = new Set(plan.tagIds);
  const metas = state.items.flatMap((item) => {
    if (!item.tagIds.some((tagId) => doomed.has(tagId))) return [];
    return [{ ...item, tagIds: item.tagIds.filter((tagId) => !doomed.has(tagId)) }];
  });
  const active = plan.activeTagIds.length === state.activeTagIds.length ? null : plan.activeTagIds;
  const hidden = plan.hiddenTagIds.length === state.hiddenTagIds.length ? null : plan.hiddenTagIds;
  try {
    await deleteTagFolderTree({ folderId: id, tagIds: plan.tagIds, metas, active, hidden });
  } catch (error) {
    if (error instanceof Error && error.message === "library-changed") {
      pushNotice("画面が切り替わったため、タグフォルダの削除を中止しました。");
      return;
    }
    pushNotice(storageErrorMessage(error, "delete"));
    return;
  }
  if (libraryConnectionEpoch() !== epoch || !userWritesOpen()) return;
  setState((current) => ({
    ...current,
    tagFolders: current.tagFolders.filter((entry) => entry.id !== id),
    tags: current.tags.filter((tag) => !doomed.has(tag.id)),
    items: current.items.map((item) =>
      item.tagIds.some((tagId) => doomed.has(tagId)) ? { ...item, tagIds: item.tagIds.filter((tagId) => !doomed.has(tagId)) } : item,
    ),
    activeTagIds: current.activeTagIds.filter((tagId) => !doomed.has(tagId)),
    hiddenTagIds: current.hiddenTagIds.filter((tagId) => !doomed.has(tagId)),
  }));
}

/** Empties only the library that is open now. Other tabs, LAN settings, and backup slots stay. */
export async function resetCurrentLibrary(): Promise<void> {
  if (!userWritesOpen()) {
    pushNotice("画面が切り替わったため、初期化を中止しました。");
    return;
  }
  const tab = activeLibraryTab();
  const expectedName = libraryDbName();
  const epoch = libraryConnectionEpoch();
  const ticket = viewEpoch;
  await writesSettled();
  if (activeLibraryTab() !== tab || libraryDbName() !== expectedName || libraryConnectionEpoch() !== epoch || viewEpoch !== ticket || !userWritesOpen()) {
    pushNotice("画面が切り替わったため、初期化を中止しました。");
    return;
  }
  const folder: Folder = {
    id: crypto.randomUUID(),
    name: INITIAL_FOLDER_NAME,
    order: 0,
    createdAt: Date.now(),
    parentId: null,
    isParent: false,
    color: null,
  };
  try {
    await resetLiveLibrary(expectedName, emptyLibraryBackup(folder));
  } catch (error) {
    if (error instanceof Error && error.message === "library-changed") {
      pushNotice("画面が切り替わったため、初期化を中止しました。");
      return;
    }
    pushNotice(`${storageErrorMessage(error, "delete")}初期化は完了していないため、このタブも他のタブも変えていません。`);
    return;
  }
  if (activeLibraryTab() !== tab || viewEpoch !== ticket) return;
  forgetAllThumbs();
  releaseAllOriginals();
  pushNotice(`タブ${tab}を初期状態に戻しました。他のタブはそのままです。`);
  await scheduleReload();
}

export async function renameTag(id: string, name: string): Promise<boolean> {
  if (viewerLock || !userWritesOpen()) return false;
  const trimmed = name.trim().slice(0, 40);
  const tag = state.tags.find((entry) => entry.id === id);
  if (!tag || !trimmed || trimmed === tag.name) return false;
  if (tagTaken(trimmed, id)) {
    pushNotice("同じ名前のタグがあります。");
    return false;
  }
  const next = { ...tag, name: trimmed };
  const previous = state.tags;
  setState((current) => ({
    ...current,
    tags: current.tags.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putTag(next);
    return true;
  } catch (error) {
    setState((current) => ({ ...current, tags: previous }));
    pushNotice(storageErrorMessage(error, "save"));
    return false;
  }
}

export async function removeTag(id: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const tag = state.tags.find((entry) => entry.id === id);
  if (!tag) return;
  const previousTags = state.tags;
  const previousItems = state.items;
  const previousIds = state.activeTagIds;
  const previousHidden = state.hiddenTagIds;
  const nextIds = previousIds.filter((entry) => entry !== id);
  const nextHidden = previousHidden.filter((entry) => entry !== id);
  const nextItems = state.items.map((item) =>
    item.tagIds.includes(id) ? { ...item, tagIds: item.tagIds.filter((entry) => entry !== id) } : item,
  );
  setState((current) => ({
    ...current,
    tags: current.tags.filter((entry) => entry.id !== id),
    items: nextItems,
    activeTagIds: nextIds,
    hiddenTagIds: nextHidden,
  }));
  try {
    await deleteTagRecord(id);
    for (const item of nextItems) {
      if (item.tagIds.length !== previousItems.find((entry) => entry.id === item.id)?.tagIds.length) await putMeta(item);
    }
    if (nextIds.length !== previousIds.length) await writeKv("tag", JSON.stringify(nextIds));
    if (nextHidden.length !== previousHidden.length) await writeKv("tagHidden", JSON.stringify(nextHidden));
  } catch (error) {
    setState((current) => ({
      ...current,
      tags: previousTags,
      items: previousItems,
      activeTagIds: previousIds,
      hiddenTagIds: previousHidden,
    }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function unassignTagFromImages(ids: readonly string[], tagId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const wanted = new Set(ids);
  const changed: ImageMeta[] = [];
  const nextItems = state.items.map((item) => {
    if (!wanted.has(item.id) || !item.tagIds.includes(tagId)) return item;
    const next = { ...item, tagIds: item.tagIds.filter((entry) => entry !== tagId) };
    changed.push(next);
    return next;
  });
  if (changed.length === 0) return;
  const previous = state.items;
  setState((current) => ({ ...current, items: nextItems }));
  try {
    for (const item of changed) await putMeta(item);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function unassignTag(imageId: string, tagId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  await unassignTagFromImages([imageId], tagId);
}

export async function assignTag(imageId: string, tagId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const item = state.items.find((entry) => entry.id === imageId);
  const tag = state.tags.find((entry) => entry.id === tagId);
  if (!item || !tag) return;
  if (item.tagIds.includes(tagId)) {
    pushNotice(`「${tag.name}」はすでに付いています。`);
    return;
  }
  const next = { ...item, tagIds: [...item.tagIds, tagId] };
  const previous = state.items;
  setState((current) => ({
    ...current,
    items: current.items.map((entry) => (entry.id === imageId ? next : entry)),
  }));
  try {
    await putMeta(next);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

async function writeTagFilters(active: string[], hidden: string[], previousActive: string[], previousHidden: string[]) {
  if (!userWritesOpen()) return;
  if (active.join("|") === previousActive.join("|") && hidden.join("|") === previousHidden.join("|")) return;
  setState((current) => ({ ...current, activeTagIds: active, hiddenTagIds: hidden }));
  try {
    if (active.join("|") !== previousActive.join("|")) await writeKv("tag", JSON.stringify(active));
    if (hidden.join("|") !== previousHidden.join("|")) await writeKv("tagHidden", JSON.stringify(hidden));
  } catch (error) {
    setState((current) => ({ ...current, activeTagIds: previousActive, hiddenTagIds: previousHidden }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function placeFilterTag(id: string, side: "active" | "hidden"): Promise<void> {
  const known = new Set(state.tags.map((tag) => tag.id));
  if (!known.has(id)) return;
  const previousActive = state.activeTagIds.filter((entry) => known.has(entry));
  const previousHidden = state.hiddenTagIds.filter((entry) => known.has(entry));
  const nextActive =
    side === "active" ? (previousActive.includes(id) ? previousActive : [...previousActive, id]) : previousActive.filter((entry) => entry !== id);
  const nextHidden =
    side === "hidden" ? (previousHidden.includes(id) ? previousHidden : [...previousHidden, id]) : previousHidden.filter((entry) => entry !== id);
  await writeTagFilters(nextActive, nextHidden, state.activeTagIds, state.hiddenTagIds);
}

export async function removeFilterTag(id: string, side: "active" | "hidden"): Promise<void> {
  const previousActive = state.activeTagIds;
  const previousHidden = state.hiddenTagIds;
  const nextActive = side === "active" ? previousActive.filter((entry) => entry !== id) : previousActive;
  const nextHidden = side === "hidden" ? previousHidden.filter((entry) => entry !== id) : previousHidden;
  await writeTagFilters(nextActive, nextHidden, previousActive, previousHidden);
}

export async function clearFilterTags(side: "active" | "hidden"): Promise<void> {
  const previousActive = state.activeTagIds;
  const previousHidden = state.hiddenTagIds;
  if (side === "active") await writeTagFilters([], previousHidden, previousActive, previousHidden);
  else await writeTagFilters(previousActive, [], previousActive, previousHidden);
}

export async function selectTag(id: string | null): Promise<void> {
  if (id === null) {
    await clearFilterTags("active");
    return;
  }
  if (state.activeTagIds.includes(id)) {
    await removeFilterTag(id, "active");
    return;
  }
  await placeFilterTag(id, "active");
}

export async function hideTag(id: string): Promise<void> {
  if (state.hiddenTagIds.includes(id)) {
    await removeFilterTag(id, "hidden");
    return;
  }
  await placeFilterTag(id, "hidden");
}

export async function setTagMatch(match: TagMatch): Promise<void> {
  if (!userWritesOpen()) return;
  const next = normalizeTagMatch(match);
  if (next === state.tagMatch) return;
  const previous = state.tagMatch;
  setState((current) => ({ ...current, tagMatch: next }));
  try {
    await writeKv("tagMatch", next);
  } catch (error) {
    setState((current) => ({ ...current, tagMatch: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveTagOpen(open: boolean): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  setState((current) => ({ ...current, tagOpen: open }));
  try {
    await writeKv("tagOpen", open ? 1 : 0);
  } catch (error) {
    setState((current) => ({ ...current, tagOpen: !open }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveTagWidth(width: number): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const next = Math.min(320, Math.max(180, Math.round(width)));
  setState((current) => ({ ...current, tagWidth: next }));
  try {
    await writeKv("tagWidth", next);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function removeImage(id: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  if (deleting.has(id)) return;
  deleting.add(id);
  try {
    await deleteImage(id);
    forgetThumb(id);
    releaseOriginal(id);
    setState((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== id),
    }));
    persistedKey = orderKey(state.items);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "delete"));
  } finally {
    deleting.delete(id);
  }
}

function withOrders(items: ImageMeta[], ids: string[]): ImageMeta[] {
  const map = new Map(items.map((item) => [item.id, item]));
  const next: ImageMeta[] = [];
  ids.forEach((id, index) => {
    const item = map.get(id);
    if (item) next.push({ ...item, order: index + 1 });
  });
  return next;
}

export function placeImageBefore(sourceId: string, targetId: string): void {
  if (viewerLock || !userWritesOpen()) return;
  if (sourceId === targetId) return;
  const ids = state.items.map((item) => item.id);
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, sourceId);
  setState((current) => ({ ...current, items: withOrders(current.items, ids) }));
}

export async function commitImageOrder(force = false): Promise<void> {
  if ((!force && viewerLock) || !userWritesOpen()) return;
  const key = orderKey(state.items);
  if (key === persistedKey) return;
  const snapshot = state.items;
  try {
    await writeMetaOrders(snapshot.map((item) => ({ id: item.id, order: item.order })));
    persistedKey = orderKey(state.items);
  } catch (error) {
    try {
      const items = await listMeta();
      persistedKey = orderKey(items);
      setState((current) => ({ ...current, items }));
    } catch {
      setState((current) => ({ ...current, items: snapshot }));
    }
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function setImageScale(id: string, scale: DisplayScale): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const previous = state.items;
  const meta = previous.find((item) => item.id === id);
  if (!meta || meta.scale === scale) return;
  const next = { ...meta, scale };
  setState((current) => ({
    ...current,
    items: current.items.map((item) => (item.id === id ? next : item)),
  }));
  try {
    await putMeta(next);
    persistedKey = orderKey(state.items);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    persistedKey = orderKey(previous);
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export function setVisibleOrder(ids: string[], force = false): void {
  if ((!force && viewerLock) || !userWritesOpen()) return;
  const next = assignVisibleOrders(state.items, ids);
  if (!next) return;
  setState((current) => ({ ...current, items: next }));
}

export function restoreOrders(entries: { id: string; order: number }[]): void {
  if (viewerLock || !userWritesOpen()) return;
  const orders = new Map(entries.map((entry) => [entry.id, entry.order]));
  setState((current) => ({
    ...current,
    items: current.items.map((item) => {
      const order = orders.get(item.id);
      return order === undefined || order === item.order ? item : { ...item, order };
    }),
  }));
}

function folderNameTaken(name: string, parentId: string | null, exceptId?: string): boolean {
  return state.folders.some(
    (folder) => folder.id !== exceptId && (folder.parentId ?? null) === parentId && folder.name === name,
  );
}

function viewFor(id: string): FolderView {
  return state.views[id] ?? DEFAULT_FOLDER_VIEW;
}

async function writeCurrentView(view: FolderView): Promise<void> {
  const folderId = state.folderId;
  const previous = viewFor(folderId);
  const previousColumns = state.columns;
  const previousDirection = state.direction;
  setState((current) => ({
    ...current,
    columns: view.columns,
    direction: view.direction,
    views: { ...current.views, [folderId]: view },
  }));
  try {
    await putFolderView(folderId, view);
  } catch (error) {
    setState((current) => ({
      ...current,
      columns: previousColumns,
      direction: previousDirection,
      views: { ...current.views, [folderId]: previous },
    }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function setDirection(direction: SortDirection): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  if (direction === state.direction) return;
  await writeCurrentView({ ...viewFor(state.folderId), direction });
}

export async function setColumns(columns: number): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const next = normalizeFolderView({ columns }).columns;
  if (next === state.columns) return;
  await writeCurrentView({ ...viewFor(state.folderId), columns: next });
}

export async function selectFolder(folderId: string): Promise<void> {
  if (!userWritesOpen()) return;
  const next = folderId === ALL_FOLDERS || state.folders.some((folder) => folder.id === folderId) ? folderId : ALL_FOLDERS;
  if (next === state.folderId) return;
  const previousId = state.folderId;
  const previousColumns = state.columns;
  const previousDirection = state.direction;
  const previousViews = state.views;
  const known = state.views[next];
  const view = known ?? DEFAULT_FOLDER_VIEW;
  setState((current) => ({
    ...current,
    folderId: next,
    columns: view.columns,
    direction: view.direction,
    views: known ? current.views : { ...current.views, [next]: view },
  }));
  try {
    await writeKv("folder", next);
    if (!known) await putFolderView(next, view);
  } catch (error) {
    setState((current) => ({
      ...current,
      folderId: previousId,
      columns: previousColumns,
      direction: previousDirection,
      views: previousViews,
    }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function toggleFolderHidden(id: string): Promise<void> {
  if (!userWritesOpen()) return;
  if (!state.folders.some((folder) => folder.id === id)) return;
  const previousHidden = state.hiddenFolderIds;
  const hidden = previousHidden.includes(id) ? previousHidden.filter((entry) => entry !== id) : [...previousHidden, id];
  setState((current) => ({ ...current, hiddenFolderIds: hidden }));
  try {
    await writeKv("folderHidden", JSON.stringify(hidden));
  } catch (error) {
    setState((current) => ({ ...current, hiddenFolderIds: previousHidden }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function createFolder(name: string, parentId: string | null = null): Promise<void> {
  if (!userWritesOpen()) return;
  const trimmed = name.trim().slice(0, 40);
  const parent = parentId ? state.folders.find((folder) => folder.id === parentId) : undefined;
  const parentKey = parent?.id ?? null;
  if (!trimmed) return;
  if (parent && !parent.isParent && state.items.some((item) => item.folderId === parent.id)) {
    pushNotice("画像が入っているフォルダは親フォルダにできません。画像のないフォルダに子フォルダを入れてください。");
    return;
  }
  if (folderNameTaken(trimmed, parentKey)) {
    pushNotice("同じ階層に同じ名前のフォルダがあります。");
    return;
  }
  const promoted = parent && !parent.isParent
    ? { ...parent, isParent: true, color: parent.color ?? pickParentColor(state.folders.flatMap((folder) => (folder.color ? [folder.color] : []))) }
    : null;
  const peers = state.folders.filter((entry) => (entry.parentId ?? null) === parentKey);
  const folder: Folder = {
    id: crypto.randomUUID(),
    name: trimmed,
    order: parentKey === null ? (peers.length === 0 ? 0 : Math.min(...peers.map((entry) => entry.order)) - 1) : peers.length,
    createdAt: Date.now(),
    parentId: parentKey,
    isParent: false,
    color: null,
  };
  const previous = state.folders;
  const previousId = state.folderId;
  const previousColumns = state.columns;
  const previousDirection = state.direction;
  const previousViews = state.views;
  const view = DEFAULT_FOLDER_VIEW;
  setState((current) => ({
    ...current,
    folders: [...current.folders.map((entry) => (promoted && entry.id === promoted.id ? promoted : entry)), folder],
    folderId: folder.id,
    columns: view.columns,
    direction: view.direction,
    views: { ...current.views, [folder.id]: view },
  }));
  try {
    await putFolder(folder);
    if (promoted) await putFolder(promoted);
    await putFolderView(folder.id, view);
    await writeKv("folder", folder.id);
  } catch (error) {
    setState((current) => ({
      ...current,
      folders: previous,
      folderId: previousId,
      columns: previousColumns,
      direction: previousDirection,
      views: previousViews,
    }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export type FolderClip = { tab: LibraryTab; folderId: string };

let folderClip: FolderClip | null = null;
const clipListeners = new Set<() => void>();

function emitClip(): void {
  for (const listener of clipListeners) listener();
}

export function folderClipSnapshot(): FolderClip | null {
  return folderClip;
}

export function useFolderClip(): FolderClip | null {
  return useSyncExternalStore(
    (listener) => {
      clipListeners.add(listener);
      return () => clipListeners.delete(listener);
    },
    folderClipSnapshot,
    () => null,
  );
}

/** Remembers a folder to paste later. Pixels stay where they are until paste. */
export function rememberFolderCopy(folderId: string): void {
  const folder = state.folders.find((entry) => entry.id === folderId);
  if (!folder || viewerLock || !userWritesOpen()) return;
  folderClip = { tab: activeLibraryTab(), folderId };
  emitClip();
  pushNotice(`「${folder.name}」をコピーしました。貼りつけできます。`);
}

export async function pasteFolderCopy(): Promise<void> {
  if (!userWritesOpen()) return;
  const clip = folderClip;
  if (!clip) {
    pushNotice("コピーしたフォルダがありません。");
    return;
  }
  const destTab = activeLibraryTab();
  const destDb = libraryDbName();
  const destEpoch = libraryConnectionEpoch();
  let source;
  try {
    await writesSettled();
    source = await readFolderCopySource(clip.tab, clip.folderId);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
    return;
  }
  if (activeLibraryTab() !== destTab || libraryDbName() !== destDb || libraryConnectionEpoch() !== destEpoch || !userWritesOpen()) {
    pushNotice("画面が切り替わったため、貼り付けを中止しました。");
    return;
  }
  if (!source) {
    folderClip = null;
    emitClip();
    pushNotice("コピー元のフォルダが見つかりません。貼り付けを中止しました。");
    return;
  }
  const destParentId = pasteParentId(state.folders, state.folderId);
  const parent = destParentId ? state.folders.find((folder) => folder.id === destParentId) : undefined;
  const parentKey = parent?.id ?? null;
  if (parent && !parent.isParent && state.items.some((item) => item.folderId === parent.id)) {
    pushNotice("画像が入っているフォルダは親フォルダにできません。画像のないフォルダに子フォルダを入れてください。");
    return;
  }
  const promoted =
    parent && !parent.isParent
      ? {
          ...parent,
          isParent: true,
          color: parent.color ?? pickParentColor(state.folders.flatMap((folder) => (folder.color ? [folder.color] : []))),
        }
      : null;
  const planned = planFolderCopy({
    rootId: source.rootId,
    sourceFolders: source.folders,
    sourceItems: source.items,
    sourceTags: source.tags,
    sourceTagFolders: source.tagFolders,
    sourceViews: source.views,
    destFolders: promoted ? state.folders.map((folder) => (folder.id === promoted.id ? promoted : folder)) : state.folders,
    destTags: state.tags,
    destTagFolders: state.tagFolders,
    destParentId: parentKey,
    sourceHiddenIds: source.hiddenIds,
  });
  if (!planned) {
    folderClip = null;
    emitClip();
    pushNotice("コピー元のフォルダが見つかりません。貼り付けを中止しました。");
    return;
  }
  const images: { meta: ImageMeta; original: Blob; thumb: Blob | null }[] = [];
  for (const image of planned.images) {
    const blob = source.blobs.get(image.sourceId);
    if (!blob) {
      pushNotice("コピー元の画像を読み取れなかったため、貼り付けを中止しました。");
      return;
    }
    images.push({ meta: image.meta, original: blob.original, thumb: blob.thumb });
  }
  const root = planned.folders.find((folder) => folder.id === planned.rootId);
  const view = planned.views.find((entry) => entry.id === planned.rootId)?.view ?? DEFAULT_FOLDER_VIEW;
  const nextHidden = planned.hiddenIds.length === 0 ? state.hiddenFolderIds : [...state.hiddenFolderIds];
  for (const id of planned.hiddenIds) {
    if (!nextHidden.includes(id)) nextHidden.push(id);
  }
  try {
    await commitFolderCopy({
      folders: planned.folders,
      views: planned.views,
      tags: planned.tags,
      tagFolders: planned.tagFolders,
      images,
      promoted,
      selectId: planned.rootId,
      hiddenIds: planned.hiddenIds.length === 0 ? null : nextHidden,
    });
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
    return;
  }
  if (libraryDbName() !== destDb || libraryConnectionEpoch() !== destEpoch) return;
  setState((current) => ({
    ...current,
    folders: [...current.folders.map((folder) => (promoted && folder.id === promoted.id ? promoted : folder)), ...planned.folders],
    items: [...current.items, ...images.map((image) => image.meta)],
    tags: [...current.tags, ...planned.tags],
    tagFolders: [...current.tagFolders, ...planned.tagFolders],
    views: {
      ...current.views,
      ...Object.fromEntries(planned.views.map((entry) => [entry.id, entry.view])),
    },
    folderId: planned.rootId,
    columns: view.columns,
    direction: view.direction,
    hiddenFolderIds: nextHidden,
  }));
  if (root) pushNotice(`「${root.name}」を貼り付けました。`);
}

export async function renameFolder(id: string, name: string): Promise<boolean> {
  if (viewerLock || !userWritesOpen()) return false;
  const trimmed = name.trim().slice(0, 40);
  const folder = state.folders.find((entry) => entry.id === id);
  if (!folder || !trimmed || trimmed === folder.name) return false;
  if (folderNameTaken(trimmed, folder.parentId ?? null, id)) {
    pushNotice("同じ階層に同じ名前のフォルダがあります。");
    return false;
  }
  const next = { ...folder, name: trimmed };
  const previous = state.folders;
  setState((current) => ({
    ...current,
    folders: current.folders.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putFolder(next);
    return true;
  } catch (error) {
    setState((current) => ({ ...current, folders: previous }));
    pushNotice(storageErrorMessage(error, "save"));
    return false;
  }
}

export async function moveFolder(sourceId: string, beforeId: string | null, parentId?: string | null): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const source = state.folders.find((folder) => folder.id === sourceId);
  if (!source) return;
  const nextParent = parentId === undefined ? (source.parentId ?? null) : parentId;
  if (folderWouldCycle(state.folders, sourceId, nextParent)) {
    pushNotice("自分自身や、その中にあるフォルダの中には入れられません。");
    return;
  }
  if (nextParent !== (source.parentId ?? null) && folderNameTaken(source.name, nextParent, sourceId)) {
    pushNotice("同じ階層に同じ名前のフォルダがあります。");
    return;
  }
  const siblings = state.folders
    .filter((folder) => folder.id !== sourceId && (folder.parentId ?? null) === nextParent)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const ids = siblings.map((folder) => folder.id);
  if (beforeId !== null && !ids.includes(beforeId)) return;
  ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, sourceId);
  const currentIds = state.folders
    .filter((folder) => (folder.parentId ?? null) === (source.parentId ?? null))
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    .map((folder) => folder.id);
  if ((source.parentId ?? null) === nextParent && currentIds.join("|") === ids.join("|")) return;
  const orderOf = new Map(ids.map((id, order) => [id, order]));
  const previous = state.folders;
  const next = state.folders.map((folder) => {
    if (folder.id === sourceId) return { ...folder, parentId: nextParent, order: orderOf.get(sourceId) ?? 0 };
    const order = orderOf.get(folder.id);
    return order === undefined ? folder : { ...folder, order };
  });
  setState((current) => ({ ...current, folders: next }));
  try {
    for (const folder of next) {
      const before = previous.find((entry) => entry.id === folder.id);
      if (!before || before.parentId !== folder.parentId || before.order !== folder.order) await putFolder(folder);
    }
  } catch (error) {
    setState((current) => ({ ...current, folders: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function nestFolder(sourceId: string, parentId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const source = state.folders.find((folder) => folder.id === sourceId);
  const target = state.folders.find((folder) => folder.id === parentId);
  if (!source || !target) return;
  if ((source.parentId ?? null) === parentId) return;
  if (!target.isParent && state.items.some((item) => item.folderId === target.id)) {
    pushNotice("画像が入っているフォルダは親フォルダにできません。画像のないフォルダへドロップしてください。");
    return;
  }
  if (folderWouldCycle(state.folders, sourceId, parentId)) {
    pushNotice("自分自身や、その中にあるフォルダの中には入れられません。");
    return;
  }
  if (folderNameTaken(source.name, parentId, sourceId)) {
    pushNotice("同じ階層に同じ名前のフォルダがあります。");
    return;
  }
  const previous = state.folders;
  const promoted = target.isParent
    ? null
    : { ...target, isParent: true, color: target.color ?? pickParentColor(state.folders.flatMap((folder) => (folder.color ? [folder.color] : []))) };
  const nextFolder = {
    ...source,
    parentId,
    order: state.folders.filter((folder) => (folder.parentId ?? null) === parentId).length,
  };
  setState((current) => ({
    ...current,
    folders: current.folders.map((folder) => {
      if (folder.id === sourceId) return nextFolder;
      if (promoted && folder.id === promoted.id) return promoted;
      return folder;
    }),
  }));
  try {
    await putFolder(nextFolder);
    if (promoted) await putFolder(promoted);
  } catch (error) {
    setState((current) => ({ ...current, folders: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function releaseParent(id: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const folder = state.folders.find((entry) => entry.id === id);
  if (!folder?.isParent) return;
  const parentId = folder.parentId ?? null;
  const siblings = state.folders.filter((entry) => entry.id !== id && (entry.parentId ?? null) === parentId).length;
  const previous = state.folders;
  let childIndex = 0;
  const next = state.folders.map((entry) => {
    if (entry.id === id) return { ...entry, isParent: false, color: null };
    if (entry.parentId !== id) return entry;
    const moved = { ...entry, parentId, order: siblings + childIndex };
    childIndex += 1;
    return moved;
  });
  setState((current) => ({ ...current, folders: next }));
  try {
    for (const entry of next) {
      const before = previous.find((folder) => folder.id === entry.id);
      if (!before || before.parentId !== entry.parentId || before.isParent !== entry.isParent || before.color !== entry.color || before.order !== entry.order) {
        await putFolder(entry);
      }
    }
  } catch (error) {
    setState((current) => ({ ...current, folders: previous }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function removeFolder(id: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const folder = state.folders.find((entry) => entry.id === id);
  if (!folder) return;
  const doomed = new Set([id, ...descendantFolderIds(state.folders, id)]);
  const remaining = state.folders.filter((entry) => !doomed.has(entry.id));
  if (remaining.length === 0) {
    pushNotice("最後のフォルダは削除できません。");
    return;
  }
  const imageIds = state.items.filter((item) => doomed.has(item.folderId)).map((item) => item.id);
  const removed: string[] = [];
  for (const imageId of imageIds) {
    if (deleting.has(imageId)) continue;
    deleting.add(imageId);
    try {
      await deleteImage(imageId);
      forgetThumb(imageId);
      releaseOriginal(imageId);
      removed.push(imageId);
    } catch (error) {
      pushNotice(storageErrorMessage(error, "delete"));
      break;
    } finally {
      deleting.delete(imageId);
    }
  }
  if (removed.length !== imageIds.length) {
    const gone = new Set(removed);
    if (gone.size > 0) {
      setState((current) => ({ ...current, items: current.items.filter((item) => !gone.has(item.id)) }));
      persistedKey = orderKey(state.items);
    }
    return;
  }
  const deletedFolderIds: string[] = [];
  let folderError: unknown = null;
  for (const folderId of doomed) {
    try {
      await deleteFolderRecord(folderId);
      await deleteFolderView(folderId);
      deletedFolderIds.push(folderId);
    } catch (error) {
      folderError = error;
      break;
    }
  }
  const goneFolders = new Set(deletedFolderIds);
  const goneImages = new Set(removed);
  const previousId = state.folderId;
  const previousHidden = state.hiddenFolderIds;
  const nextHidden = previousHidden.filter((entry) => !goneFolders.has(entry));
  const fallbackId = goneFolders.has(previousId)
    ? (folder.parentId && !goneFolders.has(folder.parentId) ? folder.parentId : remaining.find((entry) => !goneFolders.has(entry.id))?.id ?? previousId)
    : previousId;
  const nextFolderId = fallbackId;
  const homeView = nextFolderId !== previousId ? viewFor(nextFolderId) : null;
  setState((current) => {
    const views = { ...current.views };
    for (const folderId of goneFolders) delete views[folderId];
    return {
      ...current,
      folders: current.folders.filter((entry) => !goneFolders.has(entry.id)),
      folderId: nextFolderId,
      columns: homeView ? homeView.columns : current.columns,
      direction: homeView ? homeView.direction : current.direction,
      views,
      hiddenFolderIds: nextHidden,
      items: current.items.filter((item) => !goneImages.has(item.id)),
      pendingAdd: current.pendingAdd && doomed.has(current.pendingAdd.parentId) ? null : current.pendingAdd,
    };
  });
  persistedKey = orderKey(state.items);
  if (folderError) pushNotice(storageErrorMessage(folderError, "delete"));
  try {
    if (previousHidden.join("|") !== nextHidden.join("|")) await writeKv("folderHidden", JSON.stringify(nextHidden));
    if (previousId !== nextFolderId) await writeKv("folder", nextFolderId);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function moveImageToFolder(id: string, folderId: string): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const item = state.items.find((entry) => entry.id === id);
  const destination = state.folders.find((folder) => folder.id === folderId);
  if (!item || item.folderId === folderId || !destination) return;
  if (destination.isParent) {
    pushNotice("親フォルダには画像を入れられません。子フォルダへドロップしてください。");
    return;
  }
  const next = { ...item, folderId };
  const previous = state.items;
  setState((current) => ({
    ...current,
    items: current.items.map((entry) => (entry.id === id ? next : entry)),
  }));
  try {
    await putMeta(next);
    persistedKey = orderKey(state.items);
  } catch (error) {
    setState((current) => ({ ...current, items: previous }));
    persistedKey = orderKey(previous);
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveCanvasSplit(share: number): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const next = Math.round(share * 10000) / 10000;
  if (!Number.isFinite(next) || next <= 0 || next >= 1) return;
  setState((current) => ({ ...current, canvasSplit: next }));
  try {
    await writeKv("canvasSplit", next);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveFolderWidth(width: number): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const next = Math.min(420, Math.max(180, Math.round(width)));
  setState((current) => ({ ...current, folderWidth: next }));
  try {
    await writeKv("folderWidth", next);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveFolderPane(height: number): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  const next = Math.min(720, Math.max(140, Math.round(height)));
  setState((current) => ({ ...current, folderPane: next }));
  try {
    await writeKv("folderPane", next);
  } catch (error) {
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveFavoritesOnly(on: boolean): Promise<void> {
  if (!userWritesOpen()) return;
  setState((current) => ({ ...current, favoritesOnly: on }));
  try {
    await writeKv("favoritesOnly", on ? 1 : 0);
  } catch (error) {
    setState((current) => ({ ...current, favoritesOnly: !on }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}

export async function saveFolderOpen(open: boolean): Promise<void> {
  if (viewerLock || !userWritesOpen()) return;
  setState((current) => ({ ...current, folderOpen: open }));
  try {
    await writeKv("folderOpen", open ? 1 : 0);
  } catch (error) {
    setState((current) => ({ ...current, folderOpen: !open }));
    pushNotice(storageErrorMessage(error, "save"));
  }
}
