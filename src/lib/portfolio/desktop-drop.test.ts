import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desktopDropPoint, desktopDropsListening, fileNameFromPath, isDesktopShell, parseDesktopDropEvent, startDesktopFileDrops } from "./desktop-drop.ts";

describe("desktop file drops", () => {
  it("is inactive in a normal browser page", async () => {
    assert.equal(isDesktopShell(), false);
    assert.equal(desktopDropsListening(), false);
    const stop = await startDesktopFileDrops(() => {
      throw new Error("browser drop");
    });
    assert.equal(desktopDropsListening(), false);
    stop();
  });

  it("reads a wrapped drag-drop payload and scales physical pixels", () => {
    const parsed = parseDesktopDropEvent({
      event: "tauri://drag-drop",
      payload: { paths: ["C:\\pics\\a.jpg", "D:\\b.png"], position: { x: 200, y: 80 } },
    });
    assert.deepEqual(parsed?.paths, ["C:\\pics\\a.jpg", "D:\\b.png"]);
    assert.deepEqual(desktopDropPoint(parsed?.position ?? null, 2), { x: 100, y: 40 });
    assert.equal(fileNameFromPath("C:\\pics\\a.jpg"), "a.jpg");
    assert.equal(fileNameFromPath("/home/me/b.png"), "b.png");
    assert.equal(parseDesktopDropEvent({ payload: { paths: [] } }), null);
  });
});
