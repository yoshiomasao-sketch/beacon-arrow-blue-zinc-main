import type { InkSnap } from "./ink-select";

export type { InkSnap } from "./ink-select";

export const INK_COLORS = [
  "#ffffff",
  "#161616",
  "#e23b3b",
  "#f07a1a",
  "#f2c014",
  "#7bc142",
  "#1f9d55",
  "#14b8c4",
  "#2f6fed",
  "#5b4bdb",
  "#c13b9b",
  "#e56aa8",
  "#8b5a2b",
  "#8a8f98",
  "#d7dbe2",
  "#5c6570",
] as const;

export const INK_WIDTHS = [
  { id: "hair", label: "極細", ratio: 0.002, floor: 1 },
  { id: "thin", label: "細", ratio: 0.006, floor: 3 },
  { id: "thick", label: "太", ratio: 0.016, floor: 8 },
  { id: "heavy", label: "極太", ratio: 0.04, floor: 18 },
] as const;

export type InkWidthId = (typeof INK_WIDTHS)[number]["id"];
export type InkSteady = "off" | "low" | "mid" | "high";

const FOLLOW: Record<Exclude<InkSteady, "off">, number> = { low: 0.78, mid: 0.5, high: 0.28 };

export function inkWidth(id: InkWidthId, pixelWidth: number, pixelHeight: number): number {
  const spec = INK_WIDTHS.find((entry) => entry.id === id) ?? INK_WIDTHS[1];
  const base = Math.max(1, Math.min(pixelWidth, pixelHeight));
  return Math.max(spec.floor, Math.round(base * spec.ratio));
}

/** Pulls the drawn point toward the pointer. Off keeps the pointer itself. The first sample of a stroke has no previous point, so it stays on the pointer. */
export function steadyPoint(
  previous: { x: number; y: number } | null,
  next: { x: number; y: number },
  level: InkSteady,
): { x: number; y: number } {
  if (!previous || level === "off") return next;
  const follow = FOLLOW[level];
  return {
    x: previous.x + (next.x - previous.x) * follow,
    y: previous.y + (next.y - previous.y) * follow,
  };
}

/** Samples that belong to one pointer event. A burst that arrived together is kept in order; otherwise the event itself is the only sample. */
export function coalescedSamples<T extends { clientX: number; clientY: number }>(
  event: T & { getCoalescedEvents?: () => readonly T[] },
): readonly T[] {
  const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  return samples.length > 0 ? samples : [event];
}

/** Applies stabilization in arrival order. A null start keeps the first sample on the pointer. */
export function applySteadyPath(
  start: { x: number; y: number } | null,
  points: readonly { x: number; y: number }[],
  level: InkSteady,
): { x: number; y: number }[] {
  const drawn: { x: number; y: number }[] = [];
  let previous = start;
  for (const point of points) {
    const next = steadyPoint(previous, point, level);
    drawn.push(next);
    previous = next;
  }
  return drawn;
}

/** One finished stroke, erase, or clear. Not a single pointer sample. */
export type InkHistory<T> = {
  undo: T[];
  redo: T[];
};

export function emptyInkHistory<T>(): InkHistory<T> {
  return { undo: [], redo: [] };
}

export function noteInkStep<T>(history: InkHistory<T>, before: T, limit = 30): void {
  history.undo.push(before);
  if (history.undo.length > limit) history.undo.splice(0, history.undo.length - limit);
  history.redo.length = 0;
}

export function undoInkStep<T>(history: InkHistory<T>, current: T): T | null {
  const prev = history.undo.pop();
  if (prev === undefined) return null;
  history.redo.push(current);
  return prev;
}

export function redoInkStep<T>(history: InkHistory<T>, current: T): T | null {
  const next = history.redo.pop();
  if (next === undefined) return null;
  history.undo.push(current);
  return next;
}

const sessions = new Map<string, InkHistory<InkSnap>>();

export function inkSession(id: string): InkHistory<InkSnap> {
  let row = sessions.get(id);
  if (!row) {
    row = emptyInkHistory();
    sessions.set(id, row);
  }
  return row;
}

export function resetInkSession(id: string): void {
  const row = sessions.get(id);
  if (!row) return;
  row.undo.length = 0;
  row.redo.length = 0;
}

export function clearInkHistories(): void {
  sessions.clear();
}
