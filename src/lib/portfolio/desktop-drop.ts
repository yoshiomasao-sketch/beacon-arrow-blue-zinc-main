import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readFile } from "@tauri-apps/plugin-fs";

export type DesktopDrop = {
  files: File[];
  point: { x: number; y: number } | null;
  failed: number;
};

let listening = false;

export function desktopDropsListening(): boolean {
  return listening;
}

export function isDesktopShell(): boolean {
  return isTauri();
}

export function fileNameFromPath(path: string): string {
  const name = path.split(/[/\\]/).pop()?.trim() ?? "";
  return name || "dropped";
}

export function desktopDropPoint(
  position: { x: number; y: number } | null,
  ratio: number,
): { x: number; y: number } | null {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const scale = ratio > 0 ? ratio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

/** Tauriのドラッグ＆ドロップイベントからファイルパスと座標を取得する。 */
export function parseDesktopDropEvent(
  raw: unknown,
): { paths: string[]; position: { x: number; y: number } | null } | null {
  const record = asRecord(raw);
  if (!record) return null;

  const payload = asRecord(record.payload) ?? record;

  const paths = Array.isArray(payload.paths)
    ? payload.paths.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
    : [];

  if (paths.length === 0) return null;

  const position = asRecord(payload.position);
  const x = position?.x;
  const y = position?.y;

  return {
    paths,
    position:
      typeof x === "number" && typeof y === "number"
        ? { x, y }
        : null,
  };
}

async function fileFromPath(path: string): Promise<File> {
  const bytes = await readFile(path);

  if (bytes.byteLength === 0) {
    throw new Error("empty");
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  return new File([copy.buffer], fileNameFromPath(path));
}

/** Tauriデスクトップ版のOSファイルドロップを監視する。 */
export async function startDesktopFileDrops(
  onDrop: (drop: DesktopDrop) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};

  try {
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;

      const parsed = parseDesktopDropEvent(event.payload);
      if (!parsed) return;

      const point = desktopDropPoint(
        parsed.position,
        window.devicePixelRatio || 1,
      );

      void (async () => {
        const files: File[] = [];
        let failed = 0;

        for (const path of parsed.paths) {
          try {
            files.push(await fileFromPath(path));
          } catch (error) {
            console.error("Dropped file could not be read:", path, error);
            failed += 1;
          }
        }

        onDrop({ files, point, failed });
      })();
    });

    listening = true;

    return () => {
      listening = false;
      unlisten();
    };
  } catch (error) {
    listening = false;
    console.error("Desktop file drop listener could not be started:", error);
    return () => {};
  }
}
