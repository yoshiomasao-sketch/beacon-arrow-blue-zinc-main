/**
 * Keeps a small set of object URLs for grid thumbs.
 * Full-size bytes stay in IndexedDB until a preview asks for them.
 */

const urls = new Map<string, string>();
const pins = new Map<string, number>();
const inflight = new Map<string, Promise<string>>();
const MAX_UNPINNED = 48;
let thumbEpoch = 0;

function revoke(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

export function peekThumb(id: string): string | null {
  return urls.get(id) ?? null;
}

export function pinThumb(id: string): () => void {
  pins.set(id, (pins.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (pins.get(id) ?? 1) - 1;
    if (next <= 0) pins.delete(id);
    else pins.set(id, next);
    trim();
  };
}

export function forgetThumb(id: string): void {
  for (const key of [id, `${id}:motion`, `${id}:still`]) {
    const url = urls.get(key);
    if (url) revoke(url);
    urls.delete(key);
    inflight.delete(key);
    pins.delete(key);
  }
}

export function forgetAllThumbs(): void {
  thumbEpoch += 1;
  for (const url of urls.values()) revoke(url);
  urls.clear();
  inflight.clear();
  pins.clear();
}

export function loadThumb(
  id: string,
  read: (id: string) => Promise<Blob | null>,
): Promise<string> {
  const cached = urls.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(id);
  if (pending) return pending;
  const epoch = thumbEpoch;

  const task = read(id)
    .then((blob) => {
      inflight.delete(id);
      if (epoch !== thumbEpoch) throw new Error("stale-thumb");
      if (!blob) throw new Error("missing-thumb");
      const again = urls.get(id);
      if (again) return again;
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      trim(id);
      return url;
    })
    .catch((error: unknown) => {
      inflight.delete(id);
      throw error;
    });
  inflight.set(id, task);
  return task;
}

export function invalidateThumb(id: string): void {
  const url = urls.get(id);
  if (url) revoke(url);
  urls.delete(id);
  inflight.delete(id);
}

function trim(keep?: string): void {
  if (urls.size <= MAX_UNPINNED) return;
  for (const id of urls.keys()) {
    if (urls.size <= MAX_UNPINNED) break;
    if (id === keep || pins.has(id)) continue;
    const url = urls.get(id);
    if (url) revoke(url);
    urls.delete(id);
  }
}
