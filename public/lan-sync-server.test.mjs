import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyAddress, normalizeIp } from "./lan-sync-server.mjs";

test("classifies LAN clients and rejects the public internet", () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::1"), "loopback");
  assert.equal(normalizeIp("::ffff:192.168.0.4"), "192.168.0.4");
  assert.equal(classifyAddress("::ffff:192.168.0.4"), "private");
  assert.equal(classifyAddress("10.1.2.3"), "private");
  assert.equal(classifyAddress("172.16.5.5"), "private");
  assert.equal(classifyAddress("8.8.8.8"), "public");
  assert.equal(classifyAddress("2001:4860:4860::8888"), "public");
});

test("loopback can upload a snapshot and a wrong token cannot read it", async () => {
  const child = spawn(process.execPath, ["public/lan-sync-server.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || "server did not start")), 4000);
    const finish = () => {
      const found = output.match(/合言葉: ([0-9a-f]+)/);
      if (!found) return;
      clearTimeout(timer);
      resolve(found[1]);
    };
    child.stdout.on("data", finish);
    child.stderr.on("data", finish);
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(output || "server exited"));
    });
    finish();
  });
  try {
    const health = await fetch("http://127.0.0.1:17331/health");
    assert.equal(health.status, 200);
    const header = Buffer.alloc(12);
    header.write("KMCHOBK1");
    header.writeUInt32LE(2, 8);
    const body = Buffer.concat([header, Buffer.from("{}")]);
    const denied = await fetch("http://127.0.0.1:17331/snapshot", { method: "POST", body });
    assert.equal(denied.status, 401);
    const uploaded = await fetch("http://127.0.0.1:17331/snapshot", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    assert.equal(uploaded.status, 200);
    const missing = await fetch("http://127.0.0.1:17331/snapshot", { headers: { Authorization: "Bearer nope" } });
    assert.equal(missing.status, 401);
    const saved = await fetch("http://127.0.0.1:17331/snapshot", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(saved.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await saved.arrayBuffer()), body), 0);
  } finally {
    child.kill();
  }
});
