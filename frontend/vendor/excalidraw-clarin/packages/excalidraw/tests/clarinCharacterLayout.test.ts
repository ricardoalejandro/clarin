import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawTextElement } from "../element/types";
import {
  createClarinCharacterStyle,
  type ClarinCharacterStyleRun,
} from "../element/clarinCharacterStyle";
import { CLARIN_TEXT_MARK, createClarinTextFormat } from "../element/clarinRichText";
import {
  getClarinCharacterLineMetrics,
  getClarinInlineFontMetrics,
} from "../element/clarinCharacterLayout";
import { getClarinCharacterShapingGroups, getClarinNativeFragmentShapingText } from "../element/clarinCharacterShaping";
import { getClarinStyledVisualLines } from "../element/clarinCharacterStyle";
import { getClarinNativeBidiFragments } from "../element/clarinCharacterBidi";
import { measureClarinText, measureText, setCustomTextMetricsProvider } from "../element/textMeasurements";
import { wrapClarinText, wrapText } from "../element/textWrapping";
import { measureFontSizeFromWidth } from "../element/resizeElements";
import { getBoundTextMaxWidth, redrawTextBoundingBox } from "../element/textElement";
import { getFontString } from "../utils";
import { getClarinCharacterFontSegments } from "../fonts/clarinCharacterFonts";
import { Fonts } from "../fonts";
import {
  appendClarinCharacterSvgText,
  drawClarinCharacterText,
  getClarinPositionedCharacterRuns,
  getClarinCharacterRasterBounds,
} from "../renderer/clarinCharacterRendering";

const textElement = (text: string, runs: ClarinCharacterStyleRun[] = []) => ({
  type: "text",
  text,
  originalText: text,
  fontFamily: 5,
  fontSize: 20,
  lineHeight: 1.25,
  textAlign: "left",
  strokeColor: "#111111",
  width: 200,
  height: 25,
  containerId: null,
  customData: runs.length ? { clarinCharacterStyle: createClarinCharacterStyle(text, runs) } : undefined,
}) as ExcalidrawTextElement;

beforeEach(() => {
  setCustomTextMetricsProvider({
    getLineWidth: (text, font) => {
      const size = Number(font.match(/([\d.]+)px/)?.[1] || 20);
      return Array.from(text).length * size * (font.includes("Cascadia") ? 1.5 : 1);
    },
  });
});

describe("Clarin character layout", () => {
  it("leaves the legacy measurement and wrapping paths unchanged without the extension", () => {
    const element = textElement("Alpha beta\n\nGamma");
    expect(measureClarinText(element)).toEqual(measureText(element.text, getFontString(element), element.lineHeight));
    expect(wrapClarinText(element, 100)).toBe(wrapText(element.originalText, getFontString(element), 100));
  });

  it("measures effective run fonts and keeps a base-font strut on small and empty lines", () => {
    const element = textElement("AB\n\nC", [
      { from: 1, to: 2, fontScale: 2 },
      { from: 4, to: 5, fontScale: 0.5 },
    ]);
    const lines = getClarinCharacterLineMetrics(element);
    expect(lines.map((line) => line.width)).toEqual([60, 0, 10]);
    expect(lines.map((line) => line.height)).toEqual([50, 25, 25]);
    expect(lines.map((line) => line.top)).toEqual([0, 50, 75]);
    expect(measureClarinText(element)).toEqual({ width: 60, height: 100 });
    expect(lines[1].baseline).toBe(50 + getClarinInlineFontMetrics(5, 20, 1.25).ascent);
  });

  it("combines the ascent and descent of different families on a shared baseline", () => {
    const element = textElement("AB", [{ from: 1, to: 2, fontFamily: 3, fontScale: 2 }]);
    const base = getClarinInlineFontMetrics(5, 20, 1.25);
    const inline = getClarinInlineFontMetrics(3, 40, 1.25);
    const [line] = getClarinCharacterLineMetrics(element);
    expect(line.ascent).toBe(Math.max(base.ascent, inline.ascent));
    expect(line.descent).toBe(Math.max(base.descent, inline.descent));
    expect(line.height).toBe(line.ascent + line.descent);
    expect(line.width).toBe(80);
  });

  it("wraps large inline runs at their effective width while preserving original offsets and graphemes", () => {
    const element = textElement("A B C", [{ from: 2, to: 3, fontScale: 2 }]);
    expect(wrapClarinText(element, 60)).toBe("A\nB\nC");
    expect(element.originalText).toBe("A B C");
    const emoji = textElement("A👨‍👩‍👧‍👦B", [{ from: 1, to: 12, fontScale: 2 }]);
    const wrapped = wrapClarinText(emoji, 40);
    expect(wrapped.split("\n")).toContain("👨‍👩‍👧‍👦");
    expect(wrapped.replaceAll("\n", "")).toBe(emoji.originalText);
  });

  it("uses identical run positions, fonts, color and baseline in Canvas and SVG", () => {
    const source = textElement("AB\nC", [{ from: 1, to: 2, color: "#DD0000", fontFamily: 3, fontScale: 2 }]);
    const element = {
      ...source,
      textAlign: "center" as const,
      customData: {
        ...source.customData,
        clarinTextFormat: createClarinTextFormat(source.originalText, [{ from: 1, to: 2, marks: CLARIN_TEXT_MARK.BOLD | CLARIN_TEXT_MARK.UNDERLINE }]),
      },
    };
    const calls: Array<{ text: string; x: number; y: number; font: string; color: string }> = [];
    const context = {
      font: "", fillStyle: "", textAlign: "left",
      fillText(text: string, x: number, y: number) { calls.push({ text, x, y, font: this.font, color: this.fillStyle }); },
      fillRect: vi.fn(),
    };
    drawClarinCharacterText(context as unknown as CanvasRenderingContext2D, element);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    appendClarinCharacterSvgText(document, group, element);
    const spans = [...group.querySelectorAll("text")];
    expect(spans.map((span) => [span.textContent, Number(span.getAttribute("x")), Number(span.getAttribute("y")), span.getAttribute("fill")]))
      .toEqual(calls.map((call) => [call.text, call.x, call.y, call.color]));
    expect(spans[1].getAttribute("font-size")).toBe("40px");
    expect(spans[1].getAttribute("font-family")).toContain("Cascadia");
    expect(spans[1].getAttribute("font-weight")).toBe("700");
    expect(group.querySelector('rect[fill="#DD0000"]')).not.toBeNull();
    expect(calls[1].font).toContain("700 40px");
    expect(context.fillRect).toHaveBeenCalledWith(calls[1].x, calls[1].y + 3.2, 60, 2.5);
  });

  it("keeps physical RTL alignment and positions consistent between renderers", () => {
    const element = { ...textElement("אב", [{ from: 1, to: 2, color: "#DD0000" }]), textAlign: "right" as const };
    const runs = getClarinPositionedCharacterRuns(element)[0];
    expect(runs.map((run) => run.text)).toEqual(["ב", "א"]);
    expect(runs.map((run) => run.x)).toEqual([160, 180]);
    expect(runs.every((run) => run.rtl)).toBe(true);
  });

  it("keeps color-only splits in one shaping group for kerning and cursive scripts", () => {
    for (const text of ["AV", "سلام"]) {
      const element = textElement(text, [{ from: 1, to: text.length - (text.length > 2 ? 1 : 0), color: "#DD0000" }]);
      const [runs] = getClarinStyledVisualLines(element);
      const groups = getClarinCharacterShapingGroups(element, runs);
      expect(groups).toHaveLength(1);
      expect(groups[0].text).toBe(text);
      const context = {
        font: "", fillStyle: "", textAlign: "left",
        save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
        fillText: vi.fn(), fillRect: vi.fn(),
      };
      drawClarinCharacterText(context as unknown as CanvasRenderingContext2D, element);
      expect(context.fillText.mock.calls.map((call) => call[0])).toEqual(runs.map(() => text));
      expect(context.clip).toHaveBeenCalledTimes(runs.length);
      expect(context.rect.mock.calls.some((call) => call[0] < 0)).toBe(true);
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      appendClarinCharacterSvgText(document, group, element);
      expect(group.querySelectorAll("text")).toHaveLength(1);
      expect(group.querySelectorAll("mask")).toHaveLength(1);
      expect(group.textContent).toBe(text);
      expect([...group.querySelectorAll("tspan")].every((span) => !span.hasAttribute("x"))).toBe(true);
    }
  });

  it("measures one joined font group even when color boundaries fall inside a kerned pair", () => {
    setCustomTextMetricsProvider({ getLineWidth: (text) => text === "AV" ? 30 : text.length * 20 });
    const element = textElement("AV", [{ from: 1, to: 2, color: "#DD0000" }]);
    expect(measureClarinText(element).width).toBe(30);
    expect(wrapClarinText(element, 31)).toBe("AV");
  });

  it("preserves Arabic joining at font boundaries without changing canonical text or wrap offsets", () => {
    const widths: Record<string, number> = { "س\u200D": 32, "\u200Dل\u200D": 8, "\u200Dام": 34 };
    setCustomTextMetricsProvider({ getLineWidth: (text) => widths[text] ?? Array.from(text.replaceAll("\u200D", "")).length * 40 });
    const element = textElement("سلام", [{ from: 1, to: 2, fontFamily: 3, fontScale: 2 / 3 }]);
    const [line] = getClarinCharacterLineMetrics(element);
    expect(line.groups.map((group) => [group.text, group.shapingText])).toEqual([
      ["س", "س\u200D"], ["ل", "\u200Dل\u200D"], ["ام", "\u200Dام"],
    ]);
    expect(line.width).toBe(74);
    expect(wrapClarinText(element, 75)).toBe("سلام");
    const context = { font: "", fillStyle: "", textAlign: "left", fillText: vi.fn(), fillRect: vi.fn() };
    drawClarinCharacterText(context as unknown as CanvasRenderingContext2D, element);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "g");
    appendClarinCharacterSvgText(document, svg, element);
    expect([...svg.querySelectorAll("text")].map((node) => node.textContent)).toEqual(context.fillText.mock.calls.map((call) => call[0]));
    expect(element.text).toBe("سلام"); expect(element.originalText).toBe("سلام");
    expect(getClarinCharacterFontSegments(element).map((segment) => segment.text)).toEqual(["س\u200D", "\u200Dل\u200D", "\u200Dام"]);
  });

  it("selects contextual or isolated Arabic forms from the native fragment advance", () => {
    setCustomTextMetricsProvider({ getLineWidth: (text) => text === "س\u200D" ? 32 : text === "س" ? 49 : 0 });
    const font = getFontString(textElement("سلام"));
    expect(getClarinNativeFragmentShapingText("سلام", 0, 1, font, 32)).toBe("س\u200D");
    expect(getClarinNativeFragmentShapingText("سلام", 0, 1, font, 49)).toBe("س");
    expect([...document.body.children].some((node) => (node as HTMLElement).style.left === "-100000px")).toBe(false);
  });

  it("releases its temporary native measurement host even when a DOM range fails", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 40, left: 0 } as DOMRect);
    vi.spyOn(document, "createRange").mockImplementation(() => { throw new Error("Range unavailable"); });
    const element = textElement("AV", [{ from: 1, to: 2, color: "#DD0000" }]);
    expect(measureClarinText(element).width).toBe(40);
    expect([...document.body.children].some((node) => (node as HTMLElement).style.left === "-100000px")).toBe(false);
  });

  it("invalidates inline geometry when a loaded face repeats a legacy font signature", () => {
    const source = { ...textElement("AB", [{ from: 1, to: 2, fontScale: 2 }]), version: 1 };
    const groups = getClarinCharacterShapingGroups(source, getClarinStyledVisualLines(source)[0]);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 40, left: 0 } as DOMRect);
    const first = getClarinNativeBidiFragments(source, groups, { widthOnly: true });
    expect(getClarinNativeBidiFragments(source, groups, { widthOnly: true })).toBe(first);
    expect(bounds).toHaveBeenCalledTimes(1);
    const face = { family: "ClarinGeometryRetry", style: "normal", weight: "400", unicodeRange: "U+0-10FFFF" } as FontFace;
    const signature = `${face.family}-${face.style}-${face.weight}-${face.unicodeRange}`;
    Fonts.loadedFontsCache.add(signature);
    try {
      new Fonts({} as never).onLoaded([face]);
      expect(getClarinNativeBidiFragments(source, groups, { widthOnly: true })).not.toBe(first);
      expect(bounds).toHaveBeenCalledTimes(2);
    } finally { Fonts.loadedFontsCache.delete(signature); }
  });

  it("bounds temporary glyph rasters to the existing target canvas under scale and rotation", () => {
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    expect(getClarinCharacterRasterBounds({ left: -1000, top: -500, right: 9000, bottom: 8000 }, identity, 200, 100))
      .toEqual({ left: 0, top: 0, width: 200, height: 100 });
    expect(getClarinCharacterRasterBounds({ left: 10, top: 20, right: 30, bottom: 40 },
      { a: 0, b: 2, c: -2, d: 0, e: 100, f: 0 }, 200, 100))
      .toEqual({ left: 19, top: 19, width: 42, height: 42 });
    expect(getClarinCharacterRasterBounds({ left: 1000, top: 0, right: 2000, bottom: 20 }, identity, 200, 100)).toBeNull();
    expect(getClarinCharacterRasterBounds({ left: 0, top: 0, right: 20, bottom: 20 }, identity, 0, 0)).toBeNull();
  });

  it("loads and embeds every inline family with its actual characters", () => {
    const element = textElement("A😀BC", [{ from: 1, to: 4, fontFamily: 3 }]);
    expect(getClarinCharacterFontSegments(element)).toEqual([
      { fontFamily: 5, text: "A" }, { fontFamily: 3, text: "😀B" }, { fontFamily: 5, text: "C" },
    ]);
    const fontInternals = Fonts as unknown as {
      getUniqueFamilies(elements: ExcalidrawTextElement[]): number[];
      getCharsPerFamily(elements: ExcalidrawTextElement[]): Record<number, Set<string>>;
    };
    expect(fontInternals.getUniqueFamilies([element])).toEqual([5, 3]);
    const chars = fontInternals.getCharsPerFamily([element]);
    expect([...chars[3]]).toEqual(["😀", "B"]);
    expect([...chars[5]]).toEqual(["A", "C"]);
  });

  it("preserves relative typography on proportional resize and rejects effective fonts below 1px", () => {
    const element = textElement("AB", [{ from: 1, to: 2, fontScale: 0.1 }]);
    expect(measureFontSizeFromWidth(element as never, new Map(), 100)).toEqual({ size: 10 });
    expect(measureFontSizeFromWidth(element as never, new Map(), 99)).toBeNull();
    expect(measureFontSizeFromWidth(textElement("AB") as never, new Map(), 20)).toEqual({ size: 2 });
    expect(element.customData?.clarinCharacterStyle).toEqual(createClarinCharacterStyle("AB", [{ from: 1, to: 2, fontScale: 0.1 }]));
  });

  it("reflows bound text with mixed sizes and expands its real container without losing styles", () => {
    const bound = {
      ...textElement("A B C", [{ from: 2, to: 3, fontScale: 2, color: "#DD0000" }]),
      id: "bound-text", containerId: "text-box", autoResize: true,
      x: 0, y: 0, angle: 0, version: 1, versionNonce: 1, isDeleted: false,
      verticalAlign: "middle",
    } as ExcalidrawTextElement;
    const container = {
      id: "text-box", type: "rectangle", x: 0, y: 0, width: 70, height: 30,
      angle: 0, version: 1, versionNonce: 1, isDeleted: false,
      boundElements: [{ id: bound.id, type: "text" }],
    };
    const elements = new Map<string, unknown>([[bound.id, bound], [container.id, container]]);
    const originalStyle = structuredClone(bound.customData);
    redrawTextBoundingBox(bound, container as never, elements as never, false);
    expect(bound.text).toBe("A\nB\nC");
    expect(bound.height).toBe(100);
    expect(container.height).toBeGreaterThan(bound.height);
    expect(bound.width).toBeLessThanOrEqual(getBoundTextMaxWidth(container as never, bound));
    expect(bound.originalText).toBe("A B C");
    expect(bound.customData).toEqual(originalStyle);
    expect(measureFontSizeFromWidth(bound as never, elements as never, 30)).toEqual({ size: 10 });
  });
});
