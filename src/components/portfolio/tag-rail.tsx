import { Ban, Folder, PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Button } from "@/components/ui/button";
import { SpotConfirm } from "@/components/portfolio/spot-confirm";
import { tagsInRailOrder, tagInsertIndex, type InsertMark } from "@/lib/portfolio/logic";
import { TAG_DRAG, type Tag, type TagFolder } from "@/lib/portfolio/types";
import { beginTagDrag, currentTagDrag, endTagDrag, eventIsTagDrag } from "@/lib/portfolio/tag-drag";

function inkOn(color: string): string {
  const value = Number.parseInt(color.slice(1), 16);
  const y = (((value >> 16) & 255) * 299 + ((value >> 8) & 255) * 587 + (value & 255) * 114) / 1000;
  return y > 160 ? "#1c140c" : "#f3f1ec";
}

type TagSlot =
  | { kind: "folder"; folderId: string }
  | { kind: "insert"; folderId: string | null; beforeId: string | null; marks: InsertMark[] };

function slotKey(slot: TagSlot | null): string {
  if (!slot) return "";
  if (slot.kind === "folder") return `folder:${slot.folderId}`;
  return `insert:${slot.folderId ?? ""}:${slot.beforeId ?? ""}`;
}

function tagRows(root: HTMLElement, folderId: string | null, sourceId: string) {
  const scope = folderId ? folderBlock(root, folderId)?.querySelector(":scope > .tag-folder-tags") : root;
  if (!scope) return [];
  return [...scope.children]
    .filter((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("tag-line"))
    .filter((node) => node.dataset.tagId && node.dataset.tagId !== sourceId)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return { id: node.dataset.tagId ?? "", top: rect.top, bottom: rect.bottom };
    });
}

function folderBlock(root: HTMLElement, folderId: string): HTMLElement | null {
  for (const node of root.querySelectorAll(":scope > .tag-folder-block")) {
    if (node instanceof HTMLElement && node.dataset.folderId === folderId) return node;
  }
  return null;
}

function insertSlot(root: HTMLElement, folderId: string | null, clientY: number, sourceId: string): TagSlot {
  const rows = tagRows(root, folderId, sourceId);
  if (folderId && rows.length === 0) return { kind: "folder", folderId };
  const placed = tagInsertIndex(rows, clientY);
  const beforeId = placed.index >= rows.length ? null : rows[placed.index]!.id;
  return { kind: "insert", folderId, beforeId, marks: placed.marks };
}

/** Folder headers store a tag. Tag rows insert. The gap above a loose tag belongs to that list, not the folder above it. */
function resolveTagSlot(root: HTMLElement, clientY: number, sourceId: string): TagSlot | null {
  const children = [...root.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && !node.classList.contains("tag-empty"),
  );
  if (children.length === 0) return { kind: "insert", folderId: null, beforeId: null, marks: [] };
  const rootRect = root.getBoundingClientRect();
  const lastBottom = children[children.length - 1]!.getBoundingClientRect().bottom;
  if (clientY > lastBottom) return insertSlot(root, null, clientY, sourceId);

  for (let index = 0; index < children.length; index += 1) {
    const el = children[index]!;
    const rect = el.getBoundingClientRect();
    const prevBottom = index === 0 ? rootRect.top : children[index - 1]!.getBoundingClientRect().bottom;
    const nextTop = index === children.length - 1 ? lastBottom : children[index + 1]!.getBoundingClientRect().top;
    const prevEdge = el.classList.contains("tag-line") ? prevBottom : (prevBottom + rect.top) / 2;
    const nextIsLoose = index < children.length - 1 && children[index + 1]!.classList.contains("tag-line");
    const nextEdge = index === children.length - 1 ? lastBottom : nextIsLoose ? rect.bottom : (rect.bottom + nextTop) / 2;
    if (clientY >= prevEdge && clientY < nextEdge) return slotForChild(root, el, clientY, sourceId);
  }
  return insertSlot(root, null, clientY, sourceId);
}

function slotForChild(root: HTMLElement, el: HTMLElement, clientY: number, sourceId: string): TagSlot | null {
  if (!el.classList.contains("tag-folder-block")) return insertSlot(root, null, clientY, sourceId);
  const folderId = el.dataset.folderId;
  if (!folderId) return null;
  const header = [...el.children].find((node) => node instanceof HTMLElement && node.classList.contains("tag-folder"));
  const tags = [...el.children].find((node) => node instanceof HTMLElement && node.classList.contains("tag-folder-tags"));
  const headerBottom = header instanceof HTMLElement ? header.getBoundingClientRect().bottom : el.getBoundingClientRect().top;
  if (!(tags instanceof HTMLElement) || clientY <= headerBottom) return { kind: "folder", folderId };
  return insertSlot(root, folderId, clientY, sourceId);
}

export function TagRail({
  tags,
  folders,
  counts,
  selected,
  hidden,
  open,
  width,
  onToggle,
  onSelect,
  onHide,
  onCreate,
  onCreateFolder,
  onToggleFolder,
  onPlaceTag,
  onDeleteFolder,
  onRename,
  onDelete,
  viewer = false,
  slide = null,
  locked = false,
}: {
  tags: Tag[];
  folders: TagFolder[];
  counts: Record<string, number>;
  selected: string[];
  hidden: string[];
  open: boolean;
  width: number;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onCreate: (name: string) => void;
  onCreateFolder: (name: string) => void;
  onToggleFolder: (id: string) => void;
  onPlaceTag: (tagId: string, folderId: string | null, beforeId: string | null) => void;
  onDeleteFolder: (id: string) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  viewer?: boolean;
  slide?: { x: number; animate: boolean } | null;
  locked?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [composer, setComposer] = useState<"tag" | "folder" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [slot, setSlot] = useState<TagSlot | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pendingFolder, setPendingFolder] = useState<{ id: string; name: string; rect: DOMRect } | null>(null);
  const commitRef = useRef(false);
  const dragged = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLUListElement>(null);
  const slotKeyRef = useRef("");

  const clearDrag = () => {
    slotKeyRef.current = "";
    setSlot(null);
    setDragId(null);
  };

  const showSlot = (next: TagSlot | null) => {
    const key = slotKey(next);
    if (key === slotKeyRef.current) return;
    slotKeyRef.current = key;
    setSlot(next);
  };

  useEffect(() => {
    if (!open) setPendingFolder(null);
  }, [open]);

  useEffect(() => {
    const clear = () => {
      slotKeyRef.current = "";
      setSlot(null);
      setDragId(null);
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  useEffect(() => {
    if (!composer) return;
    const cancel = (event: PointerEvent) => {
      const form = formRef.current;
      if (form?.contains(event.target as Node | null)) return;
      setComposer(null);
      setDraft("");
    };
    window.addEventListener("pointerdown", cancel);
    return () => window.removeEventListener("pointerdown", cancel);
  }, [composer]);

  const finishEdit = (id: string, name: string) => {
    if (commitRef.current) return;
    commitRef.current = true;
    const trimmed = name.trim();
    const current = tags.find((tag) => tag.id === id)?.name ?? "";
    if (!trimmed || trimmed === current) {
      setEditing(null);
      return;
    }
    void onRename(id, trimmed).finally(() => setEditing(null));
  };

  const openComposer = (next: "tag" | "folder") => {
    setComposer(next);
    setDraft("");
  };

  const listed = tagsInRailOrder(tags, folders);
  const loose = listed.filter((tag) => !tag.folderId);
  const tagsIn = (folderId: string) => listed.filter((tag) => tag.folderId === folderId);
  const marks = slot?.kind === "insert" ? slot.marks : [];

  const startDrag = (tag: Tag) => (event: ReactDragEvent<HTMLElement>) => {
    if (viewer) {
      event.preventDefault();
      return;
    }
    const transfer = event.dataTransfer;
    transfer.effectAllowed = "all";
    transfer.setData(TAG_DRAG, tag.id);
    transfer.setData("text/plain", tag.name);
    beginTagDrag(tag.id);
    dragged.current = true;
    setDragId(tag.id);
    const chip = event.currentTarget.closest(".tag-chip");
    if (chip instanceof HTMLElement) transfer.setDragImage(chip, 18, 16);
  };

  const allowTagDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (viewer || !eventIsTagDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
  };

  const previewTagDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (viewer || !eventIsTagDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const root = scrollRef.current;
    const sourceId = currentTagDrag();
    if (!root || !sourceId) return;
    showSlot(resolveTagSlot(root, event.clientY, sourceId));
  };

  const commitTagDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!eventIsTagDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    const root = scrollRef.current;
    const id = event.dataTransfer.getData(TAG_DRAG) || currentTagDrag();
    const next = root && id ? resolveTagSlot(root, event.clientY, id) : null;
    clearDrag();
    if (viewer || !id || !next) return;
    if (next.kind === "folder") {
      const current = tags.find((entry) => entry.id === id);
      if ((current?.folderId ?? null) === next.folderId) return;
      onPlaceTag(id, next.folderId, null);
      return;
    }
    onPlaceTag(id, next.folderId, next.beforeId);
  };

  const renderTag = (tag: Tag, nested: boolean) => {
    const edge = marks.find((mark) => mark.id === tag.id)?.edge ?? null;
    return (
    <li className={nested ? "tag-line is-nested" : "tag-line"} data-tag-id={tag.id} key={tag.id}>
      {editing === tag.id ? (
        <form
          className="tag-edit"
          onSubmit={(event) => {
            event.preventDefault();
            finishEdit(tag.id, editName);
          }}
        >
          <input
            value={editName}
            autoFocus
            maxLength={40}
            aria-label={`${tag.name}の名前`}
            onChange={(event) => setEditName(event.target.value)}
            onBlur={(event) => finishEdit(tag.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finishEdit(tag.id, event.currentTarget.value);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                commitRef.current = true;
                setEditing(null);
              }
            }}
          />
        </form>
      ) : (
        <div
          className={["tag-chip", selected.includes(tag.id) ? "is-current" : "", hidden.includes(tag.id) ? "is-hidden" : "", dragId === tag.id ? "is-dragging" : ""].filter(Boolean).join(" ")}
          style={{ background: tag.color, color: inkOn(tag.color) }}
          draggable={!viewer}
          onDragStart={startDrag(tag)}
          onDragEnd={() => {
            endTagDrag();
            clearDrag();
          }}
        >
          <button
            type="button"
            className="tag-chip-main"
            draggable={!viewer}
            aria-pressed={selected.includes(tag.id)}
            title={selected.includes(tag.id) ? "もう一度押すと選択を外す" : "クリックで選択タグに追加"}
            onDragStart={startDrag(tag)}
            onClick={() => {
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              onSelect(tag.id);
            }}
            onDoubleClick={() => {
              if (viewer) return;
              commitRef.current = false;
              setEditing(tag.id);
              setEditName(tag.name);
            }}
          >
            <span className="tag-chip-name">{tag.name}</span>
          </button>
          <button
            type="button"
            className="tag-chip-neg"
            draggable={!viewer}
            aria-pressed={hidden.includes(tag.id)}
            aria-label={hidden.includes(tag.id) ? `${tag.name}のネガティブを外す` : `${tag.name}をネガティブにする`}
            title={hidden.includes(tag.id) ? "もう一度押すとネガティブを外す" : "ネガティブタグにする"}
            onDragStart={startDrag(tag)}
            onClick={(event) => {
              event.stopPropagation();
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              onHide(tag.id);
            }}
          >
            <Ban className="tag-neg-mark" aria-hidden="true" />
            <span className="tag-count">{counts[tag.id] ?? 0}</span>
          </button>
          {edge ? <span className={edge === "before" ? "tag-edge is-before" : "tag-edge is-after"} /> : null}
        </div>
      )}
      {viewer ? null : (
      <button
        type="button"
        className="tag-delete"
        aria-label={`${tag.name}を削除`}
        onClick={() => {
          if (window.confirm(`タグ「${tag.name}」を削除しますか？画像から外れます。`)) onDelete(tag.id);
        }}
      >
        <Trash2 aria-hidden="true" />
      </button>
      )}
    </li>
    );
  };

  if (!open && !slide) {
    return (
      <aside className={locked ? "tag-rail is-collapsed is-locked" : "tag-rail is-collapsed"} aria-label="タグ">
        <Button
          variant="quiet"
          aria-label={locked ? "拡大表示中はタグを開けません" : "タグを表示"}
          aria-disabled={locked || undefined}
          onClick={() => {
            if (!locked) onToggle();
          }}
        >
          {locked ? <Ban className="size-4" aria-hidden="true" /> : <PanelRightOpen className="size-4" aria-hidden="true" />}
          {locked ? null : <span className="rail-reveal-label">タグ</span>}
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className="tag-rail"
      style={{
        width,
        transform: slide ? `translate3d(${slide.x}px,0,0)` : undefined,
        transition: slide ? (slide.animate ? "transform 220ms ease-out" : "none") : undefined,
      }}
      aria-label="タグ"
    >
      <div className="tag-rail-head">
        <Button variant="quiet" aria-label="タグをしまう" onClick={onToggle}>
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
        <h2>タグ</h2>
      </div>
      {viewer ? null : (
      <section className="tag-create-pane">
        {composer ? (
          <form
            ref={formRef}
            className="tag-create"
            onSubmit={(event) => {
              event.preventDefault();
              const name = draft.trim();
              if (!name) return;
              if (composer === "folder") onCreateFolder(name);
              else onCreate(name);
              setDraft("");
              setComposer(null);
            }}
          >
            <input
              value={draft}
              autoFocus
              maxLength={40}
              aria-label={composer === "folder" ? "新しいフォルダ名" : "新しいタグ名"}
              placeholder={composer === "folder" ? "フォルダ名" : "タグ名"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setComposer(null);
                  setDraft("");
                }
              }}
            />
          </form>
        ) : (
          <div className="tag-create-actions">
            <Button variant="quiet" onClick={() => openComposer("tag")}>
              作成
            </Button>
            <Button variant="quiet" onClick={() => openComposer("folder")}>
              フォルダ作成
            </Button>
          </div>
        )}
      </section>
      )}
      <section className="tag-list-pane" aria-label="タグ一覧">
        <ul
          ref={scrollRef}
          className="tag-scroll"
          onDragEnter={allowTagDrop}
          onDragOver={previewTagDrop}
          onDrop={commitTagDrop}
        >
          {tags.length === 0 && folders.length === 0 ? <li className="tag-empty">タグはまだありません</li> : null}
          {folders.map((folder) => (
            <li key={folder.id} className="tag-folder-block" data-folder-id={folder.id}>
              <div className={slot?.kind === "folder" && slot.folderId === folder.id ? "tag-folder is-hot" : "tag-folder"}>
                <button type="button" className="tag-folder-toggle" aria-expanded={folder.open} onClick={() => onToggleFolder(folder.id)}>
                  <Folder className="size-4" aria-hidden="true" />
                  <span className="tag-folder-name">{folder.name}</span>
                  <span className="tag-count">{tagsIn(folder.id).length}</span>
                </button>
                {viewer ? null : (
                <button
                  type="button"
                  className="tag-delete"
                  data-spot-trigger=""
                  aria-label={`${folder.name}を削除`}
                  aria-expanded={pendingFolder?.id === folder.id}
                  onClick={(event) => {
                    setPendingFolder({
                      id: folder.id,
                      name: folder.name,
                      rect: event.currentTarget.getBoundingClientRect(),
                    });
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </button>
                )}
              </div>
              {folder.open ? <ul className="tag-folder-tags">{tagsIn(folder.id).map((tag) => renderTag(tag, true))}</ul> : null}
            </li>
          ))}
          {loose.map((tag) => renderTag(tag, false))}
        </ul>
      </section>
      {pendingFolder ? (
        <SpotConfirm
          anchor={pendingFolder.rect}
          side="lower-left"
          title={`フォルダ「${pendingFolder.name}」の削除`}
          body={`フォルダ「${pendingFolder.name}」を削除しますか？中のタグもすべて削除され、画像からの関連付けも外れます。他のタグや画像自体は残ります。`}
          confirmLabel="削除"
          onCancel={() => setPendingFolder(null)}
          onConfirm={() => {
            const id = pendingFolder.id;
            setPendingFolder(null);
            onDeleteFolder(id);
          }}
        />
      ) : null}
    </aside>
  );
}
