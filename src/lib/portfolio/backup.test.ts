import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackupError, BACKUP_VERSION, batchImageIndexes, buildBackup, emptyLibraryBackup, isBackupFileName, packBackup, readBackup, type BackupManifest, type LibraryDump } from "./backup.ts";
import { ALL_FOLDERS, type ImageMeta } from "./types.ts";

function meta(id: string, extra: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id,
    name: `${id}.png`,
    mime: "image/png",
    width: 10,
    height: 20,
    byteSize: 4,
    addedAt: 1,
    order: id === "b" ? 2 : 1,
    scale: 1,
    source: "file",
    folderId: "folder",
    favorite: id === "a",
    tagIds: ["tag"],
    animated: false,
    memo: "",
    ...extra,
  };
}

function dump(blobs: LibraryDump["blobs"], metas: ImageMeta[]): LibraryDump {
  return {
    metas,
    blobs,
    folders: [{ id: "folder", name: "作品", order: 0, createdAt: 1, parentId: null, isParent: false, color: "#e07a5f" }],
    views: [{ id: "folder", columns: 3, direction: "desc" }],
    tags: [{ id: "tag", name: "人物", color: "#e07a5f", order: 0, createdAt: 1, folderId: "group" }],
    tagFolders: [{ id: "group", name: "分類", order: 0, createdAt: 1, open: true }],
    settings: [{ key: "favoritesOnly", value: 1 }, { key: "tag", value: "[\"tag\"]" }],
  };
}

describe("backup file", () => {
  it("recognizes a backup name and describes an empty library", () => {
    assert.equal(isBackupFileName("save.kmb"), true);
    assert.equal(isBackupFileName(" SAVE.KMB "), true);
    assert.equal(isBackupFileName("photo.png"), false);
    assert.equal(isBackupFileName("notes.kmb.txt"), false);
    const parsed = emptyLibraryBackup({
      id: "fresh",
      name: "未分類",
      order: 0,
      createdAt: Date.parse("2026-10-28T00:00:00Z"),
      parentId: null,
      isParent: false,
      color: null,
    });
    assert.equal(parsed.images.length, 0);
    assert.equal(parsed.summary.images, 0);
    assert.equal(parsed.summary.folders, 1);
    assert.equal(parsed.manifest.folders.length, 1);
    assert.equal(parsed.manifest.folders[0]?.name, "未分類");
    assert.equal(parsed.manifest.tags.length, 0);
    assert.equal(parsed.manifest.tagFolders.length, 0);
    assert.equal(parsed.manifest.images.length, 0);
    assert.equal(parsed.manifest.settings.find((row) => row.key === "folder")?.value, ALL_FOLDERS);
    assert.equal(parsed.manifest.version, BACKUP_VERSION);
  });

  it("roundtrips an empty library", async () => {
    const { file, summary } = buildBackup(dump(new Map(), []), new Date("2026-10-26T12:00:00Z"));
    const parsed = await readBackup(file);
    assert.equal(summary.images, 0);
    assert.equal(parsed.images.length, 0);
    assert.equal(parsed.manifest.folders[0]?.color, "#e07a5f");
    assert.equal(parsed.manifest.settings[1]?.value, "[\"tag\"]");
    assert.equal(file.size, parsed.summary.bytes);
  });

  it("keeps image bytes, order, tags, and thumbs", async () => {
    const large = new Uint8Array(300_000);
    large[0] = 7;
    large[299_999] = 9;
    const blobs = new Map([
      ["a", { original: new Blob(["one"], { type: "image/png" }), thumb: new Blob(["thumb"], { type: "image/jpeg" }) }],
      ["b", { original: new Blob([large], { type: "video/mp4" }), thumb: null }],
    ]);
    const { file } = buildBackup(dump(blobs, [meta("b", { mime: "video/mp4", favorite: false }), meta("a", { memo: "夕景", inkVisible: false })]), new Date("2026-10-26T12:00:00Z"));
    const parsed = await readBackup(file);
    assert.deepEqual(parsed.images.map((image) => image.meta.id), ["b", "a"]);
    assert.equal(await parsed.images[1]!.original.text(), "one");
    assert.equal(await parsed.images[1]!.thumb?.text(), "thumb");
    assert.equal(parsed.images[0]!.original.size, 300_000);
    assert.equal(parsed.images[0]!.thumb, null);
    assert.equal(parsed.summary.videos, 1);
    assert.equal(parsed.summary.favorites, 1);
    assert.equal(parsed.images[1]?.meta.memo, "夕景");
    assert.equal(parsed.images[0]?.meta.memo, "");
    assert.equal(parsed.images[1]?.meta.inkVisible, false);
    assert.equal(parsed.images[0]?.meta.inkVisible, true);
    assert.equal(parsed.images[0]?.ink, null);
    assert.equal(parsed.images[1]?.ink, null);
    assert.equal(parsed.manifest.tags[0]?.folderId, "group");
    assert.equal(parsed.manifest.folderViews[0]?.direction, "desc");
  });

  it("rejects a file that is not a backup and does not invent records", async () => {
    await assert.rejects(readBackup(new Blob(["hello"])), (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.match(error.message, /バックアップファイルではありません/);
      return true;
    });
  });

  it("rejects a truncated file, a future version, and a short image", async () => {
    const { file } = buildBackup(dump(new Map([["a", { original: new Blob(["data"], { type: "image/png" }), thumb: null }]]), [meta("a")]));
    await assert.rejects(readBackup(file.slice(0, file.size - 1)), /途中で切れています/);
    const manifest: BackupManifest = {
      format: "komacho-backup",
      version: BACKUP_VERSION + 1,
      createdAt: "2026-10-26T00:00:00.000Z",
      images: [],
      folders: [],
      folderViews: [],
      tags: [],
      tagFolders: [],
      settings: [],
    };
    await assert.rejects(readBackup(packBackup(manifest, [])), /対応していません/);
    const broken: BackupManifest = {
      ...manifest,
      version: BACKUP_VERSION,
      images: [
        {
          meta: meta("a"),
          originalBytes: 1,
          originalType: "image/png",
          thumbBytes: 0,
          thumbType: null,
        },
      ],
    };
    await assert.rejects(readBackup(packBackup(broken, [new Blob(["data"])])), /長さが記録と一致しません/);
  });

  it("keeps a drawing with its image and still reads a backup that has none", async () => {
    const ink = new Blob(["ink"], { type: "image/png" });
    const { file } = buildBackup({
      ...dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]),
      inks: new Map([["a", ink]]),
    });
    const parsed = await readBackup(file);
    assert.equal(await parsed.images[0]?.ink?.text(), "ink");
    assert.equal(parsed.manifest.images[0]?.inkBytes, 3);
    const old = parsed.manifest;
    const withoutInk = {
      ...old,
      images: old.images.map((image) => {
        const { inkBytes: _inkBytes, inkType: _inkType, ...rest } = image;
        const { inkVisible: _inkVisible, ...meta } = rest.meta;
        return { ...rest, meta };
      }),
    };
    const legacy = packBackup(withoutInk, [parsed.images[0]!.original]);
    const again = await readBackup(legacy);
    assert.equal(again.images[0]?.ink, null);
    assert.equal(again.images[0]?.meta.inkVisible, true);
    assert.equal(await again.images[0]?.original.text(), "one");
  });

  it("keeps the canvas separate from image ink and still reads a backup without one", async () => {
    const ink = new Blob(["ink"], { type: "image/png" });
    const canvas = new Blob(["board"], { type: "image/png" });
    const { file } = buildBackup({
      ...dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]),
      inks: new Map([["a", ink]]),
      canvas,
    });
    const parsed = await readBackup(file);
    assert.equal(await parsed.images[0]?.ink?.text(), "ink");
    assert.equal(await parsed.canvas?.text(), "board");
    assert.equal(parsed.manifest.canvas?.bytes, 5);
    const plainFile = buildBackup(dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]));
    const plain = await readBackup(plainFile.file);
    assert.equal(plain.canvas, null);
    assert.equal(plain.manifest.canvas, undefined);
  });

  it("keeps canvas placements in settings, away from the pen layer and the sheet", async () => {
    const placements = JSON.stringify([{ id: "p", imageId: "a", x: 1, y: 2, width: 30, rotation: 4, z: 1 }]);
    const { file } = buildBackup({
      ...dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]),
      inks: new Map([["a", new Blob(["ink"], { type: "image/png" })]]),
      canvas: new Blob(["board"], { type: "image/png" }),
      settings: [
        { key: "favoritesOnly", value: 1 },
        { key: "canvasPlacements", value: placements },
      ],
    });
    const parsed = await readBackup(file);
    assert.equal(parsed.manifest.settings.find((setting) => setting.key === "canvasPlacements")?.value, placements);
    assert.equal(await parsed.images[0]?.ink?.text(), "ink");
    assert.equal(await parsed.canvas?.text(), "board");
    const older = buildBackup(dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]));
    const plain = await readBackup(older.file);
    assert.equal(plain.manifest.settings.some((setting) => setting.key === "canvasPlacements"), false);
  });

  it("keeps a drop-time memo composite after the sheet and still reads a backup without one", async () => {
    const placements = JSON.stringify([{ id: "p", imageId: "a", x: 1, y: 2, width: 30, rotation: 0, z: 1, flat: true }]);
    const { file } = buildBackup({
      ...dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]),
      inks: new Map([["a", new Blob(["ink"], { type: "image/png" })]]),
      canvas: new Blob(["board"], { type: "image/png" }),
      flats: new Map([
        ["p", new Blob(["flat"], { type: "image/png" })],
        ["q", new Blob(["second"], { type: "image/png" })],
      ]),
      settings: [{ key: "canvasPlacements", value: placements }],
    });
    const parsed = await readBackup(file);
    assert.equal(await parsed.images[0]?.ink?.text(), "ink");
    assert.equal(await parsed.canvas?.text(), "board");
    assert.deepEqual(
      parsed.flats?.map((flat) => flat.id),
      ["p", "q"],
    );
    assert.equal(await parsed.flats?.[0]?.png.text(), "flat");
    assert.equal(await parsed.flats?.[1]?.png.text(), "second");
    assert.equal(parsed.manifest.flats?.[0]?.bytes, 4);
    const bare = buildBackup({
      ...dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]),
      flats: new Map([["p", new Blob(["only"], { type: "image/png" })]]),
    });
    const withoutSheet = await readBackup(bare.file);
    assert.equal(withoutSheet.canvas, null);
    assert.equal(await withoutSheet.flats?.[0]?.png.text(), "only");
    const older = buildBackup(dump(new Map([["a", { original: new Blob(["one"], { type: "image/png" }), thumb: null }]]), [meta("a")]));
    const plain = await readBackup(older.file);
    assert.equal(plain.flats?.length, 0);
    assert.equal(plain.manifest.flats, undefined);
  });

  it("refuses to pack a library whose image body is missing", () => {
    assert.throws(() => buildBackup(dump(new Map(), [meta("a")])), /足りないため/);
  });

  it("splits restore batches without dropping or merging an oversized body", () => {
    assert.deepEqual(batchImageIndexes([]), []);
    assert.deepEqual(
      batchImageIndexes([100, 100, 100], 250, 12),
      [[0, 1], [2]],
    );
    assert.deepEqual(batchImageIndexes([10, 5_000, 10], 1_000, 12), [[0], [1], [2]]);
    const many = batchImageIndexes(Array.from({ length: 30 }, () => 10), 1_000_000, 12);
    assert.deepEqual(many.map((batch) => batch.length), [12, 12, 6]);
    assert.deepEqual(many.flat(), Array.from({ length: 30 }, (_, index) => index));
  });
});
