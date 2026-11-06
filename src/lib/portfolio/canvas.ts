export const CANVAS_BOARD_ID = "canvas:board";
export const CANVAS_FLAT_PREFIX = "canvas:flat:";
export const CANVAS_WIDTH = 1050;
export const CANVAS_HEIGHT = 1485;
export const CANVAS_PLACEMENTS_KEY = "canvasPlacements";
export const CANVAS_ORIENTATION_KEY = "canvasOrientation";
export const CANVAS_PLACE_RATIO = 0.46;
export const CANVAS_ZOOM_MIN = 0.4;
export const CANVAS_ZOOM_MAX = 6;

/** Gallery's share of the center lane. The splitter is not part of the share. */
export function centerSplit(width: number, ratio: number, splitter = 12, minGallery = 220, minCanvas = 280): number {
  const usable = Math.max(0, width - splitter);
  if (usable < 1) return 0.5;
  const safe = Number.isFinite(ratio) ? ratio : 0.5;
  let minG = minGallery;
  let minC = minCanvas;
  if (minG + minC > usable) {
    const scale = usable / (minG + minC);
    minG = Math.floor(minGallery * scale);
    minC = usable - minG;
  }
  const gallery = Math.min(usable - minC, Math.max(minG, usable * safe));
  return gallery / usable;
}

export type CanvasPlacement = {
  id: string;
  imageId: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  z: number;
  /** Drop-time picture and memo, baked into one object. Absent on older placements. */
  flat?: boolean;
  /** 0–100. Absent means fully opaque, so older placements and backups stay unchanged. Display and export only. */
  opacity?: number;
};

export type CanvasOrientation = "portrait" | "landscape";

export function canvasSize(orientation: CanvasOrientation): { width: number; height: number } {
  return orientation === "landscape" ? { width: CANVAS_HEIGHT, height: CANVAS_WIDTH } : { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
}

export function parseOrientation(raw: string): CanvasOrientation {
  return raw === "landscape" ? "landscape" : "portrait";
}

export function canvasFlatId(placementId: string): string {
  return `${CANVAS_FLAT_PREFIX}${placementId}`;
}

/** Sheet drawings and drop-time composites are not image memos. */
export function isCanvasInkId(id: string): boolean {
  return id.startsWith("canvas:");
}

export function placementHeight(width: number, srcW: number, srcH: number): number {
  const w = srcW > 0 ? srcW : 1;
  const h = srcH > 0 ? srcH : 1;
  return width * (h / w);
}

export function fittedPlacementSize(srcW: number, srcH: number, sheetW = CANVAS_WIDTH, sheetH = CANVAS_HEIGHT): { width: number; height: number } {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const fit = Math.min((sheetW * CANVAS_PLACE_RATIO) / sw, (sheetH * CANVAS_PLACE_RATIO) / sh);
  return { width: sw * fit, height: sh * fit };
}

export function containedCenter(
  x: number,
  y: number,
  width: number,
  height: number,
  sheetW = CANVAS_WIDTH,
  sheetH = CANVAS_HEIGHT,
): { x: number; y: number } {
  const hw = width / 2;
  const hh = height / 2;
  const nextX = width >= sheetW ? sheetW / 2 : Math.min(sheetW - hw, Math.max(hw, x));
  const nextY = height >= sheetH ? sheetH / 2 : Math.min(sheetH - hh, Math.max(hh, y));
  return { x: nextX, y: nextY };
}

export function clampCenter(x: number, y: number, sheetW = CANVAS_WIDTH, sheetH = CANVAS_HEIGHT): { x: number; y: number } {
  return {
    x: Math.min(sheetW, Math.max(0, x)),
    y: Math.min(sheetH, Math.max(0, y)),
  };
}

export function scaledWidth(startWidth: number, startDist: number, dist: number, sheetW = CANVAS_WIDTH): number {
  if (!(startDist > 0) || !Number.isFinite(dist)) return startWidth;
  return Math.min(sheetW * 3, Math.max(28, startWidth * (dist / startDist)));
}

export function pointerAngle(cx: number, cy: number, x: number, y: number): number {
  return Math.atan2(y - cy, x - cx);
}

export function pointerDistance(cx: number, cy: number, x: number, y: number): number {
  return Math.hypot(x - cx, y - cy);
}

export function rotatedDegrees(startRotation: number, startAngle: number, angle: number): number {
  return startRotation + ((angle - startAngle) * 180) / Math.PI;
}

/** Dark veil over the part of a placed image that hangs outside the sheet. The path is in the image's own box, before rotation, and does not change the picture. */
export function outsideVeilClip(
  placement: { x: number; y: number; width: number; height: number; rotation: number },
  sheetW: number,
  sheetH: number,
): string {
  const rad = (placement.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toLocal = (cx: number, cy: number) => {
    const dx = cx - placement.x;
    const dy = cy - placement.y;
    const ox = dx * cos + dy * sin;
    const oy = -dx * sin + dy * cos;
    return [ox + placement.width / 2, oy + placement.height / 2] as const;
  };
  const n = (value: number) => String(Math.round(value * 100) / 100);
  const corners = [toLocal(0, 0), toLocal(sheetW, 0), toLocal(sheetW, sheetH), toLocal(0, sheetH)];
  // The outer ring sits outside the picture so its antialiased edge is not baked on as a gray rim.
  const rim = 16;
  const outer = `M ${n(-rim)} ${n(-rim)} H ${n(placement.width + rim)} V ${n(placement.height + rim)} H ${n(-rim)} Z`;
  const hole = `M ${corners.map(([px, py]) => `${n(px)} ${n(py)}`).join(" L ")} Z`;
  return `path(evenodd, "${outer} ${hole}")`;
}

export type ScreenBox = { x: number; y: number; w: number; h: number };
export type ViewLimit = { left: number; top: number; right: number; bottom: number };

/** Axis-aligned screen box of a corner handle. The anchor corner stays on the picture corner until a later nudge. */
export function handleScreenBox(cornerX: number, cornerY: number, rotation: number, size: number, corner: "top-right" | "bottom-right"): ScreenBox {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ax = { x: cos, y: sin };
  const ay = { x: -sin, y: cos };
  const locals = corner === "top-right" ? [[0, 0], [-size, 0], [0, size], [-size, size]] : [[0, 0], [-size, 0], [0, -size], [-size, -size]];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [lx, ly] of locals) {
    const x = cornerX + (lx ?? 0) * ax.x + (ly ?? 0) * ay.x;
    const y = cornerY + (lx ?? 0) * ax.y + (ly ?? 0) * ay.y;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Screen pixels to the rotated frame's own pixels, so a nudge does not change the picture. */
export function screenDeltaToFrame(sx: number, sy: number, rotation: number, chrome: number): { x: number; y: number } {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wx = sx * chrome;
  const wy = sy * chrome;
  return { x: wx * cos + wy * sin, y: -wx * sin + wy * cos };
}

function clampScreenBox(box: ScreenBox, view: ViewLimit): ScreenBox {
  const maxX = Math.max(view.left, view.right - box.w);
  const maxY = Math.max(view.top, view.bottom - box.h);
  return {
    ...box,
    x: Math.min(maxX, Math.max(view.left, box.x)),
    y: Math.min(maxY, Math.max(view.top, box.y)),
  };
}

function penetration(a: ScreenBox, b: ScreenBox, gap: number): { x: number; y: number } | null {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const penX = overlapX + gap;
  const penY = overlapY + gap;
  if (penX <= 0 || penY <= 0) return null;
  return { x: penX, y: penY };
}

function pushChrome(mover: ScreenBox, blocker: ScreenBox, view: ViewLimit, gap: number): ScreenBox {
  const pen = penetration(mover, blocker, gap);
  if (!pen) return mover;
  const toward = (axis: "x" | "y") => {
    if (axis === "x") return mover.x + mover.w / 2 >= blocker.x + blocker.w / 2 ? 1 : -1;
    return mover.y + mover.h / 2 >= blocker.y + blocker.h / 2 ? 1 : -1;
  };
  const candidates: ScreenBox[] = [];
  const attempt = (axis: "x" | "y") => {
    const amount = axis === "x" ? pen.x : pen.y;
    const sign = toward(axis) || 1;
    for (const dir of [sign, -sign]) {
      const next = clampScreenBox(
        {
          ...mover,
          x: mover.x + (axis === "x" ? dir * amount : 0),
          y: mover.y + (axis === "y" ? dir * amount : 0),
        },
        view,
      );
      if (!penetration(next, blocker, gap)) candidates.push(next);
    }
  };
  if (pen.x <= pen.y) {
    attempt("x");
    attempt("y");
  } else {
    attempt("y");
    attempt("x");
  }
  if (candidates.length === 0) return mover;
  return candidates.reduce((best, next) => {
    const score = (next.x - mover.x) ** 2 + (next.y - mover.y) ** 2;
    const bestScore = (best.x - mover.x) ** 2 + (best.y - mover.y) ** 2;
    return score < bestScore ? next : best;
  });
}

/** Keeps edit controls on screen and apart. Later boxes yield first. Positions only — picture geometry is untouched. */
export function settleEditChrome(boxes: ScreenBox[], view: ViewLimit, gap = 6): ScreenBox[] {
  const placed = boxes.map((box) => clampScreenBox(box, view));
  for (let pass = 0; pass < 16; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        if (!a || !b || !penetration(a, b, gap)) continue;
        const pushed = pushChrome(b, a, view, gap);
        if (pushed.x !== b.x || pushed.y !== b.y) {
          placed[j] = pushed;
          moved = true;
          continue;
        }
        const other = pushChrome(a, b, view, gap);
        if (other.x !== a.x || other.y !== a.y) {
          placed[i] = other;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return placed;
}

/** 0–100. Anything missing or unreadable stays fully opaque. */
export function placementOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function placementAlpha(value: unknown): number {
  return placementOpacity(value) / 100;
}

function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function panelPenalty(
  box: ScreenBox,
  popup: ScreenBox,
  avoid: ScreenBox[],
  view: ViewLimit,
  ideal: { x: number; y: number },
  bias: number,
): number {
  const inside =
    box.x >= view.left - 0.01 &&
    box.y >= view.top - 0.01 &&
    box.x + box.w <= view.right + 0.01 &&
    box.y + box.h <= view.bottom + 0.01;
  const off = Math.abs(box.x - ideal.x) + Math.abs(box.y - ideal.y);
  return (boxesOverlap(box, popup) ? 1_000_000 : 0) + (inside ? 0 : 100_000) + bias + (avoid.some((item) => boxesOverlap(box, item)) ? 1_000 : 0) + off;
}

/** Puts the opacity slider just above the edit popup, on screen, and clear of that popup. */
export function placeOpacityPanel(
  popup: ScreenBox,
  panel: { w: number; h: number },
  view: ViewLimit,
  avoid: ScreenBox[] = [],
  gap = 8,
): { x: number; y: number } {
  const aboveY = popup.y - gap - panel.h;
  const aboveX = popup.x + popup.w / 2 - panel.w / 2;
  const shifts = [0];
  const parked = clampScreenBox({ x: aboveX, y: aboveY, w: panel.w, h: panel.h }, view);
  for (const blocker of avoid) {
    if (!boxesOverlap(parked, blocker)) continue;
    shifts.push(blocker.x + blocker.w + gap - aboveX);
    shifts.push(blocker.x - gap - panel.w - aboveX);
  }
  const ideal = { x: aboveX, y: aboveY };
  const raws: Array<{ box: ScreenBox; bias: number }> = [
    ...shifts.map((dx) => ({ box: { x: aboveX + dx, y: aboveY, w: panel.w, h: panel.h }, bias: 0 })),
    { box: { x: aboveX, y: popup.y + popup.h + gap, w: panel.w, h: panel.h }, bias: 10_000 },
    { box: { x: popup.x - gap - panel.w, y: popup.y + (popup.h - panel.h) / 2, w: panel.w, h: panel.h }, bias: 10_000 },
    { box: { x: popup.x + popup.w + gap, y: popup.y + (popup.h - panel.h) / 2, w: panel.w, h: panel.h }, bias: 10_000 },
  ];
  let best = clampScreenBox(raws[0]?.box ?? parked, view);
  let bestScore = panelPenalty(best, popup, avoid, view, ideal, raws[0]?.bias ?? 0);
  for (let i = 1; i < raws.length; i += 1) {
    const raw = raws[i];
    if (!raw) continue;
    const box = clampScreenBox(raw.box, view);
    const score = panelPenalty(box, popup, avoid, view, ideal, raw.bias);
    if (score < bestScore) {
      best = box;
      bestScore = score;
    }
  }
  return { x: best.x, y: best.y };
}

export function pointInPlacement(
  placement: { x: number; y: number; width: number; height: number; rotation: number },
  x: number,
  y: number,
): boolean {
  const dx = x - placement.x;
  const dy = y - placement.y;
  const rad = (-placement.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= placement.width / 2 && Math.abs(ly) <= placement.height / 2;
}

export function placementBounds(placement: { x: number; y: number; width: number; height: number; rotation: number }): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const hw = placement.width / 2;
  const hh = placement.height / 2;
  const rad = (placement.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [x, y] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]) {
    const wx = placement.x + x * cos - y * sin;
    const wy = placement.y + x * sin + y * cos;
    left = Math.min(left, wx);
    right = Math.max(right, wx);
    top = Math.min(top, wy);
    bottom = Math.max(bottom, wy);
  }
  return { left, top, right, bottom };
}

export function parsePlacements(raw: string): CanvasPlacement[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: CanvasPlacement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<CanvasPlacement>;
    const id = row.id;
    const imageId = row.imageId;
    const x = row.x;
    const y = row.y;
    const width = row.width;
    const rotation = row.rotation;
    const z = row.z;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof imageId !== "string" || !imageId) continue;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof rotation !== "number" || typeof z !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(rotation) || !Number.isFinite(z)) continue;
    if (width <= 0) continue;
    seen.add(id);
    const placement: CanvasPlacement = { id, imageId, x, y, width, rotation, z };
    if ((row as { flat?: unknown }).flat === true) placement.flat = true;
    const opacity = placementOpacity((row as { opacity?: unknown }).opacity);
    if ("opacity" in row && opacity < 100) placement.opacity = opacity;
    list.push(placement);
  }
  return list;
}

/** Display-only zoom. Cursor offsets are from the sheet center, in screen pixels. */
export function nextCanvasZoom(zoom: number, deltaY: number): number {
  const next = zoom * Math.exp(-deltaY * 0.0016);
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, next));
}

export function zoomAtCursor(
  zoom: number,
  panX: number,
  panY: number,
  cursorX: number,
  cursorY: number,
  nextZoom: number,
): { zoom: number; x: number; y: number } {
  const localX = (cursorX - panX) / zoom;
  const localY = (cursorY - panY) / zoom;
  return { zoom: nextZoom, x: cursorX - localX * nextZoom, y: cursorY - localY * nextZoom };
}

/** Puts the confirmed image on top without moving or resizing it. Other layers keep their order. */
export function raisePlacement(list: CanvasPlacement[], placement: CanvasPlacement, fresh: boolean): CanvasPlacement[] {
  const top = list.reduce((max, item) => Math.max(max, item.z), 0) + 1;
  const raised = { ...placement, z: top };
  if (fresh || !list.some((item) => item.id === raised.id)) return [...list.filter((item) => item.id !== raised.id), raised];
  return list.map((item) => (item.id === raised.id ? raised : item));
}
