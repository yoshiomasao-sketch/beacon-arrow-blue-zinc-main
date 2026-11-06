export const LAN_PORT = 17331;
const HOST_KEY = "komacho-lan-base";
const TOKEN_KEY = "komacho-lan-token";

export type SyncSpace = "local" | "loopback";

export type SyncBase = { url: string; space: SyncSpace };

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function isPrivateHostname(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".local")) return true;
  if (name.includes(":")) {
    return name === "::1" || name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd");
  }
  const parts = ipv4Parts(name);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function parseSyncBase(input: string): SyncBase {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("PCのアドレスを入力してください。");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (withScheme.toLowerCase().startsWith("https://")) {
    throw new Error("同期サーバーは http です。https では接続できません。");
  }
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("アドレスの形式が正しくありません。");
  }
  if (!isPrivateHostname(url.hostname)) {
    throw new Error("自宅のLANアドレスだけを受け付けます。インターネット上のアドレスには接続しません。");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("アドレスは http://192.168.x.x:17331 の形にしてください。");
  }
  const port = url.port ? Number(url.port) : LAN_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ポート番号が正しくありません。");
  const host = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
  const space: SyncSpace = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" ? "loopback" : "local";
  return { url: `http://${host}:${port}`, space };
}

export function rememberSyncTarget(base: string, token: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(HOST_KEY, base);
  localStorage.setItem(TOKEN_KEY, token);
}

export function rememberedSyncTarget(): { base: string; token: string } {
  if (typeof localStorage === "undefined") return { base: "", token: "" };
  return { base: localStorage.getItem(HOST_KEY) ?? "", token: localStorage.getItem(TOKEN_KEY) ?? "" };
}

export function lanErrorMessage(error: unknown, status?: number): string {
  if (status === 401) return "合言葉が違います。データは変更していません。";
  if (status === 403) return "この端末からは接続できません。データは変更していません。";
  if (status === 404) return "PCからまだデータが送られていません。データは変更していません。";
  if (status === 413) return "データが大きすぎて送れませんでした。保存データは変更していません。";
  if (error instanceof Error && error.message && !/failed to fetch|networkerror|load failed/i.test(error.message)) {
    return error.message;
  }
  return "接続できませんでした。同期サーバーが起動しているか、同じWi-Fiか、ブラウザがローカルネットワークへの接続を止めていないかを確認してください。データは変更していません。";
}

export async function lanFetch(base: SyncBase, path: string, init: { method?: string; token?: string; body?: BodyInit | null; signal?: AbortSignal } = {}): Promise<Response> {
  const headers = new Headers();
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("Content-Type", "application/octet-stream");
  const request = {
    method: init.method ?? "GET",
    mode: "cors" as const,
    headers,
    body: init.body ?? undefined,
    signal: init.signal,
    targetAddressSpace: base.space,
  };
  try {
    return await fetch(`${base.url}${path}`, request as RequestInit);
  } catch (error) {
    throw new Error(lanErrorMessage(error));
  }
}
