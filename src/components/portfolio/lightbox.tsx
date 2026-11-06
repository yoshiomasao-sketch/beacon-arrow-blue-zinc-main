import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Heart, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ImageInk } from "@/components/portfolio/ink-layer";
import { Button } from "@/components/ui/button";
import { readPixels } from "@/lib/portfolio/db";
import {
  DOUBLE_TAP_MS,
  DRAG_REST,
  IDENTITY_ZOOM,
  PINCH_MIN,
  SWIPE_ANIM_MS,
  SWIPE_MIN,
  ZOOM_ANIM_MS,
  freshGesture,
  gestureDown,
  gestureMove,
  gestureUp,
  infoOpenForItem,
  infoSheetDismiss,
  infoSheetStep,
  incomingX,
  incomingSlideVisible,
  isZoomed,
  lightboxGestureAction,
  panEdges,
  parkedX,
  pinchRelease,
  scrimForDrag,
  scrimForPinch,
  scrubDrag,
  type Drag,
  type GestureResult,
  type Zoom,
} from "@/lib/portfolio/lightbox-zoom";
import type { ImageMeta, Tag } from "@/lib/portfolio/types";
import { setInkVisible, usePortfolio } from "@/lib/portfolio/store";

type Frame = { left: number; top: number; width: number; height: number };

function containedFrame(availW: number, availH: number, imageW: number, imageH: number, insetX: number): Frame | null {
  const widthBudget = availW - insetX * 2;
  if (widthBudget <= 0 || availH <= 0 || imageW <= 0 || imageH <= 0) return null;
  const scale = Math.min(widthBudget / imageW, availH / imageH);
  const width = imageW * scale;
  const height = imageH * scale;
  return {
    left: insetX + (widthBudget - width) / 2,
    top: (availH - height) / 2,
    width,
    height,
  };
}

function mediaStyle(
  frame: Frame,
  zoom: Zoom,
  phone: boolean,
  animateZoom: boolean,
  drag: Drag,
  animateDrag: boolean,
  opacity = 1,
): { left: number; top: number; width: number; height: number; transform?: string; transformOrigin?: string; transition?: string; opacity?: number } {
  const style: { left: number; top: number; width: number; height: number; transform?: string; transformOrigin?: string; transition?: string; opacity?: number } = {
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
  };
  if (opacity < 0.999) style.opacity = opacity;
  if (phone) {
    style.transform = `translate(${zoom.x + drag.x}px, ${zoom.y + drag.y}px) scale(${zoom.scale})`;
    style.transformOrigin = "center center";
    if (animateDrag) style.transition = `transform ${SWIPE_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    else if (animateZoom) style.transition = `transform ${ZOOM_ANIM_MS}ms ease-out`;
  }
  return style;
}

function MemoLine({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const shift = node.scrollWidth - (node.parentElement?.clientWidth ?? 0);
    setOverflow(shift > 4 ? shift : 0);
  }, [text]);

  if (!text) return null;
  const scrolling = overflow > 0;
  const duration = scrolling ? overflow / 28 / 0.7 : 0;
  return (
    <p className="memo-line-view">
      <span
        ref={ref}
        className={scrolling ? "memo-line is-scrolling" : "memo-line"}
        style={
          scrolling
            ? { ["--marquee-shift" as string]: `${overflow}px`, ["--marquee-duration" as string]: `${duration}s` }
            : undefined
        }
      >
        {text}
      </span>
    </p>
  );
}

export function Lightbox({
  item,
  index,
  total,
  prev = null,
  next = null,
  onClose,
  onStep,
  onToggleFavorite,
  tags = [],
  launchInk = null,
  contained = false,
  container = null,
}: {
  item: ImageMeta | null;
  index: number;
  total: number;
  prev?: ImageMeta | null;
  next?: ImageMeta | null;
  onClose: () => void;
  onStep: (delta: number) => void;
  onToggleFavorite: (id: string) => void;
  tags?: Tag[];
  launchInk?: { current: boolean } | null;
  contained?: boolean;
  container?: HTMLElement | null;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [urlTick, setUrlTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [stageBox, setStageBox] = useState({ width: 0, height: 0 });
  const [hot, setHot] = useState<"prev" | "next" | null>(null);
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches);
  const [inkOn, setInkOn] = useState(false);
  const [inkDock, setInkDock] = useState<HTMLDivElement | null>(null);
  const hasInk = usePortfolio((state) => (item && !item.animated ? state.inkIds.includes(item.id) : false));
  const inkShown = item?.inkVisible !== false;
  const canInk = Boolean(item && !phone && !item.animated);
  const editing = canInk && (inkOn || Boolean(launchInk?.current));
  useEffect(() => {
    if (!item || phone || item.animated) {
      if (launchInk) launchInk.current = false;
      setInkOn(false);
      return;
    }
    if (launchInk?.current) {
      launchInk.current = false;
      setInkOn(true);
    }
  }, [item, phone, launchInk]);
  const [zoom, setZoom] = useState<Zoom>(IDENTITY_ZOOM);
  const [zoomAnim, setZoomAnim] = useState(false);
  const [drag, setDrag] = useState<Drag>(DRAG_REST);
  const [dragAnim, setDragAnim] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [photoOpacity, setPhotoOpacity] = useState(1);
  const [pinchFades, setPinchFades] = useState(false);
  const canPrev = total > 1;
  const canNext = total > 1;
  const swipeRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const zoomRef = useRef<Zoom>(IDENTITY_ZOOM);
  const gestureRef = useRef(freshGesture());
  const phoneRef = useRef(false);
  const suppressClick = useRef(false);
  const infoRef = useRef(false);
  const infoDragRef = useRef<{ id: number; x: number; y: number; top: number } | null>(null);
  const zoomTimer = useRef(0);
  const zoomFrame = useRef(0);
  const dragTimer = useRef(0);
  const dragFrame = useRef(0);
  const dragRef = useRef<Drag>(DRAG_REST);
  const pendingEnter = useRef<Drag | null>(null);
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const urls = useRef(new Map<string, string>());
  const loadingUrls = useRef(new Set<string>());
  const slideDir = useRef<-1 | 0 | 1>(0);
  const settleEnter = useRef(false);
  const leavingRef = useRef(false);
  const photoOpacityRef = useRef(1);
  const pinchFadesRef = useRef(false);
  const infoTapTimer = useRef(0);
  const armed = useRef(true);
  const openedAt = useRef(0);
  const seenId = useRef<string | null>(item?.id ?? null);
  const seenPhone = useRef(false);
  let shown = zoom;
  let shownDrag = drag;
  const sameImage = (item?.id ?? null) === seenId.current;

  if (!sameImage) {
    const opening = seenId.current === null && item !== null;
    const nextInfo = opening ? false : infoOpenForItem(infoRef.current, item?.id ?? null);
    const enter = pendingEnter.current;
    pendingEnter.current = null;
    seenId.current = item?.id ?? null;
    zoomRef.current = IDENTITY_ZOOM;
    if (opening || !item || gestureRef.current.pointers.length === 0) gestureRef.current = freshGesture();
    infoRef.current = nextInfo;
    shown = IDENTITY_ZOOM;
    window.cancelAnimationFrame(zoomFrame.current);
    window.clearTimeout(zoomTimer.current);
    window.clearTimeout(infoTapTimer.current);
    if (opening) {
      armed.current = false;
      openedAt.current = performance.now();
    }
    if (!item) armed.current = true;
    if (zoom !== IDENTITY_ZOOM) setZoom(IDENTITY_ZOOM);
    if (infoOpen !== nextInfo) setInfoOpen(nextInfo);
    if (zoomAnim) setZoomAnim(false);
    if (enter) {
      dragRef.current = enter;
      shownDrag = enter;
      if (drag.x !== enter.x || drag.y !== enter.y) setDrag(enter);
      if (dragAnim) setDragAnim(false);
    } else {
      window.cancelAnimationFrame(dragFrame.current);
      window.clearTimeout(dragTimer.current);
      shownDrag = DRAG_REST;
      if (drag.x !== 0 || drag.y !== 0 || dragAnim) {
        dragRef.current = DRAG_REST;
        if (drag.x !== 0 || drag.y !== 0) setDrag(DRAG_REST);
        if (dragAnim) setDragAnim(false);
      }
    }
    if (photoOpacity !== 1) {
      photoOpacityRef.current = 1;
      setPhotoOpacity(1);
    }
    if (pinchFades) {
      pinchFadesRef.current = false;
      setPinchFades(false);
    }
    leavingRef.current = false;
  }
  if (phone !== seenPhone.current) {
    seenPhone.current = phone;
    phoneRef.current = phone;
    if (!phone) {
      zoomRef.current = IDENTITY_ZOOM;
      gestureRef.current = freshGesture();
      infoRef.current = false;
      shown = IDENTITY_ZOOM;
      window.cancelAnimationFrame(zoomFrame.current);
      window.clearTimeout(zoomTimer.current);
      window.cancelAnimationFrame(dragFrame.current);
      window.clearTimeout(dragTimer.current);
      pendingEnter.current = null;
      if (zoom !== IDENTITY_ZOOM) setZoom(IDENTITY_ZOOM);
      if (infoOpen) setInfoOpen(false);
      if (zoomAnim) setZoomAnim(false);
      dragRef.current = DRAG_REST;
      if (drag.x !== 0 || drag.y !== 0) setDrag(DRAG_REST);
      if (dragAnim) setDragAnim(false);
    }
  }

  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !item) return;
    const next = containedFrame(stage.clientWidth, stage.clientHeight, item.width, item.height, 16);
    frameRef.current = next;
    const box = { width: stage.clientWidth, height: stage.clientHeight };
    setStageBox((current) => (current.width === box.width && current.height === box.height ? current : box));
    setFrame((current) => {
      if (
        current &&
        next &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
      ) {
        return current;
      }
      return next;
    });
  }, [item]);

  const bindStage = (node: HTMLDivElement | null) => {
    stageRef.current = node;
    measure();
  };

  const bindMedia = (node: HTMLImageElement | HTMLVideoElement | null) => {
    mediaRef.current = node;
  };

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(zoomFrame.current);
      window.clearTimeout(zoomTimer.current);
      window.cancelAnimationFrame(dragFrame.current);
      window.clearTimeout(dragTimer.current);
      window.clearTimeout(infoTapTimer.current);
      for (const objectUrl of urls.current.values()) URL.revokeObjectURL(objectUrl);
      urls.current.clear();
    };
  }, []);

  useEffect(() => {
    measure();
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    measure();
    const frameId = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frameId);
  }, [editing, measure]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const apply = () => {
      phoneRef.current = media.matches;
      setPhone(media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!item?.id) return;
    const frame = window.requestAnimationFrame(() => {
      armed.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item?.id]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node || !phone || !item) return;
    const block = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".lightbox-info, button, a, input, textarea")) return;
      event.preventDefault();
    };
    node.addEventListener("touchmove", block, { passive: false });
    return () => node.removeEventListener("touchmove", block);
  }, [phone, item]);

  const itemId = item?.id ?? null;
  const prevId = prev?.id ?? null;
  const nextId = next?.id ?? null;

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    setHot(null);
    setFailed(false);
    const ids = [itemId];
    if (phone && prevId && prevId !== itemId) ids.push(prevId);
    if (phone && nextId && nextId !== itemId && nextId !== prevId) ids.push(nextId);
    for (const id of ids) {
      if (urls.current.has(id) || loadingUrls.current.has(id)) continue;
      loadingUrls.current.add(id);
      readPixels(id, "original")
        .then((blob) => {
          loadingUrls.current.delete(id);
          if (!blob) {
            if (!cancelled && id === itemId) setFailed(true);
            return;
          }
          if (!urls.current.has(id)) urls.current.set(id, URL.createObjectURL(blob));
          if (!cancelled) setUrlTick((tick) => tick + 1);
        })
        .catch(() => {
          loadingUrls.current.delete(id);
          if (!cancelled && id === itemId) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [itemId, prevId, nextId, phone]);

  const step = (delta: number) => {
    if (delta < 0 && !canPrev) return;
    if (delta > 0 && !canNext) return;
    pendingEnter.current = null;
    settleEnter.current = false;
    window.clearTimeout(dragTimer.current);
    window.cancelAnimationFrame(dragFrame.current);
    onStep(delta);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!contained || !item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      stepRef.current(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [contained, item]);

  useEffect(() => {
    if (!settleEnter.current) return;
    settleEnter.current = false;
    animateDragTo(DRAG_REST);
  }, [item?.id]);

  const readVisualDrag = (): Drag => {
    const node = mediaRef.current;
    if (!node || typeof DOMMatrix === "undefined") return dragRef.current;
    const raw = getComputedStyle(node).transform;
    if (!raw || raw === "none") return DRAG_REST;
    try {
      const matrix = new DOMMatrix(raw);
      return { x: matrix.e - zoomRef.current.x, y: matrix.f - zoomRef.current.y };
    } catch {
      return dragRef.current;
    }
  };

  const stopDragMotion = (): Drag => {
    window.clearTimeout(dragTimer.current);
    window.cancelAnimationFrame(dragFrame.current);
    const visual = dragAnim ? readVisualDrag() : dragRef.current;
    dragRef.current = visual;
    if (dragAnim) {
      setDragAnim(false);
      setDrag(visual);
    }
    return visual;
  };

  const animateDragTo = (target: Drag, done?: () => void) => {
    window.clearTimeout(dragTimer.current);
    window.cancelAnimationFrame(dragFrame.current);
    setDragAnim(true);
    dragFrame.current = window.requestAnimationFrame(() => {
      dragFrame.current = window.requestAnimationFrame(() => {
        dragRef.current = target;
        setDrag(target);
        dragTimer.current = window.setTimeout(() => {
          if (done) done();
          else setDragAnim(false);
        }, SWIPE_ANIM_MS);
      });
    });
  };

  const springDrag = () => {
    if (Math.abs(dragRef.current.x) < 0.5 && Math.abs(dragRef.current.y) < 0.5) {
      dragRef.current = DRAG_REST;
      setDrag(DRAG_REST);
      setDragAnim(false);
      return;
    }
    animateDragTo(DRAG_REST);
  };

  const flySwap = (delta: number) => {
    if ((delta < 0 && !canPrev) || (delta > 0 && !canNext)) {
      springDrag();
      return;
    }
    window.clearTimeout(dragTimer.current);
    window.cancelAnimationFrame(dragFrame.current);
    const width = stageRef.current?.clientWidth || 1;
    pendingEnter.current = { x: incomingX(dragRef.current.x, width), y: 0 };
    settleEnter.current = true;
    onStep(delta);
  };

  const stopMotion = () => {
    window.clearTimeout(dragTimer.current);
    window.clearTimeout(zoomTimer.current);
    window.cancelAnimationFrame(dragFrame.current);
    window.cancelAnimationFrame(zoomFrame.current);
  };

  const setPhoto = (value: number) => {
    photoOpacityRef.current = value;
    setPhotoOpacity(value);
  };

  const setPinchFade = (value: boolean) => {
    if (pinchFadesRef.current === value) return;
    pinchFadesRef.current = value;
    setPinchFades(value);
  };

  const playMotion = (duration: number, frame: (eased: number) => void, done?: () => void) => {
    stopMotion();
    setDragAnim(false);
    setZoomAnim(false);
    const start = performance.now();
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / duration);
      frame(1 - (1 - raw) ** 3);
      if (raw < 1) dragFrame.current = window.requestAnimationFrame(tick);
      else done?.();
    };
    dragFrame.current = window.requestAnimationFrame(tick);
  };

  const abortLeave = () => {
    if (!leavingRef.current) return false;
    leavingRef.current = false;
    const fromDrag = { ...dragRef.current };
    const fromZoom = { ...zoomRef.current };
    const fromOpacity = photoOpacityRef.current;
    playMotion(SWIPE_ANIM_MS, (eased) => {
      const drag = { x: fromDrag.x * (1 - eased), y: fromDrag.y * (1 - eased) };
      const zoom = {
        scale: fromZoom.scale + (1 - fromZoom.scale) * eased,
        x: fromZoom.x * (1 - eased),
        y: fromZoom.y * (1 - eased),
      };
      dragRef.current = drag;
      zoomRef.current = zoom;
      setDrag(drag);
      setZoom(zoom);
      setPhoto(fromOpacity + (1 - fromOpacity) * eased);
    }, () => setPinchFade(false));
    return true;
  };

  const flyAway = () => {
    leavingRef.current = true;
    const from = { ...dragRef.current };
    const height = stageRef.current?.clientHeight || 1;
    const toY = Math.max(from.y + height * 0.45, height);
    playMotion(SWIPE_ANIM_MS, (eased) => {
      const next = { x: from.x * (1 - eased), y: from.y + (toY - from.y) * eased };
      dragRef.current = next;
      setDrag(next);
      setPhoto(1 - eased);
    }, () => {
      if (leavingRef.current) onClose();
    });
  };

  const shrinkAway = (from: Zoom) => {
    leavingRef.current = true;
    setPinchFade(true);
    const next = {
      scale: Math.max(PINCH_MIN * 0.45, from.scale * 0.55),
      x: from.x * 0.55,
      y: from.y * 0.55,
    };
    playMotion(ZOOM_ANIM_MS, (eased) => {
      const zoom = {
        scale: from.scale + (next.scale - from.scale) * eased,
        x: from.x + (next.x - from.x) * eased,
        y: from.y + (next.y - from.y) * eased,
      };
      zoomRef.current = zoom;
      setZoom(zoom);
      setPhoto(1 - eased);
    }, () => {
      if (leavingRef.current) onClose();
    });
  };

  const settlePinch = (startedFitted: boolean, zoom: Zoom) => {
    const release = pinchRelease(startedFitted, zoom.scale);
    if (release === "close") {
      shrinkAway(zoom);
      return;
    }
    if (release === "fit") {
      zoomRef.current = IDENTITY_ZOOM;
      window.cancelAnimationFrame(zoomFrame.current);
      window.clearTimeout(zoomTimer.current);
      setZoomAnim(true);
      zoomFrame.current = window.requestAnimationFrame(() => {
        setZoom(IDENTITY_ZOOM);
        zoomTimer.current = window.setTimeout(() => setZoomAnim(false), ZOOM_ANIM_MS);
      });
    }
  };

  const applyGesture = (result: GestureResult) => {
    if (leavingRef.current) return;
    if (result.gesture.pointers.length > 0 || result.zoom) window.clearTimeout(infoTapTimer.current);
    gestureRef.current = result.gesture;
    if (result.suppressClick) suppressClick.current = true;
    if (result.zoom) {
      const next = result.zoom;
      zoomRef.current = next;
      window.cancelAnimationFrame(zoomFrame.current);
      window.clearTimeout(zoomTimer.current);
      if (result.animateZoom) {
        setZoomAnim(true);
        zoomFrame.current = window.requestAnimationFrame(() => {
          setZoom(next);
          zoomTimer.current = window.setTimeout(() => setZoomAnim(false), ZOOM_ANIM_MS);
        });
      } else {
        setZoomAnim(false);
        setZoom(next);
      }
      if (dragRef.current.x !== 0 || dragRef.current.y !== 0 || dragAnim) {
        window.clearTimeout(dragTimer.current);
        dragRef.current = DRAG_REST;
        setDrag(DRAG_REST);
        setDragAnim(false);
      }
      if (isZoomed(next) && infoRef.current) {
        infoRef.current = false;
        setInfoOpen(false);
      }
    }
    if (result.drag) {
      const next = scrubDrag(result.drag, infoRef.current);
      window.clearTimeout(dragTimer.current);
      window.cancelAnimationFrame(dragFrame.current);
      dragRef.current = next;
      setDragAnim(false);
      setDrag(next);
    }
    if (result.gesture.mode === "pinch") setPinchFade(result.gesture.pinchFitted === true);
    if (result.pinch === "fit" || result.pinch === "keep") setPinchFade(false);
    const finished = result.gesture.mode === "idle" && result.gesture.pointers.length === 0;
    if (!finished) return;
    if (result.pinch === "close") {
      shrinkAway(zoomRef.current);
      return;
    }
    const action = lightboxGestureAction(result, infoRef.current, isZoomed(zoomRef.current));
    if (action === "show-info") {
      if (result.tap) {
        window.clearTimeout(infoTapTimer.current);
        infoTapTimer.current = window.setTimeout(() => {
          if (infoRef.current || isZoomed(zoomRef.current) || !phoneRef.current) return;
          infoRef.current = true;
          setInfoOpen(true);
        }, DOUBLE_TAP_MS);
      } else {
        window.clearTimeout(infoTapTimer.current);
        infoRef.current = true;
        setInfoOpen(true);
      }
      springDrag();
      return;
    }
    if (action === "hide-info") {
      infoRef.current = false;
      setInfoOpen(false);
      gestureRef.current = freshGesture();
      suppressClick.current = true;
      springDrag();
      return;
    }
    if (action === "close-viewer") {
      flyAway();
      return;
    }
    if (action === "step" && result.step) {
      flySwap(result.step);
      return;
    }
    springDrag();
  };

  const layout = () => {
    const base = frameRef.current;
    const stage = stageRef.current;
    if (!base || !stage) return null;
    return { base, stage: { width: stage.clientWidth, height: stage.clientHeight } };
  };

  const localPoint = (event: ReactPointerEvent<HTMLElement>) => {
    const stage = stageRef.current ?? event.currentTarget;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const beginSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === "mouse") return;
    const target = event.target as Element | null;
    if (target?.closest("button, a, input, textarea")) return;
    swipeRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const endSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.id !== event.pointerId) return;
    swipeRef.current = null;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    step(dx < 0 ? 1 : -1);
  };

  const viewerPhone = () => phoneRef.current || (typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches);

  const echoTouch = (event: ReactPointerEvent<HTMLElement>) =>
    !armed.current || event.timeStamp < openedAt.current;

  const beginPhone = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType !== "touch") return;
    if (echoTouch(event)) {
      event.stopPropagation();
      return;
    }
    const target = event.target as Element | null;
    if (target?.closest("button, a, input, textarea, .lightbox-info")) return;
    const point = localPoint(event);
    const held = stopDragMotion();
    if (abortLeave()) return;
    const place = layout();
    const edges = place ? panEdges(place.base, place.stage, zoomRef.current) : null;
    applyGesture(gestureDown(gestureRef.current, zoomRef.current, event.pointerId, point.x, point.y, held, performance.now(), edges));
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* the pointer can still move inside the viewer */
    }
  };

  const movePhone = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    if (!gestureRef.current.pointers.some((pointer) => pointer.id === event.pointerId)) return;
    const point = localPoint(event);
    applyGesture(gestureMove(gestureRef.current, event.pointerId, point.x, point.y, layout(), performance.now()));
  };

  const endPhone = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    applyGesture(gestureUp(gestureRef.current, zoomRef.current, event.pointerId, performance.now(), layout()));
  };

  const cancelPhone = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    if (abortLeave()) return;
    const gesture = gestureRef.current;
    const zoom = zoomRef.current;
    const pinching = gesture.mode === "pinch" || gesture.pinched;
    const startedFitted = gesture.pinchFitted === true;
    gestureRef.current = freshGesture();
    suppressClick.current = true;
    if (pinching) {
      settlePinch(startedFitted, zoom);
      return;
    }
    stopDragMotion();
    springDrag();
  };

  const closeInfo = () => {
    infoRef.current = false;
    setInfoOpen(false);
    gestureRef.current = freshGesture();
    suppressClick.current = true;
  };

  const onInfoPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.pointerType !== "touch") return;
    infoDragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      top: event.currentTarget.scrollTop,
    };
  };

  const onInfoPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const drag = infoDragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    infoDragRef.current = null;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const endTop = event.currentTarget.scrollTop;
    if (infoSheetDismiss(dx, dy, drag.top, endTop)) {
      closeInfo();
      return;
    }
    const delta = infoSheetStep(dx, dy, drag.top, endTop);
    if (delta !== 0) step(delta);
  };

  const stopInfoEvent = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  if (shownDrag.x > 0.5) slideDir.current = 1;
  else if (shownDrag.x < -0.5) slideDir.current = -1;
  const url = itemId ? (urls.current.get(itemId) ?? null) : null;
  void urlTick;
  const sliding = incomingSlideVisible(phone, stageBox.width, shownDrag, dragAnim, slideDir.current);
  const incomingItem = !sliding ? null : shownDrag.x > 0 || (shownDrag.x >= 0 && slideDir.current > 0) ? prev : next;
  const incomingUrl = incomingItem ? (urls.current.get(incomingItem.id) ?? null) : null;
  const incomingFrame =
    incomingItem && incomingUrl ? containedFrame(stageBox.width, stageBox.height, incomingItem.width, incomingItem.height, 16) : null;
  const incomingShift = Math.abs(shownDrag.x) > 0.5 ? incomingX(shownDrag.x, stageBox.width) : parkedX(slideDir.current === -1 ? -1 : 1, stageBox.width);
  const scrim = phone ? Math.min(scrimForDrag(shownDrag.y, stageBox.height), scrimForPinch(pinchFades, shown.scale)) : 1;
  if (contained && !container) return null;

  return (
    <Dialog.Root open={item !== null} modal={!contained} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal container={contained ? container ?? undefined : undefined}>
        {contained ? (
          <div
            className="lightbox-overlay"
            onPointerDown={(event) => {
              event.stopPropagation();
              onClose();
            }}
          />
        ) : (
        <Dialog.Overlay
          className="lightbox-overlay"
          style={
            phone
              ? {
                  opacity: scrim,
                  animation: "none",
                  transition: dragAnim ? `opacity ${SWIPE_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1)` : "none",
                }
              : undefined
          }
        />
        )}
        <Dialog.Content
          ref={contentRef}
          className={[phone ? "lightbox-content is-phone" : "lightbox-content", editing ? "is-inking" : "", contained ? "is-docked" : ""].filter(Boolean).join(" ")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (contained) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (contained) event.preventDefault();
          }}
          onFocusOutside={(event) => {
            if (contained) event.preventDefault();
          }}
          onPointerDown={(event) => {
            if (editing && event.target instanceof Element && event.target.closest(".ink-layer, .ink-select-host, .ink-tools, .ink-dock")) return;
            if (viewerPhone()) beginPhone(event);
          }}
          onPointerMove={(event) => {
            if (viewerPhone()) movePhone(event);
          }}
          onPointerUp={(event) => {
            if (viewerPhone()) endPhone(event);
          }}
          onPointerCancel={(event) => {
            if (viewerPhone()) cancelPhone(event);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") step(1);
            if (event.key === "ArrowLeft") step(-1);
          }}
        >
          {item ? (
            <>
              {phone ? (
                <>
                  <Dialog.Title className="sr-only">{item.name}</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    {item.width} × {item.height}
                    {total > 1 && index >= 0 ? ` ${index + 1}/${total}` : ""}
                  </Dialog.Description>
                </>
              ) : (
                <div className="lightbox-bar">
                  <div className="min-w-0">
                    <Dialog.Title className="sr-only">{item.name}</Dialog.Title>
                    {item.memo ? <MemoLine text={item.memo} /> : null}
                    <Dialog.Description className="text-sm text-paper/80 tabular-nums">
                      {item.width} × {item.height}
                      {total > 1 && index >= 0 ? ` · ${index + 1}/${total}` : ""}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <Button variant="quiet">閉じる</Button>
                  </Dialog.Close>
                </div>
              )}
              <div
                ref={bindStage}
                className="lightbox-stage"
                onPointerDown={(event) => {
                  if (editing) return;
                  suppressClick.current = false;
                  if (viewerPhone()) return;
                  beginSwipe(event);
                }}
                onPointerUp={(event) => {
                  if (viewerPhone()) return;
                  endSwipe(event);
                }}
                onPointerCancel={() => {
                  if (viewerPhone()) return;
                  swipeRef.current = null;
                }}
                onClick={(event) => {
                  if (!armed.current || event.timeStamp < openedAt.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    event.preventDefault();
                    return;
                  }
                  if (event.target === event.currentTarget) onClose();
                }}
              >
                {incomingFrame && incomingUrl && incomingItem ? (
                  incomingItem.mime.startsWith("video/") ? (
                    <video
                      className="lightbox-incoming"
                      src={incomingUrl}
                      muted
                      playsInline
                      style={mediaStyle(incomingFrame, IDENTITY_ZOOM, true, false, { x: incomingShift, y: 0 }, dragAnim)}
                    />
                  ) : (
                    <img
                      className="lightbox-incoming"
                      src={incomingUrl}
                      alt=""
                      style={mediaStyle(incomingFrame, IDENTITY_ZOOM, true, false, { x: incomingShift, y: 0 }, dragAnim)}
                    />
                  )
                ) : null}
                {url && item.mime.startsWith("video/") ? (
                  <video
                    src={url}
                    muted
                    loop
                    autoPlay
                    playsInline
                    ref={bindMedia}
                    style={frame ? mediaStyle(frame, shown, phone, zoomAnim && sameImage, phone ? shownDrag : DRAG_REST, dragAnim && sameImage, photoOpacity) : undefined}
                  />
                ) : url ? (
                  <img
                    ref={bindMedia}
                    src={url}
                    alt={item.name}
                    style={frame ? mediaStyle(frame, shown, phone, zoomAnim && sameImage, phone ? shownDrag : DRAG_REST, dragAnim && sameImage, photoOpacity) : undefined}
                  />
                ) : (
                  <p className="text-sm text-paper">{failed ? "プレビューを開けませんでした。" : "読み込み中"}</p>
                )}
                {frame && item && !item.animated ? (
                  <ImageInk
                    imageId={item.id}
                    pixelWidth={Math.max(1, item.width)}
                    pixelHeight={Math.max(1, item.height)}
                    live={editing}
                    shown={inkShown || editing}
                    toolsRoot={inkDock}
                    style={mediaStyle(frame, shown, phone, zoomAnim && sameImage, phone ? shownDrag : DRAG_REST, dragAnim && sameImage)}
                  />
                ) : null}
                {frame && !editing ? (
                  <div className="lightbox-hit" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
                    <button
                      type="button"
                      className={hot === "prev" ? "lightbox-edge is-prev is-hot" : "lightbox-edge is-prev"}
                      aria-label="前の画像"
                      onPointerEnter={(event) => {
                        if (event.pointerType === "mouse" && canPrev) setHot("prev");
                      }}
                      onPointerLeave={() => setHot((current) => (current === "prev" ? null : current))}
                      onClick={() => step(-1)}
                    >
                      <span className="edge-veil" aria-hidden="true">
                        <ChevronLeft />
                      </span>
                    </button>
                    <button
                      type="button"
                      className={hot === "next" ? "lightbox-edge is-next is-hot" : "lightbox-edge is-next"}
                      aria-label="次の画像"
                      onPointerEnter={(event) => {
                        if (event.pointerType === "mouse" && canNext) setHot("next");
                      }}
                      onPointerLeave={() => setHot((current) => (current === "next" ? null : current))}
                      onClick={() => step(1)}
                    >
                      <span className="edge-veil" aria-hidden="true">
                        <ChevronRight />
                      </span>
                    </button>
                  </div>
                ) : null}
                {phone && infoOpen ? (
                  <section
                    className="lightbox-info"
                    aria-label="画像情報"
                    onPointerDown={onInfoPointerDown}
                    onPointerMove={stopInfoEvent}
                    onPointerUp={onInfoPointerUp}
                    onPointerCancel={(event) => {
                      stopInfoEvent(event);
                      infoDragRef.current = null;
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {item.memo ? <MemoLine text={item.memo} /> : null}
                    <p className="lightbox-info-label">タグ</p>
                    {tags.length > 0 ? (
                      <div className="lightbox-info-tags">
                        {tags.map((tag) => (
                          <span key={tag.id} className="shot-tag" style={{ background: tag.color }}>
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="lightbox-info-empty">タグなし</p>
                    )}
                  </section>
                ) : null}
              </div>
              {editing ? <div ref={setInkDock} className="ink-dock" /> : null}
              <div className="lightbox-nav">
                {total > 1 ? (
                  <Button variant="quiet" onClick={() => step(-1)} disabled={!canPrev}>
                    前へ
                  </Button>
                ) : (
                  <span />
                )}
                <div className="lightbox-nav-mid">
                  {phone ? (
                    hasInk ? (
                      <span className="ink-pair">
                        <span className="ink-status" aria-label="ペン書き込みあり">
                          <Pencil aria-hidden="true" />
                        </span>
                        <Button
                          variant="quiet"
                          className={editing ? "lightbox-fav is-ink-locked" : inkShown ? "lightbox-fav is-ink-on" : "lightbox-fav"}
                          aria-label={editing ? "編集中は表示を切り替えられません" : inkShown ? "書き込みを隠す" : "書き込みを表示"}
                          aria-pressed={editing ? true : inkShown}
                          disabled={editing}
                          onClick={() => {
                            if (editing) return;
                            void setInkVisible(item.id, !inkShown);
                          }}
                        >
                          {editing || inkShown ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                        </Button>
                      </span>
                    ) : (
                      <span />
                    )
                  ) : item.animated ? (
                    <span />
                  ) : (
                    <span className={hasInk ? "ink-pair" : "ink-pair is-single"}>
                      <Button
                        variant="quiet"
                        className={editing ? "lightbox-fav is-on" : "lightbox-fav"}
                        aria-label={editing ? "ペン書き込みを終了" : "ペン書き込み"}
                        aria-pressed={editing}
                        onClick={() => setInkOn((current) => !current)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      {hasInk ? (
                        <Button
                          variant="quiet"
                          className={editing ? "lightbox-fav is-ink-locked" : inkShown ? "lightbox-fav is-ink-on" : "lightbox-fav"}
                          aria-label={editing ? "編集中は表示を切り替えられません" : inkShown ? "書き込みを隠す" : "書き込みを表示"}
                          aria-pressed={editing ? true : inkShown}
                          disabled={editing}
                          onClick={() => {
                            if (editing) return;
                            void setInkVisible(item.id, !inkShown);
                          }}
                        >
                          {editing || inkShown ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                        </Button>
                      ) : null}
                    </span>
                  )}
                  <Button
                    variant="quiet"
                    className={item.favorite ? "lightbox-fav is-on" : "lightbox-fav"}
                    aria-label={item.favorite ? `${item.name}のお気に入りを解除` : `${item.name}をお気に入りに追加`}
                    aria-pressed={item.favorite}
                    onClick={() => onToggleFavorite(item.id)}
                  >
                    <Heart aria-hidden="true" fill={item.favorite ? "currentColor" : "none"} />
                  </Button>
                </div>
                {total > 1 ? (
                  <Button variant="quiet" onClick={() => step(1)} disabled={!canNext}>
                    次へ
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
