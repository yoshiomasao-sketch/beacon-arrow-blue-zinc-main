import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloneSelection,
  lassoSelection,
  moveSelection,
  pointInSelection,
  rectSelection,
  selectionBounds,
  transformedBounds,
} from "./ink-select.ts";

describe("ink selection geometry", () => {
  it("normalizes a rectangle dragged toward the top left", () => {
    const rect = rectSelection(10, 8, 2, 3);
    assert.deepEqual(rect, { kind: "rect", x: 2, y: 3, w: 8, h: 5 });
    assert.equal(rectSelection(4, 4, 4.2, 9), null);
  });

  it("closes a lasso without treating a short stroke as a selection", () => {
    assert.equal(lassoSelection([{ x: 0, y: 0 }, { x: 4, y: 0 }]), null);
    const lasso = lassoSelection([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ]);
    assert.equal(lasso?.kind, "lasso");
    assert.equal(pointInSelection(lasso!, 5, 4), true);
    assert.equal(pointInSelection(lasso!, 15, 4), false);
    assert.equal(pointInSelection(lasso!, 0, 4), true);
  });

  it("keeps a point inside a rectangle edge and outside past it", () => {
    const rect = rectSelection(2, 4, 12, 14)!;
    assert.equal(pointInSelection(rect, 2, 4), true);
    assert.equal(pointInSelection(rect, 12, 14), true);
    assert.equal(pointInSelection(rect, 1.9, 8), false);
  });

  it("slides the shape without changing its size or the original object", () => {
    const rect = rectSelection(1, 2, 5, 8)!;
    const moved = moveSelection(rect, 3, -1);
    assert.deepEqual(moved, { kind: "rect", x: 4, y: 1, w: 4, h: 6 });
    assert.equal(rect.kind === "rect" && rect.x, 1);
    const lasso = lassoSelection([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ])!;
    const slid = moveSelection(lasso, 2, 2);
    assert.equal(lasso.kind === "lasso" && lasso.points[0]?.x, 0);
    assert.equal(slid.kind === "lasso" && slid.points[2]?.y, 6);
    assert.deepEqual(selectionBounds(rect), { x: 1, y: 2, w: 4, h: 6, cx: 3, cy: 5 });
  });

  it("clones a lasso so later edits do not rewrite the stored shape", () => {
    const lasso = lassoSelection([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 6 },
    ])!;
    const copy = cloneSelection(lasso)!;
    if (copy.kind === "lasso" && lasso.kind === "lasso") copy.points[0]!.x = 9;
    assert.equal(lasso.kind === "lasso" ? lasso.points[0]?.x : -1, 0);
  });

  it("places the lifted box around the scaled and shifted center", () => {
    const rect = rectSelection(0, 0, 10, 10)!;
    const box = transformedBounds(rect, { dx: 3, dy: 0, scale: 2, rotation: 0 });
    assert.equal(box.cx, 8);
    assert.equal(box.cy, 5);
    assert.equal(box.w, 20);
    assert.equal(box.h, 20);
  });
});
