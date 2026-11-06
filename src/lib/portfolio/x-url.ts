import { publicHttpUrl } from "./image-sniff.ts";

/** Pulls an X or Twitter status id out of a copied post URL. */
export function xStatusId(text: string): string | null {
  const match = text.match(
    /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[\w%.-]+\/status|i\/web\/status|i\/status)\/(\d{5,22})(?=\D|$)/i,
  );
  return match?.[1] ?? null;
}

export const X_GIF_MAX_MS = 140_000;

/** True when the address is a public video file, not a post page and not a private host. */
export function allowedVideoFileUrl(raw: string): string | null {
  const safe = publicHttpUrl(raw);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase();
  if (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com")) return null;
  const file = /\.(mp4|webm)$/i.test(url.pathname);
  const xVideo = host === "video.twimg.com" || host === "video.twitter.com";
  return file || xVideo ? safe : null;
}

/** A copied file address for an MP4 or WebM, including X's video host. Post pages are not included. */
export function directVideoUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const candidate of matches) {
    const allowed = allowedVideoFileUrl(candidate.replace(/[),.;]+$/g, ""));
    if (allowed) return allowed;
  }
  return null;
}

export type XVideoVariant = { content_type?: string; url?: string; bitrate?: number };

export type XVideoMedia = {
  type?: string;
  video_info?: { duration_millis?: number; variants?: XVideoVariant[] };
};

/** Picks one MP4, preferring a width near the GIF size so we do not download a huge file. */
export function pickXMp4(media: readonly XVideoMedia[]): { url: string; durationMs: number; width: number } | null {
  let best: { url: string; durationMs: number; width: number; bitrate: number } | null = null;
  for (const item of media) {
    const kind = (item.type ?? "").toLowerCase();
    if (kind && kind !== "video" && kind !== "animated_gif") continue;
    const durationMs = item.video_info?.duration_millis ?? 0;
    for (const variant of item.video_info?.variants ?? []) {
      const url = variant.url ?? "";
      if (!variant.content_type?.includes("video/mp4")) continue;
      if (!url.startsWith("https://video.twimg.com/")) continue;
      const size = url.match(/\/(\d{2,5})x(\d{2,5})\//);
      const width = size ? Number(size[1]) : 0;
      const bitrate = variant.bitrate ?? 0;
      const candidate = { url, durationMs, width, bitrate };
      if (!best) {
        best = candidate;
        continue;
      }
      const score = (entry: typeof candidate) => {
        if (entry.width > 0 && entry.width <= 720) return 10_000 + entry.width;
        if (entry.width > 720) return 1_000 - entry.width;
        return entry.bitrate / 10_000;
      };
      if (score(candidate) > score(best)) best = candidate;
    }
  }
  return best ? { url: best.url, durationMs: best.durationMs, width: best.width } : null;
}

function scoreFx(entry: { url: string; width: number; bitrate: number }): number {
  const mp4 = /\.mp4(\?|$)/i.test(entry.url) ? 100_000 : 0;
  if (entry.width > 0 && entry.width <= 720) return mp4 + 10_000 + entry.width;
  if (entry.width > 720) return mp4 + 1_000;
  return mp4 + entry.bitrate / 10_000;
}

export type FxVideoPick =
  | { ok: true; url: string; kind: "gif" | "video"; durationMs: number }
  | { ok: false; reason: "none" | "long" };

/** Picks one original MP4 from an FxTwitter status payload. GIF posts stay MP4 because that is how X delivers them. */
export function pickFxVideo(payload: unknown): FxVideoPick {
  const root = asRecord(payload);
  const tweet = asRecord(root.tweet ?? root);
  const media = asRecord(tweet.media);
  const items = [...asList(media.videos), ...asList(media.all)];
  let best: { url: string; kind: "gif" | "video"; durationMs: number; width: number; bitrate: number } | null = null;
  const seen = new Set<string>();
  for (const item of items) {
    const record = asRecord(item);
    const mediaKind: "gif" | "video" = textOf(record.type).toLowerCase() === "gif" ? "gif" : "video";
    const durationMs = typeof record.duration === "number" ? Math.round(record.duration * 1000) : 0;
    const variants = [record, ...asList(record.formats).map((entry) => asRecord(entry))];
    for (const variant of variants) {
      const url = textOf(variant.url);
      if (!url || seen.has(url)) continue;
      const container = `${textOf(variant.container)} ${textOf(variant.format)}`.toLowerCase();
      const mp4 = container.includes("mp4") || /\.mp4(\?|$)/i.test(url);
      const gif = /\.gif(\?|$)/i.test(url);
      if (!mp4 && !gif) continue;
      if (mp4 && !allowedVideoFileUrl(url)) continue;
      if (gif && !publicHttpUrl(url)) continue;
      seen.add(url);
      const size = url.match(/\/(\d{2,5})x(\d{2,5})\//);
      const width = size ? Number(size[1]) : typeof record.width === "number" ? record.width : 0;
      const bitrate = typeof variant.bitrate === "number" ? variant.bitrate : 0;
      const fileKind: "gif" | "video" = gif ? "gif" : mediaKind;
      const candidate = { url, kind: fileKind, durationMs, width, bitrate };
      if (!best || scoreFx(candidate) > scoreFx(best)) best = candidate;
    }
  }
  if (!best) return { ok: false, reason: "none" };
  if (best.durationMs > X_GIF_MAX_MS) return { ok: false, reason: "long" };
  return { ok: true, url: best.url, kind: best.kind, durationMs: best.durationMs };
}

export function classifyFxStatus(status: number, message: string): "ok" | "missing" | "auth" | "service" {
  const marker = message.toUpperCase();
  if (status === 404 || marker.includes("NOT_FOUND")) return "missing";
  if (status === 401 || marker.includes("PRIVATE") || marker.includes("PROTECTED")) return "auth";
  if (status >= 200 && status < 300) return "ok";
  return "service";
}

export type XPayloadClass =
  | { kind: "media"; media: XVideoMedia[] }
  | { kind: "auth"; detail: string }
  | { kind: "missing"; detail: string };

/** Separates a visible post from a login wall or a deleted post. Does not treat every non-tweet as missing. */
export function classifyXPayload(payload: unknown): XPayloadClass {
  const root = asRecord(payload);
  const wrapped = root.__typename === "TweetWithVisibilityResults" ? asRecord(root.tweet) : root;
  const typename = textOf(wrapped.__typename);
  if (!typename || typename === "Tweet") {
    const media = [...asMedia(wrapped.mediaDetails), ...asMedia(wrapped.video)];
    return { kind: "media", media };
  }
  const reason = textOf(wrapped.reason);
  const marker = `${typename} ${reason}`.toLowerCase();
  if (marker.includes("suspend") || marker.includes("deleted") || marker.includes("bounce")) {
    return { kind: "missing", detail: reason || typename };
  }
  return { kind: "auth", detail: reason || typename };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asMedia(value: unknown): XVideoMedia[] {
  if (Array.isArray(value)) return value as XVideoMedia[];
  if (value && typeof value === "object") return [value as XVideoMedia];
  return [];
}
