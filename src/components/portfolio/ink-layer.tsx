import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { deleteInk, readInk, saveInk } from "@/lib/portfolio/db";
import { INK_COLORS, INK_WIDTHS, applySteadyPath, coalescedSamples, inkSession, inkWidth, noteInkStep, redoInkStep, undoInkStep, type InkSnap, type InkSteady, type InkWidthId } from "@/lib/portfolio/ink";
import {
  blitLifted,
  clipCanvasToSelection,
  cloneSelection,
  extractSelection,
  lassoSelection,
  moveSelection,
  pointInSelection,
  rectSelection,
  selectionBounds,
  traceSelection,
  transformedBounds,
  type InkLift,
  type InkPoint,
  type InkSelection,
} from "@/lib/portfolio/ink-select";
import { pointerAngle, pointerDistance, rotatedDegrees } from "@/lib/portfolio/canvas";
import { noteInkPresence } from "@/lib/portfolio/store";

function canvasBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx || canvas.width < 1 || canvas.height < 1) return true;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0) return false;
  }
  return true;
}

function maskedHasInk(source: HTMLCanvasElement, selection: InkSelection): boolean {
  const box = selectionBounds(selection);
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const right = Math.min(source.width, Math.ceil(box.x + box.w));
  const bottom = Math.min(source.height, Math.ceil(box.y + box.h));
  const w = right - x;
  const h = bottom - y;
  if (w < 1 || h < 1) return false;
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(source, 0, 0);
  clipCanvasToSelection(copy, selection, "keep");
  const data = ctx.getImageData(x, y, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0) return true;
  }
  return false;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")?.drawImage(source, 0, 0);
  return copy;
}

function canvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement, rect: DOMRect): { x: number; y: number } {
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

function eventPoints(event: PointerEvent, canvas: HTMLCanvasElement, rect: DOMRect): { x: number; y: number }[] {
  return coalescedSamples(event).map((sample) => canvasPoint(sample.clientX, sample.clientY, canvas, rect));
}

/** Allocates a 2d context the first time. willReadFrequently is left off so pen strokes stay on the fast path. */
function drawingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext("2d", { alpha: true });
}

/** Compiles the stroke path once. Alpha 0 leaves pixels untouched. */
function primeContext(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 0;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintSnapshot(target: HTMLCanvasElement, snap: HTMLCanvasElement): void {
  const ctx = drawingContext(target);
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(snap, 0, 0, target.width, target.height);
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

const inkTail = new Map<string, Promise<void>>();

function persistInk(id: string, canvas: HTMLCanvasElement, painted: boolean, prepared?: HTMLCanvasElement): Promise<void> {
  const snap = prepared ?? cloneCanvas(canvas);
  const blank = !painted || canvasBlank(snap);
  const run = (inkTail.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (blank) {
        await deleteInk(id);
        noteInkPresence(id, false);
        return;
      }
      const blob = await toPng(snap);
      if (!blob || blob.size < 1) {
        await deleteInk(id);
        noteInkPresence(id, false);
        return;
      }
      await saveInk(id, blob);
      noteInkPresence(id, true);
    });
  inkTail.set(id, run);
  return run;
}

export function forgetPersistedInk(id: string): Promise<void> {
  const run = (inkTail.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => deleteInk(id))
    .then(() => {
      noteInkPresence(id, false);
    });
  inkTail.set(id, run);
  return run;
}

export type CanvasInkApi = {
  snapshot: () => InkSnap | null;
  restore: (next: InkSnap) => void;
  composite: () => HTMLCanvasElement | null;
};

type DrawTool = "pen" | "erase" | "rect" | "lasso";

function shapeNode(shape: InkSelection, className: string, stroke: number) {
  if (shape.kind === "rect") return <rect className={className} x={shape.x} y={shape.y} width={shape.w} height={shape.h} strokeWidth={stroke} fillRule="evenodd" />;
  return <polygon className={className} points={shape.points.map((point) => `${point.x},${point.y}`).join(" ")} strokeWidth={stroke} fillRule="evenodd" />;
}

function RotateGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 4.64a3.36 3.36 0 1 1-2.59 1.19" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
      <path d="M4.78 4.08v1.96h1.96" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScaleGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M11.5 9.05V11.5H9.05M4.5 6.95V4.5H6.95M11.5 11.5 8.56 8.56M4.5 4.5l2.94 2.94"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const GRAB_HAND =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' aria-hidden='true'><path fill='#fff' stroke='#fff' stroke-width='28' stroke-linejoin='round' d='M216,104v48a88,88,0,0,1-176,0V136a16,16,0,0,1,32,0v8a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0,16,16,0,0,1,32,0Z'/><path fill='#fff' stroke='#1c1408' stroke-width='12' stroke-linejoin='round' d='M216,104v48a88,88,0,0,1-176,0V136a16,16,0,0,1,32,0v8a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0,16,16,0,0,1,32,0Z'/></svg>";

export function ImageInk({
  imageId,
  pixelWidth,
  pixelHeight,
  style,
  live,
  shown,
  toolsRoot = null,
  canvasBridge = null,
}: {
  imageId: string;
  pixelWidth: number;
  pixelHeight: number;
  style: CSSProperties;
  live: boolean;
  shown: boolean;
  toolsRoot?: HTMLElement | null;
  canvasBridge?: {
    imageActive: boolean;
    onImageTool: () => void;
    onDrawTool: (tool: "pen" | "erase") => void;
    claimImage: (x: number, y: number) => boolean;
    onImageDrag: (x: number, y: number, downX: number, downY: number, clientX: number, clientY: number, pointerId: number) => void;
    bindInk?: (api: CanvasInkApi | null) => void;
    history?: {
      blocked: boolean;
      canUndo: boolean;
      canRedo: boolean;
      undo: () => void;
      redo: () => void;
      noteInk: (before: InkSnap) => void;
    } | null;
  } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadedId = useRef("");
  const painted = useRef(false);
  const [armed, setArmed] = useState(false);
  const stroke = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const beforeSnap = useRef<HTMLCanvasElement | null>(null);
  const mirror = useRef<HTMLCanvasElement | null>(null);
  const cold = useRef(true);
  const mirrorFresh = useRef(false);
  const rectRef = useRef<DOMRect | null>(null);
  const rectAt = useRef(0);
  const activePointer = useRef<number | null>(null);
  const [tool, setTool] = useState<DrawTool>("pen");
  const [widthId, setWidthId] = useState<InkWidthId>("thin");
  const [color, setColor] = useState<string>(INK_COLORS[2]);
  const [steady, setSteady] = useState<InkSteady>("mid");
  const [palette, setPalette] = useState(false);
  const [histTick, setHistTick] = useState(0);
  const [selection, setSelection] = useState<InkSelection | null>(null);
  const [draftShape, setDraftShape] = useState<InkSelection | null>(null);
  const [lift, setLift] = useState<InkLift | null>(null);
  const [layoutRatio, setLayoutRatio] = useState(1);
  const [uiScale, setUiScale] = useState(1);
  const [previewTick, setPreviewTick] = useState(0);
  const paletteRef = useRef<HTMLDivElement>(null);
  const history = inkSession(imageId);
  const imageHold = useRef<{ raw: { x: number; y: number }; clientX: number; clientY: number; pointerId: number } | null>(null);
  const handed = useRef(false);
  const boardInk = useRef<CanvasInkApi>({
    snapshot: () => null,
    restore: () => undefined,
    composite: () => null,
  });
  const selectionRef = useRef<InkSelection | null>(null);
  const liftRef = useRef<InkLift | null>(null);
  const holdRef = useRef<{ pixels: HTMLCanvasElement; selection: InkSelection } | null>(null);
  const extractedRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const beforeSelection = useRef<InkSelection | null>(null);
  const strokeHit = useRef(false);
  const clipStroke = useRef(false);
  const liftGen = useRef(0);
  const floatViewRef = useRef<HTMLCanvasElement | null>(null);
  const stopLiftGesture = useRef<(() => void) | null>(null);
  const selectGesture = useRef<
    | { kind: "slide"; pointerId: number; origin: InkSelection; clientX: number; clientY: number; moved: boolean }
    | { kind: "create"; pointerId: number; tool: "rect" | "lasso"; clientX: number; clientY: number; x0: number; y0: number; points: InkPoint[]; origin: InkSelection | null; moved: boolean }
    | null
  >(null);
  void histTick;

  useEffect(() => {
    const bind = canvasBridge?.bindInk;
    if (!bind) return;
    bind(boardInk.current);
    return () => bind(null);
  }, [canvasBridge?.bindInk]);

  useEffect(() => {
    if (!palette) return;
    const close = (event: PointerEvent) => {
      if (paletteRef.current?.contains(event.target as Node)) return;
      setPalette(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [palette]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const previous = loadedId.current;
    if (holdRef.current) {
      paintSnapshot(canvas, holdRef.current.pixels);
      holdRef.current = null;
      extractedRef.current = null;
      liftRef.current = null;
      stopLiftGesture.current?.();
      stopLiftGesture.current = null;
    }
    if (previous && previous !== imageId) {
      if (beforeSnap.current && moved.current) {
        noteInkStep(inkSession(previous), { pixels: beforeSnap.current, selection: cloneSelection(selectionRef.current) });
      }
      beforeSnap.current = null;
      stroke.current = null;
      if (painted.current) {
        const copy = cloneCanvas(canvas);
        void persistInk(previous, copy, true);
      }
    }
    painted.current = false;
    stroke.current = null;
    moved.current = false;
    beforeSnap.current = null;
    mirror.current = null;
    mirrorFresh.current = false;
    selectionRef.current = null;
    selectGesture.current = null;
    setSelection(null);
    setDraftShape(null);
    setLift(null);
    canvas.width = Math.max(1, pixelWidth);
    canvas.height = Math.max(1, pixelHeight);
    const primed = drawingContext(canvas);
    if (primed) primeContext(primed);
    loadedId.current = imageId;
    setHistTick((tick) => tick + 1);
    setArmed(false);
    let cancel = false;
    const finish = () => {
      if (!cancel && loadedId.current === imageId) {
        if (!mirror.current || mirror.current.width !== canvas.width || mirror.current.height !== canvas.height) mirror.current = cloneCanvas(canvas);
        mirrorFresh.current = true;
        setArmed(true);
      }
    };
    void readInk(imageId)
      .then(async (blob) => {
        if (cancel || loadedId.current !== imageId) return;
        if (!blob) {
          finish();
          return;
        }
        const bitmap = await createImageBitmap(blob);
        if (cancel || loadedId.current !== imageId) {
          bitmap.close();
          return;
        }
        const ctx = drawingContext(canvas);
        if (!ctx) {
          bitmap.close();
          finish();
          return;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        painted.current = true;
        mirror.current = cloneCanvas(canvas);
        finish();
      })
      .catch(() => {
        finish();
      });
    return () => {
      cancel = true;
    };
  }, [imageId, pixelWidth, pixelHeight]);

  useEffect(() => {
    if (live) return;
    const canvas = canvasRef.current;
    const id = loadedId.current;
    if (!canvas || !id) return;
    if (holdRef.current) {
      paintSnapshot(canvas, holdRef.current.pixels);
      holdRef.current = null;
      extractedRef.current = null;
      liftRef.current = null;
      stopLiftGesture.current?.();
      stopLiftGesture.current = null;
      setLift(null);
    }
    if (!painted.current) return;
    if (beforeSnap.current && moved.current) {
      noteInkStep(inkSession(id), { pixels: beforeSnap.current, selection: cloneSelection(selectionRef.current) });
      beforeSnap.current = null;
      stroke.current = null;
      setHistTick((tick) => tick + 1);
    }
    void persistInk(id, canvas, true);
  }, [live]);

  useEffect(() => {
    if (!canvasBridge?.imageActive) return;
    if (!holdRef.current && !liftRef.current) return;
    cancelLift();
  }, [canvasBridge?.imageActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const id = loadedId.current;
    if (!canvas || !id || !painted.current || holdRef.current) return;
    void persistInk(id, canvas, true);
  }, [tool, widthId, color]);

  const lineWidth = inkWidth(widthId, pixelWidth, pixelHeight);
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorAt = useRef<{ x: number; y: number } | null>(null);
  const fileDrag = useRef(false);
  const selectTool = tool === "rect" || tool === "lasso";
  const brushLive = Boolean(live && !canvasBridge?.imageActive && (tool === "pen" || tool === "erase"));

  useEffect(() => {
    if (!brushLive) return;
    let frame = 0;
    let cursorMode = "";
    let stageRect: DOMRect | null = null;
    let stageAt = 0;
    let contact = false;
    const apply = () => {
      frame = 0;
      const node = cursorRef.current;
      const canvas = canvasRef.current;
      const point = cursorAt.current;
      if (!node || !canvas || !point) return;
      if (fileDrag.current) {
        node.style.visibility = "hidden";
        if (cursorMode !== "auto") {
          cursorMode = "auto";
          canvas.style.cursor = "auto";
        }
        return;
      }
      const drawing = stroke.current !== null || activePointer.current !== null;
      let rect = rectRef.current;
      const age = performance.now() - rectAt.current;
      const rectStale = !rect || rect.width < 1 || rectAt.current <= 0 || (!drawing && age >= 48);
      if (rectStale) {
        rect = canvas.getBoundingClientRect();
        rectRef.current = rect;
        rectAt.current = performance.now();
      }
      const stageStale = !stageRect || stageAt <= 0 || (!drawing && performance.now() - stageAt >= 48);
      if (stageStale) {
        const stage = canvas.closest(".canvas-stage");
        stageRect = stage ? stage.getBoundingClientRect() : null;
        stageAt = performance.now();
      }
      const inRect =
        rect !== null &&
        rect.width > 0 &&
        point.x >= rect.left &&
        point.y >= rect.top &&
        point.x <= rect.right &&
        point.y <= rect.bottom;
      const inStage =
        stageRect === null ||
        (point.x >= stageRect.left && point.y >= stageRect.top && point.x <= stageRect.right && point.y <= stageRect.bottom);
      let onSheet = inRect && inStage;
      if (onSheet && !drawing) {
        const hit = document.elementFromPoint(point.x, point.y);
        onSheet = hit === canvas || Boolean(hit && canvas.contains(hit));
      }
      if (!onSheet || !rect || canvas.width < 1) {
        node.style.visibility = "hidden";
        if (cursorMode !== "auto") {
          cursorMode = "auto";
          canvas.style.cursor = "auto";
        }
        return;
      }
      const diameter = (lineWidth * rect.width) / canvas.width;
      node.style.visibility = "visible";
      node.style.width = `${diameter}px`;
      node.style.height = `${diameter}px`;
      node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%)`;
      if (cursorMode !== "none") {
        cursorMode = "none";
        canvas.style.cursor = "none";
      }
    };
    const schedule = (clientX: number, clientY: number) => {
      cursorAt.current = { x: clientX, y: clientY };
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };
    const onPointer = (event: PointerEvent) => {
      schedule(event.clientX, event.clientY);
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      contact = true;
      schedule(event.clientX, event.clientY);
    };
    const refresh = () => {
      const point = cursorAt.current;
      if (!point) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          rectAt.current = 0;
          stageAt = 0;
          schedule(point.x, point.y);
        });
      });
    };
    const nudge = () => {
      const point = cursorAt.current;
      if (!point) return;
      schedule(point.x, point.y);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 0) contact = false;
      if (event.button === 1) {
        rectAt.current = 0;
        stageAt = 0;
      }
      nudge();
    };
    const onCancel = () => {
      contact = false;
      nudge();
    };
    const hide = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const node = cursorRef.current;
      if (node) node.style.visibility = "hidden";
    };
    const onOut = (event: PointerEvent) => {
      if (event.relatedTarget != null) return;
      if (contact || stroke.current || activePointer.current !== null) return;
      const point = cursorAt.current;
      const canvas = canvasRef.current;
      if (point && canvas) {
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit === canvas || Boolean(hit && canvas.contains(hit))) return;
      }
      hide();
      cursorMode = "";
      if (canvas) canvas.style.cursor = "";
    };
    const onDragStart = () => {
      fileDrag.current = true;
      hide();
      cursorMode = "auto";
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "auto";
    };
    const onDragEnd = () => {
      fileDrag.current = false;
      nudge();
    };
    const listen = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", onDown, listen);
    window.addEventListener("pointermove", onPointer, listen);
    window.addEventListener("pointerover", onPointer, listen);
    window.addEventListener("pointerout", onOut, listen);
    window.addEventListener("pointerup", onPointerUp, listen);
    window.addEventListener("pointercancel", onCancel, listen);
    window.addEventListener("wheel", refresh, { passive: true, capture: true });
    window.addEventListener("resize", refresh);
    window.addEventListener("blur", hide);
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    const point = cursorAt.current;
    if (point) schedule(point.x, point.y);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onDown, listen);
      window.removeEventListener("pointermove", onPointer, listen);
      window.removeEventListener("pointerover", onPointer, listen);
      window.removeEventListener("pointerout", onOut, listen);
      window.removeEventListener("pointerup", onPointerUp, listen);
      window.removeEventListener("pointercancel", onCancel, listen);
      window.removeEventListener("wheel", refresh, { capture: true });
      window.removeEventListener("resize", refresh);
      window.removeEventListener("blur", hide);
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      fileDrag.current = false;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "";
      hide();
    };
  }, [brushLive, lineWidth]);

  const ensureScratch = (canvas: HTMLCanvasElement) => {
    let scratch = scratchRef.current;
    if (!scratch || scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch = document.createElement("canvas");
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      scratchRef.current = scratch;
    }
    return scratch;
  };

  const restampClipped = (canvas: HTMLCanvasElement) => {
    const snap = beforeSnap.current;
    const sel = selectionRef.current;
    const scratch = scratchRef.current;
    if (!snap || !sel || !scratch) return;
    paintSnapshot(canvas, snap);
    const ctx = drawingContext(canvas);
    if (!ctx) return;
    ctx.save();
    traceSelection(ctx, sel);
    ctx.clip("evenodd");
    ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  };

  const strokeBetween = (from: { x: number; y: number }, to: { x: number; y: number }, dot: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = (ctx: CanvasRenderingContext2D, erasing: boolean) => {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = lineWidth;
      ctx.globalAlpha = 1;
      if (erasing) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.fillStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      if (dot) {
        ctx.beginPath();
        ctx.arc(to.x, to.y, lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };
    if (!clipStroke.current) {
      const ctx = drawingContext(canvas);
      if (!ctx) return;
      paint(ctx, tool === "erase");
      painted.current = true;
      return;
    }
    const ctx = ensureScratch(canvas).getContext("2d");
    if (!ctx) return;
    paint(ctx, false);
    restampClipped(canvas);
  };

  const pushInk = (snap: InkSnap) => {
    const id = loadedId.current;
    if (!id) return;
    if (canvasBridge?.history) canvasBridge.history.noteInk(snap);
    else noteInkStep(inkSession(id), snap);
    setHistTick((tick) => tick + 1);
  };

  const finishStroke = (record: boolean) => {
    const canvas = canvasRef.current;
    const id = loadedId.current;
    const snap = beforeSnap.current;
    const selBefore = beforeSelection.current;
    const clipped = clipStroke.current;
    beforeSnap.current = null;
    beforeSelection.current = null;
    clipStroke.current = false;
    stroke.current = null;
    if (!canvas || !id) return;
    if (clipped) {
      const scratch = scratchRef.current;
      const sel = selectionRef.current;
      if (record) {
        const hit = Boolean(scratch && sel && maskedHasInk(scratch, sel));
        if (!hit) record = false;
        else painted.current = true;
      }
      if (scratch) scratch.getContext("2d")?.clearRect(0, 0, scratch.width, scratch.height);
    }
    if (record && snap) {
      pushInk({ pixels: snap, selection: cloneSelection(selBefore) });
    }
    if (tool === "erase" && canvasBlank(canvas)) painted.current = false;
    const copy = cloneCanvas(canvas);
    mirror.current = copy;
    mirrorFresh.current = true;
    void persistInk(id, canvas, painted.current, copy);
    if (selectionRef.current) setPreviewTick((tick) => tick + 1);
  };

  const applySnap = (next: InkSnap | null) => {
    const canvas = canvasRef.current;
    const id = loadedId.current;
    if (!canvas || !id || !next) return;
    stopLiftGesture.current?.();
    stopLiftGesture.current = null;
    holdRef.current = null;
    extractedRef.current = null;
    liftRef.current = null;
    setLift(null);
    selectGesture.current = null;
    setDraftShape(null);
    paintSnapshot(canvas, next.pixels);
    const sel = cloneSelection(next.selection);
    selectionRef.current = sel;
    setSelection(sel);
    const copy = cloneCanvas(canvas);
    mirror.current = copy;
    mirrorFresh.current = true;
    painted.current = !canvasBlank(canvas);
    setHistTick((tick) => tick + 1);
    void persistInk(id, canvas, painted.current, copy);
  };

  const liveSnap = (): InkSnap | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    if (holdRef.current) return { pixels: cloneCanvas(holdRef.current.pixels), selection: cloneSelection(holdRef.current.selection) };
    return { pixels: cloneCanvas(canvas), selection: cloneSelection(selectionRef.current) };
  };

  boardInk.current.snapshot = () => liveSnap();
  boardInk.current.restore = (next) => {
    applySnap(next);
  };
  boardInk.current.composite = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const hold = holdRef.current;
    const extracted = extractedRef.current;
    const lifting = liftRef.current;
    if (hold && extracted && lifting) {
      const copy = cloneCanvas(canvas);
      blitLifted(copy, extracted, hold.selection, lifting);
      return copy;
    }
    return cloneCanvas(canvas);
  };

  const undo = () => {
    if (stroke.current || liftRef.current || holdRef.current) return;
    const board = canvasBridge?.history;
    if (board) {
      if (board.blocked) return;
      board.undo();
      return;
    }
    const canvas = canvasRef.current;
    const id = loadedId.current;
    if (!canvas || !id) return;
    const session = inkSession(id);
    if (session.undo.length === 0) return;
    const current = liveSnap();
    if (!current) return;
    const restored = undoInkStep(session, current);
    if (restored) applySnap(restored);
  };

  const redo = () => {
    if (stroke.current || liftRef.current || holdRef.current) return;
    const board = canvasBridge?.history;
    if (board) {
      if (board.blocked) return;
      board.redo();
      return;
    }
    const canvas = canvasRef.current;
    const id = loadedId.current;
    if (!canvas || !id) return;
    const session = inkSession(id);
    if (session.redo.length === 0) return;
    const current = liveSnap();
    if (!current) return;
    const restored = redoInkStep(session, current);
    if (restored) applySnap(restored);
  };

  const clearAll = () => {
    if (liftRef.current || holdRef.current) return;
    const canvas = canvasRef.current;
    const id = loadedId.current;
    if (!canvas || !id) return;
    const sel = selectionRef.current;
    if (sel) {
      if (!maskedHasInk(canvas, sel)) return;
      const snap = cloneCanvas(canvas);
      clipCanvasToSelection(canvas, sel, "remove");
      pushInk({ pixels: snap, selection: cloneSelection(sel) });
      const copy = cloneCanvas(canvas);
      mirror.current = copy;
      mirrorFresh.current = true;
      painted.current = !canvasBlank(canvas);
      void persistInk(id, canvas, painted.current, copy);
      return;
    }
    const ctx = drawingContext(canvas);
    if (!ctx) return;
    const snap = cloneCanvas(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!canvasBlank(snap)) pushInk({ pixels: snap, selection: null });
    const copy = cloneCanvas(canvas);
    mirror.current = copy;
    mirrorFresh.current = true;
    painted.current = false;
    setHistTick((tick) => tick + 1);
    void persistInk(id, canvas, false, copy);
  };

  const noteSelectionStep = (beforeSel: InkSelection | null, afterSel: InkSelection | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixels = cloneCanvas(canvas);
    pushInk({ pixels, selection: cloneSelection(beforeSel) });
    const next = cloneSelection(afterSel);
    selectionRef.current = next;
    setSelection(next);
    setDraftShape(null);
  };

  const noteReplace = (origin: InkSelection, nextSel: InkSelection) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixels = cloneCanvas(canvas);
    pushInk({ pixels, selection: cloneSelection(origin) });
    pushInk({ pixels, selection: null });
    const next = cloneSelection(nextSel);
    selectionRef.current = next;
    setSelection(next);
    setDraftShape(null);
  };

  const endLiftGesture = () => {
    stopLiftGesture.current?.();
    stopLiftGesture.current = null;
  };

  const cancelLift = () => {
    endLiftGesture();
    const hold = holdRef.current;
    const canvas = canvasRef.current;
    liftRef.current = null;
    setLift(null);
    holdRef.current = null;
    extractedRef.current = null;
    if (!hold || !canvas) return;
    paintSnapshot(canvas, hold.pixels);
    const sel = cloneSelection(hold.selection);
    selectionRef.current = sel;
    setSelection(sel);
    const copy = cloneCanvas(canvas);
    mirror.current = copy;
    mirrorFresh.current = true;
  };

  const confirmLift = () => {
    endLiftGesture();
    const canvas = canvasRef.current;
    const hold = holdRef.current;
    const extracted = extractedRef.current;
    const lifting = liftRef.current;
    const id = loadedId.current;
    if (!canvas || !hold || !extracted || !lifting || !id) {
      cancelLift();
      return;
    }
    const movedLift = lifting.dx !== 0 || lifting.dy !== 0 || lifting.scale !== 1 || lifting.rotation !== 0;
    if (movedLift) blitLifted(canvas, extracted, hold.selection, lifting);
    else paintSnapshot(canvas, hold.pixels);
    pushInk({ pixels: hold.pixels, selection: cloneSelection(hold.selection) });
    holdRef.current = null;
    extractedRef.current = null;
    liftRef.current = null;
    selectionRef.current = null;
    setSelection(null);
    setLift(null);
    setDraftShape(null);
    const copy = cloneCanvas(canvas);
    mirror.current = copy;
    mirrorFresh.current = true;
    painted.current = !canvasBlank(canvas);
    void persistInk(id, canvas, painted.current, copy);
  };

  const beginLift = () => {
    const canvas = canvasRef.current;
    const sel = selectionRef.current;
    if (!canvas || !sel || holdRef.current) return;
    const selection = cloneSelection(sel);
    if (!selection) return;
    const pixels = cloneCanvas(canvas);
    holdRef.current = { pixels, selection };
    extractedRef.current = extractSelection(canvas, selection);
    clipCanvasToSelection(canvas, selection, "remove");
    const punched = cloneCanvas(canvas);
    mirror.current = punched;
    mirrorFresh.current = true;
    const next = { dx: 0, dy: 0, scale: 1, rotation: 0, gen: (liftGen.current += 1) };
    liftRef.current = next;
    setLift(next);
  };

  const dismissSelection = () => {
    if (holdRef.current || liftRef.current) {
      cancelLift();
      return;
    }
    const current = selectionRef.current;
    if (!current) return;
    noteSelectionStep(current, null);
  };

  const chooseDraw = (next: DrawTool) => {
    if (holdRef.current || liftRef.current) cancelLift();
    setTool(next);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = "";
    canvasBridge?.onDrawTool(next === "erase" ? "erase" : "pen");
  };

  const clientToBitmap = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return canvasPoint(clientX, clientY, canvas, rect);
  };

  const patchLift = (partial: Partial<Pick<InkLift, "dx" | "dy" | "scale" | "rotation">>) => {
    const current = liftRef.current;
    if (!current) return;
    const next = { ...current, ...partial };
    liftRef.current = next;
    setLift(next);
  };

  const beginLiftGesture = (pointerId: number, onMove: (event: PointerEvent) => void, cursor?: { pointerType: string; x: number; y: number }) => {
    endLiftGesture();
    const root = document.documentElement;
    let hand: HTMLDivElement | null = null;
    const placeHand = (x: number, y: number) => {
      if (!hand) return;
      hand.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-16px, -16px)`;
    };
    if (cursor) {
      const penLike = cursor.pointerType === "pen" || cursor.pointerType === "touch";
      if (penLike) {
        root.classList.add("is-canvas-pen-grab");
        hand = document.createElement("div");
        hand.className = "canvas-pen-grab";
        hand.setAttribute("aria-hidden", "true");
        hand.innerHTML = GRAB_HAND;
        placeHand(cursor.x, cursor.y);
        document.body.appendChild(hand);
      } else root.classList.add("is-canvas-grabbing");
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      placeHand(event.clientX, event.clientY);
      onMove(event);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      root.classList.remove("is-canvas-grabbing", "is-canvas-pen-grab");
      hand?.remove();
      hand = null;
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      stop();
      if (stopLiftGesture.current === stop) stopLiftGesture.current = null;
    };
    stopLiftGesture.current = stop;
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  };

  const onLiftPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    const start = liftRef.current;
    const canvas = canvasRef.current;
    if (!start || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const ox = event.clientX;
    const oy = event.clientY;
    const baseDx = start.dx;
    const baseDy = start.dy;
    beginLiftGesture(
      event.pointerId,
      (pointer) => {
        const node = canvasRef.current;
        const box = node?.getBoundingClientRect();
        const scaleX = box && box.width > 0 && node ? node.width / box.width : sx;
        const scaleY = box && box.height > 0 && node ? node.height / box.height : sy;
        patchLift({ dx: baseDx + (pointer.clientX - ox) * scaleX, dy: baseDy + (pointer.clientY - oy) * scaleY });
      },
      { pointerType: event.pointerType, x: event.clientX, y: event.clientY },
    );
  };

  const onRotateDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = liftRef.current;
    const hold = holdRef.current;
    if (!start || !hold) return;
    const box = selectionBounds(hold.selection);
    const centerX = box.cx + start.dx;
    const centerY = box.cy + start.dy;
    const down = clientToBitmap(event.clientX, event.clientY);
    if (!down) return;
    const startAngle = pointerAngle(centerX, centerY, down.x, down.y);
    const startRotation = start.rotation;
    beginLiftGesture(
      event.pointerId,
      (pointer) => {
        const now = clientToBitmap(pointer.clientX, pointer.clientY);
        if (!now) return;
        patchLift({ rotation: rotatedDegrees(startRotation, startAngle, pointerAngle(centerX, centerY, now.x, now.y)) });
      },
      { pointerType: event.pointerType, x: event.clientX, y: event.clientY },
    );
  };

  const onScaleDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = liftRef.current;
    const hold = holdRef.current;
    if (!start || !hold) return;
    const box = selectionBounds(hold.selection);
    const centerX = box.cx + start.dx;
    const centerY = box.cy + start.dy;
    const down = clientToBitmap(event.clientX, event.clientY);
    if (!down) return;
    const startDist = Math.max(1, pointerDistance(centerX, centerY, down.x, down.y));
    const startScale = start.scale;
    beginLiftGesture(event.pointerId, (pointer) => {
      const now = clientToBitmap(pointer.clientX, pointer.clientY);
      if (!now) return;
      const dist = pointerDistance(centerX, centerY, now.x, now.y);
      patchLift({ scale: Math.min(12, Math.max(0.05, startScale * (dist / startDist))) });
    });
  };

  const readRect = (canvas: HTMLCanvasElement) => {
    const cached = rectRef.current;
    const age = performance.now() - rectAt.current;
    if (cached && cached.width > 0 && rectAt.current > 0 && age < 48) return cached;
    const rect = canvas.getBoundingClientRect();
    rectRef.current = rect;
    rectAt.current = performance.now();
    return rect;
  };

  const takeBefore = (canvas: HTMLCanvasElement) => {
    const ready = mirrorFresh.current ? mirror.current : null;
    const snap = ready && ready.width === canvas.width && ready.height === canvas.height ? ready : cloneCanvas(canvas);
    beforeSnap.current = snap;
    mirror.current = snap;
    mirrorFresh.current = false;
    beforeSelection.current = cloneSelection(selectionRef.current);
    clipStroke.current = Boolean(selectionRef.current) && (tool === "pen" || tool === "erase");
    strokeHit.current = false;
    if (clipStroke.current) {
      const scratch = ensureScratch(canvas);
      scratch.getContext("2d")?.clearRect(0, 0, scratch.width, scratch.height);
      const float = floatViewRef.current;
      if (float) float.getContext("2d")?.clearRect(0, 0, float.width, float.height);
    }
  };

  const extendStroke = (samples: { x: number; y: number }[], dotStart: boolean) => {
    if (samples.length === 0) return;
    const anchor = stroke.current;
    const drawn = applySteadyPath(anchor, samples, steady);
    const first = drawn[0];
    if (!first) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const clipped = clipStroke.current;
    const ctx = clipped ? ensureScratch(canvas).getContext("2d") : drawingContext(canvas);
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 1;
    if (!clipped && tool === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = clipped && tool === "erase" ? "#ffffff" : color;
      ctx.fillStyle = clipped && tool === "erase" ? "#ffffff" : color;
    }
    const origin = anchor ?? first;
    let previous = origin;
    let movedAny = false;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    for (let index = anchor ? 0 : 1; index < drawn.length; index += 1) {
      const next = drawn[index];
      if (!next || (next.x === previous.x && next.y === previous.y)) continue;
      ctx.lineTo(next.x, next.y);
      previous = next;
      movedAny = true;
    }
    if (movedAny) ctx.stroke();
    if (dotStart && !anchor) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (!clipped && (movedAny || (dotStart && !anchor))) painted.current = true;
    if (movedAny) moved.current = true;
    stroke.current = drawn[drawn.length - 1] ?? first;
    if (clipped) restampClipped(canvas);
  };

  const inputRef = useRef({
    down: (_event: PointerEvent) => undefined,
    move: (_event: PointerEvent) => undefined,
    up: (_event: PointerEvent) => undefined,
    cancel: (_event: PointerEvent) => undefined,
    wake: () => undefined,
  });
  inputRef.current.wake = () => {
    if (!cold.current || document.hidden) return;
    if (stroke.current || activePointer.current !== null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = drawingContext(canvas);
    if (!ctx || canvas.width < 1 || canvas.height < 1) return;
    const hold = holdRef.current;
    if (hold && liftRef.current) {
      paintSnapshot(canvas, hold.pixels);
      clipCanvasToSelection(canvas, hold.selection, "remove");
    } else {
      const source = mirrorFresh.current ? mirror.current : null;
      if (source && source.width === canvas.width && source.height === canvas.height) paintSnapshot(canvas, source);
      else primeContext(ctx);
    }
    cold.current = false;
    rectRef.current = canvas.getBoundingClientRect();
    rectAt.current = performance.now();
  };
  inputRef.current.down = (event) => {
    if (!live || !armed || canvasBridge?.imageActive) return;
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (liftRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (tool === "rect" || tool === "lasso") {
      if (cold.current) inputRef.current.wake();
      const rect = readRect(canvas);
      if (rect.width < 1 || rect.height < 1) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* the pointer can already be gone */
      }
      const raw = canvasPoint(event.clientX, event.clientY, canvas, rect);
      activePointer.current = event.pointerId;
      const existing = selectionRef.current;
      if (existing && pointInSelection(existing, raw.x, raw.y)) {
        const origin = cloneSelection(existing);
        if (!origin) return;
        selectGesture.current = { kind: "slide", pointerId: event.pointerId, origin, clientX: event.clientX, clientY: event.clientY, moved: false };
        return;
      }
      selectGesture.current = {
        kind: "create",
        pointerId: event.pointerId,
        tool,
        clientX: event.clientX,
        clientY: event.clientY,
        x0: raw.x,
        y0: raw.y,
        points: [{ x: raw.x, y: raw.y }],
        origin: existing ? cloneSelection(existing) : null,
        moved: false,
      };
      return;
    }
    if (cold.current) inputRef.current.wake();
    const rect = readRect(canvas);
    if (rect.width < 1 || rect.height < 1) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* the pointer can already be gone */
    }
    const samples = eventPoints(event, canvas, rect);
    const raw = samples[0];
    if (!raw) return;
    if (canvasBridge?.claimImage(raw.x, raw.y)) {
      imageHold.current = { raw, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
      activePointer.current = event.pointerId;
      return;
    }
    activePointer.current = event.pointerId;
    moved.current = false;
    stroke.current = null;
    takeBefore(canvas);
    extendStroke(samples, true);
  };
  inputRef.current.move = (event) => {
    if (!live) return;
    const gesture = selectGesture.current;
    if (gesture && gesture.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = readRect(canvas);
      if (rect.width < 1 || rect.height < 1) return;
      const dx = event.clientX - gesture.clientX;
      const dy = event.clientY - gesture.clientY;
      const passed = gesture.moved || dx * dx + dy * dy >= 16;
      if (gesture.kind === "create" && gesture.tool === "lasso") {
        for (const point of eventPoints(event, canvas, rect)) {
          const last = gesture.points[gesture.points.length - 1];
          if (last && last.x === point.x && last.y === point.y) continue;
          gesture.points.push(point);
        }
      }
      if (!passed) return;
      if (!gesture.moved && gesture.kind === "create" && gesture.origin) {
        selectionRef.current = null;
        setSelection(null);
      }
      gesture.moved = true;
      if (gesture.kind === "slide") {
        const movedSel = moveSelection(gesture.origin, dx * (canvas.width / rect.width), dy * (canvas.height / rect.height));
        selectionRef.current = movedSel;
        setSelection(movedSel);
        canvas.style.cursor = "move";
        return;
      }
      if (gesture.tool === "rect") {
        const point = canvasPoint(event.clientX, event.clientY, canvas, rect);
        const preview = {
          kind: "rect" as const,
          x: Math.min(gesture.x0, point.x),
          y: Math.min(gesture.y0, point.y),
          w: Math.abs(point.x - gesture.x0),
          h: Math.abs(point.y - gesture.y0),
        };
        setDraftShape(preview.w > 0 || preview.h > 0 ? preview : null);
      } else if (gesture.points.length >= 2) setDraftShape({ kind: "lasso", points: gesture.points.map((point) => ({ x: point.x, y: point.y })) });
      canvas.style.cursor = "crosshair";
      return;
    }
    if ((tool === "rect" || tool === "lasso") && !liftRef.current) {
      const canvas = canvasRef.current;
      const sel = selectionRef.current;
      if (canvas) {
        if (!sel) canvas.style.cursor = "crosshair";
        else {
          const rect = readRect(canvas);
          if (rect.width > 0) {
            const point = canvasPoint(event.clientX, event.clientY, canvas, rect);
            canvas.style.cursor = pointInSelection(sel, point.x, point.y) ? "move" : "crosshair";
          }
        }
      }
    }
    const hold = imageHold.current;
    if (hold && hold.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const dx = event.clientX - hold.clientX;
      const dy = event.clientY - hold.clientY;
      if (dx * dx + dy * dy < 36) return;
      imageHold.current = null;
      handed.current = true;
      activePointer.current = null;
      canvasBridge?.onImageDrag(hold.raw.x, hold.raw.y, hold.clientX, hold.clientY, event.clientX, event.clientY, event.pointerId);
      return;
    }
    if (!stroke.current || activePointer.current !== event.pointerId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = readRect(canvas);
    if (rect.width < 1 || rect.height < 1) return;
    event.preventDefault();
    event.stopPropagation();
    extendStroke(eventPoints(event, canvas, rect), false);
  };
  inputRef.current.up = (event) => {
    if (!live) return;
    const gesture = selectGesture.current;
    if (gesture && gesture.pointerId === event.pointerId) {
      selectGesture.current = null;
      activePointer.current = null;
      event.preventDefault();
      event.stopPropagation();
      const canvas = canvasRef.current;
      if (gesture.kind === "slide") {
        if (gesture.moved) noteSelectionStep(gesture.origin, selectionRef.current);
        return;
      }
      let next: InkSelection | null = null;
      if (gesture.moved && canvas) {
        const rect = readRect(canvas);
        if (rect.width > 0) {
          const point = canvasPoint(event.clientX, event.clientY, canvas, rect);
          if (gesture.tool === "rect") next = rectSelection(gesture.x0, gesture.y0, point.x, point.y);
          else {
            const last = gesture.points[gesture.points.length - 1];
            if (!last || last.x !== point.x || last.y !== point.y) gesture.points.push(point);
            next = lassoSelection(gesture.points);
          }
        }
      }
      setDraftShape(null);
      if (!gesture.moved) {
        if (gesture.origin) noteSelectionStep(gesture.origin, null);
        return;
      }
      if (gesture.origin) {
        if (next) noteReplace(gesture.origin, next);
        else noteSelectionStep(gesture.origin, null);
        return;
      }
      if (next) noteSelectionStep(null, next);
      return;
    }
    if (handed.current) {
      handed.current = false;
      activePointer.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const hold = imageHold.current;
    if (hold && hold.pointerId === event.pointerId) {
      imageHold.current = null;
      activePointer.current = null;
      event.preventDefault();
      event.stopPropagation();
      const canvas = canvasRef.current;
      if (!canvas) return;
      takeBefore(canvas);
      moved.current = false;
      stroke.current = hold.raw;
      strokeBetween(hold.raw, hold.raw, true);
      finishStroke(true);
      return;
    }
    if (activePointer.current !== event.pointerId) return;
    const had = stroke.current;
    activePointer.current = null;
    if (!had) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = readRect(canvas);
      if (rect.width >= 1 && rect.height >= 1) extendStroke(eventPoints(event, canvas, rect), false);
    }
    const drawDot = !moved.current;
    if (drawDot) strokeBetween(had, had, true);
    finishStroke(moved.current || drawDot);
  };
  inputRef.current.cancel = () => {
    const gesture = selectGesture.current;
    if (gesture) {
      selectGesture.current = null;
      activePointer.current = null;
      setDraftShape(null);
      selectionRef.current = gesture.kind === "slide" ? gesture.origin : gesture.origin;
      setSelection(gesture.origin);
      return;
    }
    imageHold.current = null;
    activePointer.current = null;
    if (handed.current) {
      handed.current = false;
      return;
    }
    const record = Boolean(stroke.current && moved.current);
    if (stroke.current) finishStroke(record);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const down = (event: PointerEvent) => inputRef.current.down(event);
    const move = (event: PointerEvent) => inputRef.current.move(event);
    const up = (event: PointerEvent) => inputRef.current.up(event);
    const cancel = (event: PointerEvent) => inputRef.current.cancel(event);
    const flushRect = () => {
      const node = canvasRef.current;
      if (!node || stroke.current || activePointer.current !== null) return;
      rectRef.current = node.getBoundingClientRect();
      rectAt.current = performance.now();
    };
    let flushFrame = 0;
    const scheduleFlush = () => {
      if (flushFrame) return;
      flushFrame = requestAnimationFrame(() => {
        flushFrame = 0;
        flushRect();
      });
    };
    const enter = () => {
      if (cold.current) inputRef.current.wake();
      flushRect();
    };
    const lost = (event: PointerEvent) => {
      const id = event.pointerId;
      queueMicrotask(() => {
        if (activePointer.current === id) inputRef.current.cancel(event);
      });
    };
    const wake = () => {
      if (document.hidden) {
        cold.current = true;
        return;
      }
      inputRef.current.wake();
      requestAnimationFrame(() => {
        if (document.hidden) return;
        inputRef.current.wake();
      });
    };
    const markCold = () => {
      cold.current = true;
    };
    const markRectStale = () => {
      rectAt.current = 0;
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      cold.current = true;
    };
    const onContextRestored = () => {
      cold.current = true;
      inputRef.current.wake();
    };
    const listen: AddEventListenerOptions = { passive: false };
    const releaseHeld = (event: PointerEvent) => {
      const node = canvasRef.current;
      if (!node?.hasPointerCapture(event.pointerId)) return;
      try {
        node.releasePointerCapture(event.pointerId);
      } catch {
        /* pointerup already dropped it */
      }
    };
    // A stuck sheet capture retargets the next pen contact away from the gallery.
    // Hand that contact back only when it actually lands on a thumbnail.
    const unstick = (event: PointerEvent) => {
      const node = canvasRef.current;
      if (!node?.hasPointerCapture(event.pointerId)) return;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const card = under?.closest(".shot-card");
      if (!card || node === under || node.contains(under)) return;
      inputRef.current.cancel(event);
      try {
        node.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      event.stopPropagation();
      card.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          clientX: event.clientX,
          clientY: event.clientY,
          button: event.button,
          buttons: event.buttons,
          isPrimary: event.isPrimary,
        }),
      );
    };
    canvas.addEventListener("pointerdown", down, listen);
    canvas.addEventListener("pointermove", move, listen);
    canvas.addEventListener("pointerup", up, listen);
    canvas.addEventListener("pointercancel", cancel, listen);
    canvas.addEventListener("pointerenter", enter);
    canvas.addEventListener("lostpointercapture", lost);
    canvas.addEventListener("contextlost", onContextLost);
    canvas.addEventListener("contextrestored", onContextRestored);
    document.addEventListener("visibilitychange", wake);
    document.addEventListener("pointerup", scheduleFlush, true);
    document.addEventListener("pointercancel", scheduleFlush, true);
    window.addEventListener("pointerdown", unstick, true);
    window.addEventListener("pointerup", releaseHeld);
    window.addEventListener("pointercancel", releaseHeld);
    window.addEventListener("focus", wake);
    window.addEventListener("blur", markCold);
    window.addEventListener("resize", markRectStale);
    window.addEventListener("scroll", markRectStale, true);
    window.addEventListener("wheel", markRectStale, { capture: true, passive: true });
    wake();
    return () => {
      if (flushFrame) cancelAnimationFrame(flushFrame);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("pointerenter", enter);
      canvas.removeEventListener("lostpointercapture", lost);
      canvas.removeEventListener("contextlost", onContextLost);
      canvas.removeEventListener("contextrestored", onContextRestored);
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("pointerup", scheduleFlush, true);
      document.removeEventListener("pointercancel", scheduleFlush, true);
      window.removeEventListener("pointerdown", unstick, true);
      window.removeEventListener("pointerup", releaseHeld);
      window.removeEventListener("pointercancel", releaseHeld);
      window.removeEventListener("focus", wake);
      window.removeEventListener("blur", markCold);
      window.removeEventListener("resize", markRectStale);
      window.removeEventListener("scroll", markRectStale, true);
      window.removeEventListener("wheel", markRectStale, { capture: true });
    };
  }, []);

  const lifting = lift !== null;
  const selectChrome = Boolean(live && !canvasBridge?.imageActive && (selection || draftShape || lift));
  useEffect(() => () => endLiftGesture(), []);
  useLayoutEffect(() => {
    if (!selectChrome) return;
    let frame = 0;
    const measure = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width < 1) return;
      const rect = canvas.getBoundingClientRect();
      const nextRatio = canvas.clientWidth / canvas.width;
      const nextUi = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
      setLayoutRatio((prev) => (Math.abs(prev - nextRatio) < 0.0001 ? prev : nextRatio));
      setUiScale((prev) => (Math.abs(prev - nextUi) < 0.0001 ? prev : nextUi));
    };
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      });
    };
    measure();
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("wheel", refresh, { capture: true, passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("wheel", refresh, { capture: true });
    };
  }, [selectChrome]);
  const liftGenNow = lift?.gen ?? 0;
  useLayoutEffect(() => {
    const float = floatViewRef.current;
    const canvas = canvasRef.current;
    if (!float || !canvas) return;
    const paint = (source: HTMLCanvasElement) => {
      if (float.width !== source.width || float.height !== source.height) {
        float.width = source.width;
        float.height = source.height;
      }
      const ctx = float.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, float.width, float.height);
      ctx.drawImage(source, 0, 0);
    };
    if (liftRef.current && extractedRef.current) {
      paint(extractedRef.current);
      return;
    }
    const sel = selectionRef.current;
    if (!sel || draftShape) {
      float.getContext("2d")?.clearRect(0, 0, float.width, float.height);
      return;
    }
    paint(extractSelection(canvas, sel));
  }, [liftGenNow, selection, histTick, draftShape, previewTick]);

  const outline = draftShape ?? (lift ? null : selection);
  const bounds = selection ? selectionBounds(selection) : null;
  const popupBox = selection && lift ? transformedBounds(selection, lift) : bounds;
  const antStroke = 1.5 * uiScale;
  const hostStyle: CSSProperties = { ...style, pointerEvents: "none", zIndex: 5 };

  return (
    <>
      <canvas
        ref={canvasRef}
        className={["ink-layer", live ? "is-live" : "", shown || live ? "" : "is-off", brushLive ? "is-brush" : "", selectTool && live && !canvasBridge?.imageActive ? "is-select" : ""].filter(Boolean).join(" ")}
        style={style}
        aria-hidden={!live}
      />
      {selectChrome ? (
        <div className="ink-select-host" style={hostStyle}>
          {lift && bounds ? (
            <canvas
              ref={floatViewRef}
              className="ink-float"
              style={{
                transformOrigin: `${bounds.cx * layoutRatio}px ${bounds.cy * layoutRatio}px`,
                transform: `translate(${lift.dx * layoutRatio}px, ${lift.dy * layoutRatio}px) rotate(${lift.rotation}deg) scale(${lift.scale})`,
              }}
            />
          ) : selection && !draftShape ? (
            <canvas ref={floatViewRef} className="ink-float" />
          ) : null}
          {outline ? (
            <svg className="ink-ants" viewBox={`0 0 ${Math.max(1, pixelWidth)} ${Math.max(1, pixelHeight)}`} preserveAspectRatio="none">
              {shapeNode(outline, "ink-ant-fill", 0)}
              {shapeNode(outline, "ink-ant ink-ant-dark", antStroke)}
              {shapeNode(outline, "ink-ant ink-ant-light", antStroke)}
            </svg>
          ) : null}
          {lift && bounds ? (
            <div
              className="ink-lift-frame"
              style={{
                left: bounds.x * layoutRatio,
                top: bounds.y * layoutRatio,
                width: Math.max(1, bounds.w * layoutRatio),
                height: Math.max(1, bounds.h * layoutRatio),
                outline: `${(1.5 * uiScale) / Math.max(0.05, lift.scale)}px dashed #ffe14a`,
                outlineOffset: `${(3 * uiScale) / Math.max(0.05, lift.scale)}px`,
                transformOrigin: "center center",
                transform: `translate(${lift.dx * layoutRatio}px, ${lift.dy * layoutRatio}px) rotate(${lift.rotation}deg) scale(${lift.scale})`,
              }}
              onPointerDown={onLiftPointerDown}
            >
              <button type="button" className="canvas-handle is-rotate" aria-label="回転" style={{ transform: `scale(${uiScale / Math.max(0.05, lift.scale)})` }} onPointerDown={onRotateDown}>
                <RotateGlyph />
              </button>
              <button type="button" className="canvas-handle is-scale" aria-label="拡大縮小" style={{ transform: `scale(${uiScale / Math.max(0.05, lift.scale)})` }} onPointerDown={onScaleDown}>
                <ScaleGlyph />
              </button>
            </div>
          ) : null}
          {selection && !draftShape && popupBox ? (
            <div
              className="ink-select-pop"
              style={{
                left: popupBox.cx * layoutRatio,
                top: (popupBox.y + popupBox.h) * layoutRatio,
                transform: `translate(-50%, ${8 * uiScale}px) scale(${uiScale})`,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {lift ? (
                <>
                  <button type="button" className="is-commit" onClick={confirmLift}>
                    確定
                  </button>
                  <button type="button" onClick={cancelLift}>
                    キャンセル
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="is-commit" onClick={beginLift}>
                    移動
                  </button>
                  <button type="button" onClick={dismissSelection}>
                    キャンセル
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {brushLive && typeof document !== "undefined"
        ? createPortal(<div ref={cursorRef} className={tool === "erase" ? "ink-brush-cursor is-erase" : "ink-brush-cursor"} aria-hidden="true" />, document.body)
        : null}
      {live && armed && toolsRoot
        ? createPortal(
            <div className="ink-tools" role="toolbar" aria-label="ペン書き込み">
              <div className="ink-widths" role="group" aria-label="描画ツール">
                {canvasBridge ? (
                  <button
                    type="button"
                    className={canvasBridge.imageActive ? "is-on" : undefined}
                    aria-pressed={canvasBridge.imageActive}
                    onClick={() => {
                      if (holdRef.current || liftRef.current) cancelLift();
                      canvasBridge.onImageTool();
                    }}
                  >
                    画像編集
                  </button>
                ) : null}
                <button type="button" className={!canvasBridge?.imageActive && tool === "pen" ? "is-on" : undefined} aria-pressed={!canvasBridge?.imageActive && tool === "pen"} onClick={() => chooseDraw("pen")}>
                  ペン
                </button>
                <button type="button" className={!canvasBridge?.imageActive && tool === "erase" ? "is-on" : undefined} aria-pressed={!canvasBridge?.imageActive && tool === "erase"} onClick={() => chooseDraw("erase")}>
                  消しゴム
                </button>
                <button type="button" className={!canvasBridge?.imageActive && tool === "rect" ? "is-on" : undefined} aria-pressed={!canvasBridge?.imageActive && tool === "rect"} onClick={() => chooseDraw("rect")}>
                  範囲選択
                </button>
                <button type="button" className={!canvasBridge?.imageActive && tool === "lasso" ? "is-on" : undefined} aria-pressed={!canvasBridge?.imageActive && tool === "lasso"} onClick={() => chooseDraw("lasso")}>
                  投げ縄
                </button>
              </div>
              <div className="ink-widths" role="group" aria-label="ペンの太さ">
                {INK_WIDTHS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={widthId === entry.id ? "is-on" : undefined}
                    aria-pressed={widthId === entry.id}
                    onClick={() => setWidthId(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <div className="ink-palette-wrap" ref={paletteRef}>
                <button
                  type="button"
                  className="ink-color"
                  aria-label="ペンの色"
                  aria-expanded={palette}
                  style={{ background: color }}
                  onClick={() => setPalette((open) => !open)}
                />
                {palette ? (
                  <div className="ink-palette" role="listbox" aria-label="16色">
                    {INK_COLORS.map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        role="option"
                        aria-selected={entry === color}
                        className={entry === color ? "is-on" : undefined}
                        style={{ background: entry }}
                        onClick={() => {
                          setColor(entry);
                          chooseDraw("pen");
                          setPalette(false);
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
              <button type="button" onClick={clearAll} disabled={lifting}>
                全消去
              </button>
              <button type="button" onClick={undo} disabled={lifting || (canvasBridge?.history ? canvasBridge.history.blocked || !canvasBridge.history.canUndo : history.undo.length === 0)}>
                アンドゥ
              </button>
              <button type="button" onClick={redo} disabled={lifting || (canvasBridge?.history ? canvasBridge.history.blocked || !canvasBridge.history.canRedo : history.redo.length === 0)}>
                リドゥ
              </button>
              <div className="ink-steady">
                <span className="ink-steady-label">手ぶれ</span>
                <div className="ink-widths" role="group" aria-label="手ぶれ補正">
                  {(
                    [
                      ["off", "無"],
                      ["low", "弱"],
                      ["mid", "中"],
                      ["high", "強"],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} type="button" className={steady === id ? "is-on" : undefined} aria-pressed={steady === id} onClick={() => setSteady(id)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>,
            toolsRoot,
          )
        : null}
    </>
  );
}
