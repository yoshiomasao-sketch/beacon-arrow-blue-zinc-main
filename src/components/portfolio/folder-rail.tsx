import { ChevronDown, ChevronRight, Ban, Copy, FolderPlus, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { FileDock } from "@/components/portfolio/file-dock";
import { SpotConfirm } from "@/components/portfolio/spot-confirm";
import { ALL_FOLDERS, type Folder, type ImageMeta } from "@/lib/portfolio/types";
import { flattenFolders, folderAncestors, folderChildren, folderDropBand, folderWouldCycle, descendantFolderIds, storedImageCount } from "@/lib/portfolio/logic";

export function FolderRail({
  folders,
  items,
  selected,
  open,
  width,
  dragging,
  ownerFolderId,
  dropFolderId,
  dropCount = 0,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onCopy,
  onPaste,
  onToggleHidden,
  hiddenIds = [],
  copyReady = false,
  onReorder,
  onNest,
  onToggle,
  paneHeight,
  onPane,
  onJump,
  viewer = false,
  slide = null,
  locked = false,
}: {
  folders: Folder[];
  items: ImageMeta[];
  selected: string;
  open: boolean;
  width: number;
  dragging: boolean;
  ownerFolderId: string | null;
  dropFolderId: string | null;
  dropCount?: number;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  onCopy: (id: string) => void;
  onPaste: () => void;
  onToggleHidden: (id: string) => void;
  hiddenIds?: string[];
  copyReady?: boolean;
  onReorder: (sourceId: string, beforeId: string | null, parentId: string | null) => void;
  onNest: (sourceId: string, parentId: string) => void;
  onToggle: () => void;
  paneHeight: number;
  onPane: (height: number) => void;
  onJump: (id: string) => void;
  viewer?: boolean;
  slide?: { x: number; animate: boolean } | null;
  locked?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [beforeId, setBeforeId] = useState<string | null>(null);
  const [afterId, setAfterId] = useState<string | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const [nestId, setNestId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const placeRef = useRef<{ parentId: string | null; beforeId: string | null } | null>(null);
  const nestRef = useRef<string | null>(null);
  const draggedRef = useRef(false);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const editingRef = useRef(false);
  const commitRef = useRef(false);
  const railRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragPane, setDragPane] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; body: string; rect: DOMRect } | null>(null);
  const pane = dragPane ?? paneHeight;

  const count = (folder: Folder) => {
    if (folder.id === ALL_FOLDERS) return items.length;
    const ids = folder.isParent ? descendantFolderIds(folders, folder.id) : [folder.id];
    return storedImageCount(items, ids);
  };

  const startEdit = (folder: Folder) => {
    commitRef.current = false;
    editingRef.current = true;
    setEditing(folder.id);
    setEditName(folder.name);
  };

  const finishEdit = (id: string, name: string, keepOnReject: boolean) => {
    if (commitRef.current) return;
    commitRef.current = true;
    const trimmed = name.trim();
    if (!trimmed) {
      editingRef.current = false;
      setEditing(null);
      return;
    }
    void onRename(id, trimmed).then((saved) => {
      if (saved || !keepOnReject) {
        editingRef.current = false;
        setEditing(null);
        return;
      }
      commitRef.current = false;
    });
  };

  const startFolderDrag = (event: ReactPointerEvent<HTMLButtonElement>, folder: Folder) => {
    if (viewer || event.button !== 0 || editingRef.current) return;
    if ((event.target as HTMLElement).closest(".folder-op, input")) return;
    const startY = event.clientY;
    let moved = false;
    const clear = () => {
      placeRef.current = null;
      nestRef.current = null;
      setBeforeId(null);
      setAfterId(null);
      setNestId(null);
      setRootDrop(false);
    };
    const showPlace = (parentId: string | null, nextBefore: string | null, after: string | null, root: boolean) => {
      placeRef.current = { parentId, beforeId: nextBefore };
      nestRef.current = null;
      setBeforeId(nextBefore);
      setAfterId(after);
      setNestId(null);
      setRootDrop(root);
      setDragId(folder.id);
    };
    const placeBeside = (target: Folder, after: boolean) => {
      const parentId = target.parentId ?? null;
      if (folderWouldCycle(folders, folder.id, parentId)) {
        clear();
        setDragId(folder.id);
        return;
      }
      const siblings = folderChildren(folders, parentId).filter((entry) => entry.id !== folder.id);
      if (!after) {
        showPlace(parentId, target.id, null, false);
        return;
      }
      const index = siblings.findIndex((entry) => entry.id === target.id);
      const next = index >= 0 ? siblings[index + 1] : undefined;
      if (next) showPlace(parentId, next.id, null, false);
      else showPlace(parentId, null, target.id, false);
    };
    const move = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== event.pointerId || editingRef.current) return;
      if (!moved && Math.abs(pointer.clientY - startY) < 6) return;
      moved = true;
      const list = listRef.current;
      const pointed = document.elementFromPoint(pointer.clientX, pointer.clientY);
      const rows = list?.querySelectorAll<HTMLElement>("[data-folder-id]");
      const lastRow = rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
      const listRect = list?.getBoundingClientRect();
      const pastEnd =
        listRect !== undefined &&
        pointer.clientX >= listRect.left &&
        pointer.clientX <= listRect.right &&
        lastRow !== undefined &&
        pointer.clientY > lastRow.getBoundingClientRect().bottom;
      if (pastEnd || pointed?.closest("[data-root-drop]")) {
        showPlace(null, null, null, true);
        return;
      }
      const hit = pointed?.closest<HTMLElement>("[data-folder-id]");
      const id = hit?.getAttribute("data-folder-id");
      if (!hit || !id || id === folder.id) {
        clear();
        setDragId(folder.id);
        return;
      }
      const rect = hit.getBoundingClientRect();
      const ratio = rect.height > 0 ? (pointer.clientY - rect.top) / rect.height : 0.5;
      const target = folders.find((entry) => entry.id === id);
      if (!target) {
        clear();
        setDragId(folder.id);
        return;
      }
      const band = folderDropBand(ratio);
      if (band === "before" || band === "after") {
        placeBeside(target, band === "after");
        return;
      }
      if (!folderWouldCycle(folders, folder.id, target.id)) {
        placeRef.current = null;
        nestRef.current = target.id;
        setBeforeId(null);
        setAfterId(null);
        setRootDrop(false);
        setNestId(target.id);
      } else clear();
      setDragId(folder.id);
    };
    const finish = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (moved && nestRef.current) {
        setExpanded((current) => new Set(current).add(nestRef.current!));
        onNest(folder.id, nestRef.current);
      } else if (moved && placeRef.current) onReorder(folder.id, placeRef.current.beforeId, placeRef.current.parentId);
      draggedRef.current = moved;
      setDragId(null);
      clear();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  useEffect(() => {
    if (selected === ALL_FOLDERS) return;
    const chain = folderAncestors(foldersRef.current, selected);
    if (chain.length === 0) return;
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (const ancestor of chain) {
        if (!next.has(ancestor.id)) {
          next.add(ancestor.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [selected]);

  if (!open && !slide) {
    return (
      <aside className={locked ? "folder-rail is-collapsed is-locked" : "folder-rail is-collapsed"} aria-label="フォルダ">
        <Button
          variant="quiet"
          aria-label={locked ? "拡大表示中はフォルダを開けません" : "フォルダを表示"}
          aria-disabled={locked || undefined}
          onClick={() => {
            if (!locked) onToggle();
          }}
        >
          {locked ? <Ban className="size-4" aria-hidden="true" /> : <PanelLeftOpen className="size-4" aria-hidden="true" />}
          {locked ? null : <span className="rail-reveal-label">フォルダ</span>}
        </Button>
      </aside>
    );
  }

  const tree = flattenFolders(folders);
  const visibleTree = tree.filter(({ folder }) =>
    folderAncestors(folders, folder.id).every((ancestor) => expanded.has(ancestor.id)),
  );
  const current = folders.find((folder) => folder.id === selected) ?? null;
  const ancestors = current ? folderAncestors(folders, current.id) : [];

  return (
    <aside
      ref={railRef}
      className="folder-rail"
      style={{
        width,
        transform: slide ? `translate3d(${slide.x}px,0,0)` : undefined,
        transition: slide ? (slide.animate ? "transform 220ms ease-out" : "none") : undefined,
      }}
      aria-label="フォルダ"
    >
      <div className="folder-pane" style={{ height: pane }}>
      <div className="folder-rail-head">
        <h2>フォルダ</h2>
        <Button variant="quiet" aria-label="フォルダをしまう" onClick={onToggle}>
          <PanelLeftClose className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className={creating ? "folder-create is-naming" : "folder-create"}>
        {creating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <input
              value={draft}
              autoFocus
              maxLength={40}
              aria-label="新しいフォルダ名"
              placeholder="フォルダ名"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                setDraft("");
                setCreating(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.blur();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const name = draft.trim();
                  setDraft("");
                  setCreating(false);
                  if (name) onCreate(name);
                }
              }}
            />
          </form>
        ) : (
          <>
            <Button
              variant="quiet"
              className="folder-make"
              onClick={() => {
                setCreating(true);
                setDraft("");
              }}
            >
              <FolderPlus className="size-4" aria-hidden="true" />
              作成
            </Button>
            <Button variant="quiet" className="folder-paste" aria-label="コピーフォルダ貼りつけ" disabled={!copyReady} onClick={onPaste}>
              <span>コピーフォルダ</span>
              <span>貼りつけ</span>
            </Button>
          </>
        )}
      </div>
      <div className="folder-scroll" ref={listRef}>
        {current ? (
          <div className="folder-path">
            <p>{[...ancestors, current].map((folder) => folder.name).join(" / ")}</p>
          </div>
        ) : null}
        <button
          type="button"
          className={selected === ALL_FOLDERS ? "folder-row is-current" : "folder-row"}
          aria-current={selected === ALL_FOLDERS}
          onClick={() => onSelect(ALL_FOLDERS)}
        >
          <span className="folder-name">すべての画像</span>
          <span className="folder-count">{items.length}</span>
        </button>
        {visibleTree.map(({ folder, depth }) => {
          const available = dragging && ownerFolderId !== folder.id && !folder.isParent;
          const hot = dropFolderId === folder.id && !folder.isParent;
          const nesting = nestId === folder.id;
          const className = [
            "folder-row",
            selected === folder.id ? "is-current" : "",
            available ? "is-available" : "",
            hot ? "is-drop" : "",
            nesting ? "is-nest" : "",
            folder.isParent ? "is-parent" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const childCount = folderChildren(folders, folder.id).length;
          const owners = folderAncestors(folders, folder.id);
          const owner = [...owners].reverse().find((entry) => entry.isParent);
          const lineColor = folder.isParent ? folder.color : (owner?.color ?? null);
          const lineClass = [
            "folder-line",
            dragId === folder.id ? "is-ghost" : "",
            beforeId === folder.id ? "is-before" : "",
            afterId === folder.id ? "is-after" : "",
            folder.isParent ? "is-parent" : "",
            !folder.isParent && lineColor ? "is-child" : "",
            hiddenIds.includes(folder.id) ? "is-concealed" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              className={lineClass}
              key={folder.id}
              style={{ marginLeft: `${depth * 1.05}rem`, ["--folder-color" as string]: lineColor ?? undefined }}
            >
              {editing === folder.id ? (
                <form
                  className="folder-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    finishEdit(folder.id, editName, true);
                  }}
                >
                  <input
                    value={editName}
                    autoFocus
                    maxLength={40}
                    aria-label={`${folder.name}の名前`}
                    onChange={(event) => setEditName(event.target.value)}
                    onBlur={() => finishEdit(folder.id, editName, false)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        commitRef.current = true;
                        editingRef.current = false;
                        setEditing(null);
                      }
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  className={className}
                  data-folder-id={folder.id}
                  aria-current={selected === folder.id}
                  aria-expanded={childCount > 0 ? expanded.has(folder.id) : undefined}
                  onPointerDown={(event) => startFolderDrag(event, folder)}
                  onDoubleClick={() => {
                    if (!viewer) startEdit(folder);
                  }}
                  onClick={() => {
                    if (draggedRef.current) {
                      draggedRef.current = false;
                      return;
                    }
                    if (dragId) return;
                    onSelect(folder.id);
                    if (childCount > 0) {
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(folder.id)) next.delete(folder.id);
                        else next.add(folder.id);
                        return next;
                      });
                    }
                  }}
                >
                  {childCount > 0 ? (
                    expanded.has(folder.id) ? (
                      <ChevronDown className="folder-twist" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="folder-twist" aria-hidden="true" />
                    )
                  ) : null}
                  <span className="folder-name">{folder.name}</span>
                  {hot && dropCount > 1 ? <span className="folder-move-count">{dropCount}枚を移動</span> : null}
                  <span className="folder-count">{count(folder)}</span>
                </button>
              )}
              <div className="folder-ops">
                <button
                  type="button"
                  className={hiddenIds.includes(folder.id) ? "folder-op folder-hide is-on" : "folder-op folder-hide"}
                  aria-pressed={hiddenIds.includes(folder.id)}
                  aria-label={hiddenIds.includes(folder.id) ? `${folder.name}を中央エリアに表示する` : `${folder.name}を中央エリアで非表示にする`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onToggleHidden(folder.id)}
                >
                  <Ban aria-hidden="true" />
                </button>
                {viewer ? null : (
                  <>
                    <button
                      type="button"
                      className="folder-op"
                      aria-label={`${folder.name}をコピー`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => onCopy(folder.id)}
                    >
                      <Copy aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="folder-op"
                      data-spot-trigger=""
                      aria-label={`${folder.name}を削除`}
                      aria-expanded={pendingDelete?.id === folder.id}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        const extra =
                          childCount > 0
                            ? "中の子フォルダと、その中の画像・動画もまとめて削除されます。"
                            : "このフォルダの中の画像・動画も削除されます。";
                        setPendingDelete({
                          id: folder.id,
                          name: folder.name,
                          rect: event.currentTarget.getBoundingClientRect(),
                          body: `「${folder.name}」を削除しますか？${extra}他のフォルダの内容は残ります。元に戻せません。`,
                        });
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {dragId ? (
          <div className={rootDrop ? "folder-root-drop is-hot" : "folder-root-drop"} data-root-drop="true">
            最上位の末尾
          </div>
        ) : null}
        </div>
      </div>
      {viewer ? null : (
      <div
        className="pane-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label="ファイル一覧の高さ"
        onPointerDown={(event) => {
          const rail = railRef.current?.getBoundingClientRect().height ?? 0;
          const startY = event.clientY;
          const startH = pane;
          const move = (pointer: globalThis.PointerEvent) => {
            const next = Math.min(Math.max(140, startH + pointer.clientY - startY), Math.max(140, rail - 160));
            setDragPane(next);
          };
          const finish = (pointer: globalThis.PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            const next = Math.min(Math.max(140, startH + pointer.clientY - startY), Math.max(140, rail - 160));
            setDragPane(null);
            onPane(next);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", finish);
        }}
      />
      )}
      <FileDock
        items={selected === ALL_FOLDERS ? items : items.filter((item) => item.folderId === selected)}
        onJump={onJump}
        viewer={viewer}
      />
      {pendingDelete ? (
        <SpotConfirm
          anchor={pendingDelete.rect}
          side="below"
          title={`「${pendingDelete.name}」の削除`}
          body={pendingDelete.body}
          confirmLabel="削除"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const id = pendingDelete.id;
            setPendingDelete(null);
            onDelete(id);
          }}
        />
      ) : null}
    </aside>
  );
}
