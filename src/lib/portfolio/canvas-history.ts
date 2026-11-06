/** Shared canvas timeline. One confirm, delete, stroke, erase, or clear is one step. */
export type PlacementSnap = {
  id: string;
  imageId: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  z: number;
  flat?: boolean;
  opacity?: number;
};

export type BoardStep<Ink> = { kind: "ink"; before: Ink } | { kind: "placements"; before: PlacementSnap[] };

export type BoardHistory<Ink> = {
  undo: BoardStep<Ink>[];
  redo: BoardStep<Ink>[];
};

export function emptyBoardHistory<Ink>(): BoardHistory<Ink> {
  return { undo: [], redo: [] };
}

export function clonePlacementSnaps(list: PlacementSnap[]): PlacementSnap[] {
  return list.map((item) => {
    const next: PlacementSnap = {
      id: item.id,
      imageId: item.imageId,
      x: item.x,
      y: item.y,
      width: item.width,
      rotation: item.rotation,
      z: item.z,
    };
    if (item.flat) next.flat = true;
    if (typeof item.opacity === "number" && Number.isFinite(item.opacity)) {
      const pct = Math.min(100, Math.max(0, Math.round(item.opacity)));
      if (pct < 100) next.opacity = pct;
    }
    return next;
  });
}

function detach<Ink>(step: BoardStep<Ink>): BoardStep<Ink> {
  if (step.kind === "placements") return { kind: "placements", before: clonePlacementSnaps(step.before) };
  return step;
}

/** Pushes the state from before the operation. Drops the redo branch and anything past the limit. */
export function noteBoardStep<Ink>(history: BoardHistory<Ink>, step: BoardStep<Ink>, limit = 30): BoardStep<Ink>[] {
  history.undo.push(detach(step));
  const dropped: BoardStep<Ink>[] = [];
  if (history.undo.length > limit) dropped.push(...history.undo.splice(0, history.undo.length - limit));
  if (history.redo.length > 0) {
    dropped.push(...history.redo);
    history.redo.length = 0;
  }
  return dropped;
}

export function undoBoardStep<Ink>(history: BoardHistory<Ink>, current: BoardStep<Ink>): BoardStep<Ink> | null {
  const prev = history.undo.pop();
  if (prev === undefined) return null;
  history.redo.push(detach(current));
  return prev;
}

export function redoBoardStep<Ink>(history: BoardHistory<Ink>, current: BoardStep<Ink>): BoardStep<Ink> | null {
  const next = history.redo.pop();
  if (next === undefined) return null;
  history.undo.push(detach(current));
  return next;
}

export function clearBoardHistory<Ink>(history: BoardHistory<Ink>): BoardStep<Ink>[] {
  const dropped = [...history.undo, ...history.redo];
  history.undo.length = 0;
  history.redo.length = 0;
  return dropped;
}

export function flatPlacementIds<Ink>(steps: BoardStep<Ink>[]): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (step.kind !== "placements") continue;
    for (const placement of step.before) {
      if (placement.flat) ids.push(placement.id);
    }
  }
  return ids;
}

/** Drops placements whose picture left the library. Does not add a history step. */
export function scrubPlacementImages<Ink>(history: BoardHistory<Ink>, removeImage: (imageId: string) => boolean): PlacementSnap[] {
  const dropped: PlacementSnap[] = [];
  for (const stack of [history.undo, history.redo]) {
    for (const step of stack) {
      if (step.kind !== "placements") continue;
      let hit = false;
      const keep: PlacementSnap[] = [];
      for (const item of step.before) {
        if (removeImage(item.imageId)) {
          dropped.push(item);
          hit = true;
        } else keep.push(item);
      }
      if (hit) step.before = keep;
    }
  }
  return dropped;
}
