/**
 * Phone lightbox zoom. Scale 1 is the fitted image, not a 1:1 pixel view.
 * Coordinates are stage-local pixels, the same space as the fitted frame.
 */

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_EPSILON = 0.001;
export const DOUBLE_TAP_SCALE = 2;
/** How far a pinch may shrink past the fitted size before it resists. */
export const PINCH_MIN = 0.45;
export const TAP_SLOP = 10;
export const SWIPE_MIN = 56;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 32;
/** Long enough to see, short enough that the next tap still feels immediate. */
export const ZOOM_ANIM_MS = 260;
/** Release animation. Quick at the start, settled at the end, no bounce. */
export const SWIPE_ANIM_MS = 280;
/** A flick faster than this (px/ms) can turn the page before the distance threshold. */
export const SWIPE_FLICK = 0.55;

export type Point = { x: number; y: number };
export type Zoom = { scale: number; x: number; y: number };
export type StageSize = { width: number; height: number };
export type Box = { left: number; top: number; width: number; height: number };
export type Tracked = { id: number; x: number; y: number };

export const IDENTITY_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };
export type Drag = { x: number; y: number };
export const DRAG_REST: Drag = { x: 0, y: 0 };
export type Sample = { x: number; y: number; t: number };

export type GestureMode = "idle" | "pending" | "pan" | "pinch" | "swipe";

/** A few pixels of slack so rounding does not flicker the edge. */
export const EDGE_SLOP = 4;

export type PanEdge = { left: boolean; right: boolean; top: boolean };

export type Gesture = {
  pointers: Tracked[];
  mode: GestureMode;
  startZoom: Zoom;
  origin: Point;
  startMid: Point;
  startDist: number;
  pinched: boolean;
  /** True when this pinch began at the fitted size. Null until a pinch starts. */
  pinchFitted: boolean | null;
  lastTap: { t: number; x: number; y: number } | null;
  dragAxis: "x" | "y" | null;
  held: Drag;
  samples: Sample[];
  /** Edges touched when the finger went down. Null keeps a zoomed drag from paging. */
  edge: PanEdge | null;
};

export type GestureResult = {
  gesture: Gesture;
  zoom?: Zoom;
  /** Double-tap only. Pinch and drag omit this so they stay stuck to the finger. */
  animateZoom?: boolean;
  step?: -1 | 1;
  /** Up shows details. Down closes details, or the viewer when details are hidden. */
  sheet?: "up" | "down";
  /** Fitted swipe only. Where the image sits under the finger. */
  drag?: Drag;
  /** What to do with a pinch once every finger is up. */
  pinch?: "keep" | "fit" | "close";
  tap?: boolean;
  suppressClick?: boolean;
};

export function freshGesture(): Gesture {
  return {
    pointers: [],
    mode: "idle",
    startZoom: IDENTITY_ZOOM,
    origin: { x: 0, y: 0 },
    startMid: { x: 0, y: 0 },
    startDist: 0,
    pinched: false,
    pinchFitted: null,
    lastTap: null,
    dragAxis: null,
    held: DRAG_REST,
    samples: [],
    edge: null,
  };
}

export function isZoomed(zoom: Zoom): boolean {
  return zoom.scale > ZOOM_MIN + ZOOM_EPSILON;
}

export function clampScale(scale: number): number {
  return clampRange(scale, ZOOM_MIN, ZOOM_MAX);
}

function clampRange(scale: number, min: number, max: number): number {
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

export function isUnderFitted(scale: number): boolean {
  return scale < ZOOM_MIN - ZOOM_EPSILON;
}

/** Keep a live pinch. Close only if it began fitted and the fingers leave it under fitted size. */
export function pinchRelease(startedFitted: boolean, scale: number): "keep" | "fit" | "close" {
  if (!isUnderFitted(scale)) return "keep";
  return startedFitted ? "close" : "fit";
}

export function visualRect(base: Box, zoom: Zoom): Box {
  const width = base.width * zoom.scale;
  const height = base.height * zoom.scale;
  const cx = base.left + base.width / 2 + zoom.x;
  const cy = base.top + base.height / 2 + zoom.y;
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}

function clampPan(origin: number, baseSize: number, size: number, stageSize: number, pan: number): number {
  if (size <= stageSize + 0.5) return 0;
  const center = origin + baseSize / 2;
  const at = (edge: number) => edge + size / 2 - center;
  const low = Math.min(at(0), at(stageSize - size));
  const high = Math.max(at(0), at(stageSize - size));
  return Math.min(high, Math.max(low, pan));
}

/** Keeps a zoomed image from sliding entirely off the stage. Scale 1 stays on the fitted frame. */
export function clampZoom(base: Box, stage: StageSize, zoom: Zoom): Zoom {
  const scale = clampScale(zoom.scale);
  const width = base.width * scale;
  const height = base.height * scale;
  const x = clampPan(base.left, base.width, width, stage.width, Number.isFinite(zoom.x) ? zoom.x : 0);
  const y = clampPan(base.top, base.height, height, stage.height, Number.isFinite(zoom.y) ? zoom.y : 0);
  return { scale, x, y };
}

/** Changes scale while keeping the image point under `focal` in place. */
export function zoomAround(base: Box, zoom: Zoom, nextScale: number, focal: Point, minScale = ZOOM_MIN): Zoom {
  const scale = clampRange(nextScale, minScale, ZOOM_MAX);
  const rect = visualRect(base, zoom);
  if (rect.width <= 0 || rect.height <= 0) return { scale, x: zoom.x, y: zoom.y };
  const fx = (focal.x - rect.left) / rect.width;
  const fy = (focal.y - rect.top) / rect.height;
  const width = base.width * scale;
  const height = base.height * scale;
  const left = focal.x - fx * width;
  const top = focal.y - fy * height;
  return {
    scale,
    x: left + width / 2 - (base.left + base.width / 2),
    y: top + height / 2 - (base.top + base.height / 2),
  };
}

export function pinchTo(
  base: Box,
  stage: StageSize,
  start: Zoom,
  startMid: Point,
  currentMid: Point,
  startDist: number,
  currentDist: number,
): Zoom {
  const ratio = startDist > 0 ? currentDist / startDist : 1;
  const scaled = zoomAround(base, start, start.scale * ratio, startMid, PINCH_MIN);
  return clampPinchZoom(base, stage, {
    scale: scaled.scale,
    x: scaled.x + (currentMid.x - startMid.x),
    y: scaled.y + (currentMid.y - startMid.y),
  });
}

/** Fitted and larger pinches use the normal frame. Below fitted, the image may shrink but stays nearby. */
function clampPinchZoom(base: Box, stage: StageSize, zoom: Zoom): Zoom {
  const scale = clampRange(zoom.scale, PINCH_MIN, ZOOM_MAX);
  if (!isUnderFitted(scale)) return clampZoom(base, stage, { ...zoom, scale });
  const width = base.width * scale;
  const height = base.height * scale;
  const limitX = stage.width / 2 + width / 2;
  const limitY = stage.height / 2 + height / 2;
  const x = Math.min(limitX, Math.max(-limitX, Number.isFinite(zoom.x) ? zoom.x : 0));
  const y = Math.min(limitY, Math.max(-limitY, Number.isFinite(zoom.y) ? zoom.y : 0));
  return { scale, x, y };
}

export function panTo(base: Box, stage: StageSize, start: Zoom, dx: number, dy: number): Zoom {
  return clampZoom(base, stage, { scale: start.scale, x: start.x + dx, y: start.y + dy });
}

/**
 * Which edges the image is already against.
 * A side the image cannot pan along counts as reached.
 */
export function panEdges(base: Box, stage: StageSize, zoom: Zoom): PanEdge {
  const rect = visualRect(base, zoom);
  const narrow = rect.width <= stage.width + EDGE_SLOP;
  const short = rect.height <= stage.height + EDGE_SLOP;
  return {
    left: narrow || rect.left >= -EDGE_SLOP,
    right: narrow || rect.left + rect.width <= stage.width + EDGE_SLOP,
    top: short || rect.top >= -EDGE_SLOP,
  };
}

/** Pan, then resist once the image is pulled past an edge. */
export function panGive(base: Box, stage: StageSize, start: Zoom, dx: number, dy: number): Zoom {
  const raw = { scale: start.scale, x: start.x + dx, y: start.y + dy };
  const fitted = clampZoom(base, stage, raw);
  const give = (overflow: number, span: number) => (Math.abs(overflow) < 0.5 ? 0 : rubberOffset(overflow, Math.max(span, 1)));
  return {
    scale: fitted.scale,
    x: fitted.x + give(raw.x - fitted.x, stage.width),
    y: fitted.y + give(raw.y - fitted.y, stage.height),
  };
}

/** Fitted double-tap grows around the tap. Already-zoomed callers reset instead of calling this. */
export function doubleTapZoom(base: Box, stage: StageSize, focal: Point): Zoom {
  return clampZoom(base, stage, zoomAround(base, IDENTITY_ZOOM, DOUBLE_TAP_SCALE, focal));
}

export function swipeStep(dx: number, dy: number, zoomed: boolean): -1 | 0 | 1 {
  if (zoomed) return 0;
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.25) return 0;
  return dx < 0 ? 1 : -1;
}

/** Up or down at the fitted size. Diagonal and short moves are neither axis. */
export function verticalSwipe(dx: number, dy: number, zoomed: boolean): "up" | "down" | null {
  if (zoomed) return null;
  if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) < Math.abs(dx) * 1.25) return null;
  return dy < 0 ? "up" : "down";
}

export type LightboxGestureAction = "show-info" | "hide-info" | "close-viewer" | "step" | "none";

/** What a finished phone gesture does. A zoomed drag pages only when the gesture already says so. */
export function lightboxGestureAction(
  result: { sheet?: "up" | "down"; step?: -1 | 1; tap?: boolean },
  infoOpen: boolean,
  zoomed: boolean,
): LightboxGestureAction {
  if (result.sheet === "down") return infoOpen ? "hide-info" : "close-viewer";
  if (result.sheet === "up") return zoomed || infoOpen ? "none" : "show-info";
  if (zoomed) return result.tap && infoOpen ? "hide-info" : result.step ? "step" : "none";
  if (result.tap) return infoOpen ? "hide-info" : "show-info";
  if (result.step) return "step";
  return "none";
}

/** Info stays up while moving between images, and closes with the viewer. */
export function infoOpenForItem(infoOpen: boolean, itemId: string | null): boolean {
  return infoOpen && itemId !== null;
}

/** A downward swipe dismisses info only when the info list itself did not scroll. */
export function infoSheetDismiss(dx: number, dy: number, startTop: number, endTop: number): boolean {
  if (Math.abs(endTop - startTop) > 2) return false;
  if (startTop > 1) return false;
  return verticalSwipe(dx, dy, false) === "down";
}

/** Horizontal swipe on the info sheet changes images unless that sheet was scrolling. */
export function infoSheetStep(dx: number, dy: number, startTop: number, endTop: number): -1 | 0 | 1 {
  if (Math.abs(endTop - startTop) > 2) return 0;
  return swipeStep(dx, dy, false);
}

/** 1:1 at the start of a pull, then resistance so the image cannot leave the stage. */
export function rubberOffset(delta: number, span: number): number {
  if (!Number.isFinite(delta) || !Number.isFinite(span) || span <= 0) return 0;
  const sign = Math.sign(delta);
  const abs = Math.abs(delta);
  const linear = span * 0.22;
  if (abs <= linear) return delta;
  const extra = abs - linear;
  const room = span * 0.46;
  return sign * (linear + room * (1 - Math.exp(-extra / (span * 0.5))));
}

export function dominantAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) <= TAP_SLOP) return null;
  if (Math.abs(dx) >= Math.abs(dy) * 1.25) return "x";
  if (Math.abs(dy) >= Math.abs(dx) * 1.25) return "y";
  return null;
}

/** Next image sits one stage away, so its edge is already visible at the commit distance. */
export const SLIDE_LEAD = 0;

export function slideSpan(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return width * (1 + SLIDE_LEAD);
}

/** Shared track. Positive track brings the previous image in from the left. */
export function incomingX(track: number, width: number): number {
  const span = slideSpan(width);
  const dir = Math.sign(track);
  if (dir === 0 || span === 0) return 0;
  return track - dir * span;
}

export function parkedX(dir: -1 | 1, width: number): number {
  return -dir * slideSpan(width);
}

/** The next image follows the finger at 1x, including a page swipe that started zoomed. */
export function incomingSlideVisible(
  phone: boolean,
  width: number,
  drag: Drag,
  animating: boolean,
  direction: -1 | 0 | 1,
): boolean {
  return phone && width > 0 && drag.y === 0 && (Math.abs(drag.x) > 0.5 || (animating && direction !== 0));
}

/** Black backdrop. 1 at rest, 0 once the image has traveled one stage height downward. */
export function scrimForDrag(y: number, height: number): number {
  if (!Number.isFinite(y) || y <= 0 || !Number.isFinite(height) || height <= 0) return 1;
  return Math.max(0, 1 - y / height);
}

/** Backdrop while pinching. Only a pinch that began at the fitted size fades, and only once it shrinks past fitted. */
export function scrimForPinch(startedFitted: boolean, scale: number): number {
  if (!startedFitted || !isUnderFitted(scale)) return 1;
  const span = ZOOM_MIN - PINCH_MIN;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - (ZOOM_MIN - scale) / span));
}

/** Info sheet: horizontal paging may move the photo. A downward pull must not. */
export function scrubDrag(drag: Drag, infoOpen: boolean): Drag {
  if (!infoOpen || drag.y === 0) return drag;
  return { x: drag.x, y: 0 };
}

export function dragFollow(dx: number, dy: number, axis: "x" | "y" | null, stage: StageSize, held: Drag = DRAG_REST): Drag {
  if (axis === "x") return { x: rubberOffset(held.x + dx, stage.width), y: 0 };
  if (axis === "y") {
    const raw = held.y + dy;
    if (raw <= 0) return DRAG_REST;
    return { x: 0, y: rubberOffset(raw, stage.height) };
  }
  return held;
}

export function dragVelocity(samples: Sample[]): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1]!;
  let first: Sample | null = null;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index]!;
    const dt = last.t - sample.t;
    if (dt > 90) break;
    if (dt >= 12) first = sample;
  }
  const origin = first ?? samples[samples.length - 2]!;
  const dt = last.t - origin.t;
  if (dt < 8) return { vx: 0, vy: 0 };
  return { vx: (last.x - origin.x) / dt, vy: (last.y - origin.y) / dt };
}

/**
 * Distance commits a slow pull. A flick commits sooner.
 * A finger already traveling back toward rest cancels, even past the distance line.
 */
export function releaseSwipe(
  dx: number,
  dy: number,
  vx: number,
  vy: number,
  axis: "x" | "y" | null,
  zoomed: boolean,
): { step: -1 | 0 | 1; sheet: "up" | "down" | null } {
  if (zoomed || axis === null) return { step: 0, sheet: null };
  const minFlick = TAP_SLOP * 2.4;
  if (axis === "x") {
    const returning = dx !== 0 && Math.sign(vx) === -Math.sign(dx) && Math.abs(vx) >= 0.15;
    const flick = !returning && Math.abs(vx) >= SWIPE_FLICK && Math.abs(dx) >= minFlick && Math.sign(vx) === Math.sign(dx);
    const pull = !returning && Math.abs(dx) >= SWIPE_MIN;
    if (!flick && !pull) return { step: 0, sheet: null };
    return { step: dx < 0 ? 1 : -1, sheet: null };
  }
  const returning = dy !== 0 && Math.sign(vy) === -Math.sign(dy) && Math.abs(vy) >= 0.15;
  const flick = !returning && Math.abs(vy) >= SWIPE_FLICK && Math.abs(dy) >= minFlick && Math.sign(vy) === Math.sign(dy);
  const pull = !returning && Math.abs(dy) >= SWIPE_MIN;
  if (!flick && !pull) return { step: 0, sheet: null };
  return { step: 0, sheet: dy < 0 ? "up" : "down" };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function fractionAt(base: Box, zoom: Zoom, focal: Point): Point {
  const rect = visualRect(base, zoom);
  return {
    x: (focal.x - rect.left) / rect.width,
    y: (focal.y - rect.top) / rect.height,
  };
}

export function sameImagePoint(base: Box, before: Zoom, after: Zoom, focal: Point): boolean {
  const a = fractionAt(base, before, focal);
  const b = fractionAt(base, after, focal);
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function idleFrom(gesture: Gesture, lastTap: Gesture["lastTap"]): Gesture {
  return { ...freshGesture(), lastTap };
}

export function gestureDown(
  gesture: Gesture,
  zoom: Zoom,
  id: number,
  x: number,
  y: number,
  held: Drag = DRAG_REST,
  time = 0,
  edge: PanEdge | null = null,
): GestureResult {
  if (gesture.pointers.some((pointer) => pointer.id === id)) return { gesture };
  const pointers = [...gesture.pointers, { id, x, y }];
  if (pointers.length === 1) {
    return {
      gesture: {
        ...gesture,
        pointers,
        mode: "pending",
        startZoom: zoom,
        origin: { x, y },
        startMid: { x, y },
        startDist: 0,
        pinched: false,
        pinchFitted: null,
        dragAxis: null,
        held,
        samples: time > 0 ? [{ x, y, t: time }] : [],
        edge,
      },
    };
  }
  const a = pointers[0]!;
  const b = pointers[1]!;
  const startMid = midpoint(a, b);
  return {
    gesture: {
      ...gesture,
      pointers,
      mode: "pinch",
      startZoom: zoom,
      origin: startMid,
      startMid,
      startDist: distance(a, b),
      pinched: true,
      pinchFitted: gesture.pinchFitted ?? !isZoomed(zoom),
    },
    drag: DRAG_REST,
  };
}

export function gestureMove(
  gesture: Gesture,
  id: number,
  x: number,
  y: number,
  layout: { base: Box; stage: StageSize } | null,
  time = 0,
): GestureResult {
  if (!gesture.pointers.some((pointer) => pointer.id === id)) return { gesture };
  const pointers = gesture.pointers.map((pointer) => (pointer.id === id ? { id, x, y } : pointer));
  let next: Gesture = {
    ...gesture,
    pointers,
    samples: time > 0 ? gesture.samples.concat([{ x, y, t: time }]).slice(-6) : gesture.samples,
  };
  if (next.mode === "pinch" || pointers.length >= 2) {
    const a = pointers[0]!;
    const b = pointers[1]!;
    next = { ...next, mode: "pinch", pinched: true, dragAxis: null };
    if (!layout || !b) return { gesture: next, drag: DRAG_REST };
    return {
      gesture: next,
      zoom: pinchTo(layout.base, layout.stage, next.startZoom, next.startMid, midpoint(a, b), next.startDist, distance(a, b)),
      drag: DRAG_REST,
    };
  }
  const point = pointers[0]!;
  const dx = point.x - next.origin.x;
  const dy = point.y - next.origin.y;
  if (next.mode === "pending" && Math.hypot(dx, dy) > TAP_SLOP && !next.pinched) {
    const axis = dominantAxis(dx, dy);
    if (!isZoomed(next.startZoom)) next = { ...next, mode: "swipe", dragAxis: axis };
    else if (axis === "x" && next.edge && ((dx < 0 && next.edge.right) || (dx > 0 && next.edge.left))) {
      next = { ...next, mode: "swipe", dragAxis: "x" };
    } else if (axis === "y" && dy > 0 && next.edge?.top) next = { ...next, mode: "swipe", dragAxis: "y" };
    else next = { ...next, mode: "pan", dragAxis: axis };
  } else if (next.mode === "swipe" && !next.dragAxis) {
    const axis = dominantAxis(dx, dy);
    if (axis) next = { ...next, dragAxis: axis };
  }
  if (next.mode === "pan" && layout) {
    return { gesture: next, zoom: panGive(layout.base, layout.stage, next.startZoom, dx, dy) };
  }
  if (next.mode === "swipe" && layout && !next.pinched) {
    return { gesture: next, drag: dragFollow(dx, dy, next.dragAxis, layout.stage, next.held) };
  }
  return { gesture: next };
}

function finishPinch(gesture: Gesture, zoom: Zoom): GestureResult {
  const release = pinchRelease(gesture.pinchFitted === true, zoom.scale);
  return {
    gesture: idleFrom(gesture, null),
    suppressClick: true,
    pinch: release,
    ...(release === "fit" ? { zoom: IDENTITY_ZOOM, animateZoom: true } : {}),
  };
}

export function gestureUp(
  gesture: Gesture,
  zoom: Zoom,
  id: number,
  time: number,
  layout: { base: Box; stage: StageSize } | null = null,
): GestureResult {
  if (!gesture.pointers.some((pointer) => pointer.id === id)) return { gesture };
  const ended = gesture.pointers.find((pointer) => pointer.id === id)!;
  const pointers = gesture.pointers.filter((pointer) => pointer.id !== id);

  if (gesture.mode === "pinch") {
    if (pointers.length >= 2) {
      const a = pointers[0]!;
      const b = pointers[1]!;
      return {
        gesture: {
          ...gesture,
          pointers,
          mode: "pinch",
          pinched: true,
          startZoom: zoom,
          startMid: midpoint(a, b),
          startDist: distance(a, b),
        },
      };
    }
    if (pointers.length === 1) {
      const point = pointers[0]!;
      return {
        gesture: {
          ...gesture,
          pointers,
          mode: isZoomed(zoom) ? "pan" : "pending",
          startZoom: zoom,
          origin: { x: point.x, y: point.y },
          pinched: true,
        },
      };
    }
    return finishPinch(gesture, zoom);
  }

  if (pointers.length > 0) return { gesture: { ...gesture, pointers } };

  if (gesture.pinched) return finishPinch(gesture, zoom);

  if (gesture.mode === "swipe" || gesture.mode === "pan") {
    const dx = ended.x - gesture.origin.x;
    const dy = ended.y - gesture.origin.y;
    if (gesture.mode === "pan") {
      const settled = layout ? clampZoom(layout.base, layout.stage, zoom) : zoom;
      const pulled = Math.abs(settled.x - zoom.x) > 0.5 || Math.abs(settled.y - zoom.y) > 0.5;
      return {
        gesture: idleFrom(gesture, null),
        suppressClick: true,
        ...(pulled ? { zoom: settled, animateZoom: true } : {}),
      };
    }
    const velocity = dragVelocity(gesture.samples);
    const released = releaseSwipe(dx, dy, velocity.vx, velocity.vy, gesture.dragAxis, false);
    return {
      gesture: idleFrom(gesture, null),
      suppressClick: true,
      ...(released.step === 0 ? {} : { step: released.step }),
      ...(released.sheet ? { sheet: released.sheet } : {}),
    };
  }

  if (gesture.mode === "pending" && !gesture.pinched) {
    const previous = gesture.lastTap;
    if (
      previous &&
      time >= previous.t &&
      time - previous.t <= DOUBLE_TAP_MS &&
      Math.hypot(ended.x - previous.x, ended.y - previous.y) <= DOUBLE_TAP_SLOP
    ) {
      if (isZoomed(zoom) || !layout) {
        return {
          gesture: idleFrom(gesture, null),
          ...(isZoomed(zoom) ? { zoom: IDENTITY_ZOOM, animateZoom: true } : {}),
          suppressClick: true,
        };
      }
      return {
        gesture: idleFrom(gesture, null),
        zoom: doubleTapZoom(layout.base, layout.stage, { x: ended.x, y: ended.y }),
        animateZoom: true,
        suppressClick: true,
      };
    }
    return { gesture: idleFrom(gesture, { t: time, x: ended.x, y: ended.y }), tap: true };
  }

  return { gesture: idleFrom(gesture, null), suppressClick: gesture.pinched || gesture.mode !== "idle" };
}
