export type PixivStage = "作品情報" | "うごイラ情報" | "フレームデータ" | "GIF変換";

export type PixivFailReason = "auth" | "missing" | "network" | "html" | "other";

/** Turns a pixiv response into a cause the user can act on. Does not include cookies or tokens. */
export function pixivFailure(stage: PixivStage, status: number, body: string): { message: string; reason: PixivFailReason } {
  const trimmed = body.trim();
  const head = trimmed.slice(0, 240).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("just a moment") || head.includes("cf-browser-verification")) {
    return {
      reason: "html",
      message: `pixivが${stage}の代わりにページを返しました（${status || "応答"}）。ログインが必要な作品の可能性があります。`,
    };
  }
  let parsed: { error?: boolean; message?: string } | null = null;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed) as { error?: boolean; message?: string };
    } catch {
      parsed = null;
    }
  }
  if (status === 404) {
    return {
      reason: "auth",
      message: `公開情報では${stage}が見つかりませんでした（404）。削除されたか、ログインが必要な作品かは、この応答だけでは区別できません。`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      reason: "auth",
      message: `pixivが${stage}の取得を拒否しました（${status}）。ログインが必要な作品です。`,
    };
  }
  if (parsed?.error) {
    const detail = typeof parsed.message === "string" ? parsed.message.trim() : "";
    return {
      reason: "auth",
      message: detail ? `pixivが${stage}を返せませんでした。${detail}` : `pixivが${stage}を返せませんでした。ログインが必要な作品の可能性があります。`,
    };
  }
  if (status >= 400) {
    return { reason: "other", message: `pixivが${stage}の取得に失敗しました（${status}）。時間をおいて、もう一度貼り付けてください。` };
  }
  if (!trimmed) return { reason: "other", message: `pixivが空の${stage}を返しました。` };
  return { reason: "other", message: `pixivの${stage}を読み取れませんでした。` };
}

export function pixivFailureMessage(stage: PixivStage, status: number, body: string): string {
  return pixivFailure(stage, status, body).message;
}

export function pixivNetworkMessage(stage: PixivStage): string {
  return `pixivに接続できませんでした（${stage}）。通信そのものが失敗しています。`;
}
