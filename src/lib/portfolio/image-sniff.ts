import type { SupportedMime } from "./types.ts";

/** The first http(s) URL in copied text. Pixiv pages are handled separately. */
export function copiedHttpUrl(text: string): string | null {
  const visible = text.replace(/\b(?:blob|data|filesystem|chrome-untrusted|chrome):[^\s<>"']+/gi, " ");
  const match = visible.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const raw = match[0].replace(/[),.;]+$/g, "");
  return publicHttpUrl(raw);
}

/**
 * Address carried by a drop from another page.
 * A public image URL is preferred. blob: and private addresses are refused.
 */
export function droppedHttpUrl(uriList: string, html: string, plain: string, downloadUrl = ""): string | null {
  return droppedImageSources(uriList, html, plain, downloadUrl).urls[0] ?? null;
}

export type ExternalImageSources = {
  /** Public http(s) addresses, in the order the drag provided them. */
  urls: string[];
  /** data:image payloads the browser embedded in the drag. */
  dataUrls: string[];
  /** blob: or private addresses this page is not allowed to read. */
  blocked: string[];
};

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/\u0026amp;/gi, "&")
    .replace(/\u0026quot;/gi, '"')
    .replace(/\u0026#0*39;/g, "'")
    .replace(/\u0026apos;/gi, "'")
    .replace(/\u0026lt;/gi, "<")
    .replace(/\u0026gt;/gi, ">");
}

function pushAddress(raw: string, into: ExternalImageSources, seen: Set<string>): void {
  let text = raw.trim();
  if (!text || text.startsWith("#")) return;
  if (text.startsWith("//")) text = `https:${text}`;
  if (/^data:/i.test(text)) {
    if (/^data:image\/(?:png|jpe?g|gif|webp)/i.test(text) && !seen.has(text)) {
      seen.add(text);
      into.dataUrls.push(text);
    }
    return;
  }
  if (/^(?:blob|filesystem|chrome-untrusted|chrome):/i.test(text)) {
    into.blocked.push(text);
    return;
  }
  const pub = publicHttpUrl(text);
  if (pub) {
    if (!seen.has(pub)) {
      seen.add(pub);
      into.urls.push(pub);
    }
    return;
  }
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") into.blocked.push(url.toString());
  } catch {
    /* not an address */
  }
}

function htmlImageSrcs(html: string): string[] {
  const found: string[] = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const match of html.matchAll(re)) {
    const raw = decodeHtmlAttr(match[1] ?? match[2] ?? match[3] ?? "");
    if (raw) found.push(raw);
  }
  return found;
}

function emptySources(): ExternalImageSources {
  return { urls: [], dataUrls: [], blocked: [] };
}

function mergeBlocked(parts: ExternalImageSources[]): string[] {
  const blocked: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const entry of part.blocked) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      blocked.push(entry);
    }
  }
  return blocked;
}

/** A direct image address, not a page that merely links to one. */
function looksLikeImageUrl(raw: string): boolean {
  try {
    return /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

function collectLines(lines: string): ExternalImageSources {
  const into = emptySources();
  const seen = new Set<string>();
  for (const line of lines.split(/[\r\n]+/)) pushAddress(line, into, seen);
  return into;
}

function collectHtml(html: string): ExternalImageSources {
  const into = emptySources();
  const seen = new Set<string>();
  for (const src of htmlImageSrcs(html)) pushAddress(src, into, seen);
  return into;
}

function collectPlain(plain: string): ExternalImageSources {
  const into = emptySources();
  const seen = new Set<string>();
  const visible = plain.replace(/\b(?:blob|data|filesystem|chrome-untrusted|chrome):[^\s<>"']+/gi, " ");
  for (const match of visible.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    pushAddress(match[0].replace(/[),.;]+$/g, ""), into, seen);
  }
  for (const match of plain.matchAll(/data:image\/(?:png|jpe?g|gif|webp)[^'"\s]*/gi)) {
    pushAddress(match[0], into, seen);
  }
  return into;
}

function collectDownload(downloadUrl: string): ExternalImageSources {
  const into = emptySources();
  if (!downloadUrl) return into;
  pushAddress(downloadUrl.split(":").slice(2).join(":"), into, new Set<string>());
  return into;
}

export type DroppedPayload = {
  /** The one representation to import for this drag. */
  primary: ExternalImageSources;
  /** Used only when primary yields no image. Never combined with a successful primary. */
  fallback: ExternalImageSources;
};

/**
 * A drag from another page describes the same images several ways
 * (uri-list, the img markup, plain text, DownloadURL).
 * Those channels are alternate encodings, not extra images.
 */
export function chooseDroppedPayload(uriList: string, html: string, plain: string, downloadUrl = ""): DroppedPayload {
  const uri = collectLines(uriList);
  const imgs = collectHtml(html);
  const text = collectPlain(plain);
  const download = collectDownload(downloadUrl);
  const blocked = mergeBlocked([uri, imgs, text, download]);
  const none = emptySources();
  const withBlocked = (sources: ExternalImageSources): ExternalImageSources => ({ ...sources, blocked });

  const data = [uri, imgs, text, download].find((part) => part.dataUrls.length > 0);
  if (data) {
    const http = [uri, imgs, text, download].find((part) => part.urls.length > 0) ?? none;
    return {
      primary: withBlocked({ urls: [], dataUrls: data.dataUrls, blocked: [] }),
      fallback: { urls: http.urls, dataUrls: [], blocked: [] },
    };
  }

  if (uri.urls.length > 1) return { primary: withBlocked(uri), fallback: none };

  if (uri.urls.length === 1 && imgs.urls.length > 0) {
    const link = uri.urls[0]!;
    if (imgs.urls.length === 1 && imgs.urls[0] === link) return { primary: withBlocked(uri), fallback: none };
    if (imgs.urls.length > 1) return { primary: withBlocked(imgs), fallback: none };
    if (looksLikeImageUrl(link)) {
      return { primary: withBlocked(uri), fallback: { urls: imgs.urls, dataUrls: [], blocked: [] } };
    }
    return { primary: withBlocked(imgs), fallback: none };
  }

  if (uri.urls.length === 1) return { primary: withBlocked(uri), fallback: none };
  if (imgs.urls.length > 0) return { primary: withBlocked(imgs), fallback: none };
  if (text.urls.length > 0) return { primary: withBlocked(text), fallback: none };
  if (download.urls.length > 0) return { primary: withBlocked(download), fallback: none };
  return { primary: withBlocked(none), fallback: none };
}

/** Every image address on a drag from another page. Files are handled separately. */
export function droppedImageSources(uriList: string, html: string, plain: string, downloadUrl = ""): ExternalImageSources {
  return chooseDroppedPayload(uriList, html, plain, downloadUrl).primary;
}

const MAX_DATA_CHARS = 32 * 1024 * 1024;

/** Turns a data:image URL into a file when the bytes are JPEG, PNG, GIF, or WebP. */
export function fileFromDataUrl(dataUrl: string, index = 0): File | null {
  const match = /^data:(image\/(?:png|jpeg|jpg|pjpeg|gif|webp));base64,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const b64 = match[2]!.replace(/\s/g, "");
  if (!b64 || b64.length > MAX_DATA_CHARS) return null;
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  if (binary.length > 24 * 1024 * 1024) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  const sniffed = sniffImage(bytes);
  if (sniffed !== "image/jpeg" && sniffed !== "image/png" && sniffed !== "image/gif" && sniffed !== "image/webp") return null;
  const ext = sniffed === "image/jpeg" ? "jpg" : sniffed === "image/png" ? "png" : sniffed === "image/gif" ? "gif" : "webp";
  return new File([bytes], `dropped-${index + 1}.${ext}`, { type: sniffed });
}

/** Public http(s) only. Private and local addresses are refused. */
export function publicHttpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!isPublicHost(url.hostname)) return null;
  return url.toString();
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return false;
  if (host === "0.0.0.0" || host === "::1" || host === "metadata.google.internal") return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return true;
  const parts = v4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

export function sniffImage(bytes: Uint8Array): SupportedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    const webp = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

export function looksLikeHtml(bytes: Uint8Array, contentType: string): boolean {
  const type = contentType.toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml")) return true;
  const start = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 80))).trim().toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html") || start.startsWith("<head") || start.startsWith("<body");
}
