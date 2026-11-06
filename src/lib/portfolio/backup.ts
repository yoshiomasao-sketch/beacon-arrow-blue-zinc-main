import type { Folder, FolderView, ImageMeta, Tag, TagFolder } from "./types.ts";
import { ALL_FOLDERS, DEFAULT_FOLDER_VIEW } from "./types.ts";
import { normalizeFolderView, normalizeFolders, normalizeMeta, normalizeTag, normalizeTagFolder } from "./logic.ts";

export const BACKUP_MAGIC = "KMCHOBK1";
export const BACKUP_VERSION = 1;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export type BackupImageRecord = {
  meta: ImageMeta;
  originalBytes: number;
  originalType: string;
  thumbBytes: number;
  thumbType: string | null;
  /** Omitted by backups saved before ink layers existed. */
  inkBytes?: number;
  inkType?: string | null;
};

export type BackupSetting = { key: string; value: string | number };

export type BackupView = { id: string } & FolderView;

export type BackupManifest = {
  format: "komacho-backup";
  version: number;
  createdAt: string;
  images: BackupImageRecord[];
  folders: Folder[];
  folderViews: BackupView[];
  tags: Tag[];
  tagFolders: TagFolder[];
  settings: BackupSetting[];
  /** Omitted when the A4 canvas is blank. Separate from image ink. */
  canvas?: { bytes: number; type: string } | null;
  /** Drop-time picture+memo composites, after the sheet bytes. Omitted by older backups. */
  flats?: { id: string; bytes: number; type: string }[];
};

export type BackupSummary = {
  images: number;
  videos: number;
  folders: number;
  tags: number;
  tagFolders: number;
  favorites: number;
  bytes: number;
  createdAt: string;
};

export type ParsedBackup = {
  manifest: BackupManifest;
  images: { meta: ImageMeta; original: Blob; thumb: Blob | null; ink: Blob | null }[];
  /** A4 canvas drawing. Null when the backup has none. */
  canvas?: Blob | null;
  /** Picture+memo composites keyed by placement id. Empty when the backup has none. */
  flats?: { id: string; png: Blob }[];
  summary: BackupSummary;
};

export function isBackupFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".kmb");
}

/** A new library: one empty folder and no media. Other tabs and swap slots are not part of this record. */
export function emptyLibraryBackup(folder: Folder): ParsedBackup {
  const createdAt = new Date(folder.createdAt).toISOString();
  const view = { ...DEFAULT_FOLDER_VIEW };
  return {
    summary: {
      images: 0,
      videos: 0,
      folders: 1,
      tags: 0,
      tagFolders: 0,
      favorites: 0,
      bytes: 0,
      createdAt,
    },
    images: [],
    canvas: null,
    manifest: {
      format: "komacho-backup",
      version: BACKUP_VERSION,
      createdAt,
      images: [],
      folders: [folder],
      folderViews: [
        { id: folder.id, ...view },
        { id: ALL_FOLDERS, ...view },
      ],
      tags: [],
      tagFolders: [],
      settings: [{ key: "folder", value: ALL_FOLDERS }],
    },
  };
}

export type LibraryDump = {
  metas: ImageMeta[];
  blobs: ReadonlyMap<string, { original: Blob; thumb: Blob | null }>;
  folders: Folder[];
  views: BackupView[];
  tags: Tag[];
  tagFolders: TagFolder[];
  settings: BackupSetting[];
  /** Drawings keyed by image id. Omitted when nothing was drawn. */
  inks?: ReadonlyMap<string, Blob>;
  /** A4 canvas. Not an image memo. */
  canvas?: Blob | null;
  /** Picture+memo composites keyed by placement id. Not image ink and not the sheet. */
  flats?: ReadonlyMap<string, Blob>;
};

export type BackupReadProgress = {
  stage: "header" | "manifest" | "verify";
  done: number;
  total: number;
};

export class RestoreFailure extends Error {
  readonly stage: string;
  readonly fileBytes: number;
  readonly saved: number;
  readonly total: number;
  readonly elapsedMs: number;
  readonly reasonName: string;
  readonly detail: string;

  constructor(stage: string, fileBytes: number, saved: number, total: number, elapsedMs: number, cause: unknown, detail = "") {
    super(detail || (cause instanceof Error ? cause.message : "復元に失敗しました。"));
    this.name = "RestoreFailure";
    this.stage = stage;
    this.fileBytes = fileBytes;
    this.saved = saved;
    this.total = total;
    this.elapsedMs = elapsedMs;
    this.reasonName = cause instanceof Error ? cause.name : "Error";
    this.detail = detail || (cause instanceof Error ? cause.message : "");
  }
}

function byteLength(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function uniqueIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new BackupError(`${label}のIDが重複しています。`);
}

export function validateManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== "object") throw new BackupError("バックアップの内容を読めませんでした。");
  const row = raw as Partial<BackupManifest>;
  if (row.format !== "komacho-backup") throw new BackupError("バックアップファイルではありません。");
  if (row.version !== BACKUP_VERSION) throw new BackupError("このバックアップ形式には対応していません。");
  if (typeof row.createdAt !== "string" || !row.createdAt) throw new BackupError("作成日時がありません。");
  if (!Array.isArray(row.images) || !Array.isArray(row.folders) || !Array.isArray(row.folderViews)) {
    throw new BackupError("必要なデータが足りません。");
  }
  if (!Array.isArray(row.tags) || !Array.isArray(row.tagFolders) || !Array.isArray(row.settings)) {
    throw new BackupError("必要なデータが足りません。");
  }

  const images: BackupImageRecord[] = row.images.map((entry) => {
    if (!entry || typeof entry !== "object") throw new BackupError("画像の情報が不正です。");
    const image = entry as Partial<BackupImageRecord>;
    const meta = normalizeMeta(image.meta);
    if (!meta) throw new BackupError("画像の情報が不正です。");
    const originalBytes = byteLength(image.originalBytes);
    const thumbBytes = byteLength(image.thumbBytes);
    if (originalBytes < 1) throw new BackupError(`「${meta.name}」の画像データがありません。`);
    if (thumbBytes < 0) throw new BackupError(`「${meta.name}」のサムネイル情報が不正です。`);
    if (typeof image.originalType !== "string") throw new BackupError(`「${meta.name}」の形式が不正です。`);
    if (image.thumbType !== null && typeof image.thumbType !== "string") throw new BackupError(`「${meta.name}」のサムネイル形式が不正です。`);
    const inkBytes = image.inkBytes === undefined ? 0 : byteLength(image.inkBytes);
    if (inkBytes < 0) throw new BackupError(`「${meta.name}」の書き込み情報が不正です。`);
    if (inkBytes > 0 && image.inkType != null && typeof image.inkType !== "string") {
      throw new BackupError(`「${meta.name}」の書き込み形式が不正です。`);
    }
    return {
      meta,
      originalBytes,
      originalType: image.originalType || meta.mime,
      thumbBytes,
      thumbType: thumbBytes > 0 ? image.thumbType || "image/jpeg" : null,
      inkBytes,
      inkType: inkBytes > 0 ? image.inkType || "image/png" : null,
    };
  });
  uniqueIds(images.map((image) => image.meta.id), "画像");

  const folders = normalizeFolders(row.folders);
  if (folders.length !== row.folders.length) throw new BackupError("フォルダ情報が不正です。");
  uniqueIds(folders.map((folder) => folder.id), "フォルダ");

  const tags = row.tags.map((entry) => {
    const tag = normalizeTag(entry);
    if (!tag) throw new BackupError("タグ情報が不正です。");
    return tag;
  });
  uniqueIds(tags.map((tag) => tag.id), "タグ");

  const tagFolders = row.tagFolders.map((entry) => {
    const folder = normalizeTagFolder(entry);
    if (!folder) throw new BackupError("タグフォルダの情報が不正です。");
    return folder;
  });
  uniqueIds(tagFolders.map((folder) => folder.id), "タグフォルダ");

  const folderViews: BackupView[] = row.folderViews.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string" || !(entry as { id: string }).id) {
      throw new BackupError("表示設定が不正です。");
    }
    const id = (entry as { id: string }).id;
    return { id, ...normalizeFolderView(entry) };
  });
  uniqueIds(folderViews.map((view) => view.id), "表示設定");

  const settings: BackupSetting[] = row.settings.map((entry) => {
    if (!entry || typeof entry !== "object") throw new BackupError("設定が不正です。");
    const setting = entry as Partial<BackupSetting>;
    if (typeof setting.key !== "string" || !setting.key) throw new BackupError("設定が不正です。");
    if (typeof setting.value !== "string" && typeof setting.value !== "number") throw new BackupError("設定が不正です。");
    return { key: setting.key, value: setting.value };
  });
  uniqueIds(settings.map((setting) => setting.key), "設定");

  let canvas: BackupManifest["canvas"];
  const rawCanvas = (row as { canvas?: unknown }).canvas;
  if (rawCanvas != null) {
    if (typeof rawCanvas !== "object") throw new BackupError("キャンバスの情報が不正です。");
    const bytes = byteLength((rawCanvas as { bytes?: unknown }).bytes);
    if (bytes < 0) throw new BackupError("キャンバスの情報が不正です。");
    const type = (rawCanvas as { type?: unknown }).type;
    if (bytes > 0 && type != null && typeof type !== "string") throw new BackupError("キャンバスの形式が不正です。");
    if (bytes > 0) canvas = { bytes, type: typeof type === "string" && type ? type : "image/png" };
  }

  let flats: BackupManifest["flats"];
  const rawFlats = (row as { flats?: unknown }).flats;
  if (rawFlats != null) {
    if (!Array.isArray(rawFlats)) throw new BackupError("キャンバス配置画像の情報が不正です。");
    const seen = new Set<string>();
    const next: { id: string; bytes: number; type: string }[] = [];
    for (const entry of rawFlats) {
      if (!entry || typeof entry !== "object") throw new BackupError("キャンバス配置画像の情報が不正です。");
      const flat = entry as { id?: unknown; bytes?: unknown; type?: unknown };
      if (typeof flat.id !== "string" || !flat.id || seen.has(flat.id)) throw new BackupError("キャンバス配置画像の情報が不正です。");
      const bytes = byteLength(flat.bytes);
      if (bytes < 1) throw new BackupError("キャンバス配置画像の情報が不正です。");
      if (flat.type != null && typeof flat.type !== "string") throw new BackupError("キャンバス配置画像の形式が不正です。");
      seen.add(flat.id);
      next.push({ id: flat.id, bytes, type: typeof flat.type === "string" && flat.type ? flat.type : "image/png" });
    }
    if (next.length > 0) flats = next;
  }

  return {
    format: "komacho-backup",
    version: BACKUP_VERSION,
    createdAt: row.createdAt,
    images,
    folders,
    folderViews,
    tags,
    tagFolders,
    settings,
    ...(canvas ? { canvas } : {}),
    ...(flats ? { flats } : {}),
  };
}

export function packBackup(manifest: BackupManifest, binaries: Blob[]): Blob {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  if (json.byteLength > MAX_MANIFEST_BYTES) throw new BackupError("設定データが大きすぎます。");
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(BACKUP_MAGIC));
  new DataView(header.buffer).setUint32(8, json.byteLength, true);
  return new Blob([header, json, ...binaries], { type: "application/octet-stream" });
}

export function summarize(manifest: BackupManifest, bytes: number): BackupSummary {
  return {
    images: manifest.images.length,
    videos: manifest.images.filter((image) => image.meta.mime.startsWith("video/")).length,
    folders: manifest.folders.length,
    tags: manifest.tags.length,
    tagFolders: manifest.tagFolders.length,
    favorites: manifest.images.filter((image) => image.meta.favorite).length,
    bytes,
    createdAt: manifest.createdAt,
  };
}

export function buildBackup(dump: LibraryDump, createdAt = new Date()): { file: Blob; summary: BackupSummary } {
  const missing = dump.metas.filter((meta) => !(dump.blobs.get(meta.id)?.original instanceof Blob));
  if (missing.length > 0) {
    throw new BackupError(`画像データが${missing.length}件足りないため、バックアップを作成できませんでした。保存データは変更していません。`);
  }
  const images: BackupImageRecord[] = [];
  const binaries: Blob[] = [];
  for (const meta of dump.metas) {
    const row = dump.blobs.get(meta.id)!;
    const thumb = row.thumb instanceof Blob && row.thumb.size > 0 ? row.thumb : null;
    const ink = dump.inks?.get(meta.id);
    const inkBlob = ink instanceof Blob && ink.size > 0 ? ink : null;
    images.push({
      meta,
      originalBytes: row.original.size,
      originalType: row.original.type || meta.mime,
      thumbBytes: thumb?.size ?? 0,
      thumbType: thumb ? thumb.type || "image/jpeg" : null,
      inkBytes: inkBlob?.size ?? 0,
      inkType: inkBlob ? "image/png" : null,
    });
    binaries.push(row.original);
    if (thumb) binaries.push(thumb);
    if (inkBlob) binaries.push(inkBlob);
  }
  const canvas = dump.canvas instanceof Blob && dump.canvas.size > 0 ? dump.canvas : null;
  if (canvas) binaries.push(canvas);
  const flatRows = [...(dump.flats?.entries() ?? [])]
    .filter((entry): entry is [string, Blob] => entry[0].length > 0 && entry[1] instanceof Blob && entry[1].size > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, blob] of flatRows) binaries.push(blob);
  const manifest: BackupManifest = {
    format: "komacho-backup",
    version: BACKUP_VERSION,
    createdAt: createdAt.toISOString(),
    images,
    folders: dump.folders,
    folderViews: dump.views,
    tags: dump.tags,
    tagFolders: dump.tagFolders,
    settings: dump.settings,
    ...(canvas ? { canvas: { bytes: canvas.size, type: "image/png" } } : {}),
    ...(flatRows.length > 0 ? { flats: flatRows.map(([id, blob]) => ({ id, bytes: blob.size, type: "image/png" })) } : {}),
  };
  const file = packBackup(manifest, binaries);
  return { file, summary: summarize(manifest, file.size) };
}

export function backupFileName(createdAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `komacho-backup-${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}-${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}.kmb`;
}

/** Groups image bodies so one IndexedDB transaction stays small enough for a phone. */
export function batchImageIndexes(sizes: readonly number[], maxBytes = 4 * 1024 * 1024, maxCount = 12): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const size = Math.max(0, sizes[index] ?? 0);
    const alone = size > maxBytes;
    if (current.length > 0 && (alone || current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(index);
    bytes += size;
    if (alone || current.length >= maxCount || bytes >= maxBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function readBackup(file: Blob, onProgress?: (progress: BackupReadProgress) => void): Promise<ParsedBackup> {
  if (file.size < 12) throw new BackupError("バックアップファイルではありません。");
  onProgress?.({ stage: "header", done: 0, total: file.size });
  const headBytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const magic = new TextDecoder().decode(headBytes.subarray(0, 8));
  if (magic !== BACKUP_MAGIC) throw new BackupError("バックアップファイルではありません。");
  const jsonLength = new DataView(headBytes.buffer).getUint32(8, true);
  if (jsonLength < 2 || jsonLength > MAX_MANIFEST_BYTES || 12 + jsonLength > file.size) {
    throw new BackupError("ファイルが途中で切れています。");
  }
  onProgress?.({ stage: "manifest", done: 12, total: file.size });
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await file.slice(12, 12 + jsonLength).arrayBuffer()));
  } catch {
    throw new BackupError("バックアップの内容を読めませんでした。");
  }
  const manifest = validateManifest(raw);
  let offset = 12 + jsonLength;
  const images: ParsedBackup["images"] = [];
  onProgress?.({ stage: "verify", done: 0, total: manifest.images.length });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < manifest.images.length; index += 1) {
    const image = manifest.images[index]!;
    const originalEnd = offset + image.originalBytes;
    const thumbEnd = originalEnd + image.thumbBytes;
    const inkEnd = thumbEnd + (image.inkBytes ?? 0);
    if (inkEnd > file.size) throw new BackupError("画像データが途中で切れています。");
    images.push({
      meta: image.meta,
      original: file.slice(offset, originalEnd, image.originalType || image.meta.mime),
      thumb: image.thumbBytes > 0 ? file.slice(originalEnd, thumbEnd, image.thumbType || "image/jpeg") : null,
      ink: (image.inkBytes ?? 0) > 0 ? file.slice(thumbEnd, inkEnd, image.inkType || "image/png") : null,
    });
    offset = inkEnd;
    if (onProgress && index > 0 && index % 100 === 0) {
      onProgress({ stage: "verify", done: index, total: manifest.images.length });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const canvasBytes = manifest.canvas?.bytes ?? 0;
  let canvas: Blob | null = null;
  if (canvasBytes > 0) {
    const canvasEnd = offset + canvasBytes;
    if (canvasEnd > file.size) throw new BackupError("キャンバスのデータが途中で切れています。");
    canvas = file.slice(offset, canvasEnd, manifest.canvas?.type || "image/png");
    offset = canvasEnd;
  }
  const flats: { id: string; png: Blob }[] = [];
  for (const record of manifest.flats ?? []) {
    const end = offset + record.bytes;
    if (end > file.size) throw new BackupError("キャンバス配置画像のデータが途中で切れています。");
    flats.push({ id: record.id, png: file.slice(offset, end, record.type || "image/png") });
    offset = end;
  }
  if (offset !== file.size) throw new BackupError("ファイルの長さが記録と一致しません。");
  onProgress?.({ stage: "verify", done: manifest.images.length, total: manifest.images.length });
  return { manifest, images, canvas, flats, summary: summarize(manifest, file.size) };
}
