import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";

/**
 * Checks for a signed desktop update once after the Tauri app starts.
 * The browser version is intentionally unaffected.
 */
export function TauriUpdater() {
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
