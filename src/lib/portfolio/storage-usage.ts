export type AppStorageUsage = {
  originals: number;
  thumbs: number;
  meta: number | null;
  images: number;
};

export type BrowserStorageUsage = {
  usage: number | null;
  quota: number | null;
};

export type StorageSnapshot = {
  measuredAt: number;
  app: AppStorageUsage | null;
  browser: BrowserStorageUsage;
};

export type StoragePressure = "ok" | "warn" | "alert";

/** Browser quota pressure. Missing numbers stay unknown instead of a guessed percent. */
export function storagePressure(usage: number | null, quota: number | null): StoragePressure | null {
  if (usage === null || quota === null || !Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
  const ratio = usage / quota;
  if (ratio >= 0.95) return "alert";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

export function storageRatio(usage: number | null, quota: number | null): number | null {
  if (usage === null || quota === null || !Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
  return usage / quota;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "取得できません";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatCheckedAt(time: number): string {
  if (!Number.isFinite(time)) return "取得できません";
  return new Date(time).toLocaleString("ja-JP", { hour12: false });
}
