/**
 * One-way LAN sync source for ポートフォリオΔ.
 * The PC browser uploads a .kmb snapshot to loopback. Phones on the same
 * Wi-Fi may download it. Nothing is written to disk or sent off the LAN.
 *
 * Start: node lan-sync-server.mjs
 * Stop: Ctrl+C in this window. Do not forward this port on the router.
 */
import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const LAN_PORT = 17331;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAGIC = Buffer.from("KMCHOBK1");

const token = crypto.randomBytes(8).toString("hex");
let snapshot = null;

export function normalizeIp(raw) {
  const value = String(raw ?? "").replace(/^::ffff:/, "");
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function classifyAddress(raw) {
  const ip = normalizeIp(raw).toLowerCase();
  if (!ip) return "unknown";
  if (ip === "127.0.0.1" || ip === "::1") return "loopback";
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return "private";
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "public";
  const [a, b] = parts;
  if (a === 10 || a === 127) return a === 127 ? "loopback" : "private";
  if (a === 192 && b === 168) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 169 && b === 254) return "private";
  return "public";
}

export function lanUrls(port = LAN_PORT) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal || entry.family !== "IPv4") continue;
      if (classifyAddress(entry.address) !== "private") continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

function tokenOk(req) {
  const header = String(req.headers.authorization ?? "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
  const given = bearer || query;
  const left = Buffer.from(given);
  const right = Buffer.from(token);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": res.reqOrigin ?? "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Private-Network-Access-Name": "Komacho LAN",
    "Private-Network-Access-ID": "01KOMACHO0LAN0SYNC00000000000001",
  });
  res.end(payload);
}

function createLanServer() {
  return http.createServer(async (req, res) => {
    const remote = classifyAddress(req.socket.remoteAddress);
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "*";
    res.reqOrigin = origin;
    if (remote === "public" || remote === "unknown") {
      send(res, 403, { ok: false, error: "lan-only" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, {
        ok: true,
        hasSnapshot: snapshot !== null,
        createdAt: snapshot?.createdAt ?? null,
        bytes: snapshot?.bytes.length ?? 0,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/session") {
      if (remote !== "loopback") {
        send(res, 403, { ok: false, error: "loopback-only" });
        return;
      }
      send(res, 200, {
        ok: true,
        token,
        port: LAN_PORT,
        urls: lanUrls(),
        hasSnapshot: snapshot !== null,
        createdAt: snapshot?.createdAt ?? null,
        bytes: snapshot?.bytes.length ?? 0,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/snapshot") {
      if (remote !== "loopback") {
        send(res, 403, { ok: false, error: "upload-is-pc-only" });
        return;
      }
      if (!tokenOk(req)) {
        send(res, 401, { ok: false, error: "token" });
        return;
      }
      try {
        const bytes = await readBody(req);
        if (bytes.length < 12 || !bytes.subarray(0, 8).equals(MAGIC)) {
          send(res, 400, { ok: false, error: "not-a-backup" });
          return;
        }
        snapshot = { bytes, createdAt: new Date().toISOString() };
        send(res, 200, { ok: true, bytes: bytes.length, createdAt: snapshot.createdAt });
      } catch (error) {
        const status = error && error.status === 413 ? 413 : 400;
        send(res, status, { ok: false, error: status === 413 ? "too-large" : "upload-failed" });
      }
      return;
    }
    if (req.method === "GET" && (url.pathname === "/snapshot" || url.pathname === "/snapshot.kmb")) {
      if (!tokenOk(req)) {
        send(res, 401, { ok: false, error: "token" });
        return;
      }
      if (!snapshot) {
        send(res, 404, { ok: false, error: "no-snapshot" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": snapshot.bytes.length,
        "Content-Disposition": "attachment; filename=\"komacho-lan.kmb\"",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Private-Network": "true",
      });
      res.end(snapshot.bytes);
      return;
    }
    send(res, 404, { ok: false, error: "not-found" });
  });
}

function start() {
  const server = createLanServer();
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.error(`ポート ${LAN_PORT} はすでに使われています。前の同期サーバーを止めてから、もう一度起動してください。`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
  server.listen(LAN_PORT, "0.0.0.0", () => {
    const urls = lanUrls();
    console.log("ポートフォリオΔの同期サーバーを起動しました。この窓は閉じないでください。");
    console.log(urls.length > 0 ? `待ち受け: ${urls.join("  ")}` : "LANの住所が見つかりません。Wi-Fiに接続してから起動し直してください。");
    console.log(`合言葉: ${token}`);
    console.log("PCのアプリで「同期」を押し、今のデータを送ってください。");
    console.log("ルーターのポート開放はしないでください。止めるときは Ctrl+C です。");
  });
}

const launched = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (launched) start();
