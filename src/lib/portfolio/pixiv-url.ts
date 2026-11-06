/** Pulls a pixiv artwork id out of a copied URL. Other text returns null. */
export function pixivIllustId(text: string): string | null {
  const source = text.trim();
  if (!source) return null;
  const match =
    source.match(/pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i) ??
    source.match(/[?&]illust_id=(\d+)/i) ??
    source.match(/pixiv\.net\/ugoira\/(\d+)/i);
  return match?.[1] ?? null;
}
