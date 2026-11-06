import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDENTITY_ZOOM,
  ZOOM_MAX,
  DOUBLE_TAP_SCALE,
  DRAG_REST,
  PINCH_MIN,
  ZOOM_EPSILON,
  doubleTapZoom,
  freshGesture,
  gestureDown,
  gestureMove,
  gestureUp,
  infoOpenForItem,
  infoSheetDismiss,
  isZoomed,
  isUnderFitted,
  lightboxGestureAction,
  panTo,
  panEdges,
  clampZoom,
  pinchTo,
  pinchRelease,
  sameImagePoint,
  swipeStep,
  verticalSwipe,
  visualRect,
  ZOOM_ANIM_MS,
  SWIPE_ANIM_MS,
  SWIPE_MIN,
  dragFollow,
  dragVelocity,
  infoSheetStep,
  incomingX,
  incomingSlideVisible,
  parkedX,
  releaseSwipe,
  rubberOffset,
  scrimForDrag,
  scrimForPinch,
  scrubDrag,
  slideSpan,
  type Box,
  type StageSize,
  type Zoom,
} from "./lightbox-zoom.ts";

const base: Box = { left: 16, top: 80, width: 300, height: 200 };
const stage: StageSize = { width: 390, height: 600 };
const layout = { base, stage };
const center = { x: base.left + base.width / 2, y: base.top + base.height / 2 };

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} !== ${expected}`);
}

describe("lightbox zoom", () => {
  it("keeps the aspect ratio and the fitted size at scale 1", () => {
    const rect = visualRect(base, IDENTITY_ZOOM);
    near(rect.width / rect.height, base.width / base.height);
    near(rect.width, base.width);
    near(rect.left, base.left);
    assert.equal(isZoomed(IDENTITY_ZOOM), false);
  });

  it("zooms around the fingers instead of the image center", () => {
    const fitted: Box = { left: 0, top: 0, width: 300, height: 400 };
    const room: StageSize = { width: 390, height: 500 };
    const focal = { x: 90, y: 160 };
    const zoom = pinchTo(fitted, room, IDENTITY_ZOOM, focal, focal, 40, 80);
    assert.equal(zoom.scale, 2);
    assert.ok(sameImagePoint(fitted, IDENTITY_ZOOM, zoom, focal));
    assert.notEqual(zoom.x, 0);
  });

  it("pans with the pinch midpoint and refuses extreme scales", () => {
    const start = { x: 180, y: 180 };
    const moved = { x: 200, y: 190 };
    const zoom = pinchTo(base, stage, IDENTITY_ZOOM, start, moved, 40, 80);
    assert.equal(zoom.scale, 2);
    const huge = pinchTo(base, stage, IDENTITY_ZOOM, center, center, 10, 10000);
    assert.equal(huge.scale, ZOOM_MAX);
    const tiny = pinchTo(base, stage, { scale: 2, x: 0, y: 0 }, center, center, 80, 1);
    assert.equal(tiny.scale, PINCH_MIN);
    near(tiny.x, 0);
    near(tiny.y, 0);
  });

  it("drags a zoomed image and keeps it on the stage", () => {
    const fitted: Box = { left: 0, top: 0, width: 300, height: 400 };
    const room: StageSize = { width: 390, height: 500 };
    const start: Zoom = { scale: 2, x: 0, y: 0 };
    const zoom = panTo(fitted, room, start, 5000, -5000);
    const rect = visualRect(fitted, zoom);
    assert.ok(rect.left <= 0.001);
    assert.ok(rect.left + rect.width >= room.width - 0.001);
    assert.ok(rect.top <= 0.001);
    assert.ok(rect.top + rect.height >= room.height - 0.001);
    const restored = panTo(fitted, room, IDENTITY_ZOOM, 80, 40);
    near(restored.x, 0);
    near(restored.y, 0);
  });

  it("swipes only while the image is fitted", () => {
    assert.equal(swipeStep(-80, 4, false), 1);
    assert.equal(swipeStep(80, 4, false), -1);
    assert.equal(swipeStep(-80, 100, false), 0);
    assert.equal(swipeStep(-20, 0, false), 0);
    assert.equal(swipeStep(-120, 0, true), 0);
  });

  it("does not turn the page during a pinch, then drags until a double tap resets", () => {
    let zoom: Zoom = IDENTITY_ZOOM;
    let gesture = freshGesture();
    gesture = gestureDown(gesture, zoom, 1, 120, 200).gesture;
    gesture = gestureDown(gesture, zoom, 2, 180, 200).gesture;
    const pinched = gestureMove(gesture, 2, 240, 210, layout);
    gesture = pinched.gesture;
    zoom = pinched.zoom ?? zoom;
    assert.ok(zoom.scale > 1);
    const lift = gestureUp(gesture, zoom, 1, 1000);
    gesture = lift.gesture;
    assert.equal(lift.step, undefined);
    const drag = gestureMove(gesture, 2, 40, 260, layout);
    gesture = drag.gesture;
    zoom = drag.zoom ?? zoom;
    assert.equal(gesture.mode, "pan");
    const done = gestureUp(gesture, zoom, 2, 1100);
    assert.equal(done.step, undefined);
    assert.equal(done.suppressClick, true);

    gesture = freshGesture();
    zoom = { scale: 3, x: 12, y: -8 };
    gesture = gestureDown(gesture, zoom, 1, 150, 220).gesture;
    const first = gestureUp(gesture, zoom, 1, 2000);
    gesture = first.gesture;
    assert.equal(first.zoom, undefined);
    gesture = gestureDown(gesture, zoom, 1, 154, 224).gesture;
    const second = gestureUp(gesture, zoom, 1, 2200);
    assert.deepEqual(second.zoom, IDENTITY_ZOOM);
    assert.equal(second.step, undefined);
    assert.equal(second.suppressClick, true);
    assert.equal(isZoomed(second.zoom ?? zoom), false);
  });

  it("returns to swiping after the fitted size is restored, and a pinch cannot finish as a swipe", () => {
    let gesture = freshGesture();
    let zoom: Zoom = IDENTITY_ZOOM;
    gesture = gestureDown(gesture, zoom, 1, 100, 200).gesture;
    gesture = gestureMove(gesture, 1, 10, 204, layout).gesture;
    const turned = gestureUp(gesture, zoom, 1, 500);
    assert.equal(turned.step, 1);

    gesture = freshGesture();
    gesture = gestureDown(gesture, zoom, 1, 100, 200).gesture;
    gesture = gestureDown(gesture, zoom, 2, 160, 200).gesture;
    gesture = gestureUp(gesture, zoom, 2, 600).gesture;
    gesture = gestureMove(gesture, 1, 10, 200, layout).gesture;
    const afterPinch = gestureUp(gesture, zoom, 1, 700);
    assert.equal(afterPinch.step, undefined);

    gesture = freshGesture();
    gesture = gestureDown(gesture, zoom, 1, 100, 200).gesture;
    const tap = gestureUp(gesture, zoom, 1, 800);
    gesture = gestureDown(tap.gesture, zoom, 1, 108, 206).gesture;
    const again = gestureUp(gesture, zoom, 1, 900);
    assert.equal(again.zoom, undefined);
    assert.equal(again.suppressClick, true);
    gesture = gestureDown(again.gesture, IDENTITY_ZOOM, 1, 200, 200).gesture;
    gesture = gestureMove(gesture, 1, 280, 202, layout).gesture;
    const next = gestureUp(gesture, IDENTITY_ZOOM, 1, 1000);
    assert.equal(next.step, -1);
  });

  it("zooms to twice the fitted size around a double tap, then returns on the next one", () => {
    const fitted: Box = { left: 45, top: 100, width: 300, height: 400 };
    const room: StageSize = { width: 390, height: 600 };
    const frame = { base: fitted, stage: room };
    const focal = { x: fitted.left + fitted.width / 2, y: fitted.top + fitted.height / 2 };
    let gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, focal.x, focal.y).gesture;
    const first = gestureUp(gesture, IDENTITY_ZOOM, 1, 1000, frame);
    assert.equal(first.zoom, undefined);
    gesture = gestureDown(first.gesture, IDENTITY_ZOOM, 1, focal.x + 6, focal.y - 4).gesture;
    const opened = gestureUp(gesture, IDENTITY_ZOOM, 1, 1180, frame);
    const zoom = opened.zoom ?? IDENTITY_ZOOM;
    assert.equal(opened.animateZoom, true);
    assert.equal(zoom.scale, DOUBLE_TAP_SCALE);
    assert.equal(opened.step, undefined);
    assert.equal(opened.suppressClick, true);
    assert.ok(sameImagePoint(fitted, IDENTITY_ZOOM, zoom, { x: focal.x + 6, y: focal.y - 4 }));
    const rect = visualRect(fitted, zoom);
    assert.ok(rect.left <= 0.001);
    assert.ok(rect.top <= 0.001);
    assert.ok(rect.left + rect.width >= room.width - 0.001);
    assert.ok(rect.top + rect.height >= room.height - 0.001);

    gesture = gestureDown(opened.gesture, zoom, 1, 200, 280).gesture;
    const dragged = gestureMove(gesture, 1, 160, 320, frame);
    assert.equal(dragged.gesture.mode, "pan");
    assert.equal(swipeStep(-80, 0, isZoomed(dragged.zoom ?? zoom)), 0);
    gesture = gestureUp(dragged.gesture, dragged.zoom ?? zoom, 1, 1400, frame).gesture;

    gesture = gestureDown(gesture, dragged.zoom ?? zoom, 1, 180, 260).gesture;
    const arm = gestureUp(gesture, dragged.zoom ?? zoom, 1, 2000, frame);
    gesture = gestureDown(arm.gesture, dragged.zoom ?? zoom, 1, 184, 264).gesture;
    const closed = gestureUp(gesture, dragged.zoom ?? zoom, 1, 2180, frame);
    assert.deepEqual(closed.zoom, IDENTITY_ZOOM);
    assert.equal(closed.animateZoom, true);
    assert.equal(isZoomed(closed.zoom ?? zoom), false);
    assert.equal(dragged.animateZoom, undefined);
  });

  it("treats a slight pinch as zoomed and snaps back to the fitted frame", () => {
    const fitted: Box = { left: 45, top: 100, width: 300, height: 400 };
    const room: StageSize = { width: 390, height: 600 };
    const frame = { base: fitted, stage: room };
    const focal = { x: 120, y: 180 };
    const dust: Zoom = { scale: 1 + ZOOM_EPSILON * 0.5, x: 4, y: -3 };
    assert.equal(isZoomed(dust), false);
    let gesture = freshGesture();
    gesture = gestureDown(gesture, dust, 1, focal.x, focal.y).gesture;
    gesture = gestureUp(gesture, dust, 1, 3000, frame).gesture;
    gesture = gestureDown(gesture, dust, 1, focal.x + 2, focal.y + 2).gesture;
    const opened = gestureUp(gesture, dust, 1, 3160, frame);
    assert.equal(opened.zoom?.scale, DOUBLE_TAP_SCALE);

    const slight = pinchTo(fitted, room, IDENTITY_ZOOM, focal, focal, 80, 88);
    assert.ok(slight.scale > 1 + ZOOM_EPSILON);
    assert.ok(slight.scale < DOUBLE_TAP_SCALE);
    gesture = freshGesture();
    gesture = gestureDown(gesture, slight, 1, 140, 200).gesture;
    gesture = gestureUp(gesture, slight, 1, 4000, frame).gesture;
    gesture = gestureDown(gesture, slight, 1, 146, 206).gesture;
    const closed = gestureUp(gesture, slight, 1, 4180, frame);
    assert.deepEqual(closed.zoom, IDENTITY_ZOOM);
    near(closed.zoom?.x ?? 1, 0);
    near(closed.zoom?.y ?? 1, 0);
  });

  it("keeps a corner double tap on the stage", () => {
    const fitted: Box = { left: 45, top: 100, width: 300, height: 400 };
    const room: StageSize = { width: 390, height: 600 };
    const focal = { x: 60, y: 120 };
    const zoom = doubleTapZoom(fitted, room, focal);
    assert.equal(zoom.scale, DOUBLE_TAP_SCALE);
    const rect = visualRect(fitted, zoom);
    assert.ok(rect.left <= focal.x && focal.x <= rect.left + rect.width);
    assert.ok(rect.top <= focal.y && focal.y <= rect.top + rect.height);
    assert.ok(rect.left <= 0.001 && rect.left + rect.width >= room.width - 0.001);
    assert.ok(rect.top <= 0.001 && rect.top + rect.height >= room.height - 0.001);
    assert.ok(Number.isFinite(zoom.x) && Number.isFinite(zoom.y));
  });

  it("does not treat a slow tap, a distant tap, a pinch, or the tap after a swipe as a double tap", () => {
    let gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 100, 200).gesture;
    const first = gestureUp(gesture, IDENTITY_ZOOM, 1, 1000, layout);
    gesture = gestureDown(first.gesture, IDENTITY_ZOOM, 1, 140, 200).gesture;
    const far = gestureUp(gesture, IDENTITY_ZOOM, 1, 1100, layout);
    assert.equal(far.zoom, undefined);
    gesture = gestureDown(far.gesture, IDENTITY_ZOOM, 1, 140, 200).gesture;
    const late = gestureUp(gesture, IDENTITY_ZOOM, 1, 1100 + 301, layout);
    assert.equal(late.zoom, undefined);

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 100, 200).gesture;
    const tapped = gestureUp(gesture, IDENTITY_ZOOM, 1, 2000, layout);
    gesture = gestureDown(tapped.gesture, IDENTITY_ZOOM, 1, 110, 200).gesture;
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 2, 170, 200).gesture;
    const pinched = gestureMove(gesture, 2, 220, 210, layout);
    let zoom = pinched.zoom ?? IDENTITY_ZOOM;
    gesture = gestureUp(pinched.gesture, zoom, 2, 2100, layout).gesture;
    gesture = gestureUp(gesture, zoom, 1, 2120, layout).gesture;
    gesture = gestureDown(gesture, zoom, 1, 110, 200).gesture;
    const afterPinch = gestureUp(gesture, zoom, 1, 2200, layout);
    assert.equal(afterPinch.zoom, undefined);
    assert.equal(afterPinch.step, undefined);

    gesture = freshGesture();
    zoom = IDENTITY_ZOOM;
    gesture = gestureDown(gesture, zoom, 1, 200, 200).gesture;
    const armed = gestureUp(gesture, zoom, 1, 3000, layout);
    gesture = gestureDown(armed.gesture, zoom, 1, 200, 200).gesture;
    gesture = gestureMove(gesture, 1, 80, 204, layout).gesture;
    const turned = gestureUp(gesture, zoom, 1, 3100, layout);
    assert.equal(turned.step, 1);
    gesture = gestureDown(turned.gesture, IDENTITY_ZOOM, 1, 190, 200).gesture;
    const afterPage = gestureUp(gesture, IDENTITY_ZOOM, 1, 3250, layout);
    assert.equal(afterPage.zoom, undefined);
    assert.equal(afterPage.step, undefined);
  });

  it("opens info on an upward swipe, closes the viewer downward, and does neither while zoomed", () => {
    assert.equal(verticalSwipe(0, -80, false), "up");
    assert.equal(verticalSwipe(4, 90, false), "down");
    assert.equal(verticalSwipe(-70, 80, false), null);
    assert.equal(verticalSwipe(0, -30, false), null);
    assert.equal(verticalSwipe(0, -120, true), null);
    assert.equal(swipeStep(0, -90, false), 0);

    let gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 180, 340).gesture;
    gesture = gestureMove(gesture, 1, 176, 200, layout).gesture;
    const up = gestureUp(gesture, IDENTITY_ZOOM, 1, 1000, layout);
    assert.equal(up.sheet, "up");
    assert.equal(up.step, undefined);
    assert.equal(lightboxGestureAction(up, false, false), "show-info");
    assert.equal(lightboxGestureAction(up, true, false), "none");

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 180, 180).gesture;
    gesture = gestureMove(gesture, 1, 170, 320, layout).gesture;
    const down = gestureUp(gesture, IDENTITY_ZOOM, 1, 1500, layout);
    assert.equal(down.sheet, "down");
    assert.equal(down.step, undefined);
    assert.equal(lightboxGestureAction(down, false, false), "close-viewer");
    assert.equal(lightboxGestureAction(down, true, false), "hide-info");

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 40, 200).gesture;
    const tap = gestureUp(gesture, IDENTITY_ZOOM, 1, 1800, layout);
    assert.equal(tap.tap, true);
    assert.equal(tap.step, undefined);
    assert.equal(lightboxGestureAction(tap, true, false), "hide-info");
    assert.equal(lightboxGestureAction(tap, false, false), "show-info");
    assert.equal(lightboxGestureAction(tap, false, true), "none");
    assert.equal(lightboxGestureAction({ step: 1 }, true, false), "step");
    assert.equal(lightboxGestureAction({ step: -1 }, false, false), "step");

    const zoomed: Zoom = { scale: 2, x: 10, y: -8 };
    gesture = freshGesture();
    gesture = gestureDown(gesture, zoomed, 1, 180, 360).gesture;
    const dragged = gestureMove(gesture, 1, 170, 180, layout);
    assert.equal(dragged.gesture.mode, "pan");
    const parked = gestureUp(dragged.gesture, dragged.zoom ?? zoomed, 1, 2200, layout);
    assert.equal(parked.sheet, undefined);
    assert.equal(parked.step, undefined);
    assert.equal(lightboxGestureAction(parked, true, true), "none");

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 120, 240).gesture;
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 2, 180, 240).gesture;
    const pinched = gestureMove(gesture, 2, 240, 300, layout);
    assert.equal(pinched.animateZoom, undefined);
    gesture = gestureUp(pinched.gesture, pinched.zoom ?? IDENTITY_ZOOM, 2, 3000, layout).gesture;
    gesture = gestureMove(gesture, 1, 120, 80, layout).gesture;
    const afterPinch = gestureUp(gesture, pinched.zoom ?? IDENTITY_ZOOM, 1, 3200, layout);
    assert.equal(afterPinch.sheet, undefined);
    assert.equal(afterPinch.step, undefined);

    assert.equal(infoSheetDismiss(0, 90, 0, 0), true);
    assert.equal(infoSheetDismiss(0, 90, 40, 8), false);
    assert.equal(infoSheetDismiss(0, 90, 0, 36), false);
    assert.equal(infoSheetDismiss(-90, 8, 0, 0), false);
    assert.equal(infoSheetStep(-90, 6, 0, 0), 1);
    assert.equal(infoSheetStep(90, 4, 24, 24), -1);
    assert.equal(infoSheetStep(-90, 4, 0, 18), 0);
    assert.equal(infoSheetStep(0, 90, 0, 0), 0);
    assert.equal(infoOpenForItem(true, "a"), true);
    assert.equal(infoOpenForItem(true, "b"), true);
    assert.equal(infoOpenForItem(true, null), false);
    assert.equal(infoOpenForItem(false, "a"), false);
    assert.ok(ZOOM_ANIM_MS >= 200 && ZOOM_ANIM_MS <= 300);

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 40, 220).gesture;
    gesture = gestureMove(gesture, 1, 160, 224, layout).gesture;
    const turned = gestureUp(gesture, IDENTITY_ZOOM, 1, 4000, layout);
    assert.equal(turned.step, -1);
    assert.equal(turned.sheet, undefined);
    assert.equal(lightboxGestureAction(turned, true, false), "step");
    assert.equal(infoOpenForItem(true, "next"), true);
  });

  it("slides the next image in at fitted size even when the current image is zoomed", () => {
    assert.equal(incomingSlideVisible(true, 390, { x: -80, y: 0 }, false, 0), true);
    assert.equal(incomingSlideVisible(true, 390, { x: 0, y: 40 }, false, 0), false);
    assert.equal(incomingSlideVisible(false, 390, { x: -80, y: 0 }, false, 0), false);
    assert.equal(incomingSlideVisible(true, 390, DRAG_REST, true, -1), true);
    const photo: Box = { left: 0, top: 0, width: 200, height: 300 };
    const room: StageSize = { width: 280, height: 360 };
    const atRight = panTo(photo, room, clampZoom(photo, room, { scale: 2, x: 0, y: 0 }), -5000, 0);
    const edge = panEdges(photo, room, atRight);
    const down = gestureDown(freshGesture(), atRight, 1, 200, 180, DRAG_REST, 0, edge);
    const moved = gestureMove(down.gesture, 1, 110, 184, { base: photo, stage: room }, 40);
    assert.equal(moved.gesture.mode, "swipe");
    assert.equal(moved.zoom, undefined);
    assert.ok((moved.drag?.x ?? 0) < 0);
    assert.ok(incomingX(moved.drag?.x ?? 0, room.width) > 0);
  });

  it("follows the finger while fitted, then commits on a pull or a flick and springs back otherwise", () => {
    const room: StageSize = { width: 390, height: 600 };
    assert.equal(rubberOffset(48, room.width), 48);
    assert.ok(Math.abs(rubberOffset(-48, room.width) + 48) < 0.001);
    const far = rubberOffset(900, room.width);
    assert.ok(far > 48);
    assert.ok(far < room.width);
    assert.ok(SWIPE_ANIM_MS >= 200 && SWIPE_ANIM_MS <= 350);

    assert.deepEqual(dragFollow(48, 12, "x", room), { x: 48, y: 0 });
    assert.deepEqual(dragFollow(-36, 4, "x", room), { x: -36, y: 0 });
    assert.deepEqual(dragFollow(6, 70, "y", room), { x: 0, y: 70 });
    assert.deepEqual(dragFollow(2, -90, "y", room), { x: 0, y: 0 });
    assert.ok(dragFollow(900, 0, "x", room).x < room.width);

    assert.deepEqual(releaseSwipe(30, 2, 0, 0, "x", false), { step: 0, sheet: null });
    assert.deepEqual(releaseSwipe(-80, 4, 0, 0, "x", false), { step: 1, sheet: null });
    assert.deepEqual(releaseSwipe(80, -4, 0, 0, "x", false), { step: -1, sheet: null });
    assert.deepEqual(releaseSwipe(-28, 1, -0.9, 0, "x", false), { step: 1, sheet: null });
    assert.deepEqual(releaseSwipe(90, 0, -0.4, 0, "x", false), { step: 0, sheet: null });
    assert.deepEqual(releaseSwipe(4, 40, 0, 0, "y", false), { step: 0, sheet: null });
    assert.deepEqual(releaseSwipe(-6, 80, 0, 0, "y", false), { step: 0, sheet: "down" });
    assert.deepEqual(releaseSwipe(2, 30, 0, 0.8, "y", false), { step: 0, sheet: "down" });
    assert.deepEqual(releaseSwipe(1, -70, 0, 0, "y", false), { step: 0, sheet: "up" });
    assert.deepEqual(releaseSwipe(80, 0, 0, 0, "x", true), { step: 0, sheet: null });
    assert.deepEqual(releaseSwipe(80, 0, 0, 0, null, false), { step: 0, sheet: null });

    let gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 180, 240).gesture;
    const tracking = gestureMove(gesture, 1, 228, 246, layout);
    assert.equal(tracking.gesture.dragAxis, "x");
    assert.deepEqual(tracking.drag, { x: 48, y: 0 });
    const small = gestureUp(tracking.gesture, IDENTITY_ZOOM, 1, 500, layout);
    assert.equal(small.step, undefined);
    assert.equal(small.sheet, undefined);

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 200, 300, DRAG_REST, 1000).gesture;
    gesture = gestureMove(gesture, 1, 168, 304, layout, 1036).gesture;
    const flicked = gestureUp(gesture, IDENTITY_ZOOM, 1, 1044, layout);
    assert.equal(flicked.step, 1);
    assert.ok(Math.abs(dragVelocity(gesture.samples).vx + 32 / 36) < 0.02);

    gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, 160, 220).gesture;
    const down = gestureMove(gesture, 1, 154, 300, layout);
    assert.equal(down.gesture.dragAxis, "y");
    assert.equal(down.drag?.x, 0);
    assert.equal(down.drag?.y, 80);
    const zoomed = gestureMove(
      gestureDown(freshGesture(), { scale: 2, x: 0, y: 0 }, 1, 160, 220).gesture,
      1,
      80,
      300,
      layout,
    );
    assert.equal(zoomed.drag, undefined);
    assert.equal(zoomed.gesture.mode, "pan");
  });

  it("pages from a zoomed edge and otherwise springs back without paging", () => {
    const photo: Box = { left: 0, top: 0, width: 200, height: 300 };
    const room: StageSize = { width: 280, height: 360 };
    const place = { base: photo, stage: room };
    const start = clampZoom(photo, room, { scale: 2, x: 0, y: 0 });
    const atRight = panTo(photo, room, start, -5000, 0);
    const atLeft = panTo(photo, room, start, 5000, 0);
    const atTop = panTo(photo, room, start, 0, 5000);
    const below = panTo(photo, room, start, 0, -5000);
    assert.equal(panEdges(photo, room, atRight).right, true);
    assert.equal(panEdges(photo, room, atRight).left, false);
    assert.equal(panEdges(photo, room, atLeft).left, true);
    assert.equal(panEdges(photo, room, atLeft).right, false);
    assert.equal(panEdges(photo, room, atTop).top, true);
    assert.equal(panEdges(photo, room, below).top, false);
    assert.equal(panEdges(photo, room, start).left, false);
    assert.equal(panEdges(photo, room, start).right, false);
    assert.equal(panEdges(photo, room, start).top, false);
    const fittedSmall = panEdges(photo, room, clampZoom(photo, room, { scale: 1.05, x: 30, y: 20 }));
    assert.equal(fittedSmall.left && fittedSmall.right && fittedSmall.top, true);

    const pull = (zoom: Zoom, x0: number, y0: number, x1: number, y1: number) => {
      const edge = panEdges(photo, room, zoom);
      const down = gestureDown(freshGesture(), zoom, 1, x0, y0, DRAG_REST, 0, edge);
      const moved = gestureMove(down.gesture, 1, x1, y1, place, 40);
      const released = gestureUp(moved.gesture, moved.zoom ?? zoom, 1, 80, place);
      return { moved, released };
    };

    const next = pull(atRight, 200, 180, 110, 184);
    assert.equal(next.moved.gesture.mode, "swipe");
    assert.equal(next.released.step, 1);
    assert.equal(lightboxGestureAction(next.released, false, true), "step");

    const prev = pull(atLeft, 80, 180, 180, 176);
    assert.equal(prev.moved.gesture.mode, "swipe");
    assert.equal(prev.released.step, -1);

    const inside = pull(start, 180, 180, 90, 184);
    assert.equal(inside.moved.gesture.mode, "pan");
    assert.equal(inside.released.step, undefined);
    assert.equal(inside.released.sheet, undefined);
    const further = gestureMove(inside.moved.gesture, 1, 20, 184, place, 70);
    assert.equal(further.gesture.mode, "pan");
    const stopped = gestureUp(further.gesture, further.zoom ?? start, 1, 100, place);
    assert.equal(stopped.step, undefined);
    assert.equal(stopped.animateZoom, true);
    assert.deepEqual(stopped.zoom, clampZoom(photo, room, further.zoom ?? start));

    const dismiss = pull(atTop, 140, 80, 136, 190);
    assert.equal(dismiss.moved.gesture.mode, "swipe");
    assert.equal(dismiss.released.sheet, "down");
    assert.equal(lightboxGestureAction(dismiss.released, false, true), "close-viewer");
    assert.equal(lightboxGestureAction(dismiss.released, true, true), "hide-info");

    const drop = pull(below, 140, 40, 136, 400);
    assert.equal(drop.moved.gesture.mode, "pan");
    assert.equal(drop.released.sheet, undefined);
    assert.equal(drop.released.step, undefined);
    assert.equal(drop.released.animateZoom, true);
    assert.deepEqual(drop.released.zoom, clampZoom(photo, room, drop.moved.zoom ?? below));
  });

  it("shrinks past fitted while pinching, then closes or returns from the scale at release", () => {
    const inward = pinchTo(base, stage, IDENTITY_ZOOM, center, center, 100, 50);
    assert.ok(inward.scale < 1 - ZOOM_EPSILON);
    assert.ok(inward.scale >= PINCH_MIN);
    assert.equal(pinchRelease(true, inward.scale), "close");
    const restored = pinchTo(base, stage, inward, center, center, 50, 140);
    assert.ok(restored.scale >= 1 - ZOOM_EPSILON);
    assert.equal(pinchRelease(true, restored.scale), "keep");
    assert.equal(pinchRelease(true, 1 - ZOOM_EPSILON / 2), "keep");

    const zoomed: Zoom = { scale: 2, x: 12, y: -8 };
    const fromZoom = pinchTo(base, stage, zoomed, center, center, 80, 24);
    assert.ok(isUnderFitted(fromZoom.scale));
    assert.equal(pinchRelease(false, fromZoom.scale), "fit");
    const stillZoomed = pinchTo(base, stage, zoomed, center, center, 80, 70);
    assert.ok(stillZoomed.scale > 1);
    assert.equal(pinchRelease(false, stillZoomed.scale), "keep");

    let gesture = freshGesture();
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 1, center.x - 40, center.y).gesture;
    gesture = gestureDown(gesture, IDENTITY_ZOOM, 2, center.x + 40, center.y).gesture;
    assert.equal(gesture.pinchFitted, true);
    const shrunk = gestureMove(gesture, 2, center.x + 10, center.y, layout);
    assert.ok((shrunk.zoom?.scale ?? 1) < 1);
    const one = gestureUp(shrunk.gesture, shrunk.zoom ?? IDENTITY_ZOOM, 2, 1000, layout);
    assert.equal(one.pinch, undefined);
    assert.equal(one.gesture.pinchFitted, true);
    const closed = gestureUp(one.gesture, shrunk.zoom ?? IDENTITY_ZOOM, 1, 1100, layout);
    assert.equal(closed.pinch, "close");
    assert.equal(closed.step, undefined);

    gesture = freshGesture();
    gesture = gestureDown(gesture, zoomed, 1, center.x - 40, center.y).gesture;
    gesture = gestureDown(gesture, zoomed, 2, center.x + 40, center.y).gesture;
    assert.equal(gesture.pinchFitted, false);
    const dipped = gestureMove(gesture, 2, center.x - 20, center.y, layout);
    assert.ok((dipped.zoom?.scale ?? 2) < 1);
    const lifted = gestureUp(dipped.gesture, dipped.zoom ?? zoomed, 2, 2000, layout).gesture;
    const fitted = gestureUp(lifted, dipped.zoom ?? zoomed, 1, 2100, layout);
    assert.equal(fitted.pinch, "fit");
    assert.deepEqual(fitted.zoom, IDENTITY_ZOOM);
    assert.equal(fitted.animateZoom, true);

    gesture = freshGesture();
    gesture = gestureDown(gesture, zoomed, 1, center.x - 30, center.y).gesture;
    gesture = gestureDown(gesture, zoomed, 2, center.x + 30, center.y).gesture;
    const held = gestureMove(gesture, 2, center.x + 28, center.y, layout);
    assert.ok((held.zoom?.scale ?? 1) > 1);
    const kept = gestureUp(held.gesture, held.zoom ?? zoomed, 2, 3000, layout);
    const done = gestureUp(kept.gesture, held.zoom ?? zoomed, 1, 3100, layout);
    assert.equal(done.pinch, "keep");
    assert.equal(done.zoom, undefined);
  });

  it("brings the next image in early and fades the backdrop from a fitted pinch or a downward pull", () => {
    const width = 400;
    assert.equal(slideSpan(width), width);
    assert.equal(incomingX(40, width) - incomingX(16, width), 24);
    assert.ok(incomingX(SWIPE_MIN, width) > -width);
    assert.ok(incomingX(SWIPE_MIN, width) + width > 40);
    assert.equal(incomingX(width, width), 0);
    assert.equal(incomingX(-width, width), 0);
    assert.equal(incomingX(incomingX(SWIPE_MIN, width), width), SWIPE_MIN);
    assert.equal(incomingX(incomingX(-120, width), width), -120);
    assert.equal(parkedX(1, width), -width);
    assert.equal(parkedX(-1, width), width);
    assert.ok(incomingX(24, width) > parkedX(1, width));

    assert.equal(scrimForDrag(0, 800), 1);
    assert.equal(scrimForDrag(-40, 800), 1);
    assert.equal(scrimForDrag(400, 800), 0.5);
    assert.equal(scrimForDrag(800, 800), 0);
    assert.equal(scrimForDrag(900, 800), 0);

    assert.equal(scrimForPinch(true, 1), 1);
    assert.equal(scrimForPinch(true, 1 - ZOOM_EPSILON / 2), 1);
    assert.ok(Math.abs(scrimForPinch(true, 1 - (1 - PINCH_MIN) / 2) - 0.5) < 0.02);
    assert.equal(scrimForPinch(true, PINCH_MIN), 0);
    assert.equal(scrimForPinch(true, 0.2), 0);
    assert.equal(scrimForPinch(false, PINCH_MIN), 1);
    assert.equal(scrimForPinch(false, 0.5), 1);

    assert.deepEqual(scrubDrag({ x: 48, y: 0 }, true), { x: 48, y: 0 });
    assert.deepEqual(scrubDrag({ x: 0, y: 80 }, true), { x: 0, y: 0 });
    assert.deepEqual(scrubDrag({ x: 0, y: 80 }, false), { x: 0, y: 80 });
  });
});
