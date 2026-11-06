import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { forgetPersistedInk, ImageInk, type CanvasInkApi } from "@/components/portfolio/ink-layer";
import {
  CANVAS_BOARD_ID,
  CANVAS_FLAT_PREFIX,
  CANVAS_ORIENTATION_KEY,
  CANVAS_PLACEMENTS_KEY,
  canvasFlatId,
  canvasSize,
  clampCenter,
  containedCenter,
  fittedPlacementSize,
  parseOrientation,
  parsePlacements,
  placeOpacityPanel,
  placementAlpha,
  placementBounds,
  placementHeight,
  placementOpacity,
  pointerAngle,
  pointerDistance,
  raisePlacement,
  rotatedDegrees,
  handleScreenBox,
  outsideVeilClip,
  screenDeltaToFrame,
  settleEditChrome,
  scaledWidth,
  zoomAtCursor,
  nextCanvasZoom,
  type CanvasOrientation,
  type CanvasPlacement,
} from "@/lib/portfolio/canvas";
import {
  clearBoardHistory,
  clonePlacementSnaps,
  emptyBoardHistory,
  flatPlacementIds,
  noteBoardStep,
  redoBoardStep,
  scrubPlacementImages,
  undoBoardStep,
  type PlacementSnap,
} from "@/lib/portfolio/canvas-history";
import { deleteInk, listPrefixedInkIds, readInk, readKvString, readPixels, saveInk, writeKv } from "@/lib/portfolio/db";
import { resetInkSession, type InkSnap } from "@/lib/portfolio/ink";
import { notify } from "@/lib/portfolio/store";
import type { ImageMeta } from "@/lib/portfolio/types";

type Draft = {
  placement: CanvasPlacement;
  snapshot: CanvasPlacement | null;
  fresh: boolean;
};

function fittedSheet(width: number, height: number, sheetW: number, sheetH: number): { width: number; height: number } {
  const pad = 42;
  const availW = Math.max(0, width - pad * 2);
  const availH = Math.max(0, height - pad * 2);
  if (availW < 8 || availH < 8) return { width: 0, height: 0 };
  const ratio = sheetW / sheetH;
  let nextW = availW;
  let nextH = nextW / ratio;
  if (nextH > availH) {
    nextH = availH;
    nextW = nextH * ratio;
  }
  return { width: Math.max(1, Math.floor(nextW)), height: Math.max(1, Math.floor(nextH)) };
}

function clientToCanvas(clientX: number, clientY: number, world: HTMLElement, sheetW: number, sheetH: number): { x: number; y: number } {
  const rect = world.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
  return {
    x: ((clientX - rect.left) / rect.width) * sheetW,
    y: ((clientY - rect.top) / rect.height) * sheetH,
  };
}

function nextZ(list: CanvasPlacement[]): number {
  return list.reduce((max, placement) => Math.max(max, placement.z), 0) + 1;
}

const boardHistory = emptyBoardHistory<InkSnap>();

function liveFlatIds(placements: CanvasPlacement[], draft: Draft | null, baking: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const item of placements) if (item.flat) ids.add(item.id);
  if (draft?.placement.flat) ids.add(draft.placement.id);
  for (const id of baking) ids.add(id);
  for (const step of [...boardHistory.undo, ...boardHistory.redo]) {
    if (step.kind !== "placements") continue;
    for (const item of step.before) if (item.flat) ids.add(item.id);
  }
  return ids;
}

function dropUnreferencedFlats(ids: Iterable<string>, keep: Set<string>) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id) || keep.has(id)) continue;
    seen.add(id);
    void deleteInk(canvasFlatId(id)).catch(() => undefined);
  }
}

/** Bakes the memo that is showing onto a copy. The source file and its ink stay untouched. */
async function compositeWithInk(original: Blob, ink: Blob, width: number, height: number): Promise<Blob | null> {
  const base = await createImageBitmap(original);
  const overlay = await createImageBitmap(ink);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width) || base.width);
    canvas.height = Math.max(1, Math.round(height) || base.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((next) => resolve(next), "image/png"));
    return blob && blob.size > 0 ? blob : null;
  } finally {
    base.close();
    overlay.close();
  }
}

let placementTail = Promise.resolve();

function savePlacements(list: CanvasPlacement[]): Promise<void> {
  const json = JSON.stringify(list);
  placementTail = placementTail.catch(() => undefined).then(() => writeKv(CANVAS_PLACEMENTS_KEY, json));
  return placementTail;
}

function canvasPngName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `キャンバス-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}

function inkHasMarks(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 1 || canvas.height < 1) return false;
  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

type DirectoryPicker = (options?: { mode?: "read" | "readwrite" }) => Promise<{
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
}>;

function directoryPicker(): DirectoryPicker | null {
  const host = window as Window & { showDirectoryPicker?: DirectoryPicker };
  return typeof host.showDirectoryPicker === "function" ? host.showDirectoryPicker.bind(window) : null;
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.size > 0 ? blob : null), "image/png"));
}

function ScaleIcon() {
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

function RotateIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 4.64a3.36 3.36 0 1 1-2.59 1.19" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
      <path d="M4.78 4.08v1.96h1.96" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const GRAB_HAND =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' aria-hidden='true'><path fill='#fff' stroke='#fff' stroke-width='28' stroke-linejoin='round' d='M216,104v48a88,88,0,0,1-176,0V136a16,16,0,0,1,32,0v8a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0,16,16,0,0,1,32,0Z'/><path fill='#fff' stroke='#1c1408' stroke-width='12' stroke-linejoin='round' d='M216,104v48a88,88,0,0,1-176,0V136a16,16,0,0,1,32,0v8a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0,16,16,0,0,1,32,0Z'/></svg>";

export function CanvasBoard({ images, libraryEpoch, ready }: { images: ImageMeta[]; libraryEpoch: number; ready: boolean }) {
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [world, setWorld] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [placements, setPlacements] = useState<CanvasPlacement[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [imageTool, setImageTool] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [orientReady, setOrientReady] = useState(false);
  const [orientation, setOrientation] = useState<CanvasOrientation>("portrait");
  const [flipAsk, setFlipAsk] = useState(false);
  const [gesturing, setGesturing] = useState(false);
  const [chromeShift, setChromeShift] = useState({ rotate: { x: 0, y: 0 }, scale: { x: 0, y: 0 }, actions: { x: 0, y: 0 } });
  const actionsRowRef = useRef<HTMLDivElement | null>(null);
  const opacityPopRef = useRef<HTMLDivElement | null>(null);
  const opacityToggleRef = useRef<HTMLButtonElement | null>(null);
  const opacityOpenRef = useRef(false);
  const opacityDirtyRef = useRef(false);
  const opacityBaseRef = useRef(100);
  const opacitySlidingRef = useRef(false);
  const chromeBoxesRef = useRef<{ x: number; y: number; w: number; h: number }[]>([]);
  const [opacityOpen, setOpacityOpen] = useState(false);
  const [opacityPos, setOpacityPos] = useState<{ x: number; y: number } | null>(null);
  const [urls, setUrls] = useState<Record<string, { url: string; flat: boolean }>>({});
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const [baking, setBaking] = useState<Record<string, true>>({});
  const [lens, setLens] = useState({ zoom: 1, x: 0, y: 0 });
  const [histTick, setHistTick] = useState(0);
  const placementsRef = useRef(placements);
  const draftRef = useRef(draft);
  const imagesRef = useRef(images);
  const loadedRef = useRef(false);
  const imageToolRef = useRef(false);
  const orientationRef = useRef<CanvasOrientation>("portrait");
  const sheetRef = useRef(canvasSize("portrait"));
  const worldRef = useRef<HTMLDivElement | null>(null);
  const flipLock = useRef(false);
  const exportLock = useRef(false);
  const stopGesture = useRef<(() => void) | null>(null);
  const confirmRef = useRef<() => void>(() => undefined);
  const lensRef = useRef(lens);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const bakingIds = useRef(new Set<string>());
  const epochRef = useRef(libraryEpoch);
  const inkApi = useRef<CanvasInkApi | null>(null);
  const bindInk = useCallback((api: CanvasInkApi | null) => {
    inkApi.current = api;
  }, []);
  placementsRef.current = placements;
  draftRef.current = draft;
  imagesRef.current = images;
  imageToolRef.current = imageTool;
  orientationRef.current = orientation;
  sheetRef.current = canvasSize(orientation);
  worldRef.current = world;
  lensRef.current = lens;
  epochRef.current = libraryEpoch;

  const heightOf = (placement: CanvasPlacement) => {
    const image = imagesRef.current.find((item) => item.id === placement.imageId);
    return placementHeight(placement.width, image?.width ?? 0, image?.height ?? 0);
  };

  const patchDraft = (id: string, partial: Partial<CanvasPlacement>) => {
    setDraft((current) => {
      if (!current || current.placement.id !== id) return current;
      const placement: CanvasPlacement = { ...current.placement, ...partial };
      if ("opacity" in partial) {
        const pct = placementOpacity(partial.opacity);
        if (pct >= 100) delete placement.opacity;
        else placement.opacity = pct;
      }
      const next = { ...current, placement };
      draftRef.current = next;
      return next;
    });
  };

  const closeOpacityUi = () => {
    opacityDirtyRef.current = false;
    opacitySlidingRef.current = false;
    opacityOpenRef.current = false;
    setOpacityOpen(false);
    setOpacityPos(null);
  };

  const openOpacity = () => {
    const current = draftRef.current?.placement;
    if (!current) return;
    opacityBaseRef.current = placementOpacity(current.opacity);
    opacityDirtyRef.current = false;
    opacitySlidingRef.current = false;
    opacityOpenRef.current = true;
    setOpacityPos(null);
    setOpacityOpen(true);
  };

  const cancelOpacity = () => {
    const id = draftRef.current?.placement.id;
    if (id) patchDraft(id, { opacity: opacityBaseRef.current });
    closeOpacityUi();
  };

  const confirmDraft = () => {
    stopGesture.current?.();
    setGesturing(false);
    closeOpacityUi();
    const current = draftRef.current;
    if (!current || !loadedRef.current) return;
    const before = placementsRef.current;
    const next = raisePlacement(before, current.placement, current.fresh);
    const dropped = noteBoardStep(boardHistory, { kind: "placements", before: clonePlacementSnaps(before) });
    placementsRef.current = next;
    draftRef.current = null;
    dropUnreferencedFlats(flatPlacementIds(dropped), liveFlatIds(next, null, bakingIds.current));
    setPlacements(next);
    setDraft(null);
    setHistTick((tick) => tick + 1);
    void savePlacements(next);
  };
  confirmRef.current = confirmDraft;

  const cancelDraft = () => {
    stopGesture.current?.();
    setGesturing(false);
    closeOpacityUi();
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (current?.fresh) dropUnreferencedFlats([current.placement.id], liveFlatIds(placementsRef.current, null, bakingIds.current));
    setHistTick((tick) => tick + 1);
  };

  const deleteDraft = () => {
    stopGesture.current?.();
    setGesturing(false);
    closeOpacityUi();
    const current = draftRef.current;
    if (!current || !loadedRef.current) return;
    const before = placementsRef.current;
    const existed = before.some((placement) => placement.id === current.placement.id);
    draftRef.current = null;
    if (existed) {
      const next = before.filter((placement) => placement.id !== current.placement.id);
      const dropped = noteBoardStep(boardHistory, { kind: "placements", before: clonePlacementSnaps(before) });
      placementsRef.current = next;
      dropUnreferencedFlats(flatPlacementIds(dropped), liveFlatIds(next, null, bakingIds.current));
      setPlacements(next);
      void savePlacements(next);
    } else {
      dropUnreferencedFlats([current.placement.id], liveFlatIds(before, null, bakingIds.current));
    }
    setDraft(null);
    setHistTick((tick) => tick + 1);
  };

  const applyFlat = (id: string) => {
    const draftNow = draftRef.current;
    if (draftNow?.placement.id === id && !draftNow.placement.flat) {
      const next = { ...draftNow, placement: { ...draftNow.placement, flat: true } };
      draftRef.current = next;
      setDraft(next);
    }
    if (placementsRef.current.some((item) => item.id === id && !item.flat)) {
      const next = placementsRef.current.map((item) => (item.id === id ? { ...item, flat: true } : item));
      placementsRef.current = next;
      setPlacements(next);
      void savePlacements(next);
    }
  };

  const ensureEditing = (id: string): Draft | null => {
    const current = draftRef.current;
    if (current?.placement.id === id) return current;
    if (current && loadedRef.current) confirmDraft();
    const placement = placementsRef.current.find((item) => item.id === id);
    if (!placement) return null;
    const next = { placement: { ...placement }, snapshot: { ...placement }, fresh: false };
    draftRef.current = next;
    setDraft(next);
    return next;
  };

  const beginGesture = (pointerId: number, move: (event: PointerEvent) => void, cursor?: { pointerType: string; x: number; y: number }) => {
    stopGesture.current?.();
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
      } else {
        root.classList.add("is-canvas-grabbing");
      }
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      placeHand(event.clientX, event.clientY);
      move(event);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      stop();
      if (stopGesture.current === stop) stopGesture.current = null;
      setGesturing(false);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      root.classList.remove("is-canvas-grabbing", "is-canvas-pen-grab");
      hand?.remove();
      hand = null;
    };
    stopGesture.current = stop;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    setGesturing(true);
  };

  const pointOf = (clientX: number, clientY: number) => {
    const node = worldRef.current;
    if (!node) return { x: 0, y: 0 };
    const { width, height } = sheetRef.current;
    return clientToCanvas(clientX, clientY, node, width, height);
  };

  const beginMove = (start: CanvasPlacement, downX: number, downY: number, pointerId: number, atX = downX, atY = downY, pointerType?: string) => {
    const origin = pointOf(downX, downY);
    const apply = (clientX: number, clientY: number) => {
      const now = pointOf(clientX, clientY);
      const { width, height } = sheetRef.current;
      const next = clampCenter(start.x + now.x - origin.x, start.y + now.y - origin.y, width, height);
      patchDraft(start.id, { x: next.x, y: next.y });
    };
    apply(atX, atY);
    beginGesture(pointerId, (event) => apply(event.clientX, event.clientY), pointerType ? { pointerType, x: atX, y: atY } : undefined);
  };

  useEffect(() => {
    if (!stage) return;
    const measure = () => {
      const { width, height } = sheetRef.current;
      const next = fittedSheet(stage.clientWidth, stage.clientHeight, width, height);
      setFrame((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage, orientation]);

  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      const view = viewRef.current;
      if (!view) return;
      event.preventDefault();
      const mode = event.deltaMode;
      const delta = mode === 1 ? event.deltaY * 16 : mode === 2 ? event.deltaY * 800 : event.deltaY;
      const current = lensRef.current;
      const rect = view.getBoundingClientRect();
      const cursorX = event.clientX - (rect.left + rect.width / 2 - current.x);
      const cursorY = event.clientY - (rect.top + rect.height / 2 - current.y);
      const next = zoomAtCursor(current.zoom, current.x, current.y, cursorX, cursorY, nextCanvasZoom(current.zoom, delta));
      lensRef.current = next;
      setLens(next);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stage]);

  useEffect(() => {
    let cancel = false;
    loadedRef.current = false;
    setLoaded(false);
    setDraft(null);
    draftRef.current = null;
    void Promise.all([readKvString(CANVAS_PLACEMENTS_KEY, ""), readKvString(CANVAS_ORIENTATION_KEY, "portrait")]).then(async ([raw, orientRaw]) => {
      if (cancel) return;
      const list = parsePlacements(raw);
      const nextOrientation = parseOrientation(orientRaw);
      orientationRef.current = nextOrientation;
      sheetRef.current = canvasSize(nextOrientation);
      placementsRef.current = list;
      setOrientation(nextOrientation);
      setPlacements(list);
      setOrientReady(true);
      loadedRef.current = true;
      setLoaded(true);
      window.dispatchEvent(new CustomEvent("komacho-canvas-orient", { detail: { orientation: nextOrientation } }));
      try {
        const stored = await listPrefixedInkIds(CANVAS_FLAT_PREFIX);
        if (cancel) return;
        const keep = new Set(list.filter((placement) => placement.flat).map((placement) => canvasFlatId(placement.id)));
        for (const placementId of flatPlacementIds([...boardHistory.undo, ...boardHistory.redo])) keep.add(canvasFlatId(placementId));
        const draftPlacement = draftRef.current?.placement;
        if (draftPlacement?.flat) keep.add(canvasFlatId(draftPlacement.id));
        const draftId = draftPlacement?.id ?? "";
        await Promise.all(
          stored.map((id) => {
            const placementId = id.slice(CANVAS_FLAT_PREFIX.length);
            if (keep.has(id) || bakingIds.current.has(placementId) || placementId === draftId) return Promise.resolve();
            return deleteInk(id).catch(() => undefined);
          }),
        );
      } catch {
        /* an unused composite can wait until the next open */
      }
    });
    return () => {
      cancel = true;
    };
  }, [libraryEpoch]);

  useEffect(() => {
    if (!ready || !loaded) return;
    const known = new Set(images.map((image) => image.id));
    const missing = (imageId: string) => !known.has(imageId);
    const removed = placementsRef.current.filter((placement) => missing(placement.imageId));
    const editing = draftRef.current;
    if (editing && missing(editing.placement.imageId) && !removed.some((placement) => placement.id === editing.placement.id)) {
      removed.push(editing.placement);
    }
    const scrubbed = scrubPlacementImages(boardHistory, missing);
    if (removed.length === 0 && scrubbed.length === 0) return;
    const next = placementsRef.current.filter((placement) => !removed.some((item) => item.id === placement.id));
    placementsRef.current = next;
    setPlacements(next);
    if (editing && removed.some((placement) => placement.id === editing.placement.id)) {
      draftRef.current = null;
      setDraft(null);
    }
    const keep = liveFlatIds(placementsRef.current, draftRef.current, bakingIds.current);
    dropUnreferencedFlats(
      [...removed, ...scrubbed].filter((placement) => placement.flat).map((placement) => placement.id),
      keep,
    );
    if (removed.length > 0) void savePlacements(next);
    if (scrubbed.length > 0) setHistTick((tick) => tick + 1);
  }, [ready, loaded, images]);

  const placedSources = new Map<string, { placementId: string; imageId: string; flat: boolean }>();
  for (const placement of placements) placedSources.set(placement.id, { placementId: placement.id, imageId: placement.imageId, flat: placement.flat === true });
  if (draft) placedSources.set(draft.placement.id, { placementId: draft.placement.id, imageId: draft.placement.imageId, flat: draft.placement.flat === true });
  const sourceList = [...placedSources.values()].sort((a, b) => (a.placementId < b.placementId ? -1 : a.placementId > b.placementId ? 1 : 0));
  const sourceKey = sourceList.map((source) => `${source.placementId}:${source.flat ? 1 : 0}:${source.imageId}`).join("|");
  const sourcesRef = useRef(sourceList);
  sourcesRef.current = sourceList;
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  useEffect(() => {
    const sources = sourcesRef.current;
    let cancel = false;
    const created: string[] = [];
    void Promise.all(
      sources.map(async (source) => {
        try {
          let blob: Blob | null = null;
          if (source.flat) blob = await readInk(canvasFlatId(source.placementId));
          if (!blob) blob = await readPixels(source.imageId, "original");
          if (!blob) return { ...source, url: "" };
          const url = URL.createObjectURL(blob);
          created.push(url);
          return { ...source, url };
        } catch {
          return { ...source, url: "" };
        }
      }),
    ).then((pairs) => {
      if (cancel) {
        for (const url of created) URL.revokeObjectURL(url);
        return;
      }
      setUrls(Object.fromEntries(pairs.filter((pair) => pair.url).map((pair) => [pair.placementId, { url: pair.url, flat: pair.flat }])));
      setMissing(Object.fromEntries(pairs.filter((pair) => !pair.url).map((pair) => [pair.placementId, true])));
    });
    return () => {
      cancel = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [sourceKey]);

  useEffect(() => {
    const onDrop = (event: Event) => {
      const node = worldRef.current;
      if (!loadedRef.current || !node) return;
      const detail = (event as CustomEvent<{ imageId?: string; clientX?: number; clientY?: number }>).detail;
      if (!detail?.imageId || detail.clientX == null || detail.clientY == null) return;
      const image = imagesRef.current.find((item) => item.id === detail.imageId);
      if (!image || !image.mime.startsWith("image/")) return;
      if (draftRef.current) confirmRef.current();
      const { width: sheetW, height: sheetH } = sheetRef.current;
      const size = fittedPlacementSize(image.width, image.height, sheetW, sheetH);
      const raw = clientToCanvas(detail.clientX, detail.clientY, node, sheetW, sheetH);
      const center = containedCenter(Math.min(sheetW, Math.max(0, raw.x)), Math.min(sheetH, Math.max(0, raw.y)), size.width, size.height, sheetW, sheetH);
      const placement: CanvasPlacement = {
        id: crypto.randomUUID(),
        imageId: image.id,
        x: center.x,
        y: center.y,
        width: size.width,
        rotation: 0,
        z: nextZ(placementsRef.current),
      };
      const next = { placement, snapshot: null, fresh: true };
      draftRef.current = next;
      setDraft(next);
      imageToolRef.current = true;
      setImageTool(true);
      if (image.animated || image.inkVisible === false) return;
      const placementId = placement.id;
      const imageId = image.id;
      const width = image.width;
      const height = image.height;
      const epoch = epochRef.current;
      bakingIds.current.add(placementId);
      setBaking((current) => ({ ...current, [placementId]: true }));
      const alive = () =>
        epochRef.current === epoch &&
        (draftRef.current?.placement.id === placementId || placementsRef.current.some((item) => item.id === placementId));
      void (async () => {
        try {
          if (!alive()) return;
          const [original, ink] = await Promise.all([readPixels(imageId, "original"), readInk(imageId)]);
          if (!original || !ink || !alive()) return;
          const baked = await compositeWithInk(original, ink, width, height);
          if (!baked || !alive()) return;
          await saveInk(canvasFlatId(placementId), baked);
          if (!alive()) {
            await deleteInk(canvasFlatId(placementId)).catch(() => undefined);
            return;
          }
          applyFlat(placementId);
        } catch {
          /* the original picture stays on the sheet */
        } finally {
          bakingIds.current.delete(placementId);
          setBaking((current) => {
            if (!current[placementId]) return current;
            const rest = { ...current };
            delete rest[placementId];
            return rest;
          });
        }
      })();
    };
    window.addEventListener("komacho-canvas-drop", onDrop);
    return () => window.removeEventListener("komacho-canvas-drop", onDrop);
  }, []);

  useEffect(() => () => stopGesture.current?.(), []);

  const activateImageTool = () => {
    if (!loadedRef.current || imageToolRef.current) return;
    imageToolRef.current = true;
    setImageTool(true);
  };

  const liveInk = () => {
    const composed = inkApi.current?.composite();
    if (composed) return composed;
    const node = worldRef.current?.querySelector("canvas.ink-layer");
    return node instanceof HTMLCanvasElement ? node : null;
  };

  const sheetHasContent = async () => {
    if (placementsRef.current.length > 0 || draftRef.current) return true;
    const ink = liveInk();
    if (ink && inkHasMarks(ink)) return true;
    try {
      const stored = await readInk(CANVAS_BOARD_ID);
      return Boolean(stored && stored.size > 0);
    } catch {
      return false;
    }
  };

  const clearSheet = async (next: CanvasOrientation) => {
    stopGesture.current?.();
    setGesturing(false);
    const doomed = [...placementsRef.current];
    const editing = draftRef.current?.placement;
    if (editing && !doomed.some((item) => item.id === editing.id)) doomed.push(editing);
    draftRef.current = null;
    setDraft(null);
    placementsRef.current = [];
    setPlacements([]);
    setBaking({});
    bakingIds.current.clear();
    const dropped = clearBoardHistory(boardHistory);
    const flatIds = new Set<string>();
    for (const placement of doomed) if (placement.flat) flatIds.add(placement.id);
    for (const id of flatPlacementIds(dropped)) flatIds.add(id);
    dropUnreferencedFlats(flatIds, new Set());
    setHistTick((tick) => tick + 1);
    void savePlacements([]);
    resetInkSession(CANVAS_BOARD_ID);
    try {
      await forgetPersistedInk(CANVAS_BOARD_ID);
    } catch {
      /* the sheet still turns; a leftover stroke file is removed on the next open */
    }
    orientationRef.current = next;
    sheetRef.current = canvasSize(next);
    setOrientation(next);
    const fit = { zoom: 1, x: 0, y: 0 };
    lensRef.current = fit;
    setLens(fit);
    void writeKv(CANVAS_ORIENTATION_KEY, next);
    window.dispatchEvent(new CustomEvent("komacho-canvas-orient", { detail: { orientation: next } }));
    setFlipAsk(false);
  };

  const requestFlip = async () => {
    if (flipLock.current || flipAsk || !loadedRef.current) return;
    flipLock.current = true;
    try {
      const next: CanvasOrientation = orientationRef.current === "portrait" ? "landscape" : "portrait";
      if (await sheetHasContent()) {
        setFlipAsk(true);
        return;
      }
      await clearSheet(next);
    } finally {
      flipLock.current = false;
    }
  };

  const runFlip = () => {
    if (flipLock.current) return;
    const next: CanvasOrientation = orientationRef.current === "portrait" ? "landscape" : "portrait";
    flipLock.current = true;
    void clearSheet(next).finally(() => {
      flipLock.current = false;
    });
  };

  const applyHistoryPlacements = (list: PlacementSnap[]) => {
    const next = clonePlacementSnaps(list);
    placementsRef.current = next;
    draftRef.current = null;
    setPlacements(next);
    setDraft(null);
    setGesturing(false);
    void savePlacements(next);
  };

  const undoBoard = () => {
    if (draftRef.current) return;
    const top = boardHistory.undo.at(-1);
    if (!top) return;
    if (top.kind === "ink") {
      const current = inkApi.current?.snapshot() ?? null;
      if (!current) return;
      const prev = undoBoardStep(boardHistory, { kind: "ink", before: current });
      if (!prev || prev.kind !== "ink") return;
      inkApi.current?.restore(prev.before);
    } else {
      const prev = undoBoardStep(boardHistory, { kind: "placements", before: clonePlacementSnaps(placementsRef.current) });
      if (!prev || prev.kind !== "placements") return;
      applyHistoryPlacements(prev.before);
    }
    setHistTick((tick) => tick + 1);
  };

  const redoBoard = () => {
    if (draftRef.current) return;
    const top = boardHistory.redo.at(-1);
    if (!top) return;
    if (top.kind === "ink") {
      const current = inkApi.current?.snapshot() ?? null;
      if (!current) return;
      const next = redoBoardStep(boardHistory, { kind: "ink", before: current });
      if (!next || next.kind !== "ink") return;
      inkApi.current?.restore(next.before);
    } else {
      const next = redoBoardStep(boardHistory, { kind: "placements", before: clonePlacementSnaps(placementsRef.current) });
      if (!next || next.kind !== "placements") return;
      applyHistoryPlacements(next.before);
    }
    setHistTick((tick) => tick + 1);
  };

  const noteBoardInk = (before: InkSnap) => {
    const dropped = noteBoardStep(boardHistory, { kind: "ink", before });
    dropUnreferencedFlats(flatPlacementIds(dropped), liveFlatIds(placementsRef.current, draftRef.current, bakingIds.current));
    setHistTick((tick) => tick + 1);
  };

  const renderSheetPng = (): Promise<Blob | null> => {
    const { width, height } = sheetRef.current;
    if (width < 1 || height < 1) return Promise.resolve(null);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    const editingId = draftRef.current?.placement.id ?? "";
    const committed = placementsRef.current.filter((item) => item.id !== editingId).sort((a, b) => a.z - b.z);
    const editing = draftRef.current?.placement ?? null;
    const order = (editing ? [...committed, editing] : committed).map((item) => ({ ...item }));
    const heights = new Map(order.map((item) => [item.id, heightOf(item)]));
    const ink = liveInk();
    const inkSnap = document.createElement("canvas");
    if (ink && ink.width > 0 && ink.height > 0) {
      inkSnap.width = ink.width;
      inkSnap.height = ink.height;
      inkSnap.getContext("2d")?.drawImage(ink, 0, 0);
    }
    return (async () => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.clip();
      for (const placement of order) {
        let bitmap: ImageBitmap | null = null;
        try {
          const known = urlsRef.current[placement.id];
          const wantsFlat = placement.flat === true;
          let blob: Blob | null = null;
          if (known?.url && known.flat === wantsFlat) {
            const response = await fetch(known.url);
            blob = await response.blob();
          }
          if (!blob || blob.size < 1) {
            if (wantsFlat) blob = await readInk(canvasFlatId(placement.id));
            if (!blob) blob = await readPixels(placement.imageId, "original");
          }
          if (!blob || blob.size < 1) continue;
          bitmap = await createImageBitmap(blob);
          const itemHeight = heights.get(placement.id) ?? placement.width;
          ctx.save();
          ctx.translate(placement.x, placement.y);
          ctx.rotate((placement.rotation * Math.PI) / 180);
          ctx.globalAlpha = placementAlpha(placement.opacity);
          ctx.drawImage(bitmap, -placement.width / 2, -itemHeight / 2, placement.width, itemHeight);
          ctx.restore();
        } catch {
          /* skip a picture that cannot be read; the rest of the sheet still exports */
        } finally {
          bitmap?.close();
        }
      }
      if (inkSnap.width > 0 && inkSnap.height > 0) ctx.drawImage(inkSnap, 0, 0, width, height);
      ctx.restore();
      return toPngBlob(canvas);
    })();
  };

  const saveSheet = async () => {
    if (exportLock.current) return;
    if (!loadedRef.current) {
      notify("キャンバスの準備ができるまで保存できません。");
      return;
    }
    const pick = directoryPicker();
    if (!pick) {
      notify("この環境では保存先フォルダを選べません。キャンバスの内容は変えていません。");
      return;
    }
    exportLock.current = true;
    const pending = renderSheetPng();
    try {
      let dir: Awaited<ReturnType<DirectoryPicker>>;
      try {
        dir = await pick({ mode: "readwrite" });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        notify("保存先フォルダを選べませんでした。キャンバスの内容は変えていません。");
        return;
      }
      const blob = await pending;
      if (!blob) {
        notify("キャンバスを画像にできませんでした。キャンバスの内容は変えていません。");
        return;
      }
      const handle = await dir.getFileHandle(canvasPngName(), { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      notify("キャンバスを保存しました。");
    } catch {
      notify("キャンバスを保存できませんでした。キャンバスの内容は変えていません。");
    } finally {
      exportLock.current = false;
    }
  };

  const copySheet = async () => {
    if (!loadedRef.current) {
      notify("キャンバスの準備ができるまでコピーできません。");
      return;
    }
    const clip = navigator.clipboard;
    if (!clip || typeof clip.write !== "function" || typeof ClipboardItem === "undefined") {
      notify("この環境では画像をクリップボードにコピーできません。");
      return;
    }
    try {
      const pending = renderSheetPng().then((blob) => {
        if (!blob) throw new Error("empty");
        return blob;
      });
      await clip.write([new ClipboardItem({ "image/png": pending as unknown as Blob })]);
      notify("キャンバスをコピーしました。");
    } catch {
      notify("クリップボードへのコピーに失敗しました。");
    }
  };

  const actionsRef = useRef({ enter: activateImageTool, save: saveSheet, copy: copySheet, flip: requestFlip });
  actionsRef.current = { enter: activateImageTool, save: saveSheet, copy: copySheet, flip: requestFlip };

  useEffect(() => {
    if (!flipAsk) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && document.querySelector(".canvas-flip-dialog")?.contains(target)) return;
      setFlipAsk(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [flipAsk]);

  useEffect(() => {
    const onEnter = () => actionsRef.current.enter();
    const onSave = () => void actionsRef.current.save();
    const onCopy = () => void actionsRef.current.copy();
    const onFlip = () => void actionsRef.current.flip();
    window.addEventListener("komacho-canvas-drag-enter", onEnter);
    window.addEventListener("komacho-canvas-save", onSave);
    window.addEventListener("komacho-canvas-copy", onCopy);
    window.addEventListener("komacho-canvas-flip", onFlip);
    return () => {
      window.removeEventListener("komacho-canvas-drag-enter", onEnter);
      window.removeEventListener("komacho-canvas-save", onSave);
      window.removeEventListener("komacho-canvas-copy", onCopy);
      window.removeEventListener("komacho-canvas-flip", onFlip);
    };
  }, []);

  const sheet = canvasSize(orientation);
  const scale = frame.width > 0 ? Math.min(frame.width / sheet.width, frame.height / sheet.height) : 0;
  const chrome = scale > 0 ? 1 / (scale * lens.zoom) : 1;

  useLayoutEffect(() => {
    const same = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
    const zero = { rotate: { x: 0, y: 0 }, scale: { x: 0, y: 0 }, actions: { x: 0, y: 0 } };
    if (!draft || !world || !stage) {
      chromeBoxesRef.current = [];
      setChromeShift((current) => (same(current.rotate, zero.rotate) && same(current.scale, zero.scale) && same(current.actions, zero.actions) ? current : zero));
      return;
    }
    const worldRect = world.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (worldRect.width < 1 || worldRect.height < 1 || stageRect.width < 1 || stageRect.height < 1) return;
    const margin = 8;
    const view = {
      left: Math.max(margin, stageRect.left + margin),
      top: Math.max(margin, stageRect.top + margin),
      right: Math.min(window.innerWidth - margin, stageRect.right - margin),
      bottom: Math.min(window.innerHeight - margin, stageRect.bottom - margin),
    };
    if (view.right - view.left < 48 || view.bottom - view.top < 48) return;
    const toScreen = (x: number, y: number) => ({
      x: worldRect.left + (x / sheet.width) * worldRect.width,
      y: worldRect.top + (y / sheet.height) * worldRect.height,
    });
    const placement = draft.placement;
    const height = heightOf(placement);
    const rad = (placement.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corner = (lx: number, ly: number) => toScreen(placement.x + lx * cos - ly * sin, placement.y + lx * sin + ly * cos);
    const rotateCorner = corner(placement.width / 2, -height / 2);
    const scaleCorner = corner(placement.width / 2, height / 2);
    const rotateBox = handleScreenBox(rotateCorner.x, rotateCorner.y, placement.rotation, 14, "top-right");
    const scaleBox = handleScreenBox(scaleCorner.x, scaleCorner.y, placement.rotation, 14, "bottom-right");
    chromeBoxesRef.current = [rotateBox, scaleBox];
    const bounds = placementBounds({ ...placement, height });
    const anchor = toScreen((bounds.left + bounds.right) / 2, bounds.bottom + 14 * chrome);
    const row = actionsRowRef.current;
    const actionsBox = { x: anchor.x - (row?.offsetWidth || 168) / 2, y: anchor.y, w: row?.offsetWidth || 168, h: row?.offsetHeight || 28 };
    const [nextRotate, nextScale, nextActions] = settleEditChrome([rotateBox, scaleBox, actionsBox], view);
    if (!nextRotate || !nextScale || !nextActions) return;
    const next = {
      rotate: { x: nextRotate.x - rotateBox.x, y: nextRotate.y - rotateBox.y },
      scale: { x: nextScale.x - scaleBox.x, y: nextScale.y - scaleBox.y },
      actions: { x: nextActions.x - actionsBox.x, y: nextActions.y - actionsBox.y },
    };
    setChromeShift((current) => (same(current.rotate, next.rotate) && same(current.scale, next.scale) && same(current.actions, next.actions) ? current : next));
  }, [draft, world, stage, images, sheet.width, sheet.height, lens.x, lens.y, lens.zoom, frame.width, frame.height, chrome]);

  const editingId = draft?.placement.id ?? "";
  const opacitySession = useRef(editingId);
  useEffect(() => {
    if (opacitySession.current === editingId) return;
    opacitySession.current = editingId;
    opacityDirtyRef.current = false;
    opacitySlidingRef.current = false;
    opacityOpenRef.current = false;
    setOpacityOpen(false);
    setOpacityPos(null);
  }, [editingId]);

  useEffect(() => {
    if (!opacityOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (opacitySlidingRef.current) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inPanel = Boolean(opacityPopRef.current?.contains(target));
      if (inPanel) {
        if (target instanceof Element && target.closest("input[type='range']")) opacitySlidingRef.current = true;
        return;
      }
      if (opacityToggleRef.current?.contains(target)) return;
      if (!opacityDirtyRef.current) return;
      opacityDirtyRef.current = false;
      opacitySlidingRef.current = false;
      opacityOpenRef.current = false;
      setOpacityOpen(false);
      setOpacityPos(null);
    };
    const endSlide = () => {
      opacitySlidingRef.current = false;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", endSlide, true);
    window.addEventListener("pointercancel", endSlide, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", endSlide, true);
      window.removeEventListener("pointercancel", endSlide, true);
    };
  }, [opacityOpen]);

  useLayoutEffect(() => {
    if (!opacityOpen) return;
    const row = actionsRowRef.current;
    const pop = opacityPopRef.current;
    if (!row || !pop) return;
    const place = () => {
      const rect = row.getBoundingClientRect();
      const width = pop.offsetWidth;
      const height = pop.offsetHeight;
      if (rect.width < 1 || rect.height < 1 || width < 1 || height < 1) return;
      const margin = 8;
      const next = placeOpacityPanel(
        { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        { w: width, h: height },
        { left: margin, top: margin, right: window.innerWidth - margin, bottom: window.innerHeight - margin },
        chromeBoxesRef.current,
      );
      setOpacityPos((current) => (current && Math.abs(current.x - next.x) < 0.5 && Math.abs(current.y - next.y) < 0.5 ? current : next));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(row);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [opacityOpen, draft, chromeShift, lens.x, lens.y, lens.zoom, frame.width, frame.height]);

  const rotateNudge = screenDeltaToFrame(chromeShift.rotate.x, chromeShift.rotate.y, draft?.placement.rotation ?? 0, chrome);
  const scaleNudge = screenDeltaToFrame(chromeShift.scale.x, chromeShift.scale.y, draft?.placement.rotation ?? 0, chrome);

  const panFromMiddle = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = lensRef.current;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dx * dx + dy * dy > 9) moved = true;
      const next = { zoom: origin.zoom, x: origin.x + dx, y: origin.y + dy };
      lensRef.current = next;
      setLens(next);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (!moved) {
        const fit = { zoom: 1, x: 0, y: 0 };
        lensRef.current = fit;
        setLens(fit);
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  };

  const renderItem = (placement: CanvasPlacement, editing: boolean, stack: number) => {
    const image = images.find((item) => item.id === placement.imageId);
    const height = placementHeight(placement.width, image?.width ?? 0, image?.height ?? 0);
    const shown = urls[placement.id];
    const hold = Boolean(baking[placement.id]);
    const waiting = hold || (placement.flat === true && shown?.flat !== true);
    const ready = Boolean(shown && !waiting && shown.flat === (placement.flat === true));
    const fade = placementAlpha(placement.opacity);
    const fadeStyle = fade < 0.999 ? { opacity: fade } : undefined;
    return (
      <div
        key={placement.id}
        className={["canvas-item", editing ? "is-editing" : "", editing && gesturing ? "is-moving" : ""].filter(Boolean).join(" ")}
        data-placement-id={placement.id}
        data-flat={placement.flat ? "true" : "false"}
        style={{
          left: placement.x,
          top: placement.y,
          width: placement.width,
          height,
          zIndex: editing ? 1_000_000 : stack,
          transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`,
          outline: editing ? `${2 * chrome}px dashed #ffe14a` : undefined,
          outlineOffset: editing ? `${3 * chrome}px` : undefined,
          pointerEvents: imageTool ? "auto" : "none",
        }}
        onPointerDown={(event) => {
          if (!imageToolRef.current || event.button !== 0) return;
          const target = event.target as Element | null;
          if (target?.closest(".canvas-handle")) return;
          event.preventDefault();
          event.stopPropagation();
          const next = ensureEditing(placement.id);
          if (!next) return;
          beginMove(next.placement, event.clientX, event.clientY, event.pointerId, event.clientX, event.clientY, event.pointerType);
        }}
      >
        {ready && shown ? (
          <img src={shown.url} alt={image?.name ?? ""} draggable={false} style={fadeStyle} />
        ) : waiting ? null : (
          <div className="canvas-missing" style={{ fontSize: 14 * chrome, ...fadeStyle }}>
            {missing[placement.id] ? "元画像なし" : ""}
          </div>
        )}
        {editing ? null : (
          <div
            className="canvas-bleed"
            style={{ clipPath: outsideVeilClip({ ...placement, height }, sheet.width, sheet.height), ...fadeStyle }}
          />
        )}
      </div>
    );
  };

  const shown = placements.map((placement) => (draft && placement.id === draft.placement.id ? draft.placement : placement)).sort((a, b) => a.z - b.z);
  const fresh = draft?.fresh ? draft.placement : null;
  const popup = draft
    ? placementBounds({ ...draft.placement, height: heightOf(draft.placement) })
    : null;

  return (
    <section className={imageTool ? "canvas-pane is-image-tool" : "canvas-pane"} aria-label="キャンバス" onPointerDown={(event) => event.stopPropagation()}>
      <div
        className="canvas-stage"
        ref={setStage}
        onPointerDown={panFromMiddle}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
      >
        {orientReady && scale > 0 ? (
          <div
            className="canvas-view"
            ref={viewRef}
            style={{
              width: sheet.width * scale,
              height: sheet.height * scale,
              transform: `translate(${lens.x}px, ${lens.y}px) scale(${lens.zoom})`,
            }}
          >
          <div className="canvas-sheet">
            <div
              className="canvas-world"
              ref={setWorld}
              style={{ width: sheet.width, height: sheet.height, transform: `scale(${scale})` }}
            >
              <div className="canvas-images">
                {shown.map((placement, index) => renderItem(placement, draft?.placement.id === placement.id, index + 1))}
                {fresh ? renderItem(fresh, true, shown.length + 1) : null}
              </div>
              <ImageInk
                imageId={CANVAS_BOARD_ID}
                pixelWidth={sheet.width}
                pixelHeight={sheet.height}
                live
                shown
                toolsRoot={dock}
                canvasBridge={{
                  imageActive: imageTool,
                  onImageTool: () => setImageTool(true),
                  onDrawTool: () => {
                    confirmDraft();
                    setImageTool(false);
                  },
                  claimImage: () => false,
                  onImageDrag: () => undefined,
                  bindInk,
                  history: {
                    blocked: draft !== null,
                    canUndo: histTick < 0 ? false : boardHistory.undo.length > 0,
                    canRedo: histTick < 0 ? false : boardHistory.redo.length > 0,
                    undo: undoBoard,
                    redo: redoBoard,
                    noteInk: noteBoardInk,
                  },
                }}
                style={{ inset: 0, width: "100%", height: "100%", pointerEvents: imageTool ? "none" : "auto" }}
              />
              {draft ? (
                <div className="canvas-chrome">
                  <div
                    className="canvas-edit-frame"
                    style={{
                      left: draft.placement.x,
                      top: draft.placement.y,
                      width: draft.placement.width,
                      height: heightOf(draft.placement),
                      transform: `translate(-50%, -50%) rotate(${draft.placement.rotation}deg)`,
                    }}
                  >
                    <button
                      type="button"
                      className="canvas-handle is-rotate"
                      aria-label="回転"
                      style={{ transform: `translate(${rotateNudge.x}px, ${rotateNudge.y}px) scale(${chrome})` }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const current = draftRef.current?.placement;
                        if (!current) return;
                        const down = pointOf(event.clientX, event.clientY);
                        const startAngle = pointerAngle(current.x, current.y, down.x, down.y);
                        const startRotation = current.rotation;
                        beginGesture(
                          event.pointerId,
                          (pointer) => {
                            const now = pointOf(pointer.clientX, pointer.clientY);
                            patchDraft(current.id, { rotation: rotatedDegrees(startRotation, startAngle, pointerAngle(current.x, current.y, now.x, now.y)) });
                          },
                          { pointerType: event.pointerType, x: event.clientX, y: event.clientY },
                        );
                      }}
                    >
                      <RotateIcon />
                    </button>
                    <button
                      type="button"
                      className="canvas-handle is-scale"
                      aria-label="拡大縮小"
                      style={{ transform: `translate(${scaleNudge.x}px, ${scaleNudge.y}px) scale(${chrome})` }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const current = draftRef.current?.placement;
                        if (!current) return;
                        const down = pointOf(event.clientX, event.clientY);
                        const startDist = Math.max(1, pointerDistance(current.x, current.y, down.x, down.y));
                        const startWidth = current.width;
                        beginGesture(event.pointerId, (pointer) => {
                          const now = pointOf(pointer.clientX, pointer.clientY);
                          patchDraft(current.id, { width: scaledWidth(startWidth, startDist, pointerDistance(current.x, current.y, now.x, now.y), sheetRef.current.width) });
                        });
                      }}
                    >
                      <ScaleIcon />
                    </button>
                  </div>
                  {popup ? (
                    <div
                      className="canvas-actions"
                      style={{ left: (popup.left + popup.right) / 2, top: popup.bottom + 14 * chrome, transform: `translate(${chromeShift.actions.x * chrome}px, ${chromeShift.actions.y * chrome}px) scale(${chrome})` }}
                      onPointerDown={(event) => {
                        if (event.button === 1) return;
                        event.stopPropagation();
                      }}
                    >
                      <div className="canvas-actions-row" ref={actionsRowRef}>
                        <button type="button" className="is-commit" onClick={confirmDraft}>
                          確定
                        </button>
                        <button type="button" onClick={cancelDraft}>
                          キャンセル
                        </button>
                        <button type="button" onClick={deleteDraft}>
                          削除
                        </button>
                        <button
                          type="button"
                          ref={opacityToggleRef}
                          className={opacityOpen ? "is-on" : undefined}
                          aria-expanded={opacityOpen}
                          aria-pressed={opacityOpen}
                          onClick={() => {
                            if (opacityOpenRef.current) {
                              closeOpacityUi();
                              return;
                            }
                            openOpacity();
                          }}
                        >
                          不透明度
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          </div>
        ) : null}
      </div>
      <div ref={setDock} className="ink-dock canvas-dock" />
      {opacityOpen && draft
        ? createPortal(
            <div
              ref={opacityPopRef}
              className="canvas-opacity-pop"
              role="dialog"
              aria-label="不透明度"
              style={{
                left: opacityPos?.x ?? 0,
                top: opacityPos?.y ?? 0,
                visibility: opacityPos ? "visible" : "hidden",
                pointerEvents: opacityPos ? "auto" : "none",
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="canvas-opacity-head">
                <span>不透明度</span>
                <span className="canvas-opacity-value">{placementOpacity(draft.placement.opacity)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={placementOpacity(draft.placement.opacity)}
                aria-label="不透明度"
                onPointerDown={(event) => {
                  opacitySlidingRef.current = true;
                  event.stopPropagation();
                }}
                onInput={(event) => {
                  const id = draftRef.current?.placement.id;
                  if (!id) return;
                  opacityDirtyRef.current = true;
                  patchDraft(id, { opacity: Number(event.currentTarget.value) });
                }}
                onLostPointerCapture={() => {
                  opacitySlidingRef.current = false;
                }}
              />
              <div className="canvas-opacity-actions">
                <button type="button" className="is-commit" onClick={() => closeOpacityUi()}>
                  確定
                </button>
                <button type="button" onClick={cancelOpacity}>
                  キャンセル
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      {flipAsk
        ? createPortal(
            <div
              className="canvas-flip-overlay"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setFlipAsk(false);
              }}
            >
              <div
                className="canvas-flip-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="canvas-flip-title"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <p id="canvas-flip-title">キャンバスの向きを変更します。現在の内容はすべて消去されます。よろしいですか？</p>
                <div className="canvas-flip-actions">
                  <button type="button" onClick={() => setFlipAsk(false)}>
                    キャンセル
                  </button>
                  <button type="button" className="is-run" onClick={runFlip}>
                    実行
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
