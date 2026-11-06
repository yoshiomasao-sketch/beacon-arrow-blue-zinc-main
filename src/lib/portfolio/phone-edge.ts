export const PHONE_EDGE_PX = 28;
export const PHONE_AXIS_PX = 12;

export type PhonePaneSide = "folder" | "tag";

export type EdgeGesture =
  | { kind: "open"; side: PhonePaneSide; other: PhonePaneSide | null }
  | { kind: "close"; side: PhonePaneSide };

export function drawerSpan(viewport: number, rem: number): number {
  const unit = rem > 0 ? rem : 16;
  return Math.max(0, Math.min(20 * unit, viewport - 3 * unit));
}

export function edgeGesture(input: {
  startX: number;
  viewport: number;
  open: PhonePaneSide | null;
  inFolder: boolean;
  inTag: boolean;
  editable: boolean;
}): EdgeGesture | null {
  if (input.editable || input.viewport <= 0) return null;
  const atLeft = input.startX <= PHONE_EDGE_PX;
  const atRight = input.startX >= input.viewport - PHONE_EDGE_PX;
  if (input.open === "folder") {
    if (input.inFolder) return { kind: "close", side: "folder" };
    if (atRight) return { kind: "open", side: "tag", other: "folder" };
    return null;
  }
  if (input.open === "tag") {
    if (input.inTag) return { kind: "close", side: "tag" };
    if (atLeft) return { kind: "open", side: "folder", other: "tag" };
    return null;
  }
  if (atLeft) return { kind: "open", side: "folder", other: null };
  if (atRight) return { kind: "open", side: "tag", other: null };
  return null;
}

export function axisLocked(gesture: EdgeGesture, dx: number, dy: number): boolean {
  const travel = gesture.side === "folder" ? (gesture.kind === "open" ? dx : -dx) : gesture.kind === "open" ? -dx : dx;
  return travel >= PHONE_AXIS_PX && travel > Math.abs(dy) * 1.15;
}

export function revealForMove(gesture: EdgeGesture, dx: number, span: number): { folder: number; tag: number } {
  const clamp = (value: number) => Math.max(0, Math.min(span, value));
  if (gesture.kind === "close") {
    const reveal = clamp(gesture.side === "folder" ? span + dx : span - dx);
    return gesture.side === "folder" ? { folder: reveal, tag: 0 } : { folder: 0, tag: reveal };
  }
  const pulled = clamp(gesture.side === "folder" ? dx : -dx);
  if (gesture.side === "folder") return { folder: pulled, tag: gesture.other ? clamp(span - pulled) : 0 };
  return { tag: pulled, folder: gesture.other ? clamp(span - pulled) : 0 };
}

export function slideX(side: PhonePaneSide, reveal: number, span: number): number {
  const hidden = side === "folder" ? reveal - span : span - reveal;
  return hidden;
}

export function gestureCommits(gesture: EdgeGesture, reveal: { folder: number; tag: number }, span: number, viewport: number): boolean {
  const threshold = viewport * 0.2;
  if (gesture.kind === "close") return span - reveal[gesture.side] >= threshold;
  return reveal[gesture.side] >= threshold;
}
