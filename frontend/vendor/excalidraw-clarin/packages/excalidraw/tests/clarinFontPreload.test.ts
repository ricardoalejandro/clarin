import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class CachedFontFace {
  static unavailable = new Set<string>();
  status: FontFaceLoadStatus = "unloaded";
  constructor(public readonly family: string) {}
  load = vi.fn(async () => {
    if (CachedFontFace.unavailable.has(this.family)) {
      this.status = "error";
      throw new Error("Font is not in the local cache");
    }
    this.status = "loaded";
    return this;
  });
}

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let onlineListener: EventListener | undefined;
// Each case imports the actual editor graph after resetModules. Allow cold
// transformation under concurrent CI builds; these are not performance tests.
const COLD_EDITOR_IMPORT_TIMEOUT_MS = 15_000;

beforeEach(() => {
  vi.resetModules();
  CachedFontFace.unavailable.clear();
  vi.stubGlobal("FontFace", CachedFontFace);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: new Set<FontFace>(),
  });
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
    if (type === "online") onlineListener = listener as EventListener;
  });
});

afterEach(() => {
  onlineListener = undefined;
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});

async function preloadFixture() {
  const { Fonts } = await import("../fonts/Fonts");
  const { ExcalidrawFontFace } = await import("../fonts/ExcalidrawFontFace");
  const faces = Array.from({ length: 32 }, (_, index) =>
    new ExcalidrawFontFace(`Cached family ${index + 1}`, "data:font/woff2;base64,AA=="),
  );
  vi.spyOn(Fonts, "registered", "get").mockReturnValue(new Map(
    faces.map((face, index) => [index + 1, {
      metadata: { metrics: { unitsPerEm: 1000 as const, ascender: 900, descender: -100, lineHeight: 1.2 } },
      fontFaces: [face],
    }]),
  ));
  const fonts = new Fonts({} as never);
  vi.spyOn(fonts, "getSceneFamilies").mockReturnValue([]);
  vi.spyOn(fonts, "onLoaded").mockImplementation(() => {});
  return { fonts, faces };
}

describe("canonical editor font preload without network", () => {
  it("loads all cached families offline and remains complete on a second preload", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { fonts, faces } = await preloadFixture();

    await expect(fonts.preloadSelectableFonts()).resolves.toMatchObject({
      phase: "complete", loaded: 32, total: 32, failed: 0,
    });
    for (const face of faces) expect(face.fontFace.load).toHaveBeenCalledOnce();
    await expect(fonts.preloadSelectableFonts()).resolves.toMatchObject({
      phase: "complete", loaded: 32, total: 32, failed: 0,
    });
    for (const face of faces) expect(face.fontFace.load).toHaveBeenCalledOnce();
  }, COLD_EDITOR_IMPORT_TIMEOUT_MS);

  it("keeps actual cache failures pending offline and resets only the failed face on reconnection", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    CachedFontFace.unavailable.add("Cached family 32");
    const { fonts, faces } = await preloadFixture();
    const failedFace = faces[31].fontFace;

    await expect(fonts.preloadSelectableFonts()).resolves.toMatchObject({
      phase: "offline", loaded: 31, total: 32, failed: 1, failedFamilyIds: [32],
    });
    expect(failedFace.status).toBe("error");
    CachedFontFace.unavailable.clear();
    online.mockReturnValue(true);
    expect(onlineListener).toBeDefined();
    onlineListener!(new Event("online"));

    await vi.waitFor(() => expect(fonts.getPreloadProgress()).toMatchObject({
      phase: "complete", loaded: 32, total: 32, failed: 0,
    }));
    expect(faces[31].fontFace).not.toBe(failedFace);
    expect(document.fonts.has(failedFace)).toBe(false);
    expect(faces[31].fontFace.load).toHaveBeenCalledOnce();
    for (const face of faces.slice(0, 31)) expect(face.fontFace.load).toHaveBeenCalledOnce();
  }, COLD_EDITOR_IMPORT_TIMEOUT_MS);
});
