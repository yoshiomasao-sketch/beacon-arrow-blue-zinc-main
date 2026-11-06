import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPrivateHostname, lanErrorMessage, parseSyncBase } from "./lan-sync.ts";

describe("lan sync address", () => {
  it("accepts a private PC address and the loopback server", () => {
    assert.equal(parseSyncBase("192.168.1.20").url, "http://192.168.1.20:17331");
    assert.equal(parseSyncBase("http://10.0.0.8:17331").space, "local");
    assert.equal(parseSyncBase("http://127.0.0.1:17331").space, "loopback");
    assert.equal(isPrivateHostname("printer.local"), true);
  });

  it("rejects public hosts and https", () => {
    assert.throws(() => parseSyncBase("https://192.168.1.20:17331"), /http です/);
    assert.throws(() => parseSyncBase("https://example.com"), /http です/);
    assert.throws(() => parseSyncBase("http://example.com:17331"), /LANアドレスだけ/);
    assert.throws(() => parseSyncBase("http://192.168.1.20:17331/snapshot"), /形にして/);
  });

  it("keeps library data unchanged in the failure message", () => {
    assert.match(lanErrorMessage(new TypeError("Failed to fetch")), /変更していません/);
    assert.match(lanErrorMessage(new Error("x"), 401), /合言葉/);
    assert.match(lanErrorMessage(new Error("x"), 404), /まだデータが送られていません/);
  });
});
