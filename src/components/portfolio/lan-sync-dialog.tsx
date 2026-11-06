import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildBackup, readBackup, type ParsedBackup } from "@/lib/portfolio/backup";
import { readLibraryDump, replaceLibrary } from "@/lib/portfolio/db";
import {
  lanErrorMessage,
  lanFetch,
  parseSyncBase,
  rememberSyncTarget,
  rememberedSyncTarget,
  type SyncBase,
} from "@/lib/portfolio/lan-sync";

type Session = {
  token: string;
  urls: string[];
  hasSnapshot: boolean;
  createdAt: string | null;
  bytes: number;
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(lanErrorMessage(new Error("sync"), response.status));
  return response.json() as Promise<T>;
}

export function LanSyncDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [pcNote, setPcNote] = useState("");
  const [phoneBase, setPhoneBase] = useState("");
  const [phoneToken, setPhoneToken] = useState("");
  const [phoneNote, setPhoneNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ParsedBackup | null>(null);

  useEffect(() => {
    if (!open) return;
    const remembered = rememberedSyncTarget();
    setPhoneBase((current) => current || remembered.base);
    setPhoneToken((current) => current || remembered.token);
    let cancelled = false;
    setPcNote("同期サーバーを確認しています…");
    void lanFetch(parseSyncBase("127.0.0.1"), "/session")
      .then((response) => readJson<Session>(response))
      .then((next) => {
        if (cancelled) return;
        setSession(next);
        setPcNote(next.hasSnapshot ? "PCのデータを受け付けています。" : "サーバーは起動しています。まだデータは送られていません。");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSession(null);
        setPcNote(error instanceof Error ? error.message : "同期サーバーが起動していません。");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const sendSnapshot = async () => {
    setBusy(true);
    setPcNote("保存データを読み出しています…");
    try {
      const base: SyncBase = parseSyncBase("127.0.0.1");
      const current = session ?? (await readJson<Session>(await lanFetch(base, "/session")));
      const dump = await readLibraryDump((done, total) => setPcNote(`画像を読み出しています ${done}/${total}`));
      setPcNote("同期サーバーへ送っています…");
      const { file, summary } = buildBackup(dump);
      const response = await lanFetch(base, "/snapshot", { method: "POST", token: current.token, body: file });
      await readJson(response);
      setSession({ ...current, hasSnapshot: true, bytes: file.size, createdAt: new Date().toISOString() });
      setPcNote(`送りました。画像${summary.images}枚、フォルダ${summary.folders}、タグ${summary.tags}です。スマホへはまだ反映していません。`);
    } catch (error) {
      setPcNote(error instanceof Error ? error.message : lanErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const pullSnapshot = async () => {
    setBusy(true);
    setConfirm(null);
    setPhoneNote("PCへ接続しています…");
    try {
      const base = parseSyncBase(phoneBase);
      const token = phoneToken.trim();
      if (!token) throw new Error("合言葉を入力してください。");
      rememberSyncTarget(base.url, token);
      const health = await readJson<{ hasSnapshot: boolean }>(await lanFetch(base, "/health"));
      if (!health.hasSnapshot) throw new Error(lanErrorMessage(new Error("empty"), 404));
      setPhoneNote("データを受け取っています…");
      const response = await lanFetch(base, "/snapshot", { token });
      if (!response.ok) throw new Error(lanErrorMessage(new Error("snapshot"), response.status));
      const parsed = await readBackup(await response.blob());
      setConfirm(parsed);
      setPhoneNote("内容を確認しました。置き換えるまで、この端末のデータは変更していません。");
    } catch (error) {
      setPhoneNote(error instanceof Error ? error.message : lanErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const applySnapshot = async () => {
    if (!confirm) return;
    setBusy(true);
    setPhoneNote("置き換えています…");
    try {
      await replaceLibrary(confirm);
      const { summary } = confirm;
      sessionStorage.setItem(
        "komacho-restored",
        `PCのデータを受け取りました。画像${summary.images}枚、フォルダ${summary.folders}、タグ${summary.tags}、お気に入り${summary.favorites}です。`,
      );
      window.location.reload();
    } catch {
      setPhoneNote("置き換えに失敗しました。この端末のデータは変更していません。");
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="storage-sheet">
          <div className="border-b border-line px-4 py-3">
            <Dialog.Title className="font-medium">LAN同期</Dialog.Title>
            <Dialog.Description className="text-sm text-ink-muted">
              自宅PCからスマホへ、同じWi-Fiの中だけで送ります。スマホ側の変更はPCへ戻りません。
            </Dialog.Description>
          </div>
          <div className="space-y-4 px-4 py-4 text-sm">
            <p className="text-ink-muted">
              公開ページから自宅PCへ接続します。Chromeではローカルネットワークの許可が出ます。iPhoneのSafariでは拒否されることがあり、その場合はデータは変わりません。拒否されたときは、アドレスのうしろに
              /snapshot.kmb?token=合言葉 を付けて直接開くとファイルを保存できます。そのファイルは「復元」から読み込めます。
            </p>
            <section className="space-y-2">
              <h2 className="font-medium">このPCを同期元にする</h2>
              <p>{pcNote}</p>
              {session ? (
                <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
                  <dt className="text-ink-muted">アドレス</dt>
                  <dd className="break-all">{session.urls.join("、") || "LANの住所がまだありません"}</dd>
                  <dt className="text-ink-muted">合言葉</dt>
                  <dd className="break-all font-medium">{session.token}</dd>
                </dl>
              ) : (
                <p>
                  PCに
                  <a className="mx-1 underline" href="/lan-sync-server.mjs" download="lan-sync-server.mjs">
                    サーバー
                  </a>
                  と
                  <a className="mx-1 underline" href="/start-lan-sync.bat" download="start-lan-sync.bat">
                    起動ファイル
                  </a>
                  を同じフォルダへ保存し、起動ファイルをダブルクリックします。Node.js が無い場合は https://nodejs.org の LTS
                  を入れてから、もう一度起動します。
                </p>
              )}
              <Button variant="quiet" disabled={busy || !session} onClick={() => void sendSnapshot()}>
                今のデータを送る
              </Button>
            </section>
            <section className="space-y-2">
              <h2 className="font-medium">スマホで受け取る</h2>
              <label className="block">
                <span className="text-ink-muted">PCのアドレス</span>
                <input
                  className="mt-1 w-full rounded-md border border-line bg-paper px-2 py-1"
                  value={phoneBase}
                  placeholder="http://192.168.1.20:17331"
                  onChange={(event) => setPhoneBase(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-ink-muted">合言葉</span>
                <input
                  className="mt-1 w-full rounded-md border border-line bg-paper px-2 py-1"
                  value={phoneToken}
                  onChange={(event) => setPhoneToken(event.target.value)}
                />
              </label>
              <p>{phoneNote}</p>
              {confirm ? (
                <p>
                  画像{confirm.summary.images}枚、フォルダ{confirm.summary.folders}、タグ{confirm.summary.tags}
                  、お気に入り{confirm.summary.favorites}。この端末の保存データは、PCの内容に置き換わります。
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button variant="quiet" disabled={busy} onClick={() => void pullSnapshot()}>
                  データを確認
                </Button>
                <Button disabled={busy || !confirm} onClick={() => void applySnapshot()}>
                  置き換える
                </Button>
              </div>
            </section>
          </div>
          <div className="flex justify-end border-t border-line px-4 py-3">
            <Dialog.Close asChild>
              <Button variant="quiet" disabled={busy}>
                閉じる
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
