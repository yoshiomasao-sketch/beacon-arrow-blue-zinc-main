import { looksLikeHtml, publicHttpUrl, sniffImage } from "./image-sniff.ts";
import type { SupportedMime } from "./types.ts";

const MAX_BYTES = 24 * 1024 * 1024;

const MANUAL = "保存したファイルを「画像を追加」から読み込んでください。ログイン情報は使いません。";

export function pixivBlockedMessage(): string {
  return `このブラウザからpixivの作品データは取得できません。pixivが別のページからの読み取りを許していないためです。${MANUAL}`;
}

export function xPostBlockedMessage(): string {
  return `このブラウザからXの投稿ページの中の動画は取り出せません。Xが別のページからの読み取りを許していないためです。動画ファイルのアドレスをコピーするか、${MANUAL}`;
}

function sniffVideo(bytes: Uint8Array): SupportedMime | null {
  if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}

function fileName(url: string, mime: SupportedMime): string {
  const ext =
    mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : mime === "video/webm" ? "webm" : "mp4";
  try {
    const leaf = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const bare = leaf.replace(/\.(jpe?g|png|webp|gif|mp4|webm)$/i, "").replace(/[\\/:*?"<>|\n\r\t]/g, " ").trim();
    if (bare) return `${bare.slice(0, 40)}.${ext}`;
  } catch {
    /* fallback */
  }
  return `file.${ext}`;
}

export type FetchFailReason = "browser" | "format" | "url";

/** Reads a public file in the browser. Credentials are not sent. */
export async function fetchBrowserMedia(
  rawUrl: string,
  signal: AbortSignal,
): Promise<{ ok: true; file: File } | { ok: false; message: string; reason: FetchFailReason }> {
  const safe = publicHttpUrl(rawUrl);
  if (!safe) return { ok: false, reason: "browser", message: `このアドレスは取得できません。${MANUAL}` };
  let response: Response;
  try {
    response = await fetch(safe, { mode: "cors", credentials: "omit", redirect: "follow", signal, cache: "no-store" });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return { ok: false, reason: "browser", message: `このアドレスはブラウザの制限で読み取れません。${MANUAL}` };
  }
  if (response.url && !publicHttpUrl(response.url)) {
    return { ok: false, reason: "browser", message: `転送先が公開アドレスではなかったため、取得しませんでした。${MANUAL}` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "browser",
      message: `サイトが取得を拒否しました（${response.status}）。ログインが必要か、直接読めないアドレスです。${MANUAL}`,
    };
  }
  if (response.status === 404 || response.status === 410) {
    return { ok: false, reason: "url", message: `ファイルが見つかりません（${response.status}）。アドレスが切れている可能性があります。${MANUAL}` };
  }
  if (!response.ok) return { ok: false, reason: "url", message: `取得できませんでした（${response.status}）。${MANUAL}` };
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MAX_BYTES) return { ok: false, reason: "format", message: "ファイルが大きすぎます。24MBまでです。" };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (bytes.byteLength === 0) return { ok: false, reason: "format", message: "ファイルが空だったため、追加しませんでした。" };
  if (bytes.byteLength > MAX_BYTES) return { ok: false, reason: "format", message: "ファイルが大きすぎます。24MBまでです。" };
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (looksLikeHtml(bytes, type)) {
    return { ok: false, reason: "format", message: `このURLはファイルではなくページです。画像や動画のアドレスをコピーするか、${MANUAL}` };
  }
  const mime = sniffImage(bytes) ?? sniffVideo(bytes);
  if (!mime) return { ok: false, reason: "format", message: `JPEG、PNG、WebP、GIF、MP4、WebM のいずれでもありませんでした。${MANUAL}` };
  return { ok: true, file: new File([bytes], fileName(safe, mime), { type: mime }) };
}
