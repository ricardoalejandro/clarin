import { afterEach, describe, expect, it, vi } from "vitest";
import { getClarinNativeBidiFragments, invalidateClarinNativeBidiGeometry, partitionClarinBidiRanges } from "../element/clarinCharacterBidi";
import { getGraphemeBoundaries } from "../element/clarinRichText";
import type { ClarinCharacterShapingGroup } from "../element/clarinCharacterShaping";
import type { ExcalidrawTextElement } from "../element/types";

// Keep range-partition tests independent of the editor/App module graph.
// Browser coverage supplies real font strings and the actual bidi engine.
vi.mock("../utils", () => ({
  getFontString: ({ fontFamily, fontSize }: { fontFamily: number; fontSize: number }) => `${fontSize}px mock-font-${fontFamily}`,
  isRTL: (text: string) => /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/u.test(text.match(/\p{L}/u)?.[0] ?? ""),
}));

type NativePiece = { from: number; to: number; x: number; rtl: boolean };
const sourceRects = (text: string, pieces: NativePiece[]) => {
  const boundaries = getGraphemeBoundaries(text);
  return (from: number, to: number) => pieces.flatMap((piece) => {
    const start = Math.max(from, piece.from); const end = Math.min(to, piece.to);
    if (start >= end) return [];
    const count = boundaries.indexOf(end) - boundaries.indexOf(start);
    const offset = piece.rtl ? boundaries.indexOf(piece.to) - boundaries.indexOf(end)
      : boundaries.indexOf(start) - boundaries.indexOf(piece.from);
    return [{ x: piece.x + offset * 10, width: count * 10 }];
  });
};
const element = () => ({ id: "bidi", version: 1, customData: {}, text: "ABC אבג DEF", originalText: "ABC אבג DEF",
  fontFamily: 2, fontSize: 20, strokeColor: "#112233" }) as ExcalidrawTextElement;
const group = (text: string, family: number, segments = [text]): ClarinCharacterShapingGroup => ({
  text, font: `${family === 2 ? 20 : 36}px Helvetica` as never, rtl: false, width: text.length * 10,
  segments: segments.map((value) => ({ run: { from: 0, to: value.length, text: value, marks: 0,
    color: "#112233", fontFamily: family, fontSize: family === 2 ? 20 : 36, fontScale: family === 2 ? 1 : 1.8 }, clips: [] })),
});
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  vi.restoreAllMocks(); invalidateClarinNativeBidiGeometry(); document.body.replaceChildren();
  if (originalRangeRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts); else Reflect.deleteProperty(document, "fonts");
});

describe("native directional range partition", () => {
  it("splits visual discontinuities at complete graphemes", () => {
    const text = "A😀e\u0301א";
    const measure = sourceRects(text, [{ from: 0, to: 5, x: 0, rtl: false }, { from: 5, to: 6, x: 50, rtl: true }]);
    expect(partitionClarinBidiRanges(text, measure, false)).toEqual([
      { from: 0, to: 5, x: 0, width: 30, rtl: false }, { from: 5, to: 6, x: 50, width: 10, rtl: true },
    ]);
  });
  it("coalesces contiguous same-direction pieces rather than breaking Arabic shaping", () => {
    const text = "سلام";
    const measure = sourceRects(text, [{ from: 0, to: 2, x: 20, rtl: true }, { from: 2, to: 4, x: 0, rtl: true }]);
    expect(partitionClarinBidiRanges(text, measure, true)).toEqual([{ from: 0, to: 4, x: 0, width: 40, rtl: true }]);
  });
  it("uses contextual direction for a single neutral glyph", () => {
    expect(partitionClarinBidiRanges("(", sourceRects("(", [{ from: 0, to: 1, x: 30, rtl: true }]), false, () => true))
      .toEqual([{ from: 0, to: 1, x: 30, width: 10, rtl: true }]);
  });
  it("bounds native layout queries logarithmically for a long uninterrupted group", () => {
    const text = "A".repeat(10000);
    const measure = vi.fn(sourceRects(text, [{ from: 0, to: text.length, x: 0, rtl: false }]));
    expect(partitionClarinBidiRanges(text, measure, false)).toEqual([{ from: 0, to: text.length, x: 0, width: 100000, rtl: false }]);
    expect(measure.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe("whole-line native bidi geometry ownership", () => {
  const installNativeGeometry = () => {
    const pieces = new Map([
      ["ABC א", sourceRects("ABC א", [{ from: 0, to: 4, x: 0, rtl: false }, { from: 4, to: 5, x: 60, rtl: true }])],
      ["ב", sourceRects("ב", [{ from: 0, to: 1, x: 50, rtl: true }])],
      ["ג DEF", sourceRects("ג DEF", [{ from: 0, to: 1, x: 40, rtl: true }, { from: 1, to: 5, x: 70, rtl: false }])],
    ]);
    let hosts = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      hosts++;
      expect(this.childNodes).toHaveLength(3);
      expect(this.textContent).toBe("ABC אבג DEF");
      return new DOMRect(0, 0, 110, 25);
    });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: function (this: Range) {
      expect(this.startContainer).toBe(this.endContainer);
      const measure = pieces.get(this.startContainer.textContent!);
      if (!measure) throw new Error("Unexpected native text node");
      return measure(this.startOffset, this.endOffset).map((rect) => new DOMRect(rect.x, 0, rect.width, 25));
    } });
    return { hosts: () => hosts };
  };
  it("measures all font groups in one paragraph and returns physical positions with fragment-local clips", () => {
    installNativeGeometry();
    const groups = [group("ABC א", 2, ["AB", "C א"]), group("ב", 3), group("ג DEF", 2)];
    const result = getClarinNativeBidiFragments(element(), groups)!;
    expect(result.width).toBe(110);
    expect(result.fragments.map(({ groupIndex, from, to, x, width, rtl }) => ({ groupIndex, from, to, x, width, rtl }))).toEqual([
      { groupIndex: 0, from: 0, to: 4, x: 0, width: 40, rtl: false },
      { groupIndex: 2, from: 0, to: 1, x: 40, width: 10, rtl: true },
      { groupIndex: 1, from: 0, to: 1, x: 50, width: 10, rtl: true },
      { groupIndex: 0, from: 4, to: 5, x: 60, width: 10, rtl: true },
      { groupIndex: 2, from: 1, to: 5, x: 70, width: 40, rtl: false },
    ]);
    expect(result.fragments[0].clips).toEqual([[{ x: 0, width: 20 }], [{ x: 20, width: 20 }]]);
    expect(result.fragments[3].clips).toEqual([[], [{ x: 0, width: 10 }]]);
    expect(document.body.children).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("ABC");
  });
  it("reuses geometry but invalidates after font readiness or explicit font-load notification", () => {
    const native = installNativeGeometry(); const source = element();
    const groups = [group("ABC א", 2), group("ב", 3), group("ג DEF", 2)];
    let ready = false;
    Object.defineProperty(document, "fonts", { configurable: true, value: { check: () => ready } });
    const first = getClarinNativeBidiFragments(source, groups);
    expect(getClarinNativeBidiFragments(source, groups)).toBe(first);
    expect(native.hosts()).toBe(1);
    ready = true;
    expect(getClarinNativeBidiFragments(source, groups)).not.toBe(first);
    expect(native.hosts()).toBe(2);
    invalidateClarinNativeBidiGeometry(); getClarinNativeBidiFragments(source, groups);
    expect(native.hosts()).toBe(3);
    source.version++; getClarinNativeBidiFragments(source, groups);
    expect(native.hosts()).toBe(4);
  });
  it("measures wrapping widths without querying glyph ranges or poisoning the fragment cache", () => {
    const native = installNativeGeometry(); const source = element();
    const groups = [group("ABC א", 2), group("ב", 3), group("ג DEF", 2)];
    const ranges = vi.spyOn(document, "createRange");
    const widthOnly = getClarinNativeBidiFragments(source, groups, { widthOnly: true });
    expect(widthOnly).toEqual({ width: 110, fragments: [] });
    expect(ranges).not.toHaveBeenCalled();
    expect(getClarinNativeBidiFragments(source, groups, { widthOnly: true })).toBe(widthOnly);
    expect(native.hosts()).toBe(1);
    expect(getClarinNativeBidiFragments(source, groups)!.fragments.length).toBeGreaterThan(0);
    expect(native.hosts()).toBe(2); expect(ranges).toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
  });
  it("removes temporary DOM when native layout fails and creates content only as text", () => {
    const payload = '<img src="x" onerror="alert(1)">';
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      expect(this.querySelector("img")).toBeNull(); expect(this.textContent).toBe(payload + "tail");
      return new DOMRect(0, 0, 100, 25);
    });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => { throw new Error("layout unavailable"); } });
    expect(getClarinNativeBidiFragments({ ...element(), text: payload + "tail" }, [group(payload, 2), group("tail", 3)])).toBeNull();
    expect(document.body.children).toHaveLength(0);
  });
  it("leaves a complete same-font color group to the existing contextual shaping path", () => {
    const spy = vi.spyOn(document.body, "appendChild");
    expect(getClarinNativeBidiFragments(element(), [group("سلام", 2, ["س", "لام"])] )).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
