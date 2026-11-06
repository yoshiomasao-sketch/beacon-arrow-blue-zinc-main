import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearBoardHistory,
  clonePlacementSnaps,
  emptyBoardHistory,
  flatPlacementIds,
  noteBoardStep,
  redoBoardStep,
  scrubPlacementImages,
  undoBoardStep,
  type BoardStep,
  type PlacementSnap,
} from "./canvas-history.ts";

function place(id: string, x: number, z = 1, flat = false): PlacementSnap {
  const next: PlacementSnap = { id, imageId: `img-${id}`, x, y: 10, width: 80, rotation: 0, z };
  if (flat) next.flat = true;
  return next;
}

function run(history = emptyBoardHistory<string>()) {
  let ink = "blank";
  let placements: PlacementSnap[] = [];
  const snapshot = (kind: BoardStep<string>["kind"]): BoardStep<string> =>
    kind === "ink" ? { kind: "ink", before: ink } : { kind: "placements", before: placements };
  return {
    history,
    ink: () => ink,
    placements: () => placements.map((item) => ({ ...item })),
    noteInk(before: string) {
      noteBoardStep(history, { kind: "ink", before });
    },
    notePlacements(before: PlacementSnap[]) {
      noteBoardStep(history, { kind: "placements", before });
    },
    set(nextInk: string, nextPlacements: PlacementSnap[]) {
      ink = nextInk;
      placements = nextPlacements;
    },
    undo() {
      const top = history.undo.at(-1);
      if (!top) return null;
      const prev = undoBoardStep(history, snapshot(top.kind));
      if (!prev) return null;
      if (prev.kind === "ink") ink = prev.before;
      else placements = clonePlacementSnaps(prev.before);
      return prev.kind;
    },
    redo() {
      const top = history.redo.at(-1);
      if (!top) return null;
      const next = redoBoardStep(history, snapshot(top.kind));
      if (!next) return null;
      if (next.kind === "ink") ink = next.before;
      else placements = clonePlacementSnaps(next.before);
      return next.kind;
    },
  };
}

describe("canvas board history", () => {
  it("walks pen and image edits in the order they happened", () => {
    const board = run();
    board.noteInk("blank");
    board.set("stroke", []);
    board.notePlacements([]);
    board.set("stroke", [place("a", 10, 1)]);
    board.notePlacements([place("a", 10, 1)]);
    board.set("stroke", [place("a", 40, 2)]);
    board.noteInk("stroke");
    board.set("stroke-2", [place("a", 40, 2)]);

    assert.deepEqual(
      [board.undo(), board.undo(), board.undo(), board.undo()],
      ["ink", "placements", "placements", "ink"],
    );
    assert.equal(board.ink(), "blank");
    assert.deepEqual(board.placements(), []);
    assert.equal(board.undo(), null);

    assert.deepEqual(
      [board.redo(), board.redo(), board.redo(), board.redo()],
      ["ink", "placements", "placements", "ink"],
    );
    assert.equal(board.ink(), "stroke-2");
    assert.deepEqual(board.placements(), [place("a", 40, 2)]);
    assert.equal(board.redo(), null);
  });

  it("drops redo after a new committed step and keeps a bounded stack", () => {
    const board = run();
    board.noteInk("a");
    board.set("b", []);
    assert.equal(board.undo(), "ink");
    assert.equal(board.history.redo.length, 1);
    board.notePlacements([]);
    assert.equal(board.history.redo.length, 0);
    assert.equal(board.history.undo.length, 1);
    assert.equal(board.history.undo[0]?.kind, "placements");

    const limited = emptyBoardHistory<string>();
    noteBoardStep(limited, { kind: "ink", before: "1" }, 2);
    noteBoardStep(limited, { kind: "placements", before: [] }, 2);
    const dropped = noteBoardStep(limited, { kind: "ink", before: "2" }, 2);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.kind, "ink");
    assert.equal(limited.undo.length, 2);
    assert.equal(limited.undo[0]?.kind, "placements");
  });

  it("copies placement snapshots so later edits do not rewrite history", () => {
    const history = emptyBoardHistory<string>();
    const live = [place("a", 1, 1)];
    noteBoardStep(history, { kind: "placements", before: live });
    live[0]!.x = 99;
    live.push(place("b", 2, 2));
    const stored = history.undo[0];
    assert.equal(stored?.kind, "placements");
    if (stored?.kind !== "placements") return;
    assert.deepEqual(stored.before, [place("a", 1, 1)]);

    const current = [place("a", 5, 3, true)];
    undoBoardStep(history, { kind: "placements", before: current });
    current[0]!.x = 1;
    current[0]!.flat = false;
    const redo = history.redo[0];
    assert.equal(redo?.kind, "placements");
    if (redo?.kind !== "placements") return;
    assert.equal(redo.before[0]?.x, 5);
    assert.equal(redo.before[0]?.flat, true);
    assert.deepEqual(flatPlacementIds(history.redo), ["a"]);
  });

  it("clears both branches and scrubs pictures that left the library", () => {
    const history = emptyBoardHistory<string>();
    noteBoardStep(history, { kind: "placements", before: [place("a", 1, 1, true), place("b", 2, 2)] });
    noteBoardStep(history, { kind: "ink", before: "blank" });
    undoBoardStep(history, { kind: "placements", before: [place("a", 4, 3, true)] });
    const removed = scrubPlacementImages(history, (imageId) => imageId === "img-a");
    assert.equal(removed.length, 2);
    assert.deepEqual(
      history.undo.filter((step) => step.kind === "placements").map((step) => (step.kind === "placements" ? step.before.map((item) => item.id) : [])),
      [["b"]],
    );
    assert.deepEqual(
      history.redo.filter((step) => step.kind === "placements").map((step) => (step.kind === "placements" ? step.before.map((item) => item.id) : [])),
      [[]],
    );
    const cleared = clearBoardHistory(history);
    assert.equal(cleared.length, 2);
    assert.equal(history.undo.length, 0);
    assert.equal(history.redo.length, 0);
    assert.deepEqual(clonePlacementSnaps([]), []);
    const faded = place("c", 3);
    faded.opacity = 25;
    const copy = clonePlacementSnaps([faded]);
    faded.opacity = 5;
    assert.equal(copy[0]?.opacity, 25);
    const solid = place("d", 4);
    solid.opacity = 100;
    assert.equal(clonePlacementSnaps([solid])[0]?.opacity, undefined);
    const clear = place("e", 5);
    clear.opacity = 0;
    assert.equal(clonePlacementSnaps([clear])[0]?.opacity, 0);
  });
});
