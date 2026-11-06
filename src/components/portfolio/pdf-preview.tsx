import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { readPixels } from "@/lib/portfolio/db";
import {
  clampPdfGap,
  clampPdfMargin,
  layoutPdfSelection,
  type PageOrientation,
  type PdfMode,
} from "@/lib/portfolio/logic";
import { buildPortfolioPdf } from "@/lib/portfolio/pdf";
import { notify } from "@/lib/portfolio/store";
import type { ImageMeta } from "@/lib/portfolio/types";

export function PdfPreview({
  open,
  items,
  columns,
  onOpenChange,
}: {
  open: boolean;
  items: ImageMeta[];
  columns: number;
  onOpenChange: (open: boolean) => void;
}) {
  const [orientation, setOrientation] = useState<PageOrientation>("portrait");
  const [mode, setMode] = useState<PdfMode>("fit");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [marginMm, setMarginMm] = useState(10);
  const [gapMm, setGapMm] = useState(2);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdfOptions = { orientation, columns, mode, marginMm, gapMm, favoritesOnly };
  const layout = layoutPdfSelection(items, pdfOptions);
  const picked = favoritesOnly ? items.filter((item) => item.favorite) : items;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(
      items.map(async (item) => {
        const blob = await readPixels(item.id, "thumb");
        if (!blob) return [item.id, ""] as const;
        const url = URL.createObjectURL(blob);
        created.push(url);
        return [item.id, url] as const;
      }),
    ).then((pairs) => {
      if (cancelled) {
        created.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      setUrls(Object.fromEntries(pairs.filter((pair) => pair[1])));
    });
    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
      setUrls({});
    };
  }, [open, items]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content">
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <Dialog.Title className="font-medium">PDFプレビュー</Dialog.Title>
              <Dialog.Description className="text-sm text-ink-muted">
                {favoritesOnly ? "お気に入りだけを出力します。" : "フォルダ内の画像を出力します。"}
                {mode === "fit"
                  ? "用紙を埋めるように並べ直します。画面の順番と大きさは変わりません。"
                  : "いまの順番と表示サイズの関係を保って、A4に収めます。"}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="quiet">閉じる</Button>
            </Dialog.Close>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
            <Button variant={mode === "normal" ? "primary" : "quiet"} onClick={() => setMode("normal")}>
              通常
            </Button>
            <Button variant={mode === "fit" ? "primary" : "quiet"} onClick={() => setMode("fit")}>
              フィット
            </Button>
            <Button
              variant={favoritesOnly ? "primary" : "quiet"}
              aria-pressed={favoritesOnly}
              onClick={() => setFavoritesOnly((value) => !value)}
            >
              {favoritesOnly ? "お気に入りのみ" : "すべての画像"}
            </Button>
            <Button
              variant={orientation === "portrait" ? "primary" : "quiet"}
              onClick={() => setOrientation("portrait")}
            >
              A4縦
            </Button>
            <Button
              variant={orientation === "landscape" ? "primary" : "quiet"}
              onClick={() => setOrientation("landscape")}
            >
              A4横
            </Button>
            <p className="self-center text-sm text-ink-muted tabular-nums">{layout.pageCount}ページ</p>
          </div>
          {mode === "fit" ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
              <span className="text-sm text-ink-muted">余白</span>
              <Button
                variant="quiet"
                aria-label="余白を狭く"
                disabled={marginMm <= 4}
                onClick={() => setMarginMm((value) => clampPdfMargin(value - 2))}
              >
                −
              </Button>
              <span className="min-w-12 text-center text-sm tabular-nums">{marginMm}mm</span>
              <Button
                variant="quiet"
                aria-label="余白を広く"
                disabled={marginMm >= 24}
                onClick={() => setMarginMm((value) => clampPdfMargin(value + 2))}
              >
                ＋
              </Button>
              <span className="ml-2 text-sm text-ink-muted">間隔</span>
              <Button
                variant="quiet"
                aria-label="間隔を狭く"
                disabled={gapMm <= 0}
                onClick={() => setGapMm((value) => clampPdfGap(value - 1))}
              >
                −
              </Button>
              <span className="min-w-12 text-center text-sm tabular-nums">{gapMm}mm</span>
              <Button
                variant="quiet"
                aria-label="間隔を広く"
                disabled={gapMm >= 8}
                onClick={() => setGapMm((value) => clampPdfGap(value + 1))}
              >
                ＋
              </Button>
            </div>
          ) : null}
          <div className="pdf-scroll px-4 py-4">
            {picked.length === 0 ? (
              <p className="text-sm text-ink-muted">出力できる画像がありません。</p>
            ) : null}
            {Array.from({ length: layout.pageCount }, (_, page) => (
              <div
                key={`${mode}-${favoritesOnly}-${orientation}-${page}`}
                className="pdf-sheet"
                style={{ aspectRatio: `${layout.pageWidth} / ${layout.pageHeight}` }}
              >
                {layout.placements
                  .filter((place) => place.page === page)
                  .map((place) =>
                    urls[place.id] ? (
                      <img
                        key={place.id}
                        src={urls[place.id]}
                        alt=""
                        style={{
                          left: `${(place.x / layout.pageWidth) * 100}%`,
                          top: `${(place.y / layout.pageHeight) * 100}%`,
                          width: `${(place.w / layout.pageWidth) * 100}%`,
                          height: `${(place.h / layout.pageHeight) * 100}%`,
                        }}
                      />
                    ) : null,
                  )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : (
              <span />
            )}
            <Button
              disabled={saving || picked.length === 0}
              onClick={() => {
                setSaving(true);
                setError(null);
                void buildPortfolioPdf(items, pdfOptions)
                  .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = "komacho.pdf";
                    link.click();
                    URL.revokeObjectURL(url);
                  })
                  .catch(() => {
                    const message = "PDFを書き出せませんでした。もう一度保存を押してください。";
                    setError(message);
                    notify(message);
                  })
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? "書き出し中" : error ? "再試行" : "PDFを保存"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}