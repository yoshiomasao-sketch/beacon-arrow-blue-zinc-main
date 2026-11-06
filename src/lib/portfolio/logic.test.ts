import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shotAfterFailure, shotRetryDelay } from "./shot-load.ts";
import {
  baseName,
  assignVisibleOrders,
  shuffleIds,
  addedDateOrder,
  boxesInRect,
  classifyImageInput,
  exportFileName,
  fitColumns,
  tagInsertIndex,
  folderDropBand,
  folderOrderAfterMove,
  folderWouldCycle,
  pickParentColor,
  settleParentFolders,
  storedImageCount,
  flattenFolders,
  copiedFolderHiddenIds,
  normalizeFolders,
  importNotice,
  justifiedHeight,
  LAST_ROW_MAX,
  layoutFlow,
  layoutForPdf,
  layoutFit,
  layoutPdfSelection,
  layoutPortfolio,
  omitPlacements,
  maxFitRowGap,
  orderAfterVisualMove,
  insertionAt,
  orderFromInsertion,
  readingSequence,
  settleFitWhitespace,
  normalizeFolderView,
  normalizeTagMatch,
  hasEveryTag,
  passesTagFilter,
  isAnimatedImage,
  normalizeMeta,
  commitMemo,
  normalizeTag,
  parseActiveTagIds,
  sortByOrder,
  scrollTopForCenter,
  statusLabel,
  storageErrorMessage,
  tagsInRailOrder,
  nextCopyName,
  pasteParentId,
  planFolderCopy,
  planTagFolderRemoval,
} from "./logic.ts";
import { chooseDroppedPayload, copiedHttpUrl, droppedHttpUrl, droppedImageSources, fileFromDataUrl, looksLikeHtml, publicHttpUrl, sniffImage } from "./image-sniff.ts";
import { pixivFailure, pixivFailureMessage } from "./pixiv-error.ts";
import { formatBytes, storagePressure, storageRatio } from "./storage-usage.ts";
import { classifyFxStatus, classifyXPayload, directVideoUrl, pickFxVideo, pickXMp4, xStatusId } from "./x-url.ts";
import { pixivIllustId } from "./pixiv-url.ts";
import { ALL_FOLDERS, type Folder, type ImageMeta, type Tag, type TagFolder } from "./types.ts";

describe("copied image urls", () => {
  it("keeps public image addresses and refuses local ones", () => {
    assert.equal(copiedHttpUrl("https://cdn.example.com/a.gif"), "https://cdn.example.com/a.gif");
    assert.equal(copiedHttpUrl("see https://cdn.example.com/path/noext"), "https://cdn.example.com/path/noext");
    assert.equal(publicHttpUrl("http://127.0.0.1/a.png"), null);
    assert.equal(publicHttpUrl("http://192.168.0.8/a.png"), null);
    assert.equal(copiedHttpUrl("メモだけ"), null);
    assert.equal(copiedHttpUrl("blob:https://other.example/1111"), null);
    assert.equal(droppedHttpUrl("https://cdn.example.com/a.png", "", ""), "https://cdn.example.com/a.png");
    assert.equal(
      droppedHttpUrl("blob:https://other.example/1111", '<img src="https://cdn.example.com/b.jpg">', "blob:https://other.example/1111"),
      "https://cdn.example.com/b.jpg",
    );
    assert.equal(droppedHttpUrl("blob:https://other.example/1111", "", "http://127.0.0.1/a.png"), null);
    assert.equal(droppedHttpUrl("blob:https://other.example/1111", '<img src="blob:https://other.example/1111">', "blob:https://other.example/1111"), null);
    assert.equal(
      droppedHttpUrl("", '<img src="https://cdn.example.com/c.png?a=1&b=2">', ""),
      "https://cdn.example.com/c.png?a=1&b=2",
    );
    assert.equal(droppedHttpUrl("blob:https://other.example/1111", "", "", "image/png:pic.png:https://cdn.example.com/d.png"), "https://cdn.example.com/d.png");
    const many = droppedImageSources("https://cdn.example.com/a.png\nhttps://cdn.example.com/b.jpg", '<img src="https://cdn.example.com/c.gif">', "");
    assert.deepEqual(many.urls, ["https://cdn.example.com/a.png", "https://cdn.example.com/b.jpg"]);
    const linked = chooseDroppedPayload(
      "https://cdn.example.com/full.jpg",
      '<a href="https://cdn.example.com/full.jpg"><img src="https://cdn.example.com/thumb.png"></a>',
      "",
    );
    assert.deepEqual(linked.primary.urls, ["https://cdn.example.com/full.jpg"]);
    assert.deepEqual(linked.fallback.urls, ["https://cdn.example.com/thumb.png"]);
    const page = chooseDroppedPayload("https://news.example/article", '<img src="https://cdn.example.com/photo.jpg">', "");
    assert.deepEqual(page.primary.urls, ["https://cdn.example.com/photo.jpg"]);
    assert.deepEqual(page.fallback.urls, []);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const mixed = chooseDroppedPayload("https://cdn.example.com/a.png", `<img src="${png}">`, "");
    assert.deepEqual(mixed.primary.urls, []);
    assert.equal(mixed.primary.dataUrls.length, 1);
    assert.deepEqual(mixed.fallback.urls, ["https://cdn.example.com/a.png"]);
    const embedded = droppedImageSources("", `<img src="${png}">`, "");
    assert.equal(embedded.urls.length, 0);
    assert.equal(embedded.dataUrls.length, 1);
    const file = fileFromDataUrl(embedded.dataUrls[0] ?? "");
    assert.equal(file?.type, "image/png");
    assert.ok((file?.size ?? 0) > 8);
    const gif = fileFromDataUrl("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    assert.equal(gif?.type, "image/gif");
    assert.equal(fileFromDataUrl("data:text/plain;base64,QQ=="), null);
    const amp = `${String.fromCharCode(38)}amp;`;
    const escaped = droppedImageSources("", `<img src="https://cdn.example.com/c.png?a=1${amp}b=2">`, "");
    assert.equal(escaped.urls[0], `https://cdn.example.com/c.png?a=1${String.fromCharCode(38)}b=2`);
  });

  it("sniffs bytes instead of trusting a file name", () => {
    assert.equal(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
    assert.equal(sniffImage(new TextEncoder().encode("<!doctype html><html>")), null);
    assert.equal(looksLikeHtml(new TextEncoder().encode("<!DOCTYPE html><html>"), "text/html"), true);
  });
});

describe("pixiv failures", () => {
  it("separates a missing work, a refusal, and a login page from a dropped connection", () => {
    const missing = pixivFailure("作品情報", 404, '{"error":true,"message":""}');
    assert.equal(missing.reason, "auth");
    assert.match(missing.message, /削除/);
    assert.match(missing.message, /ログイン/);
    assert.match(pixivFailureMessage("作品情報", 403, ""), /拒否/);
    assert.match(pixivFailureMessage("作品情報", 403, ""), /ログイン/);
    assert.match(pixivFailureMessage("うごイラ情報", 200, "<!DOCTYPE html><html>login</html>"), /ページを返しました/);
  });
});

describe("storage usage", () => {
  it("formats sizes and does not invent a ratio when quota is missing", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.50 KB");
    assert.equal(formatBytes(12.34 * 1024 * 1024), "12.3 MB");
    assert.equal(formatBytes(Number.NaN), "取得できません");
    assert.equal(storageRatio(80, 100), 0.8);
    assert.equal(storagePressure(79, 100), "ok");
    assert.equal(storagePressure(80, 100), "warn");
    assert.equal(storagePressure(95, 100), "alert");
    assert.equal(storagePressure(10, null), null);
    assert.equal(storageRatio(null, 100), null);
  });
});

describe("x status urls", () => {
  it("reads a status id and picks a modest mp4", () => {
    assert.equal(xStatusId("https://x.com/name/status/2114639422511595606?s=20"), "2114639422511595606");
    assert.equal(xStatusId("https://mobile.twitter.com/name/status/1234567890/video/1"), "1234567890");
    assert.equal(xStatusId("https://example.com/status/123456"), null);
    assert.equal(directVideoUrl("https://video.twimg.com/ext_tw_video/123/vid/avc1/640x360/abc.mp4"), "https://video.twimg.com/ext_tw_video/123/vid/avc1/640x360/abc.mp4");
    assert.equal(directVideoUrl("https://x.com/name/status/1234567890"), null);
    assert.equal(directVideoUrl("http://127.0.0.1/secret.mp4"), null);
    assert.equal(classifyXPayload({ __typename: "TweetUnavailable", reason: "Protected" }).kind, "auth");
    assert.equal(classifyXPayload({ __typename: "TweetUnavailable", reason: "Suspended" }).kind, "missing");
    assert.equal(classifyXPayload({ __typename: "TweetWithVisibilityResults", tweet: { __typename: "Tweet", mediaDetails: [] } }).kind, "media");
    const picked = pickXMp4([
      {
        type: "video",
        video_info: {
          duration_millis: 2000,
          variants: [
            { content_type: "application/x-mpegURL", url: "https://video.twimg.com/a.m3u8" },
            { content_type: "video/mp4", bitrate: 2000000, url: "https://video.twimg.com/vid/avc1/1280x720/a.mp4" },
            { content_type: "video/mp4", bitrate: 800000, url: "https://video.twimg.com/vid/avc1/640x360/b.mp4" },
          ],
        },
      },
    ]);
    assert.equal(picked?.url, "https://video.twimg.com/vid/avc1/640x360/b.mp4");
    assert.equal(picked?.durationMs, 2000);
    const fx = pickFxVideo({
      tweet: {
        media: {
          videos: [
            {
              type: "gif",
              duration: 2.5,
              url: "https://video.twimg.com/tweet_video/abc.mp4",
              width: 720,
              format: "video/mp4",
              formats: [{ url: "https://video.twimg.com/tweet_video/abc.m3u8", container: "m3u8" }],
            },
          ],
        },
      },
    });
    assert.equal(fx.ok && fx.url, "https://video.twimg.com/tweet_video/abc.mp4");
    assert.equal(fx.ok && fx.kind, "gif");
    assert.equal(pickFxVideo({ tweet: { media: { videos: [{ type: "video", duration: 200, url: "https://video.twimg.com/ext/a.mp4", format: "video/mp4" }] } } }).ok, false);
    assert.equal(classifyFxStatus(404, "NOT_FOUND"), "missing");
    assert.equal(classifyFxStatus(401, "PRIVATE_TWEET"), "auth");
    assert.equal(classifyFxStatus(500, "API_FAIL"), "service");
  });
});

describe("pixivIllustId", () => {
  it("reads artwork ids from pixiv urls and ignores other text", () => {
    assert.equal(pixivIllustId("https://www.pixiv.net/artworks/101003492"), "101003492");
    assert.equal(pixivIllustId("https://www.pixiv.net/en/artworks/20#1"), "20");
    assert.equal(pixivIllustId("https://www.pixiv.net/member_illust.php?mode=medium&illust_id=42"), "42");
    assert.equal(pixivIllustId("ただのメモ"), null);
  });
});

describe("classifyImageInput", () => {
  it("accepts jpeg, png, and webp", () => {
    assert.deepEqual(classifyImageInput({ name: "a.jpg", type: "image/jpeg", size: 10 }), {
      ok: true,
      mime: "image/jpeg",
    });
    assert.deepEqual(classifyImageInput({ name: "a.png", type: "image/png", size: 10 }), {
      ok: true,
      mime: "image/png",
    });
    assert.deepEqual(classifyImageInput({ name: "a.gif", type: "image/gif", size: 10 }), {
      ok: true,
      mime: "image/gif",
    });
    assert.deepEqual(classifyImageInput({ name: "clip.mp4", type: "video/mp4", size: 10 }), {
      ok: true,
      mime: "video/mp4",
    });
  });

  it("uses the extension only when the browser omits a mime", () => {
    assert.deepEqual(classifyImageInput({ name: "scan.JPEG", type: "", size: 4 }), {
      ok: true,
      mime: "image/jpeg",
    });
    assert.deepEqual(classifyImageInput({ name: "loop.gif", type: "", size: 4 }), {
      ok: true,
      mime: "image/gif",
    });
    assert.equal(classifyImageInput({ name: "notes.bmp", type: "", size: 4 }).ok, false);
    assert.equal(classifyImageInput({ name: "x.bmp", type: "image/bmp", size: 4 }).ok, false);
  });

  it("rejects empty files", () => {
    assert.deepEqual(classifyImageInput({ name: "a.png", type: "image/png", size: 0 }), {
      ok: false,
      reason: "empty",
    });
  });
});

describe("sortByOrder", () => {
  it("keeps addition order, then addedAt", () => {
    const sorted = sortByOrder([
      { order: 2, addedAt: 1, id: "b" },
      { order: 1, addedAt: 9, id: "a" },
      { order: 2, addedAt: 0, id: "c" },
    ]);
    assert.deepEqual(
      sorted.map((item) => item.id),
      ["a", "c", "b"],
    );
  });
});

describe("importNotice", () => {
  it("stays quiet when everything was saved", () => {
    assert.equal(
      importNotice({
        added: 3,
        skippedType: 0,
        skippedEmpty: 0,
        failedDecode: 0,
        failedSave: 0,
        quota: false,
      }),
      null,
    );
  });

  it("explains partial failure and quota", () => {
    const message = importNotice({
      added: 1,
      skippedType: 2,
      skippedEmpty: 0,
      failedDecode: 0,
      failedSave: 1,
      quota: true,
    });
    assert.match(message ?? "", /1枚は追加しました/);
    assert.match(message ?? "", /保存容量が不足/);
    assert.match(message ?? "", /2件は対応外/);
  });
});

describe("storageErrorMessage", () => {
  it("maps quota and delete failures", () => {
    const quota = new DOMException("full", "QuotaExceededError");
    assert.match(storageErrorMessage(quota, "save"), /保存容量/);
    assert.match(storageErrorMessage(new Error("nope"), "delete"), /残しています/);
    assert.match(storageErrorMessage(new Error("nope"), "open"), /開けませんでした/);
  });
});

describe("labels", () => {
  it("formats the count and in-progress save", () => {
    assert.equal(baseName("C:\\fakepath\\panel.png"), "panel.png");
    assert.equal(statusLabel(4, null), "4枚");
    assert.equal(statusLabel(4, { done: 1, total: 3 }), "4枚 · 保存中 1/3");
  });
});

describe("normalizeMeta", () => {
  it("defaults missing display settings from older records", () => {
    const meta = normalizeMeta({
      id: "a",
      name: "panel.png",
      mime: "image/png",
      width: 10,
      height: 20,
      byteSize: 5,
      addedAt: 1,
      order: 3,
    });
    assert.equal(meta?.scale, 1);
    assert.equal(meta?.source, "file");
    assert.equal(meta?.folderId, "");
    assert.equal(meta?.favorite, false);
    assert.equal(meta?.memo, "");
    assert.equal(meta?.inkVisible, true);
    assert.deepEqual(meta?.tagIds, []);
    assert.equal(
      normalizeMeta({
        id: "a",
        mime: "image/png",
        favorite: true,
        memo: "  夕景の空  ",
      })?.favorite,
      true,
    );
    assert.equal(
      normalizeMeta({
        id: "a",
        mime: "image/png",
        memo: "  夕景の空  ",
      })?.memo,
      "夕景の空",
    );
    assert.equal(
      normalizeMeta({
        id: "a",
        mime: "image/png",
        inkVisible: false,
      })?.inkVisible,
      false,
    );
    assert.equal(commitMemo("", ""), "cancel");
    assert.equal(commitMemo("", "   "), "cancel");
    assert.equal(commitMemo("夕景", ""), "clear");
    assert.equal(commitMemo("夕景", "朝"), "save");
  });
});

describe("tag list order", () => {
  const tag = (id: string, order: number, createdAt: number, folderId: string | null) => ({
    id,
    order,
    createdAt,
    folderId,
  });

  it("follows the tag list from top to bottom, including folders and loose tags", () => {
    const tags = [
      tag("late", 1, 5, "box"),
      tag("loose-new", 0, 9, null),
      tag("early", 0, 4, "box"),
      tag("other", 0, 1, "cup"),
      tag("loose-old", 0, 2, null),
      tag("tied", 0, 8, "box"),
    ];
    const folders = [{ id: "cup" }, { id: "box" }];
    assert.deepEqual(
      tagsInRailOrder(tags, folders).map((entry) => entry.id),
      ["other", "early", "tied", "late", "loose-old", "loose-new"],
    );
    const assigned = ["late", "loose-new", "early", "other"];
    assert.deepEqual(
      tagsInRailOrder(tags, folders)
        .filter((entry) => assigned.includes(entry.id))
        .map((entry) => entry.id),
      ["other", "early", "late", "loose-new"],
    );
    assert.deepEqual(
      tags.map((entry) => entry.id),
      ["late", "loose-new", "early", "other", "loose-old", "tied"],
    );
  });

  it("keeps a tag whose folder is missing after the loose tags", () => {
    const tags = [tag("gone", 0, 1, "missing"), tag("plain", 2, 1, null), tag("first", 0, 1, null)];
    assert.deepEqual(
      tagsInRailOrder(tags, []).map((entry) => entry.id),
      ["first", "plain", "gone"],
    );
  });
});

describe("active tags", () => {
  it("keeps several known tags and matches only images that have all of them", () => {
    const known = new Set(["a", "b"]);
    assert.deepEqual(parseActiveTagIds('["b","a","a","missing"]', known), ["b", "a"]);
    assert.deepEqual(parseActiveTagIds("a", known), ["a"]);
    assert.equal(hasEveryTag(["a", "b", "c"], ["b", "a"]), true);
    assert.equal(hasEveryTag(["a"], ["a", "b"]), false);
    assert.equal(hasEveryTag(["a", "b"], []), true);
    assert.equal(passesTagFilter(["a", "b"], ["a"], ["c"]), true);
    assert.equal(passesTagFilter(["a", "b"], ["a"], ["b"]), false);
    assert.equal(passesTagFilter(["a"], ["a", "b"], []), false);
  });

  it("defaults to every selected tag and can match any one instead", () => {
    assert.equal(normalizeTagMatch(undefined), "all");
    assert.equal(normalizeTagMatch(null), "all");
    assert.equal(normalizeTagMatch(""), "all");
    assert.equal(normalizeTagMatch("or"), "all");
    assert.equal(normalizeTagMatch("all"), "all");
    assert.equal(normalizeTagMatch("any"), "any");

    const required = ["a", "b"];
    const hidden = ["x"];
    assert.equal(passesTagFilter(["a", "b"], required, [], "all"), true);
    assert.equal(passesTagFilter(["a"], required, [], "all"), false);
    assert.equal(passesTagFilter(["b"], required, [], "any"), true);
    assert.equal(passesTagFilter(["c"], required, [], "any"), false);
    assert.equal(passesTagFilter(["a", "x"], required, hidden, "any"), false);
    assert.equal(passesTagFilter(["a", "b", "x"], required, hidden, "all"), false);
    assert.equal(passesTagFilter(["c"], [], hidden, "any"), true);
    assert.equal(passesTagFilter(["c"], [], [], "all"), true);
    assert.deepEqual(required, ["a", "b"]);
    assert.deepEqual(hidden, ["x"]);
  });

  it("removes only the tags inside one tag folder, and keeps the images", () => {
    const tags = [
      { id: "a", folderId: "f1" },
      { id: "b", folderId: "f1" },
      { id: "c", folderId: "f2" },
      { id: "d", folderId: null },
    ];
    const items = [
      { id: "img1", tagIds: ["a", "c"] },
      { id: "img2", tagIds: ["d"] },
      { id: "img3", tagIds: ["b"] },
    ];
    const planned = planTagFolderRemoval({
      folderId: "f1",
      tags,
      items,
      activeTagIds: ["a", "c"],
      hiddenTagIds: ["b", "d"],
    });
    assert.deepEqual(planned.tagIds, ["a", "b"]);
    assert.deepEqual(planned.items, [
      { id: "img1", tagIds: ["c"] },
      { id: "img3", tagIds: [] },
    ]);
    assert.deepEqual(planned.activeTagIds, ["c"]);
    assert.deepEqual(planned.hiddenTagIds, ["d"]);
    assert.deepEqual(tags.map((tag) => tag.id), ["a", "b", "c", "d"]);
    assert.deepEqual(items[0]?.tagIds, ["a", "c"]);
    assert.equal(items.length, 3);
  });

  it("keeps folder and favorite filters outside the tag match", () => {
    const items = [
      { id: "both", folderId: "work", favorite: true, tagIds: ["a", "b"] },
      { id: "one", folderId: "work", favorite: false, tagIds: ["a"] },
      { id: "other", folderId: "rest", favorite: true, tagIds: ["a", "b"] },
      { id: "blocked", folderId: "work", favorite: true, tagIds: ["a", "b", "x"] },
    ];
    const shown = (match: "all" | "any", favoritesOnly: boolean) =>
      items
        .filter((item) => item.folderId === "work")
        .filter((item) => !favoritesOnly || item.favorite)
        .filter((item) => passesTagFilter(item.tagIds, ["a", "b"], ["x"], match))
        .map((item) => item.id);
    assert.deepEqual(shown("all", false), ["both"]);
    assert.deepEqual(shown("any", false), ["both", "one"]);
    assert.deepEqual(shown("any", true), ["both"]);
    assert.deepEqual(shown("all", true), ["both"]);
  });
});

describe("isAnimatedImage", () => {
  it("detects multi-frame gif, apng, and animated webp without treating stills as animation", () => {
    const gif = new Uint8Array([0x21, 0xf9, 0x00, 0x21, 0xf9]);
    const stillGif = new Uint8Array([0x21, 0xf9, 0x00]);
    const png = new TextEncoder().encode("....acTL....");
    const webp = new TextEncoder().encode("RIFF....ANIM");
    assert.equal(isAnimatedImage(gif, "image/gif"), true);
    assert.equal(isAnimatedImage(stillGif, "image/gif"), false);
    assert.equal(isAnimatedImage(png, "image/png"), true);
    assert.equal(isAnimatedImage(webp, "image/webp"), true);
    assert.equal(isAnimatedImage(png, "image/jpeg"), false);
  });
});

describe("normalizeTag", () => {
  it("keeps a named tag and drops a blank one", () => {
    const tag = normalizeTag({ id: "t", name: "  夕景  ", color: "#81b29a", order: 2, createdAt: 4 });
    assert.equal(tag?.name, "夕景");
    assert.equal(tag?.color, "#81b29a");
    assert.equal(tag?.folderId, null);
    assert.equal(normalizeTag({ id: "t", name: "   " }), null);
  });
});

describe("favorite pdf selection", () => {
  const page = {
    pageCount: 1,
    pageWidth: 210,
    pageHeight: 297,
    placements: [
      { id: "a", page: 0, x: 12, y: 12, w: 40, h: 30 },
      { id: "b", page: 0, x: 54, y: 12, w: 40, h: 30 },
      { id: "c", page: 0, x: 96, y: 12, w: 40, h: 30 },
      { id: "d", page: 0, x: 12, y: 44, w: 20, h: 20 },
    ],
  };

  it("closes a hole in the row and drops an empty row without rebuilding it", () => {
    const next = omitPlacements(page, ["a", "c"]);
    assert.deepEqual(
      next.placements.map((item) => item.id),
      ["a", "c"],
    );
    assert.equal(next.placements[0]?.x, 12);
    assert.equal(next.placements[1]?.x, 54);
    assert.equal(next.placements[0]?.y, 12);
    assert.equal(next.placements[0]?.w, 40);
    const only = omitPlacements(page, ["d"]);
    assert.equal(only.placements[0]?.y, 12);
    assert.equal(only.placements[0]?.w, 20);
  });

  it("keeps normal rows when favorites are removed and packs only favorites in fit mode", () => {
    const items = [
      { id: "a", width: 100, height: 100, scale: 1 as const, favorite: true },
      { id: "b", width: 100, height: 100, scale: 1 as const, favorite: false },
      { id: "c", width: 100, height: 100, scale: 1 as const, favorite: true },
    ];
    const normal = layoutPdfSelection(items, { orientation: "portrait", columns: 3, mode: "normal", favoritesOnly: true });
    assert.deepEqual(
      normal.placements.map((item) => item.id),
      ["a", "c"],
    );
    const fit = layoutPdfSelection(items, { orientation: "portrait", columns: 3, mode: "fit", favoritesOnly: true });
    assert.deepEqual(
      fit.placements.map((item) => item.id).sort(),
      ["a", "c"],
    );
    const all = layoutPdfSelection(items, { orientation: "portrait", columns: 3, mode: "normal" });
    assert.equal(all.placements.length, 3);
  });
});

describe("boxesInRect", () => {
  it("keeps images that meet the rectangle and ignores the rest", () => {
    const boxes = [
      { id: "a", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", x: 20, y: 0, w: 10, h: 10 },
      { id: "c", x: 0, y: 30, w: 10, h: 10 },
    ];
    assert.deepEqual(boxesInRect(boxes, { x: 8, y: 8, w: 14, h: 4 }), ["a", "b"]);
    assert.deepEqual(boxesInRect(boxes, { x: 22, y: 4, w: -6, h: 4 }), ["b"]);
  });
});

describe("parent folders", () => {
  const plain = { isParent: false, color: null };
  const manga = { id: "manga", name: "漫画", order: 0, createdAt: 1, parentId: null, ...plain };
  const workA = { id: "a", name: "作品A", order: 0, createdAt: 2, parentId: "manga", ...plain };
  const filled = { id: "filled", name: "画像あり", order: 1, createdAt: 3, parentId: null, ...plain };
  const nested = { id: "nested", name: "中", order: 0, createdAt: 4, parentId: "filled", ...plain };

  it("colors empty parents and leaves folders that already hold images", () => {
    const settled = settleParentFolders([manga, workA, filled, nested], [{ folderId: "filled" }, { folderId: "a" }, { folderId: "a" }]);
    assert.equal(settled.find((folder) => folder.id === "manga")?.isParent, true);
    assert.equal(settled.find((folder) => folder.id === "filled")?.isParent, false);
    assert.equal(storedImageCount([{ id: "1", folderId: "a" }, { id: "1", folderId: "a" }, { id: "2", folderId: "nested" }], ["a", "nested"]), 2);
    const first = pickParentColor([]);
    const second = pickParentColor([first]);
    assert.notEqual(first, second);
  });
});

describe("folder hierarchy", () => {
  const manga = { id: "manga", name: "漫画", order: 0, createdAt: 1, parentId: null, isParent: false, color: null };
  const workA = { id: "a", name: "作品A", order: 0, createdAt: 2, parentId: "manga", isParent: false, color: null };
  const workB = { id: "b", name: "作品B", order: 1, createdAt: 3, parentId: "manga", isParent: false, color: null };
  const anime = { id: "anime", name: "アニメ", order: 1, createdAt: 4, parentId: null, isParent: false, color: null };

  it("keeps older folders at the top and rejects a cycle", () => {
    const folders = normalizeFolders([
      { id: "old", name: "未分類", order: 0, createdAt: 1 },
      { id: "loop", name: "循環", order: 1, createdAt: 2, parentId: "missing" },
      { id: "self", name: "自身", order: 2, createdAt: 3, parentId: "self" },
    ]);
    assert.equal(folders.find((folder) => folder.id === "old")?.parentId, null);
    assert.equal(folders.find((folder) => folder.id === "loop")?.parentId, null);
    assert.equal(folders.find((folder) => folder.id === "self")?.parentId, null);
    const tree = flattenFolders([manga, anime, workB, workA]);
    assert.deepEqual(
      tree.map((entry) => entry.folder.id),
      ["manga", "a", "b", "anime"],
    );
    assert.equal(tree[1]?.depth, 1);
    assert.equal(folderWouldCycle([manga, workA], "manga", "a"), true);
    assert.equal(folderWouldCycle([manga, workA, anime], "a", "anime"), false);
  });

  it("keeps a copied folder hidden only when the source folder was hidden", () => {
    const map = new Map([
      ["manga", "manga-copy"],
      ["a", "a-copy"],
    ]);
    assert.deepEqual(copiedFolderHiddenIds(["manga", "anime"], map), ["manga-copy"]);
    assert.deepEqual(copiedFolderHiddenIds(["a"], map), ["a-copy"]);
    assert.deepEqual(copiedFolderHiddenIds([], map), []);
  });
});

describe("shotAfterFailure", () => {
  it("retries a transient read twice and then stops", () => {
    assert.equal(shotAfterFailure(1, "transient"), "retry");
    assert.equal(shotAfterFailure(2, "transient"), "retry");
    assert.equal(shotAfterFailure(3, "transient"), "error");
    assert.equal(shotAfterFailure(1, "missing"), "missing");
    assert.ok(shotRetryDelay(1) < shotRetryDelay(2));
  });
});

describe("folderDropBand", () => {
  it("uses the top and bottom 30 percent for reordering", () => {
    assert.equal(folderDropBand(0), "before");
    assert.equal(folderDropBand(0.29), "before");
    assert.equal(folderDropBand(0.3), "into");
    assert.equal(folderDropBand(0.7), "into");
    assert.equal(folderDropBand(0.71), "after");
  });
});

describe("tagInsertIndex", () => {
  const rows = [
    { id: "a", top: 0, bottom: 40 },
    { id: "b", top: 48, bottom: 88 },
    { id: "c", top: 96, bottom: 136 },
  ];

  it("marks the outer edge at the start and the end", () => {
    assert.deepEqual(tagInsertIndex(rows, -10), { index: 0, marks: [{ id: "a", edge: "before" }] });
    assert.deepEqual(tagInsertIndex(rows, 200), { index: 3, marks: [{ id: "c", edge: "after" }] });
    assert.deepEqual(tagInsertIndex([], 10), { index: 0, marks: [] });
  });

  it("marks the facing edges between two tags", () => {
    assert.deepEqual(tagInsertIndex(rows, 70), {
      index: 2,
      marks: [
        { id: "b", edge: "after" },
        { id: "c", edge: "before" },
      ],
    });
    assert.deepEqual(tagInsertIndex(rows, 20), { index: 0, marks: [{ id: "a", edge: "before" }] });
    assert.deepEqual(tagInsertIndex(rows, 50), {
      index: 1,
      marks: [
        { id: "a", edge: "after" },
        { id: "b", edge: "before" },
      ],
    });
  });
});

describe("folderOrderAfterMove", () => {
  it("moves a folder before another and leaves the rest of the ids alone", () => {
    assert.deepEqual(folderOrderAfterMove(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
    assert.equal(folderOrderAfterMove(["a", "b", "c"], "a", "a"), null);
    assert.deepEqual(folderOrderAfterMove(["a", "b", "c"], "a", null), ["b", "c", "a"]);
  });
});

describe("normalizeFolderView", () => {
  it("defaults a missing view to descending and keeps a saved direction", () => {
    assert.deepEqual(normalizeFolderView(null), { columns: 4, direction: "desc" });
    assert.deepEqual(normalizeFolderView({}), { columns: 4, direction: "desc" });
    assert.deepEqual(normalizeFolderView({ columns: 2, direction: "desc" }), { columns: 2, direction: "desc" });
    assert.deepEqual(normalizeFolderView({ columns: 3, direction: "asc" }), { columns: 3, direction: "asc" });
    assert.equal(normalizeFolderView({ columns: 99, direction: "asc" }).columns, 6);
  });
});

describe("assignVisibleOrders", () => {
  it("reorders one folder without changing the other folder's order numbers", () => {
    const items = [
      { id: "a1", order: 1 },
      { id: "b1", order: 2 },
      { id: "a2", order: 3 },
      { id: "b2", order: 4 },
    ];
    const next = assignVisibleOrders(items, ["a2", "a1"]);
    assert.deepEqual(next, [
      { id: "a1", order: 3 },
      { id: "b1", order: 2 },
      { id: "a2", order: 1 },
      { id: "b2", order: 4 },
    ]);
  });
});

describe("shuffleIds", () => {
  it("keeps every id once and follows Fisher-Yates swaps", () => {
    const draws = [0, 0, 0];
    let call = 0;
    const shuffled = shuffleIds(["a", "b", "c", "d"], () => draws[call++] ?? 0);
    assert.deepEqual(shuffled, ["b", "c", "d", "a"]);
    assert.deepEqual(["a", "b", "c", "d"].sort(), shuffled.slice().sort());
  });

  it("reorders only the visible images, including when the list is newest-first", () => {
    const items = [
      { id: "shown-a", order: 1, folderId: "here", addedAt: 1 },
      { id: "other", order: 2, folderId: "away", addedAt: 2 },
      { id: "shown-b", order: 3, folderId: "here", addedAt: 3 },
      { id: "hidden", order: 4, folderId: "here", addedAt: 4 },
      { id: "shown-c", order: 5, folderId: "here", addedAt: 5 },
    ];
    const visual = ["shown-a", "shown-c", "shown-b"];
    const stored = visual.slice().reverse();
    const next = assignVisibleOrders(items, stored);
    assert.deepEqual(
      readingSequence(
        (next ?? []).filter((item) => visual.includes(item.id)),
        "desc",
      ).map((item) => item.id),
      visual,
    );
    assert.equal(next?.find((item) => item.id === "other")?.order, 2);
    assert.equal(next?.find((item) => item.id === "hidden")?.order, 4);
    assert.deepEqual(
      next?.map((item) => item.folderId),
      ["here", "away", "here", "here", "here"],
    );
  });
});

describe("addedDateOrder", () => {
  it("sorts known registration times newest first and leaves unknown dates after them", () => {
    const visual = [
      { id: "new", addedAt: 300 },
      { id: "unknown", addedAt: 0 },
      { id: "old", addedAt: 100 },
      { id: "blank", addedAt: Number.NaN },
      { id: "mid", addedAt: 200 },
    ];
    assert.deepEqual(addedDateOrder(visual), ["new", "mid", "old", "unknown", "blank"]);
  });

  it("reorders only the visible images and does not invent a date for an unknown one", () => {
    const items = [
      { id: "shown-new", order: 1, addedAt: 50, folderId: "here" },
      { id: "other", order: 2, addedAt: 1, folderId: "away" },
      { id: "shown-old", order: 3, addedAt: 10, folderId: "here" },
      { id: "hidden", order: 4, addedAt: 5, folderId: "here" },
      { id: "shown-unknown", order: 5, addedAt: 0, folderId: "here" },
    ];
    const visible = [items[0]!, items[2]!, items[4]!];
    const visual = addedDateOrder(visible);
    const stored = visual.slice().reverse();
    const next = assignVisibleOrders(items, stored);
    assert.deepEqual(visual, ["shown-new", "shown-old", "shown-unknown"]);
    assert.deepEqual(
      readingSequence(
        (next ?? []).filter((item) => visual.includes(item.id)),
        "desc",
      ).map((item) => item.id),
      visual,
    );
    assert.equal(next?.find((item) => item.id === "other")?.order, 2);
    assert.equal(next?.find((item) => item.id === "hidden")?.order, 4);
    assert.equal(next?.find((item) => item.id === "shown-unknown")?.addedAt, 0);
  });
});

describe("scrollTopForCenter", () => {
  it("centers the card under a sticky header and never scrolls above zero", () => {
    assert.equal(scrollTopForCenter(400, 0, 600, 900, 100, 80), 400 + 900 - 80 - (520 - 100) / 2);
    assert.equal(scrollTopForCenter(0, 0, 800, 40, 100, 0), 0);
  });
});

describe("exportFileName", () => {
  it("keeps the readable name and matches the mime extension", () => {
    assert.equal(exportFileName("panel.png", "image/png"), "panel.png");
    assert.equal(exportFileName("wide.jpg", "image/jpeg"), "wide.jpg");
    assert.equal(exportFileName("loop.gif", "image/gif"), "loop.gif");
    assert.equal(exportFileName("clip.mp4", "video/mp4"), "clip.mp4");
    assert.equal(isAnimatedImage(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), "video/mp4"), true);
    assert.equal(exportFileName("  ", "image/png"), "image.png");
  });
});

describe("fitColumns", () => {
  it("narrows the shared width only as far as the screen allows", () => {
    assert.equal(fitColumns(4, 360), 2);
    assert.equal(fitColumns(4, 1200), 4);
  });
});

describe("layoutFlow", () => {
  it("justifies a mixed row so the right edge meets the container", () => {
    const gap = 6;
    const width = 900;
    const laid = layoutFlow(
      [
        { id: "square", width: 100, height: 100, scale: 1 },
        { id: "wide", width: 200, height: 100, scale: 1 },
        { id: "tall", width: 100, height: 200, scale: 1 },
      ],
      { contentWidth: width, columns: 3, gap },
    );
    const row = laid.placements.filter((item) => item.y === laid.placements[0]?.y);
    assert.deepEqual(
      row.map((item) => item.id),
      ["square", "wide"],
    );
    const end = (row[1]?.x ?? 0) + (row[1]?.w ?? 0);
    assert.ok(Math.abs(end - width) < 0.05);
    assert.ok(Math.abs((row[0]?.h ?? 0) - (row[1]?.h ?? 0)) < 0.01);
    assert.ok(Math.abs((row[0]?.w ?? 0) / (row[0]?.h ?? 1) - 1) < 0.02);
    assert.ok(Math.abs((row[1]?.w ?? 0) / (row[1]?.h ?? 1) - 2) < 0.02);
    assert.ok(Math.abs((row[1]?.x ?? 0) - ((row[0]?.x ?? 0) + (row[0]?.w ?? 0) + gap)) < 0.05);
  });

  it("keeps a wide image's aspect while filling the width", () => {
    const laid = layoutFlow([{ id: "banner", width: 1000, height: 100, scale: 1 }], {
      contentWidth: 300,
      columns: 3,
      gap: 4,
    });
    const box = laid.placements[0];
    assert.ok(box);
    assert.ok(Math.abs(box.w - 300) < 0.01);
    assert.ok(Math.abs(box.w / box.h - 10) < 0.02);
  });

  it("caps the last row so a single portrait does not fill the width", () => {
    const width = 400;
    const laid = layoutFlow([{ id: "portrait", width: 100, height: 400, scale: 1 }], {
      contentWidth: width,
      columns: 4,
      gap: 4,
    });
    const box = laid.placements[0];
    const target = (width - 4 * 3) / 4;
    assert.ok(box);
    assert.ok(box.w < width - 1);
    assert.ok(box.h <= target * LAST_ROW_MAX + 0.01);
    assert.ok(Math.abs(box.w / box.h - 0.25) < 0.02);
    assert.ok(Math.abs(box.h - justifiedHeight([{ width: 100, height: 400 }], width, 4)) > 1);
  });

  it("keeps the last row at the previous row height instead of stretching it", () => {
    const width = 900;
    const gap = 6;
    const laid = layoutFlow(
      [
        { id: "a", width: 100, height: 100, scale: 1 },
        { id: "b", width: 100, height: 100, scale: 1 },
        { id: "c", width: 100, height: 100, scale: 1 },
        { id: "d", width: 100, height: 100, scale: 1 },
        { id: "e", width: 100, height: 100, scale: 1 },
      ],
      { contentWidth: width, columns: 3, gap, lastRow: "match" },
    );
    const first = laid.placements.filter((item) => item.y === 0);
    const last = laid.placements.filter((item) => item.y > 0);
    assert.equal(first.length, 3);
    assert.deepEqual(
      last.map((item) => item.id),
      ["d", "e"],
    );
    assert.ok(Math.abs((first[0]?.h ?? 0) - (last[0]?.h ?? 0)) < 0.01);
    assert.ok(Math.abs((last[0]?.h ?? 0) - (last[1]?.h ?? 1)) < 0.01);
    const end = (last[1]?.x ?? 0) + (last[1]?.w ?? 0);
    assert.ok(end < width - 1);
    assert.ok(Math.abs((last[0]?.w ?? 0) / (last[0]?.h ?? 1) - 1) < 0.02);
  });

  it("shrinks an overflowing last row but does not grow a short one", () => {
    const width = 900;
    const gap = 6;
    const laid = layoutFlow(
      [
        { id: "a", width: 100, height: 100, scale: 1 },
        { id: "b", width: 100, height: 100, scale: 1 },
        { id: "c", width: 100, height: 100, scale: 1 },
        { id: "wide", width: 2000, height: 100, scale: 1 },
      ],
      { contentWidth: width, columns: 3, gap, lastRow: "match" },
    );
    const wide = laid.placements.find((item) => item.id === "wide");
    assert.ok(wide);
    assert.ok(wide.w <= width + 0.05);
    assert.ok(wide.h < laid.placements[0]!.h);
    assert.ok(Math.abs(wide.w / wide.h - 20) < 0.05);
  });
});

describe("display order", () => {
  const stored = ["a", "b", "c", "d", "e"].map((id, index) => ({
    id,
    order: index + 1,
    addedAt: index,
    width: 100,
    height: 100,
    scale: 1 as const,
  }));

  function rowIds(placements: { id: string; x: number; y: number }[]): string[][] {
    const rows: { id: string; x: number; y: number }[][] = [];
    for (const spot of [...placements].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const last = rows[rows.length - 1];
      if (!last || Math.abs(last[0]!.y - spot.y) > 0.5) rows.push([spot]);
      else last.push(spot);
    }
    return rows.map((row) => row.map((spot) => spot.id));
  }

  function lay(ids: { id: string; width: number; height: number; scale: 1 }[]) {
    return layoutFlow(ids, { contentWidth: 900, columns: 3, gap: 8, lastRow: "match" });
  }

  it("puts new images first when descending and old images first when ascending", () => {
    const source = stored.map((item) => ({ ...item }));
    assert.deepEqual(readingSequence(stored, "asc").map((item) => item.id), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(readingSequence(stored, "desc").map((item) => item.id), ["e", "d", "c", "b", "a"]);
    assert.deepEqual(source.map((item) => item.order), [1, 2, 3, 4, 5]);
  });

  it("keeps a full row, several full rows, and a short last row in reading order", () => {
    const one = lay(readingSequence(stored.slice(0, 3), "desc"));
    assert.deepEqual(rowIds(one.placements), [["c", "b", "a"]]);
    const full = lay(readingSequence(stored.slice(0, 6).concat([
      { id: "f", order: 6, addedAt: 5, width: 100, height: 100, scale: 1 },
    ]), "asc"));
    assert.deepEqual(rowIds(full.placements), [["a", "b", "c"], ["d", "e", "f"]]);
    const short = lay(readingSequence(stored, "asc"));
    assert.deepEqual(rowIds(short.placements), [["a", "b", "c"], ["d", "e"]]);
    const newestFirst = lay(readingSequence(stored, "desc"));
    assert.deepEqual(rowIds(newestFirst.placements), [["e", "d", "c"], ["b", "a"]]);
    assert.ok((newestFirst.placements.find((item) => item.id === "b")?.y ?? 0) > 0);
  });

  it("turns a descending drop back into stored oldest-first order", () => {
    const visual = [
      { id: "e", x: 0, y: 0, w: 100, h: 80 },
      { id: "d", x: 108, y: 0, w: 100, h: 80 },
      { id: "c", x: 216, y: 0, w: 100, h: 80 },
      { id: "b", x: 0, y: 88, w: 100, h: 80 },
      { id: "a", x: 108, y: 88, w: 100, h: 80 },
    ];
    assert.deepEqual(orderAfterVisualMove(visual, "e", "b", true), ["a", "b", "e", "c", "d"]);
    assert.deepEqual(orderAfterVisualMove(visual, "c", "a", false), ["e", "d", "b", "c", "a"]);
  });
});

describe("pdf follows the same reading order", () => {
  const stored = Array.from({ length: 13 }, (_, index) => ({
    id: `n${index + 1}`,
    order: index + 1,
    addedAt: index,
    width: 100,
    height: 100,
    scale: 1 as const,
    favorite: index % 2 === 0,
  }));

  function read(placements: { id: string; x: number; y: number; page?: number }[]): string[] {
    return [...placements]
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.y - b.y || a.x - b.x)
      .map((item) => item.id);
  }

  for (const direction of ["asc", "desc"] as const) {
    it(`keeps ${direction} order and leaves the short row at the end, including later pages`, () => {
      const sequence = readingSequence(stored, direction);
      const ids = sequence.map((item) => item.id);
      const screen = layoutFlow(sequence, { contentWidth: 900, columns: 3, gap: 8, lastRow: "match" });
      const normal = layoutPortfolio(sequence, { orientation: "portrait", columns: 3 });
      const fit = layoutForPdf(sequence, { orientation: "portrait", columns: 3, mode: "fit", marginMm: 12, gapMm: 3 });
      assert.deepEqual(read(screen.placements), ids);
      assert.deepEqual(read(normal.placements), ids);
      assert.deepEqual(read(fit.placements), ids);
      assert.deepEqual(read(screen.placements).slice(-1), [ids.at(-1)!]);
      assert.ok((normal.placements.at(-1)?.page ?? 0) > (normal.placements[0]?.page ?? 0));
      const lastPage = Math.max(...normal.placements.map((item) => item.page));
      const tail = normal.placements.filter((item) => item.page === lastPage).sort((a, b) => a.x - b.x);
      assert.deepEqual(tail.map((item) => item.id), ids.slice(-1));
      const other = readingSequence(stored, direction === "desc" ? "asc" : "desc");
      const flipped = layoutFlow(other, { contentWidth: 900, columns: 3, gap: 8, lastRow: "match" });
      assert.deepEqual(read(flipped.placements).slice(-1), [other.at(-1)!.id]);
      assert.notEqual(read(flipped.placements)[0], other.at(-1)!.id);
    });
  }
});

describe("reorder insertion", () => {
  const row = [
    { id: "a", x: 0, y: 0, w: 100, h: 80 },
    { id: "b", x: 108, y: 0, w: 100, h: 80 },
    { id: "c", x: 216, y: 0, w: 100, h: 80 },
  ];

  it("marks the left edge for the start and the right edge for the end", () => {
    const start = insertionAt(row, ["b"], { x: -30, y: 20 });
    assert.deepEqual(start, { index: 0, marks: [{ id: "a", edge: "before" }] });
    const end = insertionAt(row, ["b"], { x: 400, y: 70 });
    assert.deepEqual(end, { index: 2, marks: [{ id: "c", edge: "after" }] });
  });

  it("marks both edges of a gap and ignores the image being dragged", () => {
    const between = insertionAt(row, ["b"], { x: 158, y: 40 });
    assert.deepEqual(between, {
      index: 1,
      marks: [
        { id: "a", edge: "after" },
        { id: "c", edge: "before" },
      ],
    });
    assert.equal(between?.marks.some((mark) => mark.id === "b"), false);
  });

  it("uses the right half as after and the left half as before", () => {
    const afterA = insertionAt(row, [], { x: 80, y: 10 });
    assert.equal(afterA?.index, 1);
    assert.deepEqual(afterA?.marks, [
      { id: "a", edge: "after" },
      { id: "b", edge: "before" },
    ]);
    const beforeC = insertionAt(row, [], { x: 230, y: 10 });
    assert.equal(beforeC?.index, 2);
    assert.deepEqual(beforeC?.marks, [
      { id: "b", edge: "after" },
      { id: "c", edge: "before" },
    ]);
  });

  it("saves the same order the edges describe, including start and end", () => {
    assert.deepEqual(orderFromInsertion(row, ["b"], "b", 0, false), ["b", "a", "c"]);
    assert.deepEqual(orderFromInsertion(row, ["b"], "b", 2, false), ["a", "c", "b"]);
    assert.equal(orderFromInsertion(row, ["a"], "a", 0, false), null);
    const visual = [
      { id: "e", x: 0, y: 0, w: 100, h: 80 },
      { id: "d", x: 108, y: 0, w: 100, h: 80 },
      { id: "c", x: 216, y: 0, w: 100, h: 80 },
      { id: "b", x: 0, y: 88, w: 100, h: 80 },
      { id: "a", x: 108, y: 88, w: 100, h: 80 },
    ];
    assert.deepEqual(orderFromInsertion(visual, ["c"], "c", 0, true), ["a", "b", "d", "e", "c"]);
    assert.deepEqual(orderFromInsertion(visual, ["c"], "c", 4, true), ["c", "a", "b", "d", "e"]);
  });
});

describe("layoutPortfolio", () => {
  it("keeps shared height, order, and wraps the taller scale onto the next row", () => {
    const laid = layoutPortfolio(
      [
        { id: "a", width: 100, height: 200, scale: 1 },
        { id: "b", width: 100, height: 200, scale: 1 },
        { id: "c", width: 100, height: 100, scale: 3 },
      ],
      { orientation: "portrait", columns: 4 },
    );
    const byId = Object.fromEntries(laid.placements.map((item) => [item.id, item]));
    assert.equal(byId.a?.page, 0);
    assert.equal(byId.a?.y, byId.b?.y);
    assert.ok(Math.abs((byId.a?.h ?? 0) - (byId.b?.h ?? 0)) < 0.01);
    assert.ok((byId.b?.x ?? 0) > (byId.a?.x ?? 0));
    assert.equal(laid.placements.map((item) => item.id).join(""), "abc");
    assert.ok((byId.c?.w ?? 0) / (byId.c?.h ?? 1) - 1 < 0.05);
  });

  it("moves a row that does not fit onto the next page without splitting it", () => {
    const laid = layoutPortfolio(
      [
        { id: "a", width: 100, height: 100, scale: 1 },
        { id: "b", width: 100, height: 100, scale: 3 },
      ],
      { orientation: "portrait", columns: 1 },
    );
    const byId = Object.fromEntries(laid.placements.map((item) => [item.id, item]));
    assert.equal(byId.a?.page, 0);
    assert.equal(byId.b?.page, 1);
    assert.equal(laid.placements.filter((item) => item.id === "b").length, 1);
    assert.ok((byId.b?.h ?? 0) <= 297 - 24 + 0.01);
    assert.ok(Math.abs((byId.b?.w ?? 0) / (byId.b?.h ?? 1) - 1) < 0.05);
  });
});

describe("layoutFit", () => {
  const mixed = [
    { id: "p1", width: 200, height: 600, scale: 1 as const },
    { id: "p2", width: 200, height: 600, scale: 1 as const },
    { id: "p3", width: 200, height: 600, scale: 1 as const },
    { id: "p4", width: 200, height: 600, scale: 1 as const },
    { id: "l1", width: 600, height: 200, scale: 3 as const },
    { id: "l2", width: 600, height: 200, scale: 3 as const },
    { id: "l3", width: 600, height: 200, scale: 3 as const },
    { id: "l4", width: 600, height: 200, scale: 3 as const },
  ];

  function assertPacked(items: { id: string; width: number; height: number }[], margin: number, gap: number, orientation: "portrait" | "landscape") {
    const before = items.map((item) => item.id).join(",");
    const laid = layoutFit(
      items.map((item) => ({ ...item, scale: 1 })),
      { orientation, columns: 3, marginMm: margin, gapMm: gap },
    );
    assert.equal(items.map((item) => item.id).join(","), before);
    assert.equal(laid.placements.length, items.length);
    assert.equal(new Set(laid.placements.map((place) => place.id)).size, items.length);
    const page = orientation === "portrait" ? { width: 210, height: 297 } : { width: 297, height: 210 };
    assert.equal(laid.pageWidth, page.width);
    assert.equal(laid.pageHeight, page.height);
    for (const place of laid.placements) {
      const source = items.find((item) => item.id === place.id);
      assert.ok(source);
      assert.ok(place.w > 0 && place.h > 0);
      assert.ok(place.x >= margin - 0.05);
      assert.ok(place.y >= margin - 0.05);
      assert.ok(place.x + place.w <= page.width - margin + 0.2);
      assert.ok(place.y + place.h <= page.height - margin + 0.2);
      assert.ok(Math.abs(place.w / place.h - source.width / source.height) < 0.03);
    }
    const byPage = new Map<number, typeof laid.placements>();
    for (const place of laid.placements) {
      const list = byPage.get(place.page) ?? [];
      list.push(place);
      byPage.set(place.page, list);
    }
    for (const group of byPage.values()) {
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          const a = group[left]!;
          const b = group[right]!;
          const separated =
            a.x + a.w <= b.x + 0.05 ||
            b.x + b.w <= a.x + 0.05 ||
            a.y + a.h <= b.y + 0.05 ||
            b.y + b.h <= a.y + 0.05;
          assert.equal(separated, true);
          if (Math.abs(a.y - b.y) < 0.05) assert.ok(Math.abs(a.h - b.h) < 0.05);
        }
      }
    }
    return laid;
  }

  it("packs every image inside the page without changing the source order", () => {
    const portrait = assertPacked(mixed, 10, 2, "portrait");
    const landscape = assertPacked(mixed, 8, 1, "landscape");
    const portraits = Array.from({ length: 4 }, (_, index) => ({
      id: `portrait-${index}`,
      width: 200,
      height: 640,
    }));
    const landscapes = Array.from({ length: 4 }, (_, index) => ({
      id: `landscape-${index}`,
      width: 640,
      height: 200,
    }));
    assertPacked(portraits, 10, 2, "portrait");
    assertPacked(landscapes, 10, 2, "landscape");
  });

  it("keeps the portfolio's three-column rows instead of repacking", () => {
    const squares = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index + 1}`,
      width: 100,
      height: 100,
      scale: 1 as const,
    }));
    const before = squares.map((item) => item.id).join(",");
    const fit = layoutFit(squares, { orientation: "portrait", columns: 3, marginMm: 10, gapMm: 2 });
    assert.equal(squares.map((item) => item.id).join(","), before);
    assert.deepEqual(
      fit.placements.map((place) => place.id),
      squares.map((item) => item.id),
    );
    const rows: string[][] = [];
    for (const place of fit.placements) {
      const last = rows[rows.length - 1];
      const sameRow = last && Math.abs((fit.placements.find((item) => item.id === last[0])?.y ?? 0) - place.y) < 0.5;
      if (sameRow) last.push(place.id);
      else rows.push([place.id]);
    }
    assert.deepEqual(rows, [
      ["s1", "s2", "s3"],
      ["s4", "s5", "s6"],
    ]);
    const normal = layoutPortfolio(squares, { orientation: "portrait", columns: 3 });
    assert.equal(normal.placements.filter((place) => Math.abs(place.y - (normal.placements[0]?.y ?? 0)) < 0.5).length, 3);
  });

  it("keeps normal mode on the screen layout and fit mode on the packed layout", () => {
    const source = mixed.map((item) => ({ ...item }));
    const normal = layoutForPdf(source, { orientation: "portrait", columns: 4, mode: "normal" });
    const direct = layoutPortfolio(source, { orientation: "portrait", columns: 4 });
    assert.deepEqual(normal.placements, direct.placements);
    const fit = layoutForPdf(source, { orientation: "landscape", columns: 4, mode: "fit", marginMm: 12, gapMm: 3 });
    assert.equal(fit.pageWidth, 297);
    assert.deepEqual(
      fit.placements.map((place) => place.id),
      source.map((item) => item.id),
    );
    const inset = Math.min(...fit.placements.map((place) => place.x));
    assert.ok(inset >= 12 - 0.05);
  });
});

describe("fit whitespace", () => {
  const tall = { height: 150, widths: [60], aspects: [0.4] };
  const wide = { height: 40, widths: [180], aspects: [4.5] };
  const other = { height: 150, widths: [60], aspects: [0.4] };

  it("pulls only the next original row into a tail that is at least 30 percent empty", () => {
    const next = { height: 40, widths: [60, 60, 60], aspects: [1, 1, 1] };
    const after = { height: 40, widths: [180], aspects: [4.5] };
    const settled = settleFitWhitespace([[{ ...tall }], [next, after]], 277, 2);
    assert.equal(settled.pages[0]?.[1], next);
    assert.equal(settled.pages[1]?.[0], after);
    assert.deepEqual(next.widths, [60, 60, 60]);
  });

  it("does not skip ahead or reorder a later row to fill the tail", () => {
    const settled = settleFitWhitespace([[{ ...tall }], [{ ...other }, { ...wide }]], 277, 2);
    assert.equal(settled.pages[0]?.length, 1);
    assert.equal(settled.pages[1]?.length, 2);
    assert.equal(settled.pages[1]?.[1]?.aspects[0], 4.5);
  });

  it("leaves a small tail in place and only widens the gap up to the cap", () => {
    const settled = settleFitWhitespace(
      [
        [
          { height: 110, widths: [80], aspects: [0.7] },
          { height: 110, widths: [80], aspects: [0.7] },
        ],
        [{ ...wide }],
      ],
      277,
      2,
    );
    assert.equal(settled.pages[0]?.length, 2);
    assert.equal(settled.pages[1]?.[0]?.height, 40);
    const gap = settled.rowGaps[0] ?? 0;
    assert.ok(gap > 2);
    assert.ok(gap <= maxFitRowGap(2, 277) + 0.01);
    assert.equal(settled.pages[0]?.[0]?.height, 110);
    assert.equal(settled.pages[0]?.[1]?.height, 110);
    const used = 110 + gap + 110;
    assert.ok(used <= 277 + 0.05);
  });

  it("does not shrink a later row below the move limit just to fill a large tail", () => {
    const settled = settleFitWhitespace(
      [[{ height: 175, widths: [70], aspects: [0.4] }], [{ height: 200, widths: [80], aspects: [0.4] }]],
      277,
      2,
    );
    assert.equal(settled.pages.length, 2);
    assert.equal(settled.pages[1]?.[0]?.height, 200);
    assert.equal(settled.rowGaps[0], 2);
  });
});

function copyFolder(partial: Pick<Folder, "id" | "name"> & Partial<Folder>): Folder {
  return {
    order: 0,
    createdAt: 1,
    parentId: null,
    isParent: false,
    color: null,
    ...partial,
  };
}

function copyImage(partial: Pick<ImageMeta, "id" | "folderId"> & Partial<ImageMeta>): ImageMeta {
  return {
    name: "photo.jpg",
    mime: "image/jpeg",
    width: 10,
    height: 10,
    byteSize: 4,
    addedAt: 5,
    order: 3,
    scale: 1,
    source: "file",
    favorite: false,
    tagIds: [],
    animated: false,
    memo: "",
    ...partial,
  };
}

function copyTag(partial: Pick<Tag, "id" | "name"> & Partial<Tag>): Tag {
  return { color: "#e07a5f", order: 0, createdAt: 1, folderId: null, ...partial };
}

describe("folder copy", () => {
  it("numbers only a name that is already taken, using the smallest free index", () => {
    assert.equal(nextCopyName("資料", []), "資料");
    assert.equal(nextCopyName("資料", ["資料"]), "資料（1）");
    assert.equal(nextCopyName("資料", ["資料", "資料（1）"]), "資料（2）");
    assert.equal(nextCopyName("資料", ["資料", "資料（2）"]), "資料（1）");
    assert.equal(nextCopyName("資料（1）", ["資料（1）", "資料（2）"]), "資料（3）");
    const long = "あ".repeat(40);
    const numbered = nextCopyName(long, [long]);
    assert.equal(numbered.length <= 40, true);
    assert.match(numbered, /（1）$/);
    assert.equal(numbered === long, false);
  });

  it("pastes into a parent, otherwise beside the selected folder", () => {
    const parent = copyFolder({ id: "parent", name: "親", isParent: true });
    const child = copyFolder({ id: "child", name: "子", parentId: "parent" });
    const root = copyFolder({ id: "root", name: "単体" });
    assert.equal(pasteParentId([parent, child, root], ALL_FOLDERS), null);
    assert.equal(pasteParentId([parent, child], "missing"), null);
    assert.equal(pasteParentId([parent, child], "parent"), "parent");
    assert.equal(pasteParentId([parent, child], "child"), "parent");
    assert.equal(pasteParentId([root], "root"), null);
  });

  it("copies a tree with new ids, numbered names, and independent media", () => {
    const sourceFolders = [
      copyFolder({ id: "docs", name: "資料", isParent: true, color: "#d4b483", order: 4, createdAt: 9 }),
      copyFolder({ id: "sub", name: "下書き", parentId: "docs", order: 2, createdAt: 8 }),
      copyFolder({ id: "other", name: "対象外", order: 1 }),
    ];
    const outside = copyImage({ id: "out", folderId: "other", tagIds: ["foreign-only"], memo: "外" });
    const photo = copyImage({
      id: "img",
      folderId: "sub",
      favorite: true,
      memo: "メモ",
      order: 7,
      tagIds: ["season", "gone"],
      name: "beach.jpg",
    });
    const sourceTags = [copyTag({ id: "season", name: "夏", folderId: "months" })];
    const sourceTagFolders: TagFolder[] = [{ id: "months", name: "季節", order: 1, createdAt: 4, open: false }];
    const destFolders = [
      copyFolder({ id: "keep", name: "資料", order: 0, createdAt: 1 }),
      copyFolder({ id: "later", name: "あと", order: 5, createdAt: 2 }),
      copyFolder({ id: "same-child", name: "下書き", parentId: "keep" }),
    ];
    const before = structuredClone({ sourceFolders, photo, outside });
    let n = 0;
    const planned = planFolderCopy({
      rootId: "docs",
      sourceFolders,
      sourceItems: [photo, outside],
      sourceTags,
      sourceTagFolders,
      sourceViews: { docs: { columns: 2, direction: "asc" }, sub: { columns: 6, direction: "desc" } },
      destFolders,
      destTags: [copyTag({ id: "season", name: "冬" }), copyTag({ id: "named", name: "夏" })],
      destTagFolders: [],
      destParentId: null,
      sourceHiddenIds: ["sub", "missing"],
      nextId: () => ["docs", "sub", "img", "out"][n++] ?? `new-${n}`,
    });
    assert.ok(planned);
    assert.deepEqual(sourceFolders, before.sourceFolders);
    assert.deepEqual(photo, before.photo);
    assert.equal(planned.folders.some((folder) => folder.id === "docs" || folder.id === "sub"), false);
    assert.equal(planned.images.some((image) => image.meta.id === "img"), false);
    const root = planned.folders.find((folder) => folder.id === planned.rootId);
    const child = planned.folders.find((folder) => folder.id !== planned.rootId);
    assert.equal(root?.name, "資料（1）");
    assert.equal(root?.parentId, null);
    assert.equal(root?.order, -1);
    assert.equal(root?.isParent, true);
    assert.equal(root?.color, "#d4b483");
    assert.equal(root?.createdAt, 9);
    assert.equal(child?.name, "下書き");
    assert.equal(child?.parentId, root?.id);
    assert.equal(planned.hiddenIds.length, 1);
    assert.equal(planned.hiddenIds[0], child?.id);
    assert.equal(child?.order, 2);
    assert.equal(planned.images.length, 1);
    assert.equal(planned.images[0]?.sourceId, "img");
    assert.equal(planned.images[0]?.meta.folderId, child?.id);
    assert.equal(planned.images[0]?.meta.favorite, true);
    assert.equal(planned.images[0]?.meta.memo, "メモ");
    assert.equal(planned.images[0]?.meta.order, 7);
    assert.deepEqual(planned.images[0]?.meta.tagIds, ["named"]);
    assert.equal(planned.tags.length, 0);
    assert.equal(planned.tagFolders.length, 0);
    assert.deepEqual(
      planned.views.map((entry) => entry.view),
      [
        { columns: 2, direction: "asc" },
        { columns: 6, direction: "desc" },
      ],
    );
    planned.images[0]!.meta.memo = "変更";
    assert.equal(photo.memo, "メモ");
  });

  it("creates a missing tag and one shared tag folder, without reusing a foreign id", () => {
    const sourceFolders = [
      copyFolder({ id: "box", name: "箱", isParent: true }),
      copyFolder({ id: "a", name: "資料", parentId: "box" }),
      copyFolder({ id: "b", name: "資料", parentId: "box" }),
    ];
    const items = [
      copyImage({ id: "p1", folderId: "a", tagIds: ["t1"] }),
      copyImage({ id: "p2", folderId: "b", tagIds: ["t1", "t2"] }),
    ];
    let n = 0;
    const planned = planFolderCopy({
      rootId: "box",
      sourceFolders,
      sourceItems: items,
      sourceTags: [
        copyTag({ id: "t1", name: "海", folderId: "tf" }),
        copyTag({ id: "t2", name: "海", folderId: "tf" }),
      ],
      sourceTagFolders: [{ id: "tf", name: "場所", order: 3, createdAt: 6, open: true }],
      sourceViews: {},
      destFolders: [copyFolder({ id: "host", name: "親", isParent: true }), copyFolder({ id: "peer", name: "既存", parentId: "host", order: 0 })],
      destTags: [copyTag({ id: "t1", name: "山" })],
      destTagFolders: [{ id: "have", name: "別枠", order: 4, createdAt: 1, open: true }],
      destParentId: "host",
      nextId: () => `n${n++}`,
    });
    assert.ok(planned);
    assert.equal(planned.folders.find((folder) => folder.parentId === "host")?.name, "箱");
    assert.equal(planned.folders.find((folder) => folder.parentId === "host")?.order, 1);
    const copies = planned.folders.filter((folder) => folder.parentId === planned.folders.find((entry) => entry.parentId === "host")?.id);
    assert.deepEqual(copies.map((folder) => folder.name), ["資料", "資料（1）"]);
    assert.equal(copies[0]?.parentId, copies[1]?.parentId);
    assert.equal(planned.tags.length, 1);
    assert.equal(planned.tags[0]?.name, "海");
    assert.notEqual(planned.tags[0]?.id, "t1");
    assert.equal(planned.tagFolders.length, 1);
    assert.equal(planned.tagFolders[0]?.name, "場所");
    assert.equal(planned.tags[0]?.folderId, planned.tagFolders[0]?.id);
    assert.equal(planned.tagFolders[0]?.order, 5);
    assert.deepEqual(planned.images[0]?.meta.tagIds, [planned.tags[0]?.id]);
    assert.deepEqual(planned.images[1]?.meta.tagIds, [planned.tags[0]?.id]);
    assert.equal(planned.folders.find((folder) => folder.id === "box"), undefined);
  });

  it("reuses a destination tag folder of the same name and refuses a missing root", () => {
    const planned = planFolderCopy({
      rootId: "gone",
      sourceFolders: [],
      sourceItems: [],
      sourceTags: [],
      sourceTagFolders: [],
      sourceViews: {},
      destFolders: [],
      destTags: [],
      destTagFolders: [],
      destParentId: null,
    });
    assert.equal(planned, null);
    let n = 0;
    const made = planFolderCopy({
      rootId: "f",
      sourceFolders: [copyFolder({ id: "f", name: "新規" })],
      sourceItems: [copyImage({ id: "i", folderId: "f", tagIds: ["tag"] })],
      sourceTags: [copyTag({ id: "tag", name: "空", folderId: "old" })],
      sourceTagFolders: [{ id: "old", name: "既存枠", order: 0, createdAt: 1, open: true }],
      sourceViews: {},
      destFolders: [],
      destTags: [],
      destTagFolders: [{ id: "kept", name: "既存枠", order: 2, createdAt: 3, open: true }],
      destParentId: null,
      nextId: () => `k${n++}`,
    });
    assert.equal(made?.tags[0]?.folderId, "kept");
    assert.equal(made?.tagFolders.length, 0);
    assert.equal(made?.folders[0]?.name, "新規");
    assert.equal(made?.folders[0]?.order, 0);
  });
});

