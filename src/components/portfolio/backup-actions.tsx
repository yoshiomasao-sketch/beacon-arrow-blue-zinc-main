import * as Dialog from "@radix-ui/react-dialog";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { Button } from "@/components/ui/button";
import { backupFileName, buildBackup, readBackup, BackupError, RestoreFailure, type BackupSummary, type ParsedBackup } from "@/lib/portfolio/backup";
import { readLibraryDump, restoreLibrary, type LibraryTab, type RestoreProgress } from "@/lib/portfolio/db";
import { storageErrorMessage } from "@/lib/portfolio/logic";
import { formatBytes } from "@/lib/portfolio/storage-usage";

type Job =
  | { mode: "work"; title: string; status: string }
  | { mode: "confirm"; parsed: ParsedBackup }
  | { mode: "error"; message: string; canDownload: boolean }
  | { mode: "done"; message: string }
  | { mode: "ready"; message: string };

function summaryLine(summary: BackupSummary, tail: string): string {
  return `バックアップを作成しました。画像${summary.images}枚（動画${summary.videos}件）、フォルダ${summary.folders}、タグ${summary.tags}、タグフォルダ${summary.tagFolders}、お気に入り${summary.favorites}を含みます。${tail}`;
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function shareApiPresent(): boolean {
  return typeof navigator.share === "function" && typeof navigator.canShare === "function";
}

function shareSupported(file: File): boolean {
  if (!shareApiPresent()) return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function namedBackup(data: Blob, name: string): File {
  if (data instanceof File && data.name === name) return data;
  return new File([data], name, { type: data.type || "application/octet-stream" });
}

function triggerDownload(data: Blob, name: string): void {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function saveBackupFile(data: Blob, name: string): Promise<boolean> {
  if (!isTauri()) {
    triggerDownload(data, name);
    return true;
  }

  const path = await save({
    defaultPath: name,
    filters: [{ name: "KomaCho Backup", extensions: ["kmb"] }],
  });

  if (!path) return false;

  const bytes = new Uint8Array(await data.arrayBuffer());
  await writeFile(path, bytes);
  return true;
}

function reason(error: unknown, fallback: string): string {
  if (error instanceof RestoreFailure) {
    const seconds = Math.max(1, Math.round(error.elapsedMs / 1000));
    const quota = error.reasonName === "QuotaExceededError";
    const lines = [
      `${error.stage}の段階で失敗しました。`,
      `ファイル ${formatBytes(error.fileBytes)}、処理 ${error.saved}/${error.total} 件、経過 ${seconds} 秒。`,
      quota ? "ブラウザの保存容量が足りません。復元は今のデータを残したまま書き込むため、ファイルサイズ分の空きがさらに必要です。現在のライブラリは消していません。" : `エラーは ${error.reasonName} です。`,
    ];
    if (error.detail && error.detail !== error.reasonName) lines.push(error.detail);
    lines.push("現在のデータは変更していません。もう一度「復元」からやり直せます。");
    return lines.join("\n");
  }
  if (error instanceof BackupError) return error.message;
  return storageErrorMessage(error, "save") || fallback;
}

function readStatus(stage: "header" | "manifest" | "verify", done: number, total: number, fileBytes: number): string {
  if (stage === "header") return `ファイルを開いています\n${formatBytes(fileBytes)}`;
  if (stage === "manifest") return `目録を読み込んでいます\n${formatBytes(fileBytes)}`;
  return `データを検証しています\n${done}/${total} 件 · ${formatBytes(fileBytes)}`;
}

function saveStatus(progress: RestoreProgress): string {
  const label =
    progress.stage === "draft"
      ? "下書きを用意しています"
      : progress.stage === "check"
        ? "件数を照合しています"
        : progress.stage === "switch"
          ? "ライブラリを切り替えています"
          : "画像を分割して保存しています";
  const seconds = Math.max(0, Math.round(progress.elapsedMs / 1000));
  return `${label}\n${progress.done}/${progress.total} 件 · ${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)} · ${seconds}秒`;
}

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export type BackupController = {
  inspectFile: (file: File) => void;
};

export const BackupActions = forwardRef<BackupController, { disabled: boolean; viewer?: boolean; tab: LibraryTab }>(function BackupActions(
  { disabled, viewer = false, tab },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<File | null>(null);
  const noteRef = useRef("");
  const sharingRef = useRef(false);
  const jobRef = useRef<Job | null>(null);
  const [sharing, setSharing] = useState(false);
  const [job, setJobState] = useState<Job | null>(null);
  const busy = job?.mode === "work";

  const setJob = (next: Job | null) => {
    jobRef.current = next;
    setJobState(next);
  };

  const setSharingFlag = (value: boolean) => {
    sharingRef.current = value;
    setSharing(value);
  };

  const forgetFile = () => {
    fileRef.current = null;
  };

  const downloadSaved = async () => {
    const file = fileRef.current;
    if (!file) {
      setSharingFlag(false);
      setJob({
        mode: "error",
        message: "バックアップファイルがありません。共有もダウンロードもできません。もう一度「バックアップ」を押してください。保存データは変更していません。",
        canDownload: false,
      });
      return;
    }

    const shareAlreadyFailed = jobRef.current?.mode === "error";
    const previousMessage =
      jobRef.current?.mode === "ready"
        ? jobRef.current.message
        : noteRef.current;

    setJob({
      mode: "work",
      title: "バックアップ保存",
      status: isTauri() ? "保存先を選択しています…" : "ダウンロードを準備しています…",
    });

    try {
      const saved = await saveBackupFile(file, file.name);
      if (!saved) {
        setSharingFlag(false);
        setJob({
          mode: "ready",
          message: `${previousMessage}\n保存をキャンセルしました。同じファイルをもう一度保存できます。`,
        });
        return;
      }

      forgetFile();
      setSharingFlag(false);
      setJob({
        mode: "done",
        message: isTauri()
          ? "バックアップを保存しました。保存データは変更していません。"
          : "ダウンロードしました。保存データは変更していません。",
      });
    } catch (error) {
      setSharingFlag(false);
      const detail = reason(error, "バックアップファイルの保存に失敗しました。");
      setJob({
        mode: "error",
        canDownload: true,
        message: shareAlreadyFailed
          ? `共有に続いてファイル保存にも失敗しました。\n${detail}\n同じファイルは残っています。もう一度保存できます。保存データは変更していません。`
          : `${detail}\n同じファイルは残っています。もう一度保存できます。保存データは変更していません。`,
      });
    }
  };

  const finishShareError = (error: unknown) => {
    setSharingFlag(false);
    if (!fileRef.current) return;
    const name = errorName(error);
    if (name === "AbortError") {
      setJob({
        mode: "ready",
        message: `${noteRef.current}\n共有を取り消しました。同じファイルを、もう一度「共有する」か「ダウンロード」で渡せます。保存データは変更していません。`,
      });
      return;
    }
    const why =
      name === "NotAllowedError"
        ? "ブラウザが共有メニューを拒否しました。ファイルを作った直後の操作ではなかったか、この形式を共有できません。"
        : name === "DataError" || name === "TypeError"
          ? "このブラウザは、このバックアップファイルを共有メニューに載せられませんでした。"
          : `共有に失敗しました${name ? `（${name}）` : ""}。`;
    setJob({
      mode: "error",
      canDownload: true,
      message: `${why}\n同じファイルは残しています。「ダウンロード」で保存できます。共有は自動ではやり直していません。保存データは変更していません。`,
    });
  };

  const shareSaved = () => {
    const file = fileRef.current;
    if (sharingRef.current) return;
    if (!file) {
      setJob({
        mode: "error",
        message: "バックアップファイルがありません。共有もダウンロードもできません。もう一度「バックアップ」を押してください。保存データは変更していません。",
        canDownload: false,
      });
      return;
    }
    if (!shareSupported(file)) {
      void downloadSaved();
      return;
    }
    setSharingFlag(true);
    setJob({ mode: "ready", message: `${noteRef.current}\n共有メニューを開いています…` });
    let pending: Promise<void>;
    try {
      pending = navigator.share({ files: [file], title: file.name });
    } catch (error) {
      finishShareError(error);
      return;
    }
    void pending.then(
      () => {
        setSharingFlag(false);
        if (!fileRef.current) return;
        forgetFile();
        setJob({
          mode: "done",
          message: "共有メニューに渡しました。保存先はそこで選んでください。特定のサービスへは送っていません。保存データは変更していません。",
        });
      },
      (error: unknown) => {
        finishShareError(error);
      },
    );
  };

  const download = async () => {
    if (busy || sharingRef.current) return;
    setJob({ mode: "work", title: "バックアップ", status: "保存データを読み出しています…" });
    try {
      const createdAt = new Date();
      const dump = await readLibraryDump((done, total) => {
        setJob({ mode: "work", title: "バックアップ", status: `画像を読み出しています ${done}/${total}` });
      });
      setJob({ mode: "work", title: "バックアップ", status: "ファイルを作成しています…" });
      const { file, summary } = buildBackup(dump, createdAt);
      const name = backupFileName(createdAt);
      const kept = summaryLine(summary, "保存データは変更していません。");
      if (!viewer || isTauri()) {
        const saved = await saveBackupFile(file, name);
        if (!saved) {
          setJob({
            mode: "done",
            message: "保存をキャンセルしました。バックアップファイルは保存されていません。必要な場合は、もう一度「バックアップを保存」を押してください。保存データは変更していません。",
          });
          return;
        }
        setJob({
          mode: "done",
          message: isTauri()
            ? summaryLine(summary, "バックアップファイルを保存しました。保存データは変更していません。")
            : kept,
        });
        return;
      }
      if (!shareApiPresent()) {
        triggerDownload(file, name);
        setJob({
          mode: "done",
          message: summaryLine(summary, "このブラウザはファイルの共有メニューに対応していないため、ダウンロードしました。保存データは変更していません。"),
        });
        return;
      }
      const named = namedBackup(file, name);
      if (!shareSupported(named)) {
        triggerDownload(file, name);
        setJob({
          mode: "done",
          message: summaryLine(summary, "このブラウザは、このバックアップファイルを共有メニューに載せられないため、ダウンロードしました。保存データは変更していません。"),
        });
        return;
      }
      fileRef.current = named;
      noteRef.current = kept;
      setJob({
        mode: "ready",
        message: `${kept}\nファイルはできています。「共有する」で保存先を選ぶか、「ダウンロード」で保存できます。`,
      });
    } catch (error) {
      forgetFile();
      setSharingFlag(false);
      setJob({ mode: "error", message: reason(error, "バックアップに失敗しました。保存データは変更していません。"), canDownload: false });
    }
  };

  const inspect = async (file: File | undefined) => {
    if (!file || sharingRef.current || jobRef.current?.mode === "work" || jobRef.current?.mode === "confirm") return;
    let stage = "ファイルの受付";
    setJob({ mode: "work", title: "復元", status: `ファイルを開いています\n${formatBytes(file.size)}` });
    try {
      const parsed = await readBackup(file, (progress) => {
        stage = progress.stage === "header" ? "ファイルの受付" : progress.stage === "manifest" ? "目録の読み込み" : "データの検証";
        setJob({ mode: "work", title: "復元", status: readStatus(progress.stage, progress.done, progress.total, file.size) });
      });
      setJob({ mode: "confirm", parsed });
    } catch (error) {
      const detail = reason(error, "バックアップを読めませんでした。");
      setJob({
        mode: "error",
        message: `${detail}\n段階: ${stage}\nファイル ${formatBytes(file.size)}\n現在のデータは変更していません。`,
        canDownload: false,
      });
    }
  };

  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;
  useImperativeHandle(ref, () => ({
    inspectFile(file: File) {
      void inspectRef.current(file);
    },
  }));

  const restore = async (parsed: ParsedBackup) => {
    const started = performance.now();
    setJob({ mode: "work", title: "復元", status: "下書きを用意しています\n現在のデータは、まだ消していません" });
    try {
      await restoreLibrary(parsed, (progress) => {
        setJob({ mode: "work", title: "復元", status: saveStatus(progress) });
      });
    } catch (error) {
      setJob({ mode: "error", message: reason(error, "復元に失敗しました。現在のデータは変更していません。"), canDownload: false });
      return;
    }
    const { summary } = parsed;
    const seconds = Math.max(1, Math.round((performance.now() - started) / 1000));
    try {
      sessionStorage.setItem(
        "komacho-restored",
        `復元しました。画像${summary.images}枚（動画${summary.videos}件）、フォルダ${summary.folders}、タグ${summary.tags}、タグフォルダ${summary.tagFolders}、お気に入り${summary.favorites}です。ファイル ${formatBytes(summary.bytes)}、${seconds}秒。`,
      );
    } catch {
      /* the library already switched; reloading still shows the restored data */
    }
    window.location.reload();
  };

  return (
    <>
      <Button variant="quiet" className="aux-btn" disabled={disabled || busy || sharing} onClick={() => void download()}>
        {viewer ? "保存" : "バックアップを保存"}
      </Button>
      <Button variant="quiet" className="aux-btn" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
        {viewer ? "復元" : "バックアップから復元"}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".kmb,application/octet-stream"
        className="sr-only"
        aria-label="バックアップファイル"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void inspect(file);
        }}
      />
      <Dialog.Root
        open={job !== null}
        modal={job?.mode === "work" || job?.mode === "confirm"}
        onOpenChange={(open) => {
          if (open || busy || sharingRef.current) return;
          if (fileRef.current) return;
          setJob(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="sheet-overlay" />
          <Dialog.Content
            className="storage-sheet"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onFocusOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => event.preventDefault()}
          >
            <div className="border-b border-line px-4 py-3">
              <Dialog.Title className="font-medium">
                {job?.mode === "confirm" ? "復元の確認" : job?.mode === "work" ? job.title : job?.mode === "error" ? "できませんでした" : "バックアップ"}
              </Dialog.Title>
            </div>
            <div className="space-y-3 px-4 py-4 text-sm">
              {job?.mode === "work" ? <p className="whitespace-pre-wrap">{job.status}</p> : null}
              {job?.mode === "done" || job?.mode === "error" || job?.mode === "ready" ? <p className="whitespace-pre-wrap">{job.message}</p> : null}
              {job?.mode === "confirm" ? (
                <>
                  <p>復元先はタブ{tab}です。他のタブは変更しません。現在の保存データは、このバックアップの時点の内容にすべて置き換わります。先に「バックアップを保存」で今のデータを保存しておくことをおすすめします。</p>
                  <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
                    <dt className="text-ink-muted">復元先</dt>
                    <dd>タブ{tab}</dd>
                    <dt className="text-ink-muted">作成日時</dt>
                    <dd>{when(job.parsed.summary.createdAt)}</dd>
                    <dt className="text-ink-muted">画像</dt>
                    <dd>
                      {job.parsed.summary.images}枚（動画{job.parsed.summary.videos}件）
                    </dd>
                    <dt className="text-ink-muted">フォルダ</dt>
                    <dd>{job.parsed.summary.folders}</dd>
                    <dt className="text-ink-muted">タグ</dt>
                    <dd>
                      {job.parsed.summary.tags}（フォルダ{job.parsed.summary.tagFolders}）
                    </dd>
                    <dt className="text-ink-muted">お気に入り</dt>
                    <dd>{job.parsed.summary.favorites}</dd>
                    <dt className="text-ink-muted">ファイル</dt>
                    <dd>{formatBytes(job.parsed.summary.bytes)}</dd>
                  </dl>
                </>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
              {job?.mode === "confirm" ? (
                <>
                  <Button variant="quiet" onClick={() => setJob(null)}>
                    キャンセル
                  </Button>
                  <Button onClick={() => void restore(job.parsed)}>置き換える</Button>
                </>
              ) : job?.mode === "ready" ? (
                <>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      forgetFile();
                      setSharingFlag(false);
                      setJob(null);
                    }}
                  >
                    閉じる
                  </Button>
                  <Button variant="quiet" onClick={() => void downloadSaved()}>
                    ダウンロード
                  </Button>
                  <Button disabled={sharing} onClick={() => shareSaved()}>
                    共有する
                  </Button>
                </>
              ) : job?.mode === "work" ? null : (
                <>
                  {job?.mode === "error" && job.canDownload ? (
                    <Button variant="quiet" onClick={() => void downloadSaved()}>
                      ダウンロード
                    </Button>
                  ) : null}
                  <Button
                    variant="quiet"
                    onClick={() => {
                      forgetFile();
                      setJob(null);
                    }}
                  >
                    閉じる
                  </Button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
});