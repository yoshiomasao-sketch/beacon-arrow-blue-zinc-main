import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";

type Selection = { x: number; y: number; w: number; h: number };
type Frame = {
  left: number;
  top: number;
  viewLeft: number;
  viewTop: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
};

export function captureErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return "画面共有がキャンセルされました。切り取る画面を選ぶと、範囲を指定できます。";
  }
  return "画面を取得できませんでした。ブラウザの共有ダイアログで、画面またはウィンドウを選んでください。";
}

type FocusController = {
  setFocusBehavior: (behavior: "focus-captured-surface" | "focus-capturing-application") => void;
};

function shareController(): FocusController | null {
  const Ctor = (globalThis as { CaptureController?: new () => FocusController }).CaptureController;
  if (typeof Ctor !== "function") return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function presentedFrame(video: HTMLVideoElement): Promise<void> {
  const request = video.requestVideoFrameCallback?.bind(video);
  if (!request) return new Promise((resolve) => window.setTimeout(resolve, 50));
  return new Promise((resolve) => {
    request(() => resolve());
  });
}

export async function captureScreenFrame(): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("unsupported");
  const controller = shareController();
  // A monitor capture composites the browser's "currently sharing" indicator into the
  // pixels. A window capture does not. The indicator itself cannot be hidden by the page.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "window" },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    monitorTypeSurfaces: "include",
    surfaceSwitching: "exclude",
    ...(controller ? { controller } : {}),
  } as DisplayMediaStreamOptions);
  if (controller) {
    try {
      controller.setFocusBehavior("focus-capturing-application");
    } catch {
      // Monitor shares reject this hint. Leave the browser's own indicator alone.
    }
  }
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
    if (video.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("timeout")), 5000);
        video.onloadeddata = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });
    }
    await presentedFrame(video);
    await presentedFrame(video);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width < 2 || height < 2) throw new Error("empty");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(video, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png"))), "image/png");
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}

function contentFrame(image: HTMLImageElement): Frame | null {
  const box = image.getBoundingClientRect();
  const origin = image.parentElement?.getBoundingClientRect() ?? box;
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (box.width < 1 || box.height < 1 || naturalWidth < 2 || naturalHeight < 2) return null;
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  const viewLeft = box.left + (box.width - width) / 2;
  const viewTop = box.top + (box.height - height) / 2;
  return {
    left: viewLeft - origin.left,
    top: viewTop - origin.top,
    viewLeft,
    viewTop,
    width,
    height,
    naturalWidth,
    naturalHeight,
  };
}

function cropBlob(image: HTMLImageElement, rect: Selection): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const width = Math.max(1, Math.round(rect.w));
  const height = Math.max(1, Math.round(rect.h));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas"));
  ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png"))), "image/png");
  });
}

export function SnipOverlay({
  url,
  busy,
  onCancel,
  onCrop,
}: {
  url: string;
  busy: boolean;
  onCancel: () => void;
  onCrop: (blob: Blob) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const rectRef = useRef<Selection | null>(null);
  const [rect, setRect] = useState<Selection | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);

  const choose = (next: Selection | null) => {
    rectRef.current = next;
    setRect(next);
  };

  useEffect(() => {
    const onResize = () => {
      const image = imageRef.current;
      if (image) setFrame(contentFrame(image));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const measure = () => {
    const image = imageRef.current;
    if (!image) return;
    setFrame(contentFrame(image));
  };

  const point = (event: ReactPointerEvent) => {
    const image = imageRef.current;
    const current = image ? contentFrame(image) : null;
    if (!image || !current) return null;
    const x = Math.min(current.naturalWidth, Math.max(0, ((event.clientX - current.viewLeft) / current.width) * current.naturalWidth));
    const y = Math.min(
      current.naturalHeight,
      Math.max(0, ((event.clientY - current.viewTop) / current.height) * current.naturalHeight),
    );
    return { x, y };
  };

  const shown =
    rect && frame && rect.w > 1 && rect.h > 1
      ? {
          left: frame.left + (rect.x / frame.naturalWidth) * frame.width,
          top: frame.top + (rect.y / frame.naturalHeight) * frame.height,
          width: (rect.w / frame.naturalWidth) * frame.width,
          height: (rect.h / frame.naturalHeight) * frame.height,
        }
      : null;

  return (
    <div className="snip-layer" role="dialog" aria-modal="true" aria-label="画面の範囲を選択">
      <div
        className="snip-stage"
        onPointerDown={(event) => {
          if (busy) return;
          const start = point(event);
          if (!start) return;
          dragRef.current = start;
          choose({ x: start.x, y: start.y, w: 0, h: 0 });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = dragRef.current;
          const current = point(event);
          if (!start || !current) return;
          setRect({
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            w: Math.abs(current.x - start.x),
            h: Math.abs(current.y - start.y),
          });
          rectRef.current = {
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            w: Math.abs(current.x - start.x),
            h: Math.abs(current.y - start.y),
          };
        }}
        onPointerUp={() => {
          const chosen = rectRef.current;
          dragRef.current = null;
          const image = imageRef.current;
          if (!image || !chosen || chosen.w < 8 || chosen.h < 8 || busy) {
            if (!busy) choose(null);
            return;
          }
          choose(null);
          void cropBlob(image, chosen)
            .then(onCrop)
            .catch(() => onCancel());
        }}
      >
        <img ref={imageRef} src={url} alt="" draggable={false} onLoad={measure} />
        {shown ? (
          <div className="snip-rect" style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height }}>
            <span className="snip-size" style={{ top: shown.top < 36 ? "100%" : "auto", bottom: shown.top < 36 ? "auto" : "100%" }}>
              {Math.round(rect?.x ?? 0)}, {Math.round(rect?.y ?? 0)} · {Math.round(rect?.w ?? 0)} × {Math.round(rect?.h ?? 0)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="snip-bar">
        <p className="text-sm">ドラッグして範囲を指定します。離すと、その範囲を追加します。</p>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          {busy ? "追加中" : "キャンセル"}
        </Button>
      </div>
    </div>
  );
}
