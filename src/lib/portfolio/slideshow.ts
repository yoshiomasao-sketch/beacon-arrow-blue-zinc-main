export type SlideshowOrder = "sequence" | "random";

export type SlideshowCursor = {
  deck: number[];
  at: number;
};

/** Still images only, in the gallery order already applied to `items`. */
export function slideshowCandidates<T extends { mime: string }>(items: readonly T[]): T[] {
  return items.filter((item) => item.mime.startsWith("image/"));
}

/** Integer seconds from 1 through 60. Anything else falls back to 5. */
export function clampSlideSeconds(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(60, Math.max(1, Math.round(value)));
}

export function startDeck(count: number, order: SlideshowOrder, random: () => number = Math.random): SlideshowCursor {
  if (count <= 0) return { deck: [], at: 0 };
  if (count === 1 || order === "sequence") return { deck: indexes(count), at: 0 };
  return { deck: shuffleDeck(count, -1, random), at: 0 };
}

/** Next slide. Sequence wraps. Random finishes the deck, then shuffles again without repeating the last image. */
export function advanceDeck(
  cursor: SlideshowCursor,
  count: number,
  order: SlideshowOrder,
  random: () => number = Math.random,
): SlideshowCursor {
  if (count <= 1) return startDeck(count, order, random);
  if (cursor.at + 1 < cursor.deck.length) return { deck: cursor.deck, at: cursor.at + 1 };
  if (order === "sequence") return { deck: cursor.deck.length === count ? cursor.deck : indexes(count), at: 0 };
  const last = cursor.deck[cursor.deck.length - 1] ?? -1;
  return { deck: shuffleDeck(count, last, random), at: 0 };
}

function indexes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function shuffleDeck(count: number, avoidFirst: number, random: () => number): number[] {
  const deck = indexes(count);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = deck[index] ?? index;
    deck[index] = deck[swap] ?? current;
    deck[swap] = current;
  }
  if (avoidFirst >= 0 && deck[0] === avoidFirst) {
    const swap = 1 + Math.floor(random() * (count - 1));
    const current = deck[0] ?? 0;
    deck[0] = deck[swap] ?? current;
    deck[swap] = current;
  }
  return deck;
}
