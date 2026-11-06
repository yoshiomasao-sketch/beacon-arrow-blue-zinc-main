import { fetchBrowserMedia } from "./browser-fetch.ts";
import { X_GIF_MAX_MS, classifyFxStatus, pickFxVideo } from "./x-url.ts";

const META_URL = "https://api.fxtwitter.com/status/";

export type XLoadResult = { ok: true; file: File } | { ok: false; reason: string; message: string };

/**
 * Reads a public post id from FxTwitter in the browser, then downloads the original MP4.
 * Only the status id is sent. Cookies are not sent. X's own post page is not readable here.
 */
export async function loadXPostVideo(id: string, signal: AbortSignal, onProgress?: (note: string) => void): Promise<XLoadResult> {
  if (!/^\d{5,22}$/.test(id)) {
    return { ok: false, reason: "url", message: "Xの投稿URLから投稿IDを読み取れませんでした。" };
  }
  onProgress?.("公開の投稿IDだけを api.fxtwitter.com に送って、動画のアドレスを調べています。ログイン情報は送りません。");
  let response: Response;
  try {
    response = await fetch(`${META_URL}${id}`, {
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return {
      ok: false,
      reason: "cors",
      message:
        "投稿情報の取得先（api.fxtwitter.com）をブラウザから読めませんでした。通信できないか、ブラウザの制限です。ログイン情報は送っていません。動画ファイルのアドレスをコピーするか、保存したファイルを「画像を追加」から読み込んでください。",
    };
  }
  const text = await response.text();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (text.trim().startsWith("<")) {
    return {
      ok: false,
      reason: "service",
      message: "投稿情報の取得先がデータを返さなかったため、動画アドレスを特定できませんでした。時間をおいてもう一度貼り付けてください。",
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "service", message: "投稿情報の形式を読めなかったため、動画を特定できませんでした。" };
  }
  const record = payload && typeof payload === "object" ? (payload as { message?: unknown }) : {};
  const remoteMessage = typeof record.message === "string" ? record.message : "";
  const kind = classifyFxStatus(response.status, remoteMessage);
  if (kind === "missing") {
    return { ok: false, reason: "missing", message: "この投稿は見つかりません。削除されたか、URLが違う可能性があります。" };
  }
  if (kind === "auth") {
    return {
      ok: false,
      reason: "auth",
      message: "この投稿は非公開か、ログインが必要です。制限の回避はしません。見られるファイルを保存して「画像を追加」から読み込んでください。",
    };
  }
  if (kind === "service") {
    return {
      ok: false,
      reason: "service",
      message: `投稿情報を取得できませんでした（${response.status || "不明"}）。api.fxtwitter.com が一時的に使えない可能性があります。`,
    };
  }
  const picked = pickFxVideo(payload);
  if (!picked.ok && picked.reason === "long") {
    return { ok: false, reason: "long", message: `この動画は長すぎます。保存できるのは${Math.round(X_GIF_MAX_MS / 1000)}秒までです。` };
  }
  if (!picked.ok) {
    return { ok: false, reason: "none", message: "この投稿には動画もGIFもありません。画像だけの投稿は、画像のアドレスをコピーして貼り付けてください。" };
  }
  onProgress?.("元の動画ファイルをダウンロードしています。変換はしません。");
  const loaded = await fetchBrowserMedia(picked.url, signal);
  if (!loaded.ok) {
    return { ok: false, reason: "download", message: loaded.message };
  }
  const ext = loaded.file.type === "image/gif" ? "gif" : loaded.file.type === "video/webm" ? "webm" : "mp4";
  return { ok: true, file: new File([loaded.file], `${id}.${ext}`, { type: loaded.file.type }) };
}
