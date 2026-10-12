import { describe, expect, it } from "vitest";
import { resolveClarinSubsetWorkerUrl } from "../subset/clarinSubsetWorkerUrl";

describe("Clarin subset worker URL", () => {
  const assets = "/vendor/whiteboards-editor/0.18.1-clarin.8/";
  it("uses the configured versioned asset on the page origin", () => {
    expect(resolveClarinSubsetWorkerUrl(assets, "https://clarin.test/shared/whiteboards/a")?.href)
      .toBe(`https://clarin.test${assets}subset-worker.js`);
    expect(resolveClarinSubsetWorkerUrl(`http://localhost:3011${assets}`, "http://localhost:3011/dashboard")?.href)
      .toBe(`http://localhost:3011${assets}subset-worker.js`);
  });
  it("selects a safe local base from the supported array without loading an external fallback", () => {
    expect(resolveClarinSubsetWorkerUrl(["https://external.invalid/", assets], "https://clarin.test/")?.origin)
      .toBe("https://clarin.test");
  });
  it.each([
    undefined, "file:///tmp/subset-worker.js", "https://external.invalid/",
    "//external.invalid/vendor/whiteboards-editor/0.18.1-clarin.8/",
    "/api/", `${assets}?next=https://external.invalid`, `${assets}#fragment`,
    "/vendor/whiteboards-editor/0.18.1%2fother/",
    `https://user:password@clarin.test${assets}`, "data:text/javascript,void(0)",
  ])("rejects an unsafe or unconfigured asset base: %s", value => {
    expect(resolveClarinSubsetWorkerUrl(value, "https://clarin.test/")).toBeUndefined();
  });
  it("does not build a worker in a file or invalid page context", () => {
    expect(resolveClarinSubsetWorkerUrl(assets, "file:///tmp/editor.html")).toBeUndefined();
    expect(resolveClarinSubsetWorkerUrl(assets, "invalid")).toBeUndefined();
  });
  it.each([3, 4, 5])("supports the exact offline-v%s asset directory on the same origin", version => {
    expect(resolveClarinSubsetWorkerUrl(`/offline-v${version}/whiteboard-assets/`, "http://localhost:3011/")?.href)
      .toBe(`http://localhost:3011/offline-v${version}/whiteboard-assets/subset-worker.js`);
    expect(resolveClarinSubsetWorkerUrl(`/offline-v${version}/arbitrary/`, "http://localhost:3011/")).toBeUndefined();
  });
});
