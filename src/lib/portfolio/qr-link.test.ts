import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  confirmCode,
  connectionUrl,
  digestHex,
  emptyGather,
  encodeSignal,
  failureNote,
  gateAnswer,
  gatherChunks,
  pageUrlForPhone,
  parseConnectionText,
  QR_BYTE_LIMIT,
  qrByteLength,
  sdpDeferRemoteChecks,
  sdpHasCandidate,
  signalPayload,
  timeoutStage,
  type SignalMessage,
} from "./qr-link.ts";

const sdp = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n${Array.from({ length: 80 }, (_, index) => `a=candidate:${index} 1 UDP 2122252543 192.168.${index % 200}.${(index * 3) % 200} ${10000 + index} typ host\r\n`).join("")}`;

describe("qr link codec", () => {
  it("splits a long connection message and restores it without dropping bytes", () => {
    const message: SignalMessage = { v: 1, k: "offer", sdp };
    const lines = encodeSignal(message, "ab12cd34");
    assert.ok(lines.length > 1);
    let gather = emptyGather();
    let signal: SignalMessage | null = null;
    for (const line of lines) {
      const result = gatherChunks(gather, line);
      gather = result.gather;
      signal = result.signal;
    }
    assert.deepEqual(signal, message);
  });

  it("keeps an unfinished scan incomplete", () => {
    const lines = encodeSignal({ v: 1, k: "answer", sdp }, "00112233");
    const first = gatherChunks(emptyGather(), lines[0] ?? "");
    assert.equal(first.signal, null);
    assert.match(first.note, /1\//);
  });

  it("rejects a truncated or mixed chunk instead of guessing", () => {
    const lines = encodeSignal({ v: 1, k: "offer", sdp }, "abcdef01");
    const broken = lines.map((line, index) => (index === lines.length - 1 ? line.slice(0, -6) : line));
    assert.throws(() => {
      let gather = emptyGather();
      for (const line of broken) gather = gatherChunks(gather, line).gather;
    }, /結合できませんでした|形式が正しくありません|途中で切れています/);
    const other = gatherChunks(emptyGather(), lines[0] ?? "");
    const replacement = encodeSignal({ v: 1, k: "answer", sdp }, "ff00ff00")[0] ?? "";
    const restarted = gatherChunks(other.gather, replacement);
    assert.match(restarted.note, /破棄しました/);
    assert.equal(restarted.gather.id, "ff00ff00");
    assert.equal(restarted.signal, null);
  });

  it("hashes the test payload", async () => {
    assert.equal(await digestHex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("names the failed stage and keeps remote checks from starting early", () => {
    assert.match(failureNote("ice", "候補が届きません。"), /ICE接続の成立の段階で失敗しました/);
    assert.match(failureNote("ice", "候補が届きません。"), /外部サービスなしでは/);
    assert.equal(timeoutStage("connected"), "channel");
    assert.equal(timeoutStage("checking"), "ice");
    const offer = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=application 50000 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 192.0.2.10",
      "a=ice-ufrag:abcd",
      "a=ice-pwd:abcdefghijklmnopqrstuvwx",
      "a=fingerprint:sha-256 AA:BB",
      "a=setup:actpass",
      "a=mid:0",
      "a=sctp-port:5000",
      "a=candidate:1 1 UDP 1 192.0.2.10 50000 typ host",
      "a=end-of-candidates",
      "",
    ].join("\r\n");
    assert.equal(sdpHasCandidate(offer), true);
    const deferred = sdpDeferRemoteChecks(offer);
    assert.equal(sdpHasCandidate(deferred), false);
    assert.match(deferred, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel/);
    assert.match(deferred, /c=IN IP4 0\.0\.0\.0/);
    assert.match(deferred, /a=ice-ufrag:abcd/);
    assert.match(deferred, /a=fingerprint:sha-256 AA:BB/);
    assert.doesNotMatch(deferred, /192\.0\.2\.10/);
  });

  it("round-trips every QR piece without dropping bytes", () => {
    const lines = encodeSignal({ v: 1, k: "offer", sdp }, "ab12cd34");
    let gather = emptyGather();
    let signal: SignalMessage | null = null;
    for (const line of lines) {
      const qr = QRCode.create(line, { errorCorrectionLevel: "M" });
      const margin = 4;
      const scale = 4;
      const size = qr.modules.size;
      const dim = (size + margin * 2) * scale;
      const data = new Uint8ClampedArray(dim * dim * 4);
      for (let y = 0; y < dim; y += 1) {
        for (let x = 0; x < dim; x += 1) {
          const moduleX = Math.floor(x / scale) - margin;
          const moduleY = Math.floor(y / scale) - margin;
          const dark = moduleX >= 0 && moduleY >= 0 && moduleX < size && moduleY < size && qr.modules.get(moduleX, moduleY);
          const offset = (y * dim + x) * 4;
          const value = dark ? 0 : 255;
          data[offset] = value;
          data[offset + 1] = value;
          data[offset + 2] = value;
          data[offset + 3] = 255;
        }
      }
      const code = jsQR(data, dim, dim);
      assert.equal(code?.data, line);
      const result = gatherChunks(gather, code?.data ?? "");
      gather = result.gather;
      signal = result.signal;
    }
    assert.deepEqual(signal, { v: 1, k: "offer", sdp });
  });

  it("opens from one connection URL and does not treat a 4-digit code as the connection", async () => {
    const message: SignalMessage = {
      v: 1,
      k: "offer",
      sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:1 1 UDP 2122252543 192.168.1.20 50000 typ host\r\n",
    };
    const link = connectionUrl("http://127.0.0.1:8080/library?x=1#old", message);
    assert.equal(link.startsWith("http://127.0.0.1:8080/library?x=1#k1="), true);
    assert.deepEqual(parseConnectionText(link), message);
    const encoded = `${link.slice(0, link.indexOf("#k1=") + 4)}${encodeURIComponent(link.split("#k1=")[1] ?? "")}`;
    assert.deepEqual(parseConnectionText(encoded), message);
    const lines = encodeSignal({ v: 1, k: "offer", sdp }, "ab12cd34");
    assert.ok(lines.length > 1);
    const manual = `http://192.168.0.5:8080/#k1=${lines.join("~").replaceAll("~", "%7E")}`;
    assert.deepEqual(parseConnectionText(manual), { v: 1, k: "offer", sdp });
    assert.throws(() => parseConnectionText("https://www.google.com/search?q=komacho"), /検索へ移動しません/);
    assert.throws(() => connectionUrl("javascript:alert(1)", message), /住所を作れません/);

    const loopback = pageUrlForPhone(`http://127.0.0.1:8080/app?x=1#stay`, message.sdp);
    assert.match(loopback.url, /^http:\/\/192\.168\.1\.20:8080\/app\?x=1$/);
    assert.match(loopback.note, /192\.168\.1\.20/);
    const hidden = pageUrlForPhone("http://localhost:8080/", "a=candidate:1 1 UDP 1 phone.local 9 typ host");
    assert.match(hidden.url, /^http:\/\/localhost:8080\/$/);
    assert.match(hidden.note, /localhost/);
    const remote = pageUrlForPhone("https://example.com/app", message.sdp);
    assert.equal(remote.note, "");
    assert.match(remote.url, /^https:\/\/example.com\/app$/);

    const answer: SignalMessage = { ...message, k: "answer" };
    const code = await confirmCode(answer.sdp);
    assert.match(code, /^\d{4}$/);
    assert.equal(await confirmCode(answer.sdp), code);
    const payload = signalPayload(answer);
    const numberOnly = await gateAnswer("", code);
    assert.equal(numberOnly.ok, false);
    if (!numberOnly.ok) {
      assert.equal(numberOnly.reason, "number-only");
      assert.match(numberOnly.detail, /番号だけでは接続できません/);
    }
    const needsCode = await gateAnswer(payload, "");
    assert.equal(needsCode.ok, false);
    if (!needsCode.ok) assert.equal(needsCode.reason, "need-code");
    const wrongCode = code === "0000" ? "0001" : "0000";
    const mismatched = await gateAnswer(payload, wrongCode);
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.reason, "mismatch");
    const opened = await gateAnswer(payload, code);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal(opened.signal.sdp, answer.sdp);
    const offerPaste = await gateAnswer(link, code);
    assert.equal(offerPaste.ok, false);
    if (!offerPaste.ok) assert.equal(offerPaste.reason, "not-answer");

    const huge: SignalMessage = {
      v: 1,
      k: "offer",
      sdp: `${message.sdp}${Array.from({ length: 200 }, () => crypto.randomUUID()).join("")}\r\n`,
    };
    const bulky = connectionUrl("https://example.com/", huge);
    assert.ok(qrByteLength(bulky) > QR_BYTE_LIMIT);
    assert.equal(bulky.slice(bulky.indexOf("#k1=") + 4), signalPayload(huge));
    assert.equal(parseConnectionText(bulky).sdp, huge.sdp);

    const qr = QRCode.create(link, { errorCorrectionLevel: "L" });
    const margin = 4;
    const scale = 4;
    const size = qr.modules.size;
    const dim = (size + margin * 2) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4);
    for (let y = 0; y < dim; y += 1) {
      for (let x = 0; x < dim; x += 1) {
        const moduleX = Math.floor(x / scale) - margin;
        const moduleY = Math.floor(y / scale) - margin;
        const dark = moduleX >= 0 && moduleY >= 0 && moduleX < size && moduleY < size && qr.modules.get(moduleX, moduleY);
        const offset = (y * dim + x) * 4;
        const value = dark ? 0 : 255;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }
    const scanned = jsQR(data, dim, dim);
    assert.equal(scanned?.data, link);
    assert.deepEqual(parseConnectionText(scanned?.data ?? ""), message);
  });
});
