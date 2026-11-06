import { TAG_DRAG } from "./types.ts";

let tagDragId: string | null = null;

export function beginTagDrag(id: string): void {
  tagDragId = id;
}

export function endTagDrag(): void {
  tagDragId = null;
}

export function currentTagDrag(): string | null {
  return tagDragId;
}

/** Custom drag types are hidden during dragover in some browsers. The in-memory id covers that. */
export function eventIsTagDrag(types: ArrayLike<string> | undefined): boolean {
  if (tagDragId) return true;
  if (!types) return false;
  return Array.from(types).includes(TAG_DRAG);
}
