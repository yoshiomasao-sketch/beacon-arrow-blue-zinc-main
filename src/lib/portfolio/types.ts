export const SUPPORTED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"] as const;

export type SupportedMime = (typeof SUPPORTED_MIMES)[number];

/** How an image entered the library. Backup/restore can use the same records later. */
export type ImageSource = "file" | "clipboard" | "capture";

/** Relative card width. 1 is the shared column width. */
export type DisplayScale = 1 | 2 | 3;

/**
 * Management record only. Pixel bytes are never stored on this object.
 */
export type ImageMeta = {
  id: string;
  name: string;
  mime: SupportedMime;
  width: number;
  height: number;
  byteSize: number;
  addedAt: number;
  /** Stable gallery order. Lower numbers are shown first. */
  order: number;
  scale: DisplayScale;
  source: ImageSource;
  /** Owning folder. Empty only before the first library migration. */
  folderId: string;
  /** Kept by image id. Moving folders does not clear it. */
  favorite: boolean;
  /** Tag ids, not names. A rename updates every image through the tag record. */
  tagIds: string[];
  /** True when the original file itself animates. Stills stay false. */
  animated: boolean;
  /** Short note kept with this image. Empty when unset. */
  memo: string;
  /** False hides the pen layer only. Missing means shown. */
  inkVisible?: boolean;
};

export type Tag = {
  id: string;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  /** Null when the tag sits at the root of the tag list. */
  folderId: string | null;
};

export type TagFolder = {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  open: boolean;
};

export const TAG_COLORS = ["#e07a5f", "#d4b483", "#81b29a", "#7eb6d6", "#c38d9e", "#b8a1e3", "#e6c35c", "#8fbf9f"] as const;

export const TAG_DRAG = "application/x-komacho-tag";

export type Folder = {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  /** Null for folders at the top. Missing on older records, which stay at the top. */
  parentId: string | null;
  /** True when this folder holds only child folders, not images. */
  isParent: boolean;
  /** Saved outline color for a parent folder. Null for ordinary folders. */
  color: string | null;
};

export const ALL_FOLDERS = "all";

/** Gallery display for one folder. Add fields here when a new per-folder setting appears. */
export type FolderView = {
  columns: number;
  direction: "asc" | "desc";
};

export const DEFAULT_FOLDER_VIEW: FolderView = {
  columns: 4,
  direction: "desc",
};
