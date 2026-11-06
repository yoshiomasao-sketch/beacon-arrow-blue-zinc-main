import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileFromOriginal, OWN_FILE_DRAG, SHOT_DRAG, writeOriginalDrag, type OriginalDragSink } from "./export-file.ts";

describe("original drag payload", () => {
  it("passes the original bytes and mime through unchanged", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 9]);
    const blob = new Blob([bytes], { type: "image/png" });
    const file = fileFromOriginal({ name: "夕景.png", mime: "image/png", addedAt: 1_700_000_000_000 }, blob);
    assert.equal(file.type, "image/png");
    assert.equal(file.name, "夕景.png");
    assert.equal(file.size, bytes.byteLength);
    assert.equal(file.lastModified, 1_700_000_000_000);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    const sink: OriginalDragSink & { data: Map<string, string>; added: File | null; cleared: boolean } = {
      effectAllowed: "",
      data: new Map(),
      added: null,
      cleared: false,
      setData(type, value) {
        this.data.set(type, value);
      },
      items: {
        clear() {
          sink.cleared = true;
        },
        add(next) {
          sink.added = next;
        },
      },
    };
    writeOriginalDrag(sink, "shot-1", file);
    assert.equal(sink.effectAllowed, "copy");
    assert.equal(sink.cleared, true);
    assert.equal(sink.data.get(SHOT_DRAG), "shot-1");
    assert.equal(sink.data.get(OWN_FILE_DRAG), "shot-1");
    assert.equal(sink.data.get("text/plain"), "夕景.png");
    assert.equal(sink.added, file);
  });

  it("keeps a jpeg name and does not invent a png", () => {
    const file = fileFromOriginal({ name: "scan", mime: "image/jpeg", addedAt: 0 }, new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    assert.equal(file.name, "scan.jpg");
    assert.equal(file.type, "image/jpeg");
    assert.equal(file.size, 3);
  });
});
