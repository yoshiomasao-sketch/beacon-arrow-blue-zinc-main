import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { readPixels } from "@/lib/portfolio/db";
import {
  advanceDeck,
  clampSlideSeconds,
  slideshowCandidates,
  startDeck,
  type SlideshowCursor,
  type SlideshowOrder,
} from "@/lib/portfolio/slideshow";
import { notify } from "@/lib/portfolio/store";
import type { ImageMeta } from "@/lib/portfolio/types";

const EMPTY_NOTE = "表示中の画像がないため、スライドショーを開始できません。";

export function Slideshow({
  open,
  items,
  onOpenChange,
  container = null,
  dock = false,
  anchor = null,
}: {
  open: boolean;
  items: ImageMeta[];
  onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
  dock?: boolean;
  anchor?: HTMLElement | null;
}) {
  const [order, setOrder] = useState<SlideshowOrder>("sequence");
  const [seconds, setSeconds] = useState(5);
  const [showClock, setShowClock] = useState(false);
  const [zoom, setZoom] = useState(true);
  const [play, setPlay] = useState<{
    items: ImageMeta[];
    order: SlideshowOrder;
    seconds: number;
    showClock: boolean;
    zoom: boolean;
  } | null>(null);

  useEffect(() => {
    if (open) return;
    setPlay(null);
    setOrder("sequence");
    setSeconds(5);
    setShowClock(false);
    setZoom(true);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  if (play) {
    if (dock && !container) return null;
    const host = container ?? document.body;
    return createPortal(
      <SlideshowPlayer
        items={play.items}
        order={play.order}
        seconds={play.seconds}
        showClock={play.showClock}
        zoom={play.zoom}
        docked={dock}
        onClose={() => onOpenChange(false)}
      />,
      host,
    );
  }

  const start = () => {
    const list = slideshowCandidates(items).slice();
    if (list.length === 0) {
      notify(EMPTY_NOTE);
      onOpenChange(false);
      return;
    }
    setPlay({ items: list, order, seconds: clampSlideSeconds(seconds), showClock, zoom });
  };

  return createPortal(
    <SlideshowSetup
      anchor={anchor}
      order={order}
      seconds={seconds}
      showClock={showClock}
      zoom={zoom}
      onOrder={setOrder}
      onSeconds={setSeconds}
      onShowClock={setShowClock}
      onZoom={setZoom}
      onClose={() => onOpenChange(false)}
      onStart={start}
    />,
    document.body,
  );
}

function SlideshowSetup({
  anchor,
  order,
  seconds,
  showClock,
  zoom,
  onOrder,
  onSeconds,
  onShowClock,
  onZoom,
  onClose,
  onStart,
}: {
  anchor: HTMLElement | null;
  order: SlideshowOrder;
  seconds: number;
  showClock: boolean;
  zoom: boolean;
  onOrder: (order: SlideshowOrder) => void;
  onSeconds: (seconds: number) => void;
  onShowClock: (shown: boolean) => void;
  onZoom: (zoom: boolean) => void;
  onClose: () => void;
  onStart: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const secondsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [secondsOpen, setSecondsOpen] = useState(false);
  const [menuMax, setMenuMax] = useState(240);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const node = cardRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const rect = anchor?.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      let top = rect ? rect.bottom + gap : Math.max(margin, (window.innerHeight - box.height) / 2);
      let left = rect ? rect.left : Math.max(margin, (window.innerWidth - box.width) / 2);
      if (left + box.width > window.innerWidth - margin) left = window.innerWidth - margin - box.width;
      if (left < margin) left = margin;
      if (top + box.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - box.height);
      if (top < margin) top = margin;
      setPos((current) => (current && current.top === top && current.left === left ? current : { top, left }));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useLayoutEffect(() => {
    if (!secondsOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    const top = menu.getBoundingClientRect().top;
    setMenuMax(Math.max(40, window.innerHeight - top - 8));
    const chosen = menu.querySelector("[aria-selected='true']");
    if (!(chosen instanceof HTMLElement)) return;
    const start = chosen.offsetTop;
    const end = start + chosen.offsetHeight;
    if (start < menu.scrollTop) menu.scrollTop = start;
    else if (end > menu.scrollTop + menu.clientHeight) menu.scrollTop = end - menu.clientHeight;
  }, [secondsOpen, pos]);

  return (
    <div className="slideshow-setup is-anchored" onClick={onClose}>
      <div
        ref={cardRef}
        className="slideshow-setup-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slideshow-title"
        style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: 0 }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          const target = event.target;
          if (target instanceof Node && secondsRef.current?.contains(target)) return;
          setSecondsOpen(false);
        }}
      >
        <div>
          <h2 id="slideshow-title" className="m-0 text-base font-medium">
            スライドショー
          </h2>
          <p className="m-0 mt-1 text-sm text-ink-muted">いま一覧に出ている画像を再生します。</p>
        </div>
        <div>
          <p className="m-0 text-sm">画像の順番</p>
          <div className="slideshow-choices" role="group" aria-label="画像の順番">
            <Button variant={order === "sequence" ? "primary" : "quiet"} aria-pressed={order === "sequence"} onClick={() => onOrder("sequence")}>
              順番どおり
            </Button>
            <Button variant={order === "random" ? "primary" : "quiet"} aria-pressed={order === "random"} onClick={() => onOrder("random")}>
              ランダム
            </Button>
          </div>
        </div>
        <div className="text-sm">
          切り替え間隔
          <div className="slideshow-seconds" ref={secondsRef}>
            <button
              type="button"
              aria-label="切り替え間隔"
              aria-haspopup="listbox"
              aria-expanded={secondsOpen}
              onClick={() => {
                setSecondsOpen((open) => {
                  if (open) return false;
                  const rect = secondsRef.current?.getBoundingClientRect();
                  if (rect) setMenuMax(Math.max(40, window.innerHeight - rect.bottom - 10));
                  return true;
                });
              }}
            >
              {seconds}秒
            </button>
            {secondsOpen ? (
              <div ref={menuRef} className="slideshow-seconds-menu" role="listbox" aria-label="切り替え間隔" style={{ maxHeight: menuMax }}>
                {Array.from({ length: 60 }, (_, index) => index + 1).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="option"
                    aria-selected={value === seconds}
                    onClick={() => {
                      onSeconds(clampSlideSeconds(value));
                      setSecondsOpen(false);
                    }}
                  >
                    {value}秒
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <label className="slideshow-clock-option">
          <input type="checkbox" checked={zoom} onChange={(event) => onZoom(event.target.checked)} />
          ゆっくり拡大する
        </label>
        <label className="slideshow-clock-option">
          <input type="checkbox" checked={showClock} onChange={(event) => onShowClock(event.target.checked)} />
          切り替えまでの秒数を表示
        </label>
        <div className="slideshow-actions">
          <Button variant="quiet" onClick={onClose}>
            キャンセル
          </Button>
          <Button onClick={onStart}>開始</Button>
        </div>
      </div>
    </div>
  );
}

function SlideshowPlayer({
  items,
  order,
  seconds,
  showClock,
  zoom,
  docked = false,
  onClose,
}: {
  items: ImageMeta[];
  order: SlideshowOrder;
  seconds: number;
  showClock: boolean;
  zoom: boolean;
  docked?: boolean;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  const [layers, setLayers] = useState<Array<{ token: number; url: string; on: boolean }>>([]);
  const [remaining, setRemaining] = useState(seconds);
  const tokenRef = useRef(0);
  const endsAtRef = useRef(0);
  const showClockRef = useRef(showClock);
  showClockRef.current = showClock;

  useEffect(() => {
    let alive = true;
    const urls = new Map<string, string>();
    let timer = 0;
    let reveal = 0;
    let failures = 0;
    let cursor: SlideshowCursor = startDeck(items.length, order);
    let pending: SlideshowCursor | null = null;

    const urlFor = async (id: string) => {
      const cached = urls.get(id);
      if (cached) return cached;
      const blob = await readPixels(id, "original");
      if (!blob || !alive) return null;
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      return url;
    };

    const warm = (index: number | undefined) => {
      const item = index === undefined ? undefined : items[index];
      if (!item) return;
      void urlFor(item.id).then((url) => {
        if (url && alive) void decodeImage(url).catch(() => undefined);
      });
    };

    const show = async (index: number) => {
      if (!alive) return;
      const item = items[index];
      if (!item) return;
      const url = await urlFor(item.id);
      if (!alive) return;
      if (!url) {
        failures += 1;
        if (failures > items.length) return;
        pending = null;
        cursor = advanceDeck(cursor, items.length, order);
        void show(cursor.deck[cursor.at] ?? index);
        return;
      }
      try {
        await decodeImage(url);
      } catch {
        /* A failed decode still tries the blob URL. */
      }
      if (!alive) return;
      failures = 0;
      const token = tokenRef.current + 1;
      tokenRef.current = token;
      setLayers((current) => [...current.map((layer) => ({ ...layer, on: false })), { token, url, on: false }].slice(-2));
      reveal = window.requestAnimationFrame(() => {
        reveal = window.requestAnimationFrame(() => {
          if (!alive) return;
          setLayers((current) => current.map((layer) => (layer.token === token ? { ...layer, on: true } : layer)));
        });
      });
      pending = advanceDeck(cursor, items.length, order);
      warm(pending.deck[pending.at]);
      const endsAt = performance.now() + seconds * 1000;
      endsAtRef.current = endsAt;
      if (showClockRef.current) setRemaining(seconds);
      timer = window.setTimeout(() => {
        if (!alive || !pending) return;
        cursor = pending;
        pending = null;
        void show(cursor.deck[cursor.at] ?? 0);
      }, endsAt - performance.now());
    };

    void show(cursor.deck[cursor.at] ?? 0);

    const onKey = (event: KeyboardEvent) => {
      if (dockedRef.current) {
        const target = event.target;
        if (target instanceof Node && document.querySelector(".canvas-pane")?.contains(target)) return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(reveal);
      window.removeEventListener("keydown", onKey, true);
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [items, order, seconds]);

  useEffect(() => {
    if (docked) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [docked]);

  useEffect(() => {
    if (!showClock) return;
    const tick = () => {
      const endsAt = endsAtRef.current;
      if (endsAt <= 0) return;
      const next = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
      setRemaining((current) => (current === next ? current : next));
    };
    tick();
    const clock = window.setInterval(tick, 200);
    return () => {
      window.clearInterval(clock);
      endsAtRef.current = 0;
    };
  }, [showClock]);

  return (
    <div
      className="slideshow-stage"
      role="button"
      tabIndex={0}
      aria-label="スライドショーを終了"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {layers.map((layer) => (
        <div
          key={layer.token}
          className={layer.on ? "slideshow-photo is-on" : "slideshow-photo"}
          data-zoom={zoom ? "on" : "off"}
          style={{ ["--slide-ms" as string]: `${seconds * 1000}ms` }}
        >
          <img src={layer.url} alt="" draggable={false} />
        </div>
      ))}
      {showClock ? (
        <p className="slideshow-remaining" aria-live="polite">
          {remaining} 秒
        </p>
      ) : null}
    </div>
  );
}

function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.decoding = "async";
  const ready = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("load"));
  });
  image.src = url;
  if (typeof image.decode === "function") return image.decode().catch(() => ready);
  return ready;
}
