import { isAnimatedImage } from "./logic.ts";
import type { SupportedMime } from "./types.ts";

const THUMB_EDGE = 640;

export class ImagePrepareError extends Error {
  readonly kind = "decode" as const;

  constructor() {
    super("decode");
    this.name = "ImagePrepareError";
  }
}

export type PreparedImage = {
  width: number;
  height: number;
  original: Blob;
  /** Null when the original is already small enough for the grid. */
  thumb: Blob | null;
  animated: boolean;
};

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  const paint = (mime: string) =>
    new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), mime, 0.82);
    });

  return paint(type).then((blob) => {
    if (blob) return blob;
    if (type === "image/jpeg") throw new ImagePrepareError();
    return paint("image/jpeg").then((fallback) => {
      if (!fallback) throw new ImagePrepareError();
      return fallback;
    });
  });
}

function prepareVideo(original: Blob): Promise<PreparedImage> {
  const url = URL.createObjectURL(original);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  return new Promise((resolve, reject) => {
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new ImagePrepareError());
    };
    video.onerror = fail;
    video.onloadeddata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width < 1 || height < 1) {
        fail();
        return;
      }
      const longEdge = Math.max(width, height);
      const scale = longEdge <= THUMB_EDGE ? 1 : THUMB_EDGE / longEdge;
      const tw = Math.max(1, Math.round(width * scale));
      const th = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        fail();
        return;
      }
      ctx.drawImage(video, 0, 0, tw, th);
      canvas.toBlob((poster) => {
        URL.revokeObjectURL(url);
        if (!poster) reject(new ImagePrepareError());
        else resolve({ width, height, original, thumb: poster, animated: true });
      }, "image/jpeg", 0.82);
    };
  });
}

export async function prepareImage(file: Blob, mime: SupportedMime): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const animated = isAnimatedImage(bytes, mime);
  const original = new Blob([bytes], { type: mime });
  if (mime === "video/mp4" || mime === "video/webm") return prepareVideo(original);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(original, { imageOrientation: "from-image" });
  } catch {
    throw new ImagePrepareError();
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width < 1 || height < 1) throw new ImagePrepareError();

    const longEdge = Math.max(width, height);
    if (!animated && longEdge <= THUMB_EDGE) {
      return { width, height, original, thumb: null, animated };
    }

    const scale = longEdge <= THUMB_EDGE ? 1 : THUMB_EDGE / longEdge;
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d", { alpha: mime === "image/png" || mime === "image/gif" || mime === "image/webp" });
    if (!ctx) throw new ImagePrepareError();
    ctx.drawImage(bitmap, 0, 0, tw, th);
    const thumbType = mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const thumb = await canvasToBlob(canvas, thumbType);
    return { width, height, original, thumb, animated };
  } finally {
    bitmap.close();
  }
}
