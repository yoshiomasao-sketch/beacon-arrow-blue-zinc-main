import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceDeck, clampSlideSeconds, slideshowCandidates, startDeck } from "./slideshow.ts";

describe("slideshow candidates", () => {
  it("keeps gallery order and drops video", () => {
    const picked = slideshowCandidates([
      { id: "a", mime: "image/jpeg" },
      { id: "b", mime: "video/mp4" },
      { id: "c", mime: "image/png" },
      { id: "d", mime: "video/webm" },
      { id: "e", mime: "image/gif" },
    ]);
    assert.deepEqual(picked.map((item) => item.id), ["a", "c", "e"]);
  });

  it("clamps the interval to whole seconds from 1 to 60", () => {
    assert.equal(clampSlideSeconds(1), 1);
    assert.equal(clampSlideSeconds(5), 5);
    assert.equal(clampSlideSeconds(5.6), 6);
    assert.equal(clampSlideSeconds(60), 60);
    assert.equal(clampSlideSeconds(61), 60);
    assert.equal(clampSlideSeconds(0), 1);
    assert.equal(clampSlideSeconds(99), 60);
    assert.equal(clampSlideSeconds(Number.NaN), 5);
  });
});

describe("slideshow order", () => {
  it("plays sequence in order and wraps", () => {
    let cursor = startDeck(3, "sequence");
    assert.deepEqual(cursor, { deck: [0, 1, 2], at: 0 });
    cursor = advanceDeck(cursor, 3, "sequence");
    assert.equal(cursor.at, 1);
    cursor = advanceDeck(cursor, 3, "sequence");
    assert.equal(cursor.at, 2);
    cursor = advanceDeck(cursor, 3, "sequence");
    assert.equal(cursor.at, 0);
    assert.deepEqual(cursor.deck, [0, 1, 2]);
  });

  it("repeats the only image", () => {
    let cursor = startDeck(1, "random");
    cursor = advanceDeck(cursor, 1, "random", () => 0);
    assert.deepEqual(cursor, { deck: [0], at: 0 });
  });

  it("does not repeat inside a random pass or across the boundary", () => {
    const random = mulberry(7);
    let cursor = startDeck(5, "random", random);
    const first = [cursor.deck[cursor.at] ?? -1];
    for (let step = 0; step < 4; step += 1) {
      cursor = advanceDeck(cursor, 5, "random", random);
      first.push(cursor.deck[cursor.at] ?? -1);
    }
    assert.equal(new Set(first).size, 5);
    const last = first[first.length - 1];
    cursor = advanceDeck(cursor, 5, "random", random);
    const next = cursor.deck[cursor.at];
    assert.notEqual(next, last);
    const second = [next ?? -1];
    for (let step = 0; step < 4; step += 1) {
      cursor = advanceDeck(cursor, 5, "random", random);
      second.push(cursor.deck[cursor.at] ?? -1);
    }
    assert.equal(new Set(second).size, 5);
  });
});

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
