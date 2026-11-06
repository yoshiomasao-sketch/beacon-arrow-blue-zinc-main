import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";

const PIECE = 500;
const MAX_PIECES = 32;
const LINE = /^K1\.([0-9a-f]{8})\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/;

export type SignalMessage = {
  v: 1;
  k: "offer" | "answer";
  sdp: string;
};

export type Gather = {
  id: string | null;
  count: number;
  parts: string[];
};

export function emptyGather(): Gather {
  return { id: null, count: 0, parts: [] };
}

export function newSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function assertSignal(message: SignalMessage): void {
  if (message.v !== 1 || (message.k !== "offer" && message.k !== "answer")) {
    throw new Error("接続情報の形式が違います。");
  }
  if (!message.sdp.startsWith("v=0") || !message.sdp.includes("m=application")) {
    throw new Error("接続情報が途中で切れています。すべてのQRを読み取り直してください。");
  }
}

export function encodeSignal(message: SignalMessage, sessionId: string): string[] {
  assertSignal(message);
  if (!/^[0-9a-f]{8}$/.test(sessionId)) throw new Error("接続情報を作れませんでした。");
  const packed = bytesToBase64Url(gzipSync(strToU8(JSON.stringify(message))));
  const count = Math.ceil(packed.length / PIECE);
  if (count < 1 || count > MAX_PIECES) throw new Error("接続情報が長すぎてQRに分けられません。切り捨てはしていません。");
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(`K1.${sessionId}.${index + 1}.${count}.${packed.slice(index * PIECE, (index + 1) * PIECE)}`);
  }
  if (lines.join("").length < packed.length) throw new Error("接続情報を分けられませんでした。");
  return lines;
}

export function gatherChunks(current: Gather, raw: string): { gather: Gather; signal: SignalMessage | null; note: string } {
  const lines = raw
    .split(/\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { gather: current, signal: null, note: "接続情報が空です。" };
  const next: Gather = { id: current.id, count: current.count, parts: current.parts.slice() };
  let replaced = false;
  for (const line of lines) {
    const match = LINE.exec(line);
    if (!match) throw new Error("QRの形式が正しくありません。途中で切れていないか確認してください。");
    const id = match[1] ?? "";
    const index = Number(match[2]);
    const count = Number(match[3]);
    const piece = match[4] ?? "";
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > MAX_PIECES || index < 1 || index > count) {
      throw new Error("QRの順番が正しくありません。");
    }
    if (next.id && next.id !== id) {
      next.id = id;
      next.count = count;
      next.parts = Array.from({ length: count }, () => "");
      replaced = true;
    }
    if (!next.id) {
      next.id = id;
      next.count = count;
      next.parts = Array.from({ length: count }, () => "");
    }
    if (count !== next.count) throw new Error("QRの枚数が一致しません。最初から読み取り直してください。");
    const previous = next.parts[index - 1] ?? "";
    if (previous && previous !== piece) throw new Error("同じ番号のQRの内容が違います。読み取り直してください。");
    next.parts[index - 1] = piece;
  }
  const have = next.parts.filter(Boolean).length;
  if (have < next.count) {
    return {
      gather: next,
      signal: null,
      note: `${replaced ? "新しい接続情報を読み始めたので、前の読み取りは破棄しました。" : ""}${have}/${next.count} を読み取りました。残りのQRも読み取ってください。`,
    };
  }
  let message: SignalMessage;
  try {
    message = JSON.parse(strFromU8(gunzipSync(base64UrlToBytes(next.parts.join(""))))) as SignalMessage;
    assertSignal(message);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("接続情報")) throw error;
    throw new Error("接続情報を結合できませんでした。QRが欠けていないか確認してください。");
  }
  return { gather: emptyGather(), signal: message, note: "接続情報を結合しました。" };
}

export async function digestHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const FILE_CHUNK = 16 * 1024;
export const BUFFER_LIMIT = 256 * 1024;

export const CONNECT_STAGES = ["qr", "parse", "prepare", "ice", "channel", "file"] as const;

export type ConnectStage = (typeof CONNECT_STAGES)[number];

export function stageLabel(stage: ConnectStage): string {
  if (stage === "qr") return "QRコードの読み取り";
  if (stage === "parse") return "接続情報の解析";
  if (stage === "prepare") return "WebRTC接続の準備";
  if (stage === "ice") return "ICE接続の成立";
  if (stage === "channel") return "DataChannel接続の成立";
  return "テストファイルの送信・受信";
}

export function failureNote(stage: ConnectStage, detail: string): string {
  return `${stageLabel(stage)}の段階で失敗しました。${detail} 外部サービスなしでは、この先へ直接接続できない可能性があります。`;
}

export function timeoutStage(ice: string): ConnectStage {
  return ice === "connected" || ice === "completed" ? "channel" : "ice";
}

export function sdpHasCandidate(sdp: string): boolean {
  return sdp.split(/\r?\n/).some((line) => line.startsWith("a=candidate:"));
}

export function sdpDeferRemoteChecks(sdp: string): string {
  const lines = sdp
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith("a=candidate:") && line !== "a=end-of-candidates");
  const rewritten = lines.map((line) => {
    if (line.startsWith("m=application ")) {
      const parts = line.split(" ");
      if (parts.length >= 2) parts[1] = "9";
      return parts.join(" ");
    }
    if (line.startsWith("c=")) return "c=IN IP4 0.0.0.0";
    return line;
  });
  return `${rewritten.join("\r\n")}\r\n`;
}

/** Version 40, error correction L, byte mode. Do not put more than this in one QR. */
export const QR_BYTE_LIMIT = 2953;

export const ANSWER_RETURN_LIMIT =
  "ブラウザはスマホの応答をPCへ自動で返せません。外部の中継サーバーもPCのカメラも使わないため、応答の文字列を1回だけコピーしてPCに貼り付けてください。4桁の番号は貼り付けの確認だけです。番号だけでは接続できません。";

export function qrByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function signalPayload(message: SignalMessage): string {
  assertSignal(message);
  return bytesToBase64Url(gzipSync(strToU8(JSON.stringify(message))));
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replaceAll("[", "").replaceAll("]", "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = nums[0] ?? -1;
  const b = nums[1] ?? -1;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

export function hostCandidateForPage(sdp: string): string | null {
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:") || !line.includes(" typ host")) continue;
    const address = line.split(" ")[4] ?? "";
    if (isPrivateIpv4(address)) return address;
  }
  return null;
}

export function pageUrlForPhone(pageUrl: string, sdp: string): { url: string; note: string } {
  const url = new URL(pageUrl);
  url.hash = "";
  if (!isLoopbackHost(url.hostname)) return { url: url.toString(), note: "" };
  const ip = hostCandidateForPage(sdp);
  if (!ip) {
    return {
      url: url.toString(),
      note: "このページはPCの中（localhost）でしか開けません。スマホのカメラで読み取ってもアプリは開きません。同じWi-FiのPCの住所でアプリを開いてから、もう一度QRを作ってください。",
    };
  }
  url.hostname = ip;
  return {
    url: url.toString(),
    note: `スマホが同じネットワークから開けるよう、QRの住所を ${ip} にしました。その住所でこのアプリが見えないときは、読み取っても接続画面は開きません。`,
  };
}

export function connectionUrl(pageUrl: string, message: SignalMessage): string {
  const url = new URL(pageUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("接続用の住所を作れません。");
  url.hash = "";
  return `${url.origin}${url.pathname}${url.search}#k1=${signalPayload(message)}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractPayload(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("接続情報が空です。");
  const marker = text.indexOf("#k1=");
  if (marker >= 0) {
    const payload = safeDecode((text.slice(marker + 4).split(/\s/)[0] ?? "").trim());
    if (!payload) throw new Error("接続情報が見つかりません。検索には移動しません。");
    if (payload.includes("K1.") && payload.includes("~")) return payload.split("~").join("\n");
    return payload;
  }
  if (text.includes("K1.")) return text;
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  throw new Error("接続情報が見つかりません。この文字では検索へ移動しません。");
}

export function parseConnectionText(raw: string): SignalMessage {
  const input = extractPayload(raw);
  if (input.includes("K1.")) {
    const result = gatherChunks(emptyGather(), input);
    if (!result.signal) throw new Error("1回分の接続情報が揃っていません。短く切ってはいません。");
    return result.signal;
  }
  try {
    const message = JSON.parse(strFromU8(gunzipSync(base64UrlToBytes(input)))) as SignalMessage;
    assertSignal(message);
    return message;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("接続情報")) throw error;
    throw new Error("接続情報を解析できませんでした。途中で切れていないか確認してください。");
  }
}

export async function confirmCode(sdp: string): Promise<string> {
  const hex = await digestHex(new TextEncoder().encode(sdp));
  return String(Number.parseInt(hex.slice(0, 8), 16) % 10000).padStart(4, "0");
}

export type AnswerGate =
  | { ok: true; signal: SignalMessage }
  | { ok: false; reason: "number-only" | "missing" | "need-code" | "mismatch" | "not-answer" | "bad"; detail: string };

export async function gateAnswer(raw: string, code: string): Promise<AnswerGate> {
  const digits = code.trim();
  const text = raw.trim();
  if (!text && digits) {
    return {
      ok: false,
      reason: "number-only",
      detail: "番号だけでは接続できません。スマホに出た応答の文字列を貼り付けてください。4桁は、その貼り付けが正しいかの確認だけです。",
    };
  }
  if (!text) {
    return { ok: false, reason: "missing", detail: "スマホの応答を貼り付けてください。番号だけでは接続できません。" };
  }
  let signal: SignalMessage;
  try {
    signal = parseConnectionText(text);
  } catch (error) {
    return { ok: false, reason: "bad", detail: error instanceof Error ? error.message : "応答を読めませんでした。" };
  }
  if (signal.k !== "answer") {
    return {
      ok: false,
      reason: "not-answer",
      detail: "これは応答ではありません。スマホ側に出た応答を貼り付けてください。番号だけでは接続できません。",
    };
  }
  if (!/^\d{4}$/.test(digits)) {
    return {
      ok: false,
      reason: "need-code",
      detail: "確認用の4桁を入力してください。番号だけでは接続できません。応答と番号が両方一致したときだけ接続します。",
    };
  }
  const expected = await confirmCode(signal.sdp);
  if (digits !== expected) {
    return {
      ok: false,
      reason: "mismatch",
      detail: "確認番号が応答と一致しないので、接続情報は適用しませんでした。番号だけでは接続できません。",
    };
  }
  return { ok: true, signal };
}
