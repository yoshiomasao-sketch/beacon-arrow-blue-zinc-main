import { readPixels } from "./db.ts";
import { layoutPdfSelection, type PageOrientation, type PdfMode } from "./logic.ts";
import type { ImageMeta } from "./types.ts";

const MM = 72 / 25.4;

function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) return 1;
    const size = view.getUint16(offset + 2);
    if (marker === 0xe1 && size >= 16) {
      const start = offset + 4;
      if (view.getUint32(start) !== 0x45786966) return 1;
      const endian = view.getUint16(start + 6);
      const little = endian === 0x4949;
      if (!little && endian !== 0x4d4d) return 1;
      const tiff = start + 6;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > bytes.length) return 1;
      const count = view.getUint16(ifd, little);
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > bytes.length) break;
        if (view.getUint16(entry, little) === 0x0112) {
          return view.getUint16(entry + 8, little) || 1;
        }
      }
      return 1;
    }
    if (size < 2) return 1;
    offset += 2 + size;
  }
  return 1;
}

async function rasterPng(blob: Blob, maxEdge?: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = maxEdge && longEdge > maxEdge ? maxEdge / longEdge : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("png"))), "image/png");
    });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function pngBytes(blob: Blob): Promise<Uint8Array> {
  try {
    return await rasterPng(blob);
  } catch {
    return rasterPng(blob, 4096);
  }
}

export async function buildPortfolioPdf(
  items: ImageMeta[],
  options: {
    columns: number;
    orientation: PageOrientation;
    mode?: PdfMode;
    marginMm?: number;
    gapMm?: number;
    favoritesOnly?: boolean;
  },
): Promise<Blob> {
  const { PDFDocument } = await import("pdf-lib");
  const layout = layoutPdfSelection(items, options);
  const pdf = await PDFDocument.create();
  const pages = Array.from({ length: Math.max(layout.pageCount, 1) }, () =>
    pdf.addPage([layout.pageWidth * MM, layout.pageHeight * MM]),
  );

  for (const place of layout.placements) {
    const item = items.find((entry) => entry.id === place.id);
    const page = pages[place.page];
    if (!item || !page) continue;
    const blob = await readPixels(item.id, "original");
    if (!blob) throw new Error("missing image");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const image = item.animated
      ? await pdf.embedPng(await pngBytes(blob))
      : item.mime === "image/png"
        ? await pdf.embedPng(bytes)
        : item.mime === "image/jpeg" && jpegOrientation(bytes) <= 1
          ? await pdf.embedJpg(bytes)
          : await pdf.embedPng(await pngBytes(blob));
    page.drawImage(image, {
      x: place.x * MM,
      y: (layout.pageHeight - place.y - place.h) * MM,
      width: place.w * MM,
      height: place.h * MM,
    });
  }

  const saved = await pdf.save();
  const copy = new ArrayBuffer(saved.byteLength);
  new Uint8Array(copy).set(saved);
  return new Blob([copy], { type: "application/pdf" });
}
