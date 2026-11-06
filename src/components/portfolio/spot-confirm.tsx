import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SpotSide = "below" | "lower-left";

/** Keeps a small confirm next to its button, and nudges it back inside the window. */
export function placeSpot(anchor: DOMRect, side: SpotSide, box: { width: number; height: number }): { top: number; left: number } {
  const margin = 8;
  const gap = 6;
  const vw = typeof window === "undefined" ? box.width + margin * 2 : window.innerWidth;
  const vh = typeof window === "undefined" ? box.height + margin * 2 : window.innerHeight;
  let left = side === "lower-left" ? anchor.left - box.width + Math.min(20, anchor.width) : anchor.left;
  let top = anchor.bottom + gap;
  if (top + box.height > vh - margin) {
    const above = anchor.top - gap - box.height;
    top = above >= margin ? above : Math.max(margin, vh - margin - box.height);
  }
  if (top < margin) top = margin;
  if (left + box.width > vw - margin) left = vw - margin - box.width;
  if (left < margin) left = margin;
  return { top, left };
}

export function SpotConfirm({
  anchor,
  side,
  title,
  body,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  anchor: DOMRect;
  side: SpotSide;
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => placeSpot(anchor, side, { width: 288, height: 148 }));

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const next = placeSpot(anchor, side, { width: box.width, height: box.height });
    setPos((current) => (current.top === next.top && current.left === next.left ? current : next));
  }, [anchor, side, body, title]);

  useEffect(() => {
    if (busy) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-spot-trigger]")) return;
      onCancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onCancel();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [busy, onCancel]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div ref={ref} className="spot-confirm" role="dialog" aria-label={title} style={{ top: pos.top, left: pos.left }}>
      <p>{body}</p>
      <div className="spot-confirm-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="spot-go" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
