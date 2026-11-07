
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import { measureStorage } from "@/lib/portfolio/db";
import {
  formatBytes,
  formatCheckedAt,
  storagePressure,
  storageRatio,
  type StorageSnapshot,
} from "@/lib/portfolio/storage-usage";

function Amount({ value, pending }: { value: number | null; pending: boolean }) {
  if (pending) return <span className="text-ink-muted">計測しています</span>;
  return <span className="tabular-nums">{value === null ? "取得できません" : formatBytes(value)}</span>;
}

export function StorageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");

  const desktop = isTauri();

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    setMeasuring(true);
    setSnapshot(null);

    void measureStorage().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      setMeasuring(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !desktop) return;

    let cancelled = false;

    void getVersion()
      .then((currentVersion) => {
        if (!cancelled) setVersion(currentVersion);
      })
      .catch((error) => {
        console.error("Failed to get app version:", error);
        if (!cancelled) setVersion(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, desktop]);

  const handleCheckUpdate = async () => {
    if (!desktop || checkingUpdate) return;

    setCheckingUpdate(true);
    setUpdateMessage("更新を確認しています。");

    let update: Awaited<ReturnType<typeof check>> = null;

    try {
      update = await check();

      if (!update) {
        setUpdateMessage("最新バージョンを使用しています。");
        return;
      }

      const accepted = window.confirm(
        `ポートフォリオΔの新しいバージョン（${update.version}）があります。\n\n今すぐ更新しますか？\n更新中はアプリが終了します。`,
      );

      if (!accepted) {
        setUpdateMessage("更新をキャンセルしました。");
        return;
      }

      setUpdateMessage("アップデートをダウンロードしています。");
      await update.downloadAndInstall();
      setUpdateMessage("アップデートが完了しました。アプリを再起動してください。");
    } catch (error) {
      console.error("Manual update check failed:", error);
      setUpdateMessage("アップデートの確認またはインストールに失敗しました。時間をおいて再度お試しください。");
    } finally {
      if (update) {
        try {
          await update.close();
        } catch {
          // The updater resource may already be released after installation.
        }
      }
      setCheckingUpdate(false);
    }
  };

  const usage = snapshot?.browser.usage ?? null;
  const quota = snapshot?.browser.quota ?? null;
  const ratio = storageRatio(usage, quota);
  const pressure = storagePressure(usage, quota);
  const remaining = usage !== null && quota !== null ? Math.max(0, quota - usage) : null;
  const appTotal =
    snapshot?.app == null
      ? null
      : snapshot.app.originals + snapshot.app.thumbs + (snapshot.app.meta ?? 0);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="storage-sheet">
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <Dialog.Title className="font-medium">詳細</Dialog.Title>
              <Dialog.Description className="text-sm text-ink-muted">
                アプリのバージョン情報と保存容量を確認できます。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="quiet">閉じる</Button>
            </Dialog.Close>
          </div>
          <div className="space-y-4 px-4 py-4 text-sm">
            <section className="space-y-2">
              <h2 className="font-medium">バージョン情報</h2>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <dt>アプリの種類</dt>
                <dd className="text-right">{desktop ? "デスクトップ版" : "ブラウザ版"}</dd>
                {desktop ? (
                  <>
                    <dt>現在のバージョン</dt>
                    <dd className="text-right tabular-nums">
                      {version ?? "取得できません"}
                    </dd>
                  </>
                ) : null}
              </dl>
              {desktop ? (
                <>
                  <Button
                    variant="quiet"
                    disabled={checkingUpdate}
                    onClick={() => void handleCheckUpdate()}
                  >
                    {checkingUpdate ? "確認中…" : "更新を確認"}
                  </Button>
                  {updateMessage ? (
                    <p className="text-xs text-ink-muted" aria-live="polite">
                      {updateMessage}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-ink-faint">
                  ブラウザ版は自動的に最新の内容が読み込まれます。
                </p>
              )}
            </section>
            <section className="space-y-2">
              <h2 className="font-medium">このアプリの使用量</h2>
              {measuring ? <p className="text-ink-muted">容量を計測しています。</p> : null}
              {snapshot?.app ? (
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                  <dt>画像・動画</dt>
                  <dd className="text-right">
                    <Amount value={snapshot.app.originals} pending={false} />
                  </dd>
                  <dt className="text-ink-muted">サムネイル</dt>
                  <dd className="text-right text-ink-muted">
                    <Amount value={snapshot.app.thumbs} pending={false} />
                  </dd>
                  <dt className="text-ink-muted">メタデータ（概算）</dt>
                  <dd className="text-right text-ink-muted">
                    <Amount value={snapshot.app.meta} pending={false} />
                  </dd>
                  <dt>合計</dt>
                  <dd className="text-right">
                    <Amount value={appTotal} pending={false} />
                  </dd>
                </dl>
              ) : measuring ? null : (
                <p>取得できません</p>
              )}
              <p className="text-xs text-ink-faint">
                画像・動画は元ファイル、サムネイルは一覧用の別データです。同じファイルを二重には数えていません。合計にデータベースの管理領域は含みません。
              </p>
            </section>
            <section className="space-y-2">
              <h2 className="font-medium">ブラウザの保存容量の目安</h2>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <dt>使用量</dt>
                <dd className="text-right">
                  <Amount value={usage} pending={!snapshot} />
                </dd>
                <dt>保存可能容量</dt>
                <dd className="text-right">
                  <Amount value={quota} pending={!snapshot} />
                </dd>
                <dt>残り容量の目安</dt>
                <dd className="text-right">
                  <Amount value={remaining} pending={!snapshot} />
                </dd>
              </dl>
              {ratio === null ? (
                <p className="text-ink-muted">{snapshot ? "使用率は取得できません" : "使用率を計測しています"}</p>
              ) : (
                <div
                  className={pressure === "alert" ? "storage-bar is-alert" : pressure === "warn" ? "storage-bar is-warn" : "storage-bar"}
                  role="meter"
                  aria-label="ブラウザの保存容量の使用率"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(Math.min(ratio, 1) * 100)}
                >
                  <span style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
                </div>
              )}
              {pressure === "warn" ? (
                <p className="storage-note is-warn">
                  保存容量の目安の80%以上を使っています。不要な画像を削除すると余裕が戻ります。画像は自動では削除しません。
                </p>
              ) : null}
              {pressure === "alert" ? (
                <p className="storage-note is-alert">
                  保存容量の目安の95%以上を使っています。追加に失敗することがあります。不要な画像を削除してください。画像は自動では削除しません。
                </p>
              ) : null}
              <p className="text-xs text-ink-faint">
                ブラウザ全体の使用量には、このアプリ以外の同じサイトのデータも含まれることがあります。
              </p>
            </section>
            <p className="text-xs text-ink-faint">最終確認 {snapshot ? formatCheckedAt(snapshot.measuredAt) : "計測しています"}</p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
