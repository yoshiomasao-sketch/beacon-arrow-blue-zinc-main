import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { axisLocked, drawerSpan, edgeGesture, gestureCommits, revealForMove, slideX } from "./phone-edge.ts";

describe("phone edge swipe", () => {
  it("opens from the screen edge and closes from inside the open panel", () => {
    assert.deepEqual(edgeGesture({ startX: 10, viewport: 390, open: null, inFolder: false, inTag: false, editable: false }), {
      kind: "open",
      side: "folder",
      other: null,
    });
    assert.deepEqual(edgeGesture({ startX: 370, viewport: 390, open: null, inFolder: false, inTag: false, editable: false }), {
      kind: "open",
      side: "tag",
      other: null,
    });
    assert.equal(edgeGesture({ startX: 180, viewport: 390, open: null, inFolder: false, inTag: false, editable: false }), null);
    assert.equal(edgeGesture({ startX: 8, viewport: 390, open: null, inFolder: false, inTag: false, editable: true }), null);
    assert.deepEqual(edgeGesture({ startX: 80, viewport: 390, open: "folder", inFolder: true, inTag: false, editable: false }), {
      kind: "close",
      side: "folder",
    });
    assert.deepEqual(edgeGesture({ startX: 370, viewport: 390, open: "folder", inFolder: false, inTag: false, editable: false }), {
      kind: "open",
      side: "tag",
      other: "folder",
    });
  });

  it("follows the finger and commits only after about 20 percent of the screen", () => {
    const span = drawerSpan(390, 16);
    assert.equal(span, 320);
    const opening = revealForMove({ kind: "open", side: "folder", other: null }, 40, span);
    assert.equal(opening.folder, 40);
    assert.equal(slideX("folder", opening.folder, span), -280);
    assert.equal(gestureCommits({ kind: "open", side: "folder", other: null }, opening, span, 390), false);
    const past = revealForMove({ kind: "open", side: "folder", other: null }, 80, span);
    assert.equal(gestureCommits({ kind: "open", side: "folder", other: null }, past, span, 390), true);
    const closing = revealForMove({ kind: "close", side: "tag" }, 70, span);
    assert.equal(closing.tag, 250);
    assert.equal(gestureCommits({ kind: "close", side: "tag" }, closing, span, 390), false);
    const switched = revealForMove({ kind: "open", side: "tag", other: "folder" }, -90, span);
    assert.equal(switched.tag, 90);
    assert.equal(switched.folder, 230);
    assert.equal(axisLocked({ kind: "open", side: "folder", other: null }, 8, 2), false);
    assert.equal(axisLocked({ kind: "open", side: "folder", other: null }, 20, 30), false);
    assert.equal(axisLocked({ kind: "open", side: "folder", other: null }, 20, 4), true);
  });
});
