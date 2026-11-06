import { looksLikeHtml, publicHttpUrl, sniffImage } from "./image-sniff.ts";
import type { SupportedMime } from "./types.ts";

const MAX_BYTES = 24 * 1024 * 1024;

export type RemoteImage =
  | { ok: true; base64: string; mime: SupportedMime; fileName: string }
  | { ok: false; message: string };

function fileName(url: string, mime: SupportedMime): string {
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  let base = "image";
  try {
    const leaf = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const stripped = leaf.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[\\/:*?"<>|\n\r\t]/g, " ").trim();
    if (stripped) base = stripped.slice(0, 40);
  } catch {
    base = "image";
  }
  return `${base}.${ext}`;
}

/** Fetches a public image URL directly. The address is not sent to another service. */
export async function fetchRemoteImage(rawUrl: string): Promise<RemoteImage> {
  const target = publicHttpUrl(rawUrl);
  if (!target) return { ok: false, message: "このアドレスは取得できません。http または https の公開URLをコピーしてください。" };
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    accept: "image/gif,image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.5",
  };
  if (new URL(target).hostname.endsWith("pximg.net")) headers.referer = "https://www.pixiv.net/";
  try {
    const response = await fetch(target, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!publicHttpUrl(response.url)) {
      return { ok: false, message: "このアドレスは公開されていない場所へ転送されたため、取得しませんでした。" };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: "サイトが画像の取得を拒否しました。ログインが必要か、直接ダウンロードできないアドレスの可能性があります。",
      };
    }
    if (response.status === 404) {
      return { ok: false, message: "画像が見つかりませんでした。アドレスが切れていないか確認してください。" };
    }
    if (!response.ok) {
      return { ok: false, message: `画像を取得できませんでした（${response.status}）。時間をおいて、もう一度貼り付けてください。` };
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const advertised = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > MAX_BYTES) {
      return { ok: false, message: "画像が大きすぎて追加できません。" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, message: "画像データが空だったため、追加しませんでした。" };
    if (bytes.byteLength > MAX_BYTES) return { ok: false, message: "画像が大きすぎて追加できません。" };
    if (looksLikeHtml(bytes, type)) {
      return {
        ok: false,
        message: "このURLは画像ファイルではなく、Webページです。画像を右クリックして「画像アドレスをコピー」してから貼り付けてください。",
      };
    }
    const mime = sniffImage(bytes);
    if (!mime) return { ok: false, message: "JPEG、PNG、WebP、GIF のいずれでもなかったため、追加しませんでした。" };
    return { ok: true, base64: Buffer.from(bytes).toString("base64"), mime, fileName: fileName(target, mime) };
  } catch {
    return { ok: false, message: "画像の取得に失敗しました。通信できないアドレスか、時間をおいてもう一度貼り付けてください。" };
  }
}
