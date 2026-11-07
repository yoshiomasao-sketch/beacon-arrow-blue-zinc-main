
import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";

/**
 * Checks for a signed desktop update once after the Tauri app starts.
 * The browser version is intentionally unaffected.
 */
export function TauriUpdater() {
  // Set the desktop window title with the current app version.
  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    void (async () => {
      try {
        const version = await getVersion();

        if (cancelled) return;

        await getCurrentWindow().setTitle(
          `ポートフォリオΔ v${version}`
        );
      } catch (error) {
        console.error("Failed to set window title:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Check for application updates.
  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    void (async () => {
      let update: Awaited<ReturnType<typeof check>> = null;
      try {
        update = await check();
        if (!update || cancelled) return;

        const accepted = window.confirm(
          `ポートフォリオΔの新しいバージョン（${update.version}）があります。\n\n今すぐ更新しますか？\n更新中はアプリが終了します。`,
        );

        if (!accepted || cancelled) {
          await update.close();
          return;
        }

        await update.downloadAndInstall();
      } catch (error) {
        console.error("Tauri updater failed:", error);
        if (!cancelled) {
          window.alert("アップデートの確認またはインストールに失敗しました。\n時間をおいて再度お試しください。");
        }
      } finally {
        if (update && !cancelled) {
          try {
            await update.close();
          } catch {
            // The updater resource may already be released after installation.
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
