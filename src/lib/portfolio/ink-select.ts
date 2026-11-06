/** A closed selection over ink pixels. Coordinates are bitmap pixels, not screen pixels. */
export type InkPoint = { x: number; y: number };

export type InkSelection =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "lasso"; points: InkPoint[] };

export type InkBounds = { x: number; y: number; w: number; h: number; cx: number; cy: number };

/** Ink bitmap plus the selection that was active with it. Selection is null when nothing is selected. */
export type InkSnap = {
  pixels: HTMLCanvasElement;
  selection: InkSelection | null;
};

export type InkLift = {
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
  gen: number;
};

export function cloneSelection(selection: InkSelection | null): InkSelection | null {
  if (!selection) return null;
  if (selection.kind === "rect") return { kind: "rect", x: selection.x, y: selection.y, w: selection.w, h: selection.h };
  return { kind: "lasso", points: selection.points.map((point) => ({ x: point.x, y: point.y })) };
}

/** Diagonal drag. A flat line is not a selection. */
export function rectSelection(x0: number, y0: number, x1: number, y1: number): InkSelection | null {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (w < 1 || h < 1) return null;
  return { kind: "rect", x, y, w, h };
}

/** Closed by the outline, not by repeating the first point. */
export function lassoSelection(points: readonly InkPoint[]): InkSelection | null {
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const copy: InkPoint[] = [];
  for (const point of points) {
    copy.push({ x: point.x, y: point.y });
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (maxX - minX < 1 || maxY - minY < 1) return null;
  return { kind: "lasso", points: copy };
}

export function moveSelection(selection: InkSelection, dx: number, dy: number): InkSelection {
  if (selection.kind === "rect") return { kind: "rect", x: selection.x + dx, y: selection.y + dy, w: selection.w, h: selection.h };
  return { kind: "lasso", points: selection.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
}

export function selectionBounds(selection: InkSelection): InkBounds {
  if (selection.kind === "rect") {
    return {
      x: selection.x,
      y: selection.y,
      w: selection.w,
      h: selection.h,
      cx: selection.x + selection.w / 2,
      cy: selection.y + selection.h / 2,
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of selection.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  return { x: minX, y: minY, w, h, cx: minX + w / 2, cy: minY + h / 2 };
}

/** Even-odd, matching the mask fill. The boundary counts as inside. */
export function pointInSelection(selection: InkSelection, x: number, y: number): boolean {
  if (selection.kind === "rect") {
    return x >= selection.x && y >= selection.y && x <= selection.x + selection.w && y <= selection.y + selection.h;
  }
  return pointInPolygon(selection.points, x, y);
}

export function pointInPolygon(points: readonly InkPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if (!a || !b) continue;
    if (pointOnSegment(a, b, x, y)) return true;
    const crosses = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(a: InkPoint, b: InkPoint, x: number, y: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = x - a.x;
  const apy = y - a.y;
  const cross = abx * apy - aby * apx;
  if (cross * cross > 0.25 * (abx * abx + aby * aby)) return false;
  const dot = apx * abx + apy * aby;
  if (dot < 0) return false;
  return dot <= abx * abx + aby * aby;
}

export function traceSelection(ctx: CanvasRenderingContext2D, selection: InkSelection): void {
  ctx.beginPath();
  if (selection.kind === "rect") {
    ctx.rect(selection.x, selection.y, selection.w, selection.h);
    return;
  }
  const first = selection.points[0];
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < selection.points.length; index += 1) {
    const point = selection.points[index];
    if (point) ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

export function clipCanvasToSelection(target: HTMLCanvasElement, selection: InkSelection, mode: "keep" | "remove"): void {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = mode === "keep" ? "destination-in" : "destination-out";
  ctx.fillStyle = "#fff";
  traceSelection(ctx, selection);
  ctx.fill("evenodd");
  ctx.restore();
}

export function extractSelection(source: HTMLCanvasElement, selection: InkSelection): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext("2d");
  if (!ctx) return copy;
  ctx.drawImage(source, 0, 0);
  clipCanvasToSelection(copy, selection, "keep");
  return copy;
}

/** Axis-aligned box of the selection after the lift transform. Button placement uses this, not the rotated frame. */
export function transformedBounds(selection: InkSelection, lift: Pick<InkLift, "dx" | "dy" | "scale" | "rotation">): InkBounds {
  const box = selectionBounds(selection);
  const rad = (lift.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const x = corner[0] ?? 0;
    const y = corner[1] ?? 0;
    const dx = x - box.cx;
    const dy = y - box.cy;
    const rx = (dx * cos - dy * sin) * lift.scale + box.cx + lift.dx;
    const ry = (dx * sin + dy * cos) * lift.scale + box.cy + lift.dy;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  return { x: minX, y: minY, w, h, cx: minX + w / 2, cy: minY + h / 2 };
}

export function blitLifted(target: HTMLCanvasElement, extracted: HTMLCanvasElement, selection: InkSelection, lift: Pick<InkLift, "dx" | "dy" | "scale" | "rotation">): void {
  const box = selectionBounds(selection);
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.translate(box.cx + lift.dx, box.cy + lift.dy);
  ctx.rotate((lift.rotation * Math.PI) / 180);
  ctx.scale(lift.scale, lift.scale);
  ctx.translate(-box.cx, -box.cy);
  ctx.drawImage(extracted, 0, 0);
  ctx.restore();
}
