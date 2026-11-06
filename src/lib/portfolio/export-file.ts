import { readPixels } from "./db.ts";
import { exportFileName } from "./logic.ts";
import type { ImageMeta } from "./types.ts";

const ready = new Map<string, File>();
const pending = new Map<string, Promise<File | null>>();
const order: string[] = [];
const MAX_READY = 8;
let activeReads = 0;
const waiters: (() => void)[] = [];

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeReads += 1;
      job().then(resolve, reject).finally(() => {
        activeReads -= 1;
        waiters.shift()?.();
      });
    };
    if (activeReads < 2) run();
    else waiters.push(run);
  });
}

export const OWN_FILE_DRAG = "application/x-komacho-file";
/** Gallery thumbnail dragged out of the app. The payload is the original file, not the thumb or pen layer. */
export const SHOT_DRAG = "application/x-komacho-shot";

export type OriginalDragSink = {
  effectAllowed: string;
  setData: (type: string, value: string) => void;
  items: { add: (file: File) => unknown; clear?: () => void };
};

/** A File around the stored original bytes. Does not re-encode or write anything back. */
export function fileFromOriginal(meta: { name: string; mime: string; addedAt: number }, blob: Blob): File {
  return new File([blob], exportFileName(meta.name, meta.mime), {
    type: meta.mime,
    lastModified: meta.addedAt || Date.now(),
  });
}

/**
 * Offer the original file to another app.
 * String types mark the drag as ours so the gallery does not import a copy of itself.
 */
export function writeOriginalDrag(sink: OriginalDragSink, id: string, file: File): void {
  try {
    sink.items.clear?.();
  } catch {
    /* a protected drag store can still accept setData and add */
  }
  sink.effectAllowed = "copy";
  sink.setData(SHOT_DRAG, id);
  sink.setData(OWN_FILE_DRAG, id);
  sink.setData("text/plain", file.name);
  sink.items.add(file);
}

function remember(id: string, file: File): void {
  ready.set(id, file);
  const at = order.indexOf(id);
  if (at >= 0) order.splice(at, 1);
  order.push(id);
  while (order.length > MAX_READY) {
    const stale = order.shift();
    if (stale) ready.delete(stale);
  }
}

export function releaseOriginal(id: string): void {
  ready.delete(id);
  pending.delete(id);
  const at = order.indexOf(id);
  if (at >= 0) order.splice(at, 1);
}

export function releaseAllOriginals(): void {
  ready.clear();
  pending.clear();
  order.length = 0;
}

export function cachedOriginal(id: string): File | null {
  return ready.get(id) ?? null;
}

/** Builds a File from the stored original. Does not write anything back. */
export function primeOriginal(meta: ImageMeta): Promise<File | null> {
  const hit = ready.get(meta.id);
  if (hit) return Promise.resolve(hit);
  const current = pending.get(meta.id);
  if (current) return current;
  const task = schedule(() => readPixels(meta.id, "original"))
    .then((blob) => {
      pending.delete(meta.id);
      if (!blob) return null;
      const file = fileFromOriginal(meta, blob);
      remember(meta.id, file);
      return file;
    })
    .catch((error: unknown) => {
      pending.delete(meta.id);
      throw error;
    });
  pending.set(meta.id, task);
  return task;
}

export async function downloadOriginal(meta: ImageMeta): Promise<boolean> {
  const file = await primeOriginal(meta);
  if (!file) return false;
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  return true;
}
