import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readPixels } from "@/lib/portfolio/db";
import { cachedOriginal, downloadOriginal, OWN_FILE_DRAG, primeOriginal } from "@/lib/portfolio/export-file";
import { exportFileName } from "@/lib/portfolio/logic";
import { loadThumb, pinThumb } from "@/lib/portfolio/thumbs";
import type { ImageMeta } from "@/lib/portfolio/types";

function FileRow({ item, onJump, viewer }: { item: ImageMeta; onJump: (id: string) => void; viewer: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [primed, setPrimed] = useState(() => cachedOriginal(item.id) !== null);
  const dragged = useRef(false);
  const name = exportFileName(item.name, item.mime);

  useEffect(() => {
    let cancelled = false;
    const unpin = pinThumb(item.id);
    loadThumb(item.id, (id) => readPixels(id, "thumb"))
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    void (viewer ? Promise.resolve(null) : primeOriginal(item)).then((file) => {
      if (!cancelled && file) setPrimed(true);
    });
    return () => {
      cancelled = true;
      unpin();
    };
  }, [item.id, viewer]);

  const prepare = () => {
    void primeOriginal(item).then((file) => {
      if (file) setPrimed(true);
    });
  };

  return (
    <li className="file-line">
      <div
        className={dragging ? "file-row is-dragging" : "file-row"}
        draggable={!viewer && primed}
        title={viewer ? name : primed ? `${name} をドラッグして渡せます` : "ファイルを準備しています"}
        onPointerEnter={() => {
          if (!viewer) prepare();
        }}
        onDragStart={(event) => {
          if (viewer) {
            event.preventDefault();
            return;
          }
          const file = cachedOriginal(item.id);
          const transfer = event.dataTransfer;
          if (!file || !transfer) {
            event.preventDefault();
            return;
          }
          transfer.effectAllowed = "copy";
          transfer.setData(OWN_FILE_DRAG, item.id);
          transfer.setData("text/plain", file.name);
          try {
            transfer.items.add(file);
          } catch {
            event.preventDefault();
            return;
          }
          const image = event.currentTarget.querySelector("img");
          if (image) transfer.setDragImage(image, 16, 16);
          dragged.current = true;
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          onJump(item.id);
        }}
      >
        {url ? <img src={url} alt="" draggable={false} /> : <span className="file-thumb" />}
        <span className="file-name">{name}</span>
      </div>
      <button
        type="button"
        className="file-download"
        aria-label={`${name}をダウンロード`}
        draggable={false}
        hidden={viewer}
        onClick={() => {
          if (viewer) return;
          void downloadOriginal(item);
        }}
      >
        <Download aria-hidden="true" />
      </button>
    </li>
  );
}

export function FileDock({ items, onJump, viewer = false }: { items: ImageMeta[]; onJump: (id: string) => void; viewer?: boolean }) {
  const signature = items.map((item) => item.id).join("|");
  useEffect(() => {
    for (const item of items.slice(0, 4)) void primeOriginal(item);
  }, [signature, items]);

  return (
    <section className="file-dock" aria-label="ファイル一覧">
      <h2 className="file-dock-title">ファイル一覧</h2>
      {items.length === 0 ? (
        <p className="file-empty">このフォルダにファイルはありません</p>
      ) : (
        <ul className="file-scroll">
          {items.map((item) => (
            <FileRow key={item.id} item={item} onJump={onJump} viewer={viewer} />
          ))}
        </ul>
      )}
    </section>
  );
}
