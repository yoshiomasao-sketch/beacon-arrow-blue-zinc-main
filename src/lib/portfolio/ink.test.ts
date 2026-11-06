import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySteadyPath, clearInkHistories, coalescedSamples, emptyInkHistory, inkSession, noteInkStep, redoInkStep, steadyPoint, undoInkStep, type InkSnap } from "./ink.ts";

describe("ink history", () => {
  it("treats one stroke as one step and drops redo after a new stroke", () => {
    const history = emptyInkHistory<string>();
    noteInkStep(history, "empty");
    noteInkStep(history, "line");
    assert.deepEqual(history.undo, ["empty", "line"]);
    assert.deepEqual(history.redo, []);
    assert.equal(undoInkStep(history, "dot"), "line");
    assert.equal(undoInkStep(history, "line"), "empty");
    assert.equal(undoInkStep(history, "empty"), null);
    assert.deepEqual(history.redo, ["dot", "line"]);
    assert.equal(redoInkStep(history, "empty"), "line");
    assert.equal(redoInkStep(history, "line"), "dot");
    noteInkStep(history, "dot");
    assert.deepEqual(history.redo, []);
    assert.deepEqual(history.undo, ["empty", "line", "dot"]);
  });

  it("keeps a bounded undo stack and restores a clear", () => {
    const history = emptyInkHistory<string>();
    noteInkStep(history, "a", 2);
    noteInkStep(history, "b", 2);
    noteInkStep(history, "c", 2);
    assert.deepEqual(history.undo, ["b", "c"]);
    assert.equal(undoInkStep(history, "cleared"), "c");
    assert.equal(redoInkStep(history, "c"), "cleared");
  });

  it("keeps the pointer when stabilization is off and softens it otherwise", () => {
    const previous = { x: 0, y: 0 };
    const next = { x: 10, y: 20 };
    assert.deepEqual(steadyPoint(null, next, "off"), next);
    assert.deepEqual(steadyPoint(previous, next, "off"), next);
    assert.deepEqual(steadyPoint(previous, next, "mid"), { x: 5, y: 10 });
    const eased = steadyPoint(previous, next, "low");
    assert.ok(Math.abs(eased.x - 7.8) < 1e-9 && Math.abs(eased.y - 15.6) < 1e-9);
  });

  it("keeps the first sample of a stroke on the pointer before easing", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    const drawn = applySteadyPath(null, points, "high");
    assert.deepEqual(drawn[0], { x: 0, y: 0 });
    assert.ok(Math.abs((drawn[1]?.x ?? 0) - 2.8) < 1e-9);
    assert.ok(Math.abs((drawn[2]?.x ?? 0) - (2.8 + (20 - 2.8) * 0.28)) < 1e-9);
    assert.deepEqual(applySteadyPath(null, points, "off"), points);
  });

  it("keeps coalesced samples in order and falls back to the event itself", () => {
    const nested = [
      { clientX: 1, clientY: 2 },
      { clientX: 3, clientY: 4 },
    ];
    const event = {
      clientX: 9,
      clientY: 9,
      getCoalescedEvents: () => nested,
    };
    assert.equal(coalescedSamples(event), nested);
    const empty = { clientX: 5, clientY: 6, getCoalescedEvents: () => [] as { clientX: number; clientY: number }[] };
    assert.equal(coalescedSamples(empty)[0], empty);
    const plain = { clientX: 7, clientY: 8 };
    assert.equal(coalescedSamples(plain)[0], plain);
  });

  it("does not mix histories between images", () => {
    clearInkHistories();
    const first = { pixels: "a-before" as unknown as HTMLCanvasElement, selection: null } satisfies InkSnap;
    const second = { pixels: "b-before" as unknown as HTMLCanvasElement, selection: null } satisfies InkSnap;
    const now = { pixels: "a-now" as unknown as HTMLCanvasElement, selection: null } satisfies InkSnap;
    noteInkStep(inkSession("image-a"), first);
    noteInkStep(inkSession("image-b"), second);
    assert.equal(undoInkStep(inkSession("image-a"), now), first);
    assert.equal(inkSession("image-b").undo[0], second);
    assert.equal(inkSession("image-a").redo.length, 1);
    clearInkHistories();
    assert.equal(inkSession("image-a").undo.length, 0);
    assert.equal(inkSession("image-b").undo.length, 0);
  });
});
