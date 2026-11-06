import { ALL_FOLDERS, DEFAULT_FOLDER_VIEW, SUPPORTED_MIMES, TAG_COLORS, type DisplayScale, type Folder, type FolderView, type ImageMeta, type ImageSource, type SupportedMime, type Tag, type TagFolder } from "./types.ts";

export type ImageCandidate = {
  name: string;
  type: string;
  size: number;
};

export type ClassifyResult =
  | { ok: true; mime: SupportedMime }
  | { ok: false; reason: "empty" | "type" };

const EXTENSIONS: Record<string, SupportedMime> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function baseName(name: string): string {
  const trimmed = name.trim();
  const cut = trimmed.split(/[/\\]/).pop()?.trim() ?? "";
  return cut || "無題";
}

export function classifyImageInput(file: ImageCandidate): ClassifyResult {
  if (file.size <= 0) return { ok: false, reason: "empty" };

  const type = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "image/jpg" || type === "image/pjpeg") return { ok: true, mime: "image/jpeg" };
  if (type === "video/mp4" || type === "video/webm") return { ok: true, mime: type };
  if ((SUPPORTED_MIMES as readonly string[]).includes(type)) {
    return { ok: true, mime: type as SupportedMime };
  }
  if (type && type !== "application/octet-stream") return { ok: false, reason: "type" };

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = EXTENSIONS[ext];
  if (!mime) return { ok: false, reason: "type" };
  return { ok: true, mime };
}

export function sortByOrder<T extends { order: number; addedAt: number }>(items: T[]): T[] {
  return items.slice().sort((a, b) => a.order - b.order || a.addedAt - b.addedAt);
}

/** Screen, lightbox, and PDF share this list. Stored order stays oldest-first. */
export function readingSequence<T extends { order: number; addedAt: number }>(
  items: T[],
  direction: "asc" | "desc",
): T[] {
  const sorted = sortByOrder(items);
  if (direction === "desc") sorted.reverse();
  return sorted;
}

export type ImportStats = {
  added: number;
  skippedType: number;
  skippedEmpty: number;
  failedDecode: number;
  failedSave: number;
  quota: boolean;
};

export function importNotice(stats: ImportStats): string | null {
  const problems =
    stats.skippedType + stats.skippedEmpty + stats.failedDecode + stats.failedSave;
  if (problems === 0) return null;

  const parts: string[] = [];
  if (stats.added > 0) parts.push(`${stats.added}枚は追加しました。`);
  if (stats.quota) {
    parts.push("保存容量が不足している可能性があります。「容量」で使用量を確認し、不要な画像を削除してから、もう一度追加してください。画像は自動では削除しません。");
  } else if (stats.failedSave > 0) {
    parts.push(`${stats.failedSave}枚を保存できませんでした。`);
  }
  if (stats.failedDecode > 0) {
    parts.push(`${stats.failedDecode}枚は画像として読み込めませんでした。`);
  }
  if (stats.skippedType > 0) {
    parts.push(`${stats.skippedType}件は対応外の形式です。JPEG、PNG、GIF、WebPのみ追加できます。`);
  }
  if (stats.skippedEmpty > 0) parts.push(`${stats.skippedEmpty}件は空のファイルでした。`);
  return parts.join("");
}

export function storageErrorMessage(error: unknown, action: "save" | "delete" | "open"): string {
  const name =
    (typeof DOMException !== "undefined" && error instanceof DOMException) || error instanceof Error
      ? error.name
      : "";
  if (name === "QuotaExceededError") {
    return "保存容量が不足しています。「容量」で使用量を確認し、不要な画像を削除してから、もう一度追加してください。画像は自動では削除しません。";
  }
  if (action === "delete") return "削除を保存できませんでした。画像はそのまま残しています。";
  if (action === "open") {
    return "画像ライブラリを開けませんでした。このブラウザでは保存機能が使えないことがあります。";
  }
  return "保存に失敗しました。容量が足りない可能性があります。「容量」で使用量を確認し、不要な画像を削除してからもう一度試してください。画像は自動では削除しません。";
}

export function formatCount(count: number): string {
  return `${count}枚`;
}

export function statusLabel(
  count: number,
  importing: { done: number; total: number } | null,
): string {
  if (!importing) return formatCount(count);
  return `${formatCount(count)} · 保存中 ${importing.done}/${importing.total}`;
}

export function normalizeScale(value: unknown): DisplayScale {
  return value === 2 || value === 3 ? value : 1;
}

export function normalizeMeta(raw: unknown): ImageMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ImageMeta>;
  if (typeof row.id !== "string" || !row.id) return null;
  if (
    row.mime !== "image/jpeg" &&
    row.mime !== "image/png" &&
    row.mime !== "image/webp" &&
    row.mime !== "image/gif" &&
    row.mime !== "video/mp4" &&
    row.mime !== "video/webm"
  ) {
    return null;
  }
  const source: ImageSource =
    row.source === "clipboard" || row.source === "capture" ? row.source : "file";
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name ? row.name : "無題",
    mime: row.mime,
    width: typeof row.width === "number" ? row.width : 0,
    height: typeof row.height === "number" ? row.height : 0,
    byteSize: typeof row.byteSize === "number" ? row.byteSize : 0,
    addedAt: typeof row.addedAt === "number" ? row.addedAt : 0,
    order: typeof row.order === "number" ? row.order : 0,
    scale: normalizeScale(row.scale),
    source,
    folderId: typeof row.folderId === "string" ? row.folderId : "",
    favorite: row.favorite === true,
    tagIds: Array.isArray(row.tagIds)
      ? [...new Set(row.tagIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [],
    animated: row.animated === true,
    memo: normalizeMemo(row.memo),
    inkVisible: row.inkVisible === false ? false : true,
  };
}

export function normalizeMemo(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 100);
}

/** Empty text cancels a new note and clears one that already existed. */
export function commitMemo(original: string, draft: string): "cancel" | "save" | "clear" {
  const next = normalizeMemo(draft);
  if (!next) return normalizeMemo(original) ? "clear" : "cancel";
  return "save";
}

export function parseActiveTagIds(raw: string, known: ReadonlySet<string>): string[] {
  if (!raw) return [];
  let ids: string[] = [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch {
      ids = [];
    }
  } else {
    ids = [raw];
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function hasEveryTag(tagIds: readonly string[], required: readonly string[]): boolean {
  return required.every((id) => tagIds.includes(id));
}

export type TagMatch = "all" | "any";

/** Missing or unknown values stay on the original AND match. */
export function normalizeTagMatch(value: unknown): TagMatch {
  return value === "any" ? "any" : "all";
}

export function passesTagFilter(
  tagIds: readonly string[],
  required: readonly string[],
  hidden: readonly string[],
  match: TagMatch = "all",
): boolean {
  if (hidden.some((id) => tagIds.includes(id))) return false;
  if (required.length === 0) return true;
  if (normalizeTagMatch(match) === "any") return required.some((id) => tagIds.includes(id));
  return hasEveryTag(tagIds, required);
}

/** Tags that belong to one tag folder, and the image links that must drop those tags. */
export function planTagFolderRemoval(input: {
  folderId: string;
  tags: readonly { id: string; folderId: string | null }[];
  items: readonly { id: string; tagIds: readonly string[] }[];
  activeTagIds: readonly string[];
  hiddenTagIds: readonly string[];
}): { tagIds: string[]; items: { id: string; tagIds: string[] }[]; activeTagIds: string[]; hiddenTagIds: string[] } {
  const doomed = new Set(input.tags.filter((tag) => tag.folderId === input.folderId).map((tag) => tag.id));
  return {
    tagIds: [...doomed],
    items: input.items.flatMap((item) => {
      if (!item.tagIds.some((id) => doomed.has(id))) return [];
      return [{ id: item.id, tagIds: item.tagIds.filter((id) => !doomed.has(id)) }];
    }),
    activeTagIds: input.activeTagIds.filter((id) => !doomed.has(id)),
    hiddenTagIds: input.hiddenTagIds.filter((id) => !doomed.has(id)),
  };
}

/** Same comparison the tag list uses inside one folder, and for tags with no folder. */
export function compareTagOrder(a: { order: number; createdAt: number }, b: { order: number; createdAt: number }): number {
  return a.order - b.order || a.createdAt - b.createdAt;
}

/**
 * Tags in the right-hand list's top-to-bottom order.
 * Folders stay in the order they are shown, then tags that belong to no folder.
 */
export function tagsInRailOrder<T extends { order: number; createdAt: number; folderId: string | null }>(
  tags: readonly T[],
  folders: readonly { id: string }[],
): T[] {
  const groups = new Map<string | null, T[]>();
  for (const tag of tags) {
    const key = tag.folderId ?? null;
    const list = groups.get(key);
    if (list) list.push(tag);
    else groups.set(key, [tag]);
  }
  const take = (key: string | null) => (groups.get(key) ?? []).slice().sort(compareTagOrder);
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const folder of folders) {
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    ordered.push(...take(folder.id));
  }
  ordered.push(...take(null));
  for (const [key, list] of groups) {
    if (key !== null && !seen.has(key)) ordered.push(...list.slice().sort(compareTagOrder));
  }
  return ordered;
}

export function normalizeTag(raw: unknown): Tag | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<Tag>;
  if (typeof row.id !== "string" || !row.id) return null;
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const color = typeof row.color === "string" && TAG_COLORS.includes(row.color as (typeof TAG_COLORS)[number]) ? row.color : TAG_COLORS[0];
  return {
    id: row.id,
    name,
    color,
    order: typeof row.order === "number" ? row.order : 0,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    folderId: typeof row.folderId === "string" && row.folderId ? row.folderId : null,
  };
}

export function normalizeTagFolder(raw: unknown): TagFolder | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<TagFolder>;
  if (typeof row.id !== "string" || !row.id) return null;
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 40) : "";
  if (!name) return null;
  return {
    id: row.id,
    name,
    order: typeof row.order === "number" ? row.order : 0,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    open: row.open !== false,
  };
}

export function assignVisibleOrders<T extends { id: string; order: number }>(
  items: T[],
  visibleIds: string[],
): T[] | null {
  const visible = new Set(visibleIds);
  const slots = items
    .filter((item) => visible.has(item.id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (slots.length !== visibleIds.length || new Set(visibleIds).size !== visibleIds.length) return null;
  if (slots.map((item) => item.id).join("|") === visibleIds.join("|")) return null;
  const orders = slots.map((item) => item.order);
  const nextOrder = new Map(visibleIds.map((id, index) => [id, orders[index]!]));
  return items.map((item) => {
    const order = nextOrder.get(item.id);
    return order === undefined ? item : { ...item, order };
  });
}

/** Unbiased Fisher–Yates. The input list is not changed. */
export function shuffleIds(ids: readonly string[], random: () => number = Math.random): string[] {
  const next = ids.slice();
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = next[index]!;
    next[index] = next[swap]!;
    next[swap] = current;
  }
  return next;
}

/** Newest registration first. Missing or non-positive addedAt stays unknown and follows the dated images. */
export function addedDateOrder<T extends { id: string; addedAt: number }>(items: readonly T[]): string[] {
  const ranked = items.map((item, index) => ({ item, index }));
  const known = ranked.filter((entry) => Number.isFinite(entry.item.addedAt) && entry.item.addedAt > 0);
  const unknown = ranked.filter((entry) => !known.includes(entry));
  known.sort((a, b) => b.item.addedAt - a.item.addedAt || a.index - b.index);
  return [...known, ...unknown].map((entry) => entry.item.id);
}

export function folderOrderAfterMove(ids: string[], sourceId: string, beforeId: string | null): string[] | null {
  if (!ids.includes(sourceId) || (beforeId !== null && !ids.includes(beforeId)) || beforeId === sourceId) return null;
  const next = ids.filter((id) => id !== sourceId);
  const at = beforeId === null ? next.length : next.indexOf(beforeId);
  next.splice(at, 0, sourceId);
  if (next.join("|") === ids.join("|")) return null;
  return next;
}

export function normalizeFolders(raw: unknown[]): Folder[] {
  const parsed = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Partial<Folder>;
    if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name.trim()) return [];
    const parentId = typeof row.parentId === "string" && row.parentId && row.parentId !== row.id ? row.parentId : null;
    return [
      {
        id: row.id,
        name: row.name,
        order: typeof row.order === "number" ? row.order : 0,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
        parentId,
        isParent: row.isParent === true,
        color: typeof row.color === "string" && row.color.trim() ? row.color : null,
      },
    ];
  });
  const ids = new Set(parsed.map((folder) => folder.id));
  const linked = parsed.map((folder) => ({
    ...folder,
    parentId: folder.parentId && ids.has(folder.parentId) ? folder.parentId : null,
  }));
  const byId = new Map(linked.map((folder) => [folder.id, folder]));
  return linked.map((folder) => {
    const seen = new Set<string>([folder.id]);
    let parent = folder.parentId;
    while (parent) {
      if (seen.has(parent) || !byId.has(parent)) return { ...folder, parentId: null };
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    return folder;
  });
}

export function folderChildren(folders: readonly Folder[], parentId: string | null): Folder[] {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export function flattenFolders(folders: readonly Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of folderChildren(folders, parentId)) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function folderAncestors(folders: readonly Folder[], id: string): Folder[] {
  const out: Folder[] = [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    out.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return out;
}

/** New folder ids that should stay hidden because their source folders were hidden. */
export function copiedFolderHiddenIds(sourceHiddenIds: readonly string[], folderIdMap: ReadonlyMap<string, string>): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of sourceHiddenIds) {
    const copied = folderIdMap.get(id);
    if (!copied || seen.has(copied)) continue;
    seen.add(copied);
    next.push(copied);
  }
  return next;
}

/** Top and bottom 30% reorder beside the row. The middle nests into it. */
export function folderDropBand(ratio: number): "before" | "after" | "into" {
  if (ratio < 0.3) return "before";
  if (ratio > 0.7) return "after";
  return "into";
}
export function folderWouldCycle(folders: readonly Folder[], sourceId: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (parentId === sourceId) return true;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<string>([sourceId]);
  let current: string | null = parentId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

export function descendantFolderIds(folders: readonly Folder[], rootId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const child of folderChildren(folders, id)) {
      out.push(child.id);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

export function storedImageCount(items: readonly { id: string; folderId: string }[], folderIds: readonly string[]): number {
  const ids = new Set(folderIds);
  const seen = new Set<string>();
  let count = 0;
  for (const item of items) {
    if (!ids.has(item.folderId) || seen.has(item.id)) continue;
    seen.add(item.id);
    count += 1;
  }
  return count;
}

export function folderPath(folders: readonly Folder[], id: string): string {
  const self = folders.find((folder) => folder.id === id);
  if (!self) return "";
  return [...folderAncestors(folders, id), self].map((folder) => folder.name).join(" / ");
}

export function imageFolderChoices(folders: readonly Folder[], parentId: string): Folder[] {
  return descendantFolderIds(folders, parentId).flatMap((id) => {
    const folder = folders.find((entry) => entry.id === id);
    return folder && !folder.isParent ? [folder] : [];
  });
}

export const PARENT_COLORS = ["#e07a5f", "#81b29a", "#7eb6d6", "#e6c35c", "#c38d9e", "#b8a1e3", "#6fbfc9", "#d4b483", "#f2a7c3", "#a3c47a", "#e0986a", "#8aa4e0"] as const;

export function pickParentColor(used: readonly string[]): string {
  const taken = new Set(used.map((color) => color.toLowerCase()));
  const free = PARENT_COLORS.find((color) => !taken.has(color.toLowerCase()));
  if (free) return free;
  for (let step = 0; step < 360; step += 1) {
    const color = `hsl(${(used.length * 47 + step) % 360} 58% 58%)`;
    if (!taken.has(color.toLowerCase())) return color;
  }
  return PARENT_COLORS[used.length % PARENT_COLORS.length] ?? PARENT_COLORS[0];
}

/** Marks empty folders that already contain children as parents, without moving images. */
export function settleParentFolders(folders: readonly Folder[], items: readonly { folderId: string }[]): Folder[] {
  const direct = new Map<string, number>();
  for (const item of items) direct.set(item.folderId, (direct.get(item.folderId) ?? 0) + 1);
  const used = folders.flatMap((folder) => (folder.color ? [folder.color] : []));
  return folders.map((folder) => {
    const children = folders.some((entry) => entry.parentId === folder.id);
    const count = direct.get(folder.id) ?? 0;
    const shouldParent = folder.isParent || (children && count === 0);
    if (!shouldParent) {
      if (!folder.isParent && !folder.color) return folder;
      return { ...folder, isParent: false, color: null };
    }
    if (folder.isParent && folder.color) return folder;
    const color = folder.color ?? pickParentColor(used);
    if (!folder.color) used.push(color);
    return { ...folder, isParent: true, color };
  });
}

export function scrollTopForCenter(
  scrollTop: number,
  scrollerTop: number,
  scrollerHeight: number,
  cardTop: number,
  cardHeight: number,
  sticky = 0,
): number {
  const room = Math.max(0, scrollerHeight - sticky);
  const delta = cardTop - scrollerTop - sticky - (room - cardHeight) / 2;
  return Math.max(0, scrollTop + delta);
}

export function exportFileName(name: string, mime: string): string {
  const ext =
    mime === "image/jpeg"
      ? "jpg"
      : mime === "image/webp"
        ? "webp"
        : mime === "image/gif"
          ? "gif"
          : mime === "video/mp4"
            ? "mp4"
            : mime === "video/webm"
              ? "webm"
              : "png";
  const trimmed = name.trim() || "image";
  const bare = trimmed.replace(/\.(jpe?g|png|webp|gif|mp4|webm)$/i, "");
  return `${bare}.${ext}`;
}

function hasAscii(bytes: Uint8Array, needle: string): boolean {
  const first = needle.charCodeAt(0);
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    if (bytes[index] !== first) continue;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle.charCodeAt(offset)) continue outer;
    }
    return true;
  }
  return false;
}

/** True when the file has more than one frame. Static GIF, PNG, and WebP stay false. */
export function isAnimatedImage(bytes: Uint8Array, mime: string): boolean {
  if (mime === "video/mp4" || mime === "video/webm") return true;
  if (mime === "image/gif") {
    let controls = 0;
    for (let index = 0; index < bytes.length - 1; index += 1) {
      if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9) {
        controls += 1;
        if (controls > 1) return true;
      }
    }
    return false;
  }
  if (mime === "image/png") return hasAscii(bytes, "acTL");
  if (mime === "image/webp") return hasAscii(bytes, "ANIM");
  return false;
}

export function clampColumns(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(6, Math.max(2, Math.round(value)));
}

export function normalizeFolderView(raw: unknown): FolderView {
  const row = raw && typeof raw === "object" ? (raw as Partial<FolderView>) : {};
  return {
    columns: clampColumns(typeof row.columns === "number" ? row.columns : DEFAULT_FOLDER_VIEW.columns),
    direction: row.direction === "asc" ? "asc" : "desc",
  };
}

/** How many shared columns fit. Preferred count is the saved unified height. */
export function fitColumns(preferred: number, contentPx: number, minTrack = 148, gap = 12): number {
  const pref = clampColumns(preferred);
  if (contentPx <= 0) return pref;
  const fit = Math.max(1, Math.floor((contentPx + gap) / (minTrack + gap)));
  return Math.max(1, Math.min(pref, fit));
}

export const GALLERY_GAP_PX = 8;

/** Empty space on each side of the gallery, used to start a range selection. */
export const GALLERY_GUTTER_PX = 120;

export type FlowItem = {
  id: string;
  width: number;
  height: number;
  scale: DisplayScale;
};

export type FlowBox = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Image ids whose boxes meet a drag rectangle. Touching an edge counts. */
export function boxesInRect(boxes: readonly FlowBox[], rect: { x: number; y: number; w: number; h: number }): string[] {
  const left = Math.min(rect.x, rect.x + rect.w);
  const right = Math.max(rect.x, rect.x + rect.w);
  const top = Math.min(rect.y, rect.y + rect.h);
  const bottom = Math.max(rect.y, rect.y + rect.h);
  return boxes
    .filter((box) => box.x < right && box.x + box.w > left && box.y < bottom && box.y + box.h > top)
    .map((box) => box.id);
}

/** Preferred row height. A square at scale 1 is about one column wide. */
export function baselineHeight(contentWidth: number, columns: number, gap = GALLERY_GAP_PX): number {
  const cols = Math.max(1, Math.round(columns));
  if (contentWidth <= 0) return 0;
  return Math.max(1, (contentWidth - gap * (cols - 1)) / cols);
}

export function rowGroups<T extends { x: number; y: number }>(spots: T[]): T[][] {
  const sorted = [...spots].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const spot of sorted) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs(last[0]!.y - spot.y) > 0.5) rows.push([spot]);
    else last.push(spot);
  }
  return rows;
}

export function orderAfterVisualMove(
  placements: { id: string; x: number; y: number }[],
  sourceId: string,
  targetId: string,
  descending: boolean,
): string[] | null {
  if (sourceId === targetId) return null;
  const rows = rowGroups(placements);
  const visual = rows.flat().map((spot) => spot.id);
  if (!visual.includes(sourceId) || !visual.includes(targetId)) return null;
  const next = visual.filter((id) => id !== sourceId);
  const index = next.indexOf(targetId);
  if (index < 0) return null;
  next.splice(index, 0, sourceId);
  return descending ? next.slice().reverse() : next;
}

export type InsertEdge = "before" | "after";

export type InsertMark = {
  id: string;
  edge: InsertEdge;
};

function rowIndexAt<T extends { y: number; h: number }>(rows: readonly (readonly T[])[], y: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const top = Math.min(...row.map((box) => box.y));
    const bottom = Math.max(...row.map((box) => box.y + box.h));
    const dist = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  }
  return best;
}

/** Where a vertical tag row would land. `rows` already excludes the tag being dragged. */
export function tagInsertIndex(
  rows: readonly { id: string; top: number; bottom: number }[],
  clientY: number,
): { index: number; marks: InsertMark[] } {
  if (rows.length === 0) return { index: 0, marks: [] };
  let index = rows.length;
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (clientY <= (row.top + row.bottom) / 2) {
      index = at;
      break;
    }
  }
  return { index, marks: insertMarks(rows, index) };
}

/** Yellow edges for one insertion slot. The dragged images are not in `rest`. */
export function insertMarks(rest: readonly { id: string }[], index: number): InsertMark[] {
  if (rest.length === 0) return [];
  const at = Math.max(0, Math.min(index, rest.length));
  if (at <= 0) return [{ id: rest[0]!.id, edge: "before" }];
  if (at >= rest.length) return [{ id: rest[rest.length - 1]!.id, edge: "after" }];
  return [
    { id: rest[at - 1]!.id, edge: "after" },
    { id: rest[at]!.id, edge: "before" },
  ];
}

/**
 * Where a drag would land in visual reading order, after the moving images are taken out.
 * Index 0 is before the first remaining image. Index `rest.length` is after the last.
 * `point` uses the same coordinates as the boxes.
 */
export function insertionAt(
  placements: readonly FlowBox[],
  movingIds: readonly string[],
  point: { x: number; y: number },
): { index: number; marks: InsertMark[] } | null {
  const moving = new Set(movingIds);
  const rest = rowGroups([...placements]).flat().filter((box) => !moving.has(box.id));
  if (rest.length === 0) return null;
  const rows = rowGroups(rest);
  const rowAt = rowIndexAt(rows, point.y);
  const row = rows[rowAt]!;
  let local = 0;
  for (let index = 0; index < row.length; index += 1) {
    const card = row[index]!;
    if (point.x >= card.x + card.w / 2) local = index + 1;
  }
  const before = rows.slice(0, rowAt).reduce((sum, entry) => sum + entry.length, 0);
  const index = before + local;
  return { index, marks: insertMarks(rest, index) };
}

/** Visual insertion, written back as stored oldest-first order.
 * Descending shows that sequence reversed, so the saved list is reversed once.
 */
export function orderFromInsertion(
  placements: readonly FlowBox[],
  movingIds: readonly string[],
  sourceId: string,
  index: number,
  descending: boolean,
): string[] | null {
  const moving = new Set(movingIds);
  if (!moving.has(sourceId)) return null;
  const visual = rowGroups([...placements]).flat().map((box) => box.id);
  if (!visual.includes(sourceId)) return null;
  const block = visual.filter((id) => moving.has(id));
  const rest = visual.filter((id) => !moving.has(id));
  if (rest.length === 0 || block.length === 0) return null;
  const at = Math.max(0, Math.min(index, rest.length));
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  if (next.join("|") === visual.join("|")) return null;
  return descending ? next.slice().reverse() : next;
}

/** Last row may grow to fill the width, but not past this multiple of the preferred height. */
export const LAST_ROW_MAX = 2;

function imageAspect(item: { width: number; height: number }): number {
  if (item.width > 0 && item.height > 0) return item.width / item.height;
  return 1;
}

/** Height that makes this row, including gaps, exactly as wide as the container. */
export function justifiedHeight(
  row: { width: number; height: number }[],
  contentWidth: number,
  gap: number,
): number {
  const sum = row.reduce((total, item) => total + imageAspect(item), 0);
  const gaps = gap * Math.max(0, row.length - 1);
  if (sum <= 0 || contentWidth <= gaps) return 0;
  return (contentWidth - gaps) / sum;
}

/**
 * Justified rows. Order is kept. Each full row is scaled so its images and
 * gaps land exactly on the container width, without cropping.
 * `lastRow: "match"` keeps the incomplete row at the previous row's height
 * and only shrinks it when it would overflow. The default still caps growth
 * with LAST_ROW_MAX so PDF pages keep their current packing.
 */
export function layoutFlow(
  items: FlowItem[],
  options: { contentWidth: number; columns: number; gap?: number; lastRow?: "cap" | "match" },
): { width: number; height: number; placements: FlowBox[] } {
  const gap = options.gap ?? GALLERY_GAP_PX;
  const contentWidth = options.contentWidth;
  if (contentWidth <= 0 || items.length === 0) {
    return { width: Math.max(0, contentWidth), height: 0, placements: [] };
  }
  const target = baselineHeight(contentWidth, options.columns, gap);
  const rows: FlowItem[][] = [];
  let row: FlowItem[] = [];

  const close = () => {
    if (row.length === 0) return;
    rows.push(row);
    row = [];
  };

  for (const item of items) {
    if (row.length > 0 && normalizeScale(item.scale) !== normalizeScale(row[0]!.scale)) close();
    const trial = [...row, item];
    const want = target * normalizeScale(item.scale);
    const trialHeight = justifiedHeight(trial, contentWidth, gap);
    if (row.length > 0 && trialHeight < want) {
      const currentHeight = justifiedHeight(row, contentWidth, gap);
      if (Math.abs(trialHeight - want) < Math.abs(currentHeight - want)) {
        row = trial;
        close();
      } else {
        close();
        row = [item];
      }
    } else {
      row = trial;
    }
  }

  const lines = row.length > 0 ? [...rows, row] : rows;
  const placements: FlowBox[] = [];
  let y = 0;
  let previousHeight = 0;
  let previousScale = 1;
  lines.forEach((line, index) => {
    const last = index === lines.length - 1;
    const fill = justifiedHeight(line, contentWidth, gap);
    const scale = normalizeScale(line[0]!.scale);
    const want = target * scale;
    let height = fill;
    if (last && options.lastRow === "match") {
      const basis = index === 0 ? want : previousHeight * (scale / previousScale);
      const aspects = line.reduce((total, item) => total + imageAspect(item), 0);
      const used = basis * aspects + gap * Math.max(0, line.length - 1);
      height = used > contentWidth + 0.01 ? fill : basis;
    } else if (last) {
      height = Math.min(fill, want * LAST_ROW_MAX);
    }
    let x = 0;
    for (const item of line) {
      const w = height * imageAspect(item);
      placements.push({ id: item.id, x, y, w, h: height });
      x += w + gap;
    }
    y += height + gap;
    previousHeight = height;
    previousScale = scale;
  });

  return {
    width: contentWidth,
    height: placements.length === 0 ? 0 : y - gap,
    placements,
  };
}

export type PageOrientation = "portrait" | "landscape";

export const A4_MM = {
  portrait: { width: 210, height: 297 },
  landscape: { width: 297, height: 210 },
} as const;

const PAGE_MARGIN_MM = 12;
const PAGE_GAP_MM = 2;

export type LayoutItem = {
  id: string;
  width: number;
  height: number;
  scale: DisplayScale;
};

export type Placement = {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PortfolioLayout = {
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
  placements: Placement[];
};

/**
 * Same height-based rows as the screen, then whole rows move to the next page.
 */
export function layoutPortfolio(
  items: LayoutItem[],
  options: { orientation: PageOrientation; columns: number },
): PortfolioLayout {
  const page = A4_MM[options.orientation];
  const contentW = page.width - PAGE_MARGIN_MM * 2;
  const contentH = page.height - PAGE_MARGIN_MM * 2;
  const flow = layoutFlow(items, { contentWidth: contentW, columns: options.columns, gap: PAGE_GAP_MM });

  const rows: FlowBox[][] = [];
  for (const place of flow.placements) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs((last[0]?.y ?? 0) - place.y) > 0.01) rows.push([place]);
    else last.push(place);
  }

  const placements: Placement[] = [];
  let pageIndex = 0;
  let y = 0;

  for (const row of rows) {
    const rowH = Math.max(...row.map((cell) => cell.h));
    let scale = 1;
    let usedH = rowH;
    if (usedH > contentH) {
      scale = contentH / usedH;
      usedH = contentH;
    }
    if (y > 0 && y + usedH > contentH + 0.01) {
      pageIndex += 1;
      y = 0;
    }
    for (const cell of row) {
      placements.push({
        id: cell.id,
        page: pageIndex,
        x: PAGE_MARGIN_MM + cell.x * scale,
        y: PAGE_MARGIN_MM + y,
        w: cell.w * scale,
        h: cell.h * scale,
      });
    }
    y += usedH + PAGE_GAP_MM * scale;
  }

  return {
    pageCount: rows.length === 0 ? 0 : pageIndex + 1,
    pageWidth: page.width,
    pageHeight: page.height,
    placements,
  };
}

export type PdfMode = "normal" | "fit";

export type PdfLayoutOptions = {
  orientation: PageOrientation;
  columns: number;
  mode?: PdfMode;
  marginMm?: number;
  gapMm?: number;
};

const FIT_MARGIN_MIN = 4;
const FIT_MARGIN_MAX = 24;
const FIT_GAP_MIN = 0;
const FIT_GAP_MAX = 8;

export function clampPdfMargin(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(FIT_MARGIN_MAX, Math.max(FIT_MARGIN_MIN, Math.round(value)));
}

export function clampPdfGap(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.min(FIT_GAP_MAX, Math.max(FIT_GAP_MIN, Math.round(value)));
}

/** Normal keeps the screen layout. Fit keeps those same rows and only eases page-break gaps. */
export function layoutForPdf(items: LayoutItem[], options: PdfLayoutOptions): PortfolioLayout {
  if (options.mode === "fit") {
    return layoutFit(items, {
      orientation: options.orientation,
      columns: options.columns,
      marginMm: clampPdfMargin(options.marginMm ?? 10),
      gapMm: clampPdfGap(options.gapMm ?? 2),
    });
  }
  return layoutPortfolio(items, { orientation: options.orientation, columns: options.columns });
}

/**
 * Drops images that are not kept, then closes the holes.
 * Surviving images stay in their original rows and keep their size.
 * Empty rows disappear. Rows are not rebuilt the way fit mode does.
 */
export function omitPlacements(
  layout: PortfolioLayout,
  keepIds: readonly string[],
  margin = PAGE_MARGIN_MM,
  gap = PAGE_GAP_MM,
): PortfolioLayout {
  const keep = new Set(keepIds);
  const ordered = [...layout.placements].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const rows: Placement[][] = [];
  for (const cell of ordered) {
    if (!keep.has(cell.id)) continue;
    const row = rows[rows.length - 1];
    const same = row && row[0]!.page === cell.page && Math.abs(row[0]!.y - cell.y) < 0.05;
    if (same && row) row.push(cell);
    else rows.push([cell]);
  }
  const contentH = layout.pageHeight - margin * 2;
  const placements: Placement[] = [];
  let pageIndex = 0;
  let y = 0;
  for (const row of rows) {
    const cells = [...row].sort((a, b) => a.x - b.x);
    const rowH = Math.max(...cells.map((cell) => cell.h));
    let usedH = rowH;
    let scale = 1;
    if (usedH > contentH && contentH > 0) {
      scale = contentH / usedH;
      usedH = contentH;
    }
    if (y > 0 && y + usedH > contentH + 0.01) {
      pageIndex += 1;
      y = 0;
    }
    let x = margin;
    for (const cell of cells) {
      placements.push({
        id: cell.id,
        page: pageIndex,
        x,
        y: margin + y,
        w: cell.w * scale,
        h: cell.h * scale,
      });
      x += cell.w * scale + gap * scale;
    }
    y += usedH + gap * scale;
  }
  return {
    pageCount: placements.length === 0 ? 0 : pageIndex + 1,
    pageWidth: layout.pageWidth,
    pageHeight: layout.pageHeight,
    placements,
  };
}

export function layoutPdfSelection(
  items: (LayoutItem & { favorite?: boolean })[],
  options: PdfLayoutOptions & { favoritesOnly?: boolean },
): PortfolioLayout {
  const picked = options.favoritesOnly ? items.filter((item) => item.favorite) : items;
  if (options.mode === "fit") return layoutForPdf(picked, options);
  const full = layoutForPdf(items, { ...options, mode: "normal" });
  if (!options.favoritesOnly) return full;
  return omitPlacements(full, picked.map((item) => item.id));
}

/** Leftover content height at or above this share of the page pulls one later row forward. */
export const FIT_TAIL_RATIO = 0.3;
/** A row moved into the tail may shrink, but not below this share of its own height. */
export const FIT_MIN_MOVE_SCALE = 0.85;

export function maxFitRowGap(baseGap: number, contentH: number): number {
  return Math.min(18, Math.max(baseGap, contentH * 0.07));
}

export type FitSettleRow = { height: number; widths: number[]; aspects: number[] };

function rowsUsed(rows: { height: number }[], gap: number): number {
  if (rows.length === 0) return 0;
  return rows.reduce((total, row) => total + row.height, 0) + gap * (rows.length - 1);
}

function scaleFitRow<T extends FitSettleRow>(row: T, scale: number): T {
  if (scale >= 0.999) return row;
  return { ...row, height: row.height * scale, widths: row.widths.map((width) => width * scale) };
}

/**
 * Large tails may take the next original row if it still fits close to its size.
 * Small tails keep every row and only open the space between them. Nothing is enlarged,
 * and rows are never rebuilt or taken out of order.
 */
export function settleFitWhitespace<T extends FitSettleRow>(
  source: T[][],
  contentH: number,
  gap: number,
): { pages: T[][]; rowGaps: number[] } {
  const pages = source.map((page) => page.slice());
  if (contentH <= 1) return { pages, rowGaps: pages.map(() => gap) };

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const left = contentH - rowsUsed(page, gap);
    if (left < contentH * FIT_TAIL_RATIO - 0.01) continue;
    const donor = pages[index + 1];
    const row = donor?.[0];
    const available = page.length === 0 ? contentH : left - gap;
    if (!donor || !row || available < 8) continue;
    const scale = Math.min(1, available / row.height);
    if (scale < FIT_MIN_MOVE_SCALE) continue;
    const placed = scaleFitRow(row, scale);
    donor.shift();
    page.push(placed);
    if (rowsUsed(page, gap) > contentH + 0.05) {
      page.pop();
      donor.unshift(row);
    }
  }

  const kept: T[][] = [];
  const rowGaps: number[] = [];
  for (const page of pages) {
    if (page.length === 0) continue;
    const left = contentH - rowsUsed(page, gap);
    const ratio = left / contentH;
    let rowGap = gap;
    if (ratio < FIT_TAIL_RATIO && page.length > 1 && left > 0.5) {
      const slots = page.length - 1;
      const room = Math.max(0, maxFitRowGap(gap, contentH) - gap);
      rowGap = gap + Math.min(room, left / slots);
    }
    kept.push(page);
    rowGaps.push(rowGap);
  }
  return { pages: kept, rowGaps };
}

function paginateFitRows<T extends FitSettleRow>(rows: T[], contentH: number, gap: number): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  for (const source of rows) {
    const row = source.height > contentH ? scaleFitRow(source, contentH / source.height) : source;
    if (page.length > 0 && rowsUsed([...page, row], gap) > contentH + 0.05) {
      pages.push(page);
      page = [row];
    } else {
      page.push(row);
    }
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/**
 * Same rows as the portfolio. Page breaks may pull the next row forward or
 * open the gaps. The input array and its items are left untouched.
 */
export function layoutFit(
  items: LayoutItem[],
  options: { orientation: PageOrientation; columns: number; marginMm: number; gapMm: number },
): PortfolioLayout {
  const page = A4_MM[options.orientation];
  const margin = options.marginMm;
  const gap = options.gapMm;
  const contentW = page.width - margin * 2;
  const contentH = page.height - margin * 2;
  const placements: Placement[] = [];
  if (contentW <= 8 || contentH <= 8 || items.length === 0) {
    return { pageCount: 0, pageWidth: page.width, pageHeight: page.height, placements };
  }

  const flow = layoutFlow(items, { contentWidth: contentW, columns: options.columns, gap });
  const rows = rowGroups(flow.placements).map((row) => ({
    ids: row.map((cell) => cell.id),
    height: Math.max(...row.map((cell) => cell.h)),
    widths: row.map((cell) => cell.w),
    aspects: row.map((cell) => cell.w / Math.max(cell.h, 0.001)),
  }));
  const settled = settleFitWhitespace(paginateFitRows(rows, contentH, gap), contentH, gap);
  let pageIndex = 0;
  for (let index = 0; index < settled.pages.length; index += 1) {
    const pageRows = settled.pages[index] ?? [];
    const rowGap = settled.rowGaps[index] ?? gap;
    let y = 0;
    for (const row of pageRows) {
      let x = margin;
      for (let cell = 0; cell < row.ids.length; cell += 1) {
        placements.push({
          id: row.ids[cell]!,
          page: pageIndex,
          x,
          y: margin + y,
          w: row.widths[cell] ?? 0,
          h: row.height,
        });
        x += (row.widths[cell] ?? 0) + gap;
      }
      y += row.height + rowGap;
    }
    pageIndex += 1;
  }

  return {
    pageCount: placements.length === 0 ? 0 : pageIndex,
    pageWidth: page.width,
    pageHeight: page.height,
    placements,
  };
}

/** Where a pasted folder lands. A parent receives it; a normal folder uses its own parent. */
export function pasteParentId(folders: readonly Folder[], selectedId: string): string | null {
  if (selectedId === ALL_FOLDERS) return null;
  const current = folders.find((folder) => folder.id === selectedId);
  if (!current) return null;
  if (current.isParent) return current.id;
  return current.parentId ?? null;
}

/** Smallest unused 「名前（n）」 when `name` is already taken under the same parent. */
export function nextCopyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const base = name.replace(/（\d+）$/, "");
  for (let n = 1; n < 1000; n += 1) {
    const suffix = `（${n}）`;
    const room = Math.max(1, 40 - suffix.length);
    const candidate = `${base.slice(0, room)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return name;
}

export type PlannedFolderCopy = {
  rootId: string;
  folders: Folder[];
  views: { id: string; view: FolderView }[];
  tags: Tag[];
  tagFolders: TagFolder[];
  images: { sourceId: string; meta: ImageMeta }[];
  hiddenIds: string[];
};

/**
 * New ids for the copied tree. Tag ids are reused only when the destination
 * already has that same tag. Otherwise the tag, and its folder, are copied by name.
 */
export function planFolderCopy(input: {
  rootId: string;
  sourceFolders: readonly Folder[];
  sourceItems: readonly ImageMeta[];
  sourceTags: readonly Tag[];
  sourceTagFolders: readonly TagFolder[];
  sourceViews: Readonly<Record<string, FolderView>>;
  destFolders: readonly Folder[];
  destTags: readonly Tag[];
  destTagFolders: readonly TagFolder[];
  destParentId: string | null;
  sourceHiddenIds?: readonly string[];
  now?: number;
  nextId?: () => string;
}): PlannedFolderCopy | null {
  const root = input.sourceFolders.find((folder) => folder.id === input.rootId);
  if (!root) return null;
  const nextId = input.nextId ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now();
  const takenIds = new Set<string>([
    ...input.sourceFolders.map((folder) => folder.id),
    ...input.sourceItems.map((item) => item.id),
    ...input.sourceTags.map((tag) => tag.id),
    ...input.sourceTagFolders.map((folder) => folder.id),
    ...input.destFolders.map((folder) => folder.id),
    ...input.destTags.map((tag) => tag.id),
    ...input.destTagFolders.map((folder) => folder.id),
  ]);
  const allocate = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = nextId();
      if (!takenIds.has(id)) {
        takenIds.add(id);
        return id;
      }
    }
    const id = `${nextId()}-${takenIds.size}`;
    takenIds.add(id);
    return id;
  };
  const folderIdMap = new Map<string, string>();
  const made: Folder[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const folder = queue.shift()!;
    const id = allocate();
    folderIdMap.set(folder.id, id);
    const parentId = folder.id === root.id ? input.destParentId : (folderIdMap.get(folder.parentId ?? "") ?? input.destParentId);
    const siblingNames = [
      ...input.destFolders.filter((entry) => (entry.parentId ?? null) === parentId).map((entry) => entry.name),
      ...made.filter((entry) => (entry.parentId ?? null) === parentId).map((entry) => entry.name),
    ];
    const peers = input.destFolders.filter((entry) => (entry.parentId ?? null) === parentId);
    const order =
      folder.id === root.id
        ? parentId === null
          ? peers.length === 0
            ? 0
            : Math.min(...peers.map((entry) => entry.order)) - 1
          : peers.length
        : folder.order;
    made.push({
      ...folder,
      id,
      name: nextCopyName(folder.name, siblingNames),
      parentId,
      order,
      createdAt: folder.createdAt,
    });
    for (const child of folderChildren(input.sourceFolders, folder.id)) queue.push(child);
  }

  const copiedItems = input.sourceItems.filter((item) => folderIdMap.has(item.folderId));
  const tagIdMap = new Map<string, string>();
  const tags: Tag[] = [];
  const tagFolders: TagFolder[] = [];
  const folderNameToNew = new Map<string, string>();
  const plannedTagNames = new Map<string, string>();
  const usedTagIds = new Set(copiedItems.flatMap((item) => item.tagIds));
  for (const sourceId of usedTagIds) {
    const source = input.sourceTags.find((tag) => tag.id === sourceId);
    if (!source) continue;
    const same = input.destTags.find((tag) => tag.id === source.id && tag.name === source.name);
    const named = same ?? input.destTags.find((tag) => tag.name === source.name);
    if (named) {
      tagIdMap.set(source.id, named.id);
      continue;
    }
    const plannedName = plannedTagNames.get(source.name);
    if (plannedName) {
      tagIdMap.set(source.id, plannedName);
      continue;
    }
    let folderId: string | null = null;
    if (source.folderId) {
      const sourceFolder = input.sourceTagFolders.find((folder) => folder.id === source.folderId);
      const folderName = sourceFolder?.name ?? "";
      if (folderName) {
        const existing = input.destTagFolders.find((folder) => folder.name === folderName);
        const planned = folderNameToNew.get(folderName);
        if (existing) folderId = existing.id;
        else if (planned) folderId = planned;
        else {
          folderId = allocate();
          folderNameToNew.set(folderName, folderId);
          const orders = [...input.destTagFolders, ...tagFolders].map((folder) => folder.order);
          tagFolders.push({
            id: folderId,
            name: folderName,
            order: orders.length === 0 ? 0 : Math.max(...orders) + 1,
            createdAt: sourceFolder?.createdAt ?? now,
            open: sourceFolder?.open ?? true,
          });
        }
      }
    }
    const id = allocate();
    tagIdMap.set(source.id, id);
    plannedTagNames.set(source.name, id);
    tags.push({ ...source, id, folderId, createdAt: source.createdAt });
  }

  const sourceByNew = new Map([...folderIdMap].map(([from, to]) => [to, from]));
  const images: { sourceId: string; meta: ImageMeta }[] = [];
  for (const item of copiedItems) {
    const folderId = folderIdMap.get(item.folderId);
    if (!folderId) continue;
    images.push({
      sourceId: item.id,
      meta: {
        ...item,
        id: allocate(),
        folderId,
        tagIds: [...new Set(item.tagIds.flatMap((id) => {
          const next = tagIdMap.get(id);
          return next ? [next] : [];
        }))],
      },
    });
  }

  return {
    rootId: folderIdMap.get(root.id) ?? made[0]!.id,
    folders: made,
    views: made.map((folder) => {
      const view = input.sourceViews[sourceByNew.get(folder.id) ?? ""] ?? DEFAULT_FOLDER_VIEW;
      return { id: folder.id, view: { columns: view.columns, direction: view.direction } };
    }),
    tags,
    tagFolders,
    images,
    hiddenIds: copiedFolderHiddenIds(input.sourceHiddenIds ?? [], folderIdMap),
  };
}
