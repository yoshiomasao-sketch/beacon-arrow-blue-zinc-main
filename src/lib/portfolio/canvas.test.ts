import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  canvasSize,
  centerSplit,
  containedCenter,
  fittedPlacementSize,
  handleScreenBox,
  outsideVeilClip,
  screenDeltaToFrame,
  settleEditChrome,
  parseOrientation,
  parsePlacements,
  placeOpacityPanel,
  placementAlpha,
  placementHeight,
  placementOpacity,
  pointInPlacement,
  raisePlacement,
  rotatedDegrees,
  scaledWidth,
  zoomAtCursor,
  type CanvasPlacement,
} from "./canvas.ts";

describe("canvas placements", () => {
  it("keeps A4 ratio when the sheet is turned sideways", () => {
    assert.deepEqual(canvasSize("portrait"), { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    assert.deepEqual(canvasSize("landscape"), { width: CANVAS_HEIGHT, height: CANVAS_WIDTH });
    assert.equal(parseOrientation("landscape"), "landscape");
    assert.equal(parseOrientation(""), "portrait");
    const turned = fittedPlacementSize(200, 100, CANVAS_HEIGHT, CANVAS_WIDTH);
    assert.equal(turned.width / turned.height, 2);
    assert.ok(turned.width <= CANVAS_HEIGHT * 0.46 + 0.001);
    assert.ok(turned.height <= CANVAS_WIDTH * 0.46 + 0.001);
  });

  it("fits a dropped image inside the sheet without stretching it", () => {
    const wide = fittedPlacementSize(200, 100);
    assert.equal(wide.width / wide.height, 2);
    assert.ok(wide.width <= CANVAS_WIDTH * 0.46 + 0.001);
    assert.ok(wide.height <= CANVAS_HEIGHT * 0.46 + 0.001);
    const placed = containedCenter(0, 0, wide.width, wide.height);
    assert.ok(placed.x - wide.width / 2 >= -0.001);
    assert.ok(placed.y - wide.height / 2 >= -0.001);
  });

  it("scales from the center and keeps the source aspect", () => {
    assert.equal(scaledWidth(100, 40, 80), 200);
    assert.equal(placementHeight(200, 80, 40), 100);
    assert.equal(scaledWidth(100, 0, 80), 100);
  });

  it("rotates around the gesture and hits only the turned rectangle", () => {
    assert.equal(rotatedDegrees(10, 0, Math.PI / 2), 100);
    const box = { x: 100, y: 100, width: 100, height: 40, rotation: 90 };
    assert.equal(pointInPlacement(box, 100, 140), true);
    assert.equal(pointInPlacement(box, 140, 100), false);
    assert.equal(pointInPlacement({ ...box, rotation: 0 }, 140, 100), true);
  });

  it("cuts the veil on the sheet edge without moving the picture", () => {
    const clip = outsideVeilClip({ x: 0, y: 100, width: 200, height: 80, rotation: 0 }, 1050, 1485);
    assert.match(clip, /^path\(evenodd, "M -16 -16 H 216 V 96 H -16 Z M /);
    assert.ok(clip.includes("M 100 -60 L 1150 -60 L 1150 1425 L 100 1425 Z"));
    const turned = outsideVeilClip({ x: 500, y: 700, width: 400, height: 200, rotation: 90 }, 1050, 1485);
    assert.ok(turned.includes("M -500 600 L -500 -450 L 985 -450 L 985 600 Z"));
  });

  it("keeps edit controls inside the screen and apart without moving the picture", () => {
    const upright = handleScreenBox(100, 40, 0, 14, "top-right");
    assert.equal(upright.x, 86);
    assert.equal(upright.y, 40);
    assert.equal(upright.w, 14);
    assert.equal(upright.h, 14);
    const turned = handleScreenBox(100, 40, 90, 14, "top-right");
    assert.ok(Math.abs(turned.x - 86) < 0.01);
    assert.ok(Math.abs(turned.y - 26) < 0.01);
    assert.deepEqual(screenDeltaToFrame(10, 0, 0, 2), { x: 20, y: 0 });
    const local = screenDeltaToFrame(10, 0, 90, 1);
    assert.ok(Math.abs(local.x) < 0.001);
    assert.ok(Math.abs(local.y + 10) < 0.001);

    const view = { left: 0, top: 0, right: 200, bottom: 160 };
    const inside = settleEditChrome([{ x: 10, y: 12, w: 14, h: 14 }], view);
    assert.deepEqual(inside[0], { x: 10, y: 12, w: 14, h: 14 });
    const clipped = settleEditChrome([{ x: 260, y: -30, w: 14, h: 14 }], view)[0];
    assert.ok(clipped);
    assert.equal(clipped.x + clipped.w, 200);
    assert.equal(clipped.y, 0);

    const crowded = settleEditChrome(
      [
        { x: 190, y: 150, w: 14, h: 14 },
        { x: 190, y: 150, w: 14, h: 14 },
        { x: 120, y: 150, w: 120, h: 28 },
      ],
      view,
    );
    for (const box of crowded) {
      assert.ok(box.x >= view.left - 0.01);
      assert.ok(box.y >= view.top - 0.01);
      assert.ok(box.x + box.w <= view.right + 0.01);
      assert.ok(box.y + box.h <= view.bottom + 0.01);
    }
    for (let i = 0; i < crowded.length; i += 1) {
      for (let j = i + 1; j < crowded.length; j += 1) {
        const a = crowded[i];
        const b = crowded[j];
        if (!a || !b) continue;
        const gapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const gapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        assert.ok(gapX <= 0 || gapY <= 0);
      }
    }
  });

  it("reads only complete placement records", () => {
    const raw = JSON.stringify([
      { id: "p", imageId: "a", x: 1, y: 2, width: 3, rotation: 4, z: 5 },
      { id: "f", imageId: "b", x: 1, y: 2, width: 3, rotation: 0, z: 6, flat: true },
      { id: "g", imageId: "b", x: 1, y: 2, width: 3, rotation: 0, z: 7, flat: false },
      { id: "p", imageId: "dup", x: 1, y: 2, width: 3, rotation: 0, z: 0 },
      { id: "bad", imageId: "a", x: 1, width: 3 },
      null,
    ]);
    assert.deepEqual(parsePlacements(raw), [
      { id: "p", imageId: "a", x: 1, y: 2, width: 3, rotation: 4, z: 5 },
      { id: "f", imageId: "b", x: 1, y: 2, width: 3, rotation: 0, z: 6, flat: true },
      { id: "g", imageId: "b", x: 1, y: 2, width: 3, rotation: 0, z: 7 },
    ]);
    assert.deepEqual(parsePlacements(""), []);
    assert.deepEqual(parsePlacements("nope"), []);
    const faded = JSON.stringify([
      { id: "o", imageId: "a", x: 1, y: 2, width: 3, rotation: 0, z: 1, opacity: 40 },
      { id: "z", imageId: "a", x: 1, y: 2, width: 3, rotation: 0, z: 2, opacity: 0 },
      { id: "full", imageId: "a", x: 1, y: 2, width: 3, rotation: 0, z: 3, opacity: 100 },
      { id: "hi", imageId: "a", x: 1, y: 2, width: 3, rotation: 0, z: 4, opacity: 140 },
      { id: "bad", imageId: "a", x: 1, y: 2, width: 3, rotation: 0, z: 5, opacity: "40" },
      { id: "old", imageId: "a", x: 1, y: 2, width: 3, rotation: 0, z: 6 },
    ]);
    assert.equal(parsePlacements(faded).find((item) => item.id === "o")?.opacity, 40);
    assert.equal(parsePlacements(faded).find((item) => item.id === "z")?.opacity, 0);
    assert.equal(parsePlacements(faded).find((item) => item.id === "full")?.opacity, undefined);
    assert.equal(parsePlacements(faded).find((item) => item.id === "hi")?.opacity, undefined);
    assert.equal(parsePlacements(faded).find((item) => item.id === "bad")?.opacity, undefined);
    assert.equal(parsePlacements(faded).find((item) => item.id === "old")?.opacity, undefined);
    assert.equal(placementOpacity(undefined), 100);
    assert.equal(placementAlpha(40), 0.4);
    assert.equal(placementAlpha(0), 0);
  });

  it("keeps the opacity slider above the popup and inside the screen", () => {
    const view = { left: 0, top: 0, right: 400, bottom: 300 };
    const panel = { w: 180, h: 72 };
    const mid = placeOpacityPanel({ x: 100, y: 180, w: 160, h: 28 }, panel, view);
    assert.equal(mid.y, 180 - 8 - panel.h);
    assert.equal(mid.x, 100 + 80 - panel.w / 2);
    const top = placeOpacityPanel({ x: 100, y: 4, w: 160, h: 28 }, panel, view);
    assert.ok(top.y >= view.top);
    assert.ok(top.y + panel.h <= view.bottom);
    assert.ok(top.y >= 4 + 28 || top.x + panel.w <= 100 || top.x >= 260);
    const edge = placeOpacityPanel({ x: 330, y: 180, w: 60, h: 28 }, panel, view);
    assert.ok(edge.x >= view.left);
    assert.ok(edge.x + panel.w <= view.right);
    assert.equal(edge.y, 180 - 8 - panel.h);
    const handle = { x: 90, y: 180 - 8 - panel.h, w: 40, h: 40 };
    const shifted = placeOpacityPanel({ x: 100, y: 180, w: 160, h: 28 }, panel, view, [handle]);
    const hits =
      shifted.x < handle.x + handle.w &&
      shifted.x + panel.w > handle.x &&
      shifted.y < handle.y + handle.h &&
      shifted.y + panel.h > handle.y;
    assert.equal(hits, false);
  });

  it("raises a confirmed image to the front even when nothing else changed", () => {
    const back: CanvasPlacement = { id: "back", imageId: "a", x: 10, y: 20, width: 30, rotation: 15, z: 1 };
    const front: CanvasPlacement = { id: "front", imageId: "b", x: 40, y: 50, width: 60, rotation: 0, z: 2 };
    const raised = raisePlacement([back, front], back, false);
    assert.equal(raised.find((item) => item.id === "back")?.z, 3);
    assert.equal(raised.find((item) => item.id === "front")?.z, 2);
    assert.deepEqual(
      (({ z: _z, ...rest }) => rest)(raised.find((item) => item.id === "back")!),
      { id: "back", imageId: "a", x: 10, y: 20, width: 30, rotation: 15 },
    );
    const added = raisePlacement(raised, { id: "new", imageId: "c", x: 1, y: 2, width: 3, rotation: 0, z: 0 }, true);
    assert.equal(added.at(-1)?.id, "new");
    assert.equal(added.at(-1)?.z, 4);
    const baked = raisePlacement([back], { ...back, flat: true }, false);
    assert.equal(baked[0]?.flat, true);
    assert.equal(baked[0]?.x, back.x);
    const faded = raisePlacement([back], { ...back, opacity: 30 }, false);
    assert.equal(faded[0]?.opacity, 30);
  });

  it("keeps the gallery and canvas ratio until a side hits its minimum", () => {
    assert.equal(centerSplit(1012, 0.5), 0.5);
    assert.equal(centerSplit(1012, 0.3), 0.3);
    assert.equal(centerSplit(1012, 0.1), 220 / 1000);
    assert.equal(centerSplit(1012, 0.95), (1000 - 280) / 1000);
    assert.equal(centerSplit(0, 0.2), 0.5);
    const tight = centerSplit(400, 0.5);
    assert.ok(tight > 0.2 && tight < 0.8);
  });

  it("keeps the point under the cursor when the canvas zooms", () => {
    const next = zoomAtCursor(1, 0, 0, 40, -20, 2);
    assert.equal(next.zoom, 2);
    assert.equal(next.x + 40 * next.zoom, 40);
    assert.equal(next.y + -20 * next.zoom, -20);
  });
});
