import { isRTL, getFontString } from "../utils";
import type { ExcalidrawTextElement, FontString } from "./types";
import { CLARIN_TEXT_MARK, getClarinFontForMarks } from "./clarinRichText";
import { getClarinStyledVisualLines } from "./clarinCharacterStyle";
import { getLineWidth } from "./textMeasurements";
import { getClarinJoiningContext } from "./clarinCharacterJoining";

export type ClarinStyledVisualRun = ReturnType<typeof getClarinStyledVisualLines>[number][number];
export interface ClarinShapingClip { x: number; width: number }
export interface ClarinShapedCharacterSegment {
  run: ClarinStyledVisualRun;
  clips: ClarinShapingClip[];
}
export interface ClarinCharacterShapingGroup {
  text: string;
  /** Display-only join controls preserve native forms across font boundaries. */
  shapingText?: string;
  font: FontString;
  rtl: boolean;
  width: number;
  nativeX?: number;
  segments: ClarinShapedCharacterSegment[];
}

export const getClarinCharacterRunFont = (run: {
  fontFamily: number; fontSize: number; marks: number;
}) => getClarinFontForMarks(getFontString(run), run.marks) as FontString;

type NativeGeometry = { width: number; clips: ClarinShapingClip[][] };
type ElementGeometryCache = {
  version: number; text: string; customData: ExcalidrawTextElement["customData"];
  entries: Map<string, NativeGeometry>; characters: number;
};
let nativeGeometryCache = new WeakMap<ExcalidrawTextElement, ElementGeometryCache>();
let nativeJoinsAcrossTypography: boolean | null = null;
export const invalidateClarinCharacterShapingGeometry = () => {
  nativeGeometryCache = new WeakMap(); nativeJoinsAcrossTypography = null;
};
const MAX_NATIVE_GEOMETRY_CHARACTERS = 262_144;
const MAX_NATIVE_GEOMETRY_ENTRIES = 128;

/** Only a fixed, non-private capability boolean survives this synchronous probe. */
const prefersNativeContextualJoining = () => {
  if (nativeJoinsAcrossTypography !== null) return nativeJoinsAcrossTypography;
  if (typeof document === "undefined" || !document.body) return false;
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", left: "-100000px", top: "0", display: "inline-block",
    width: "max-content", margin: "0", padding: "0", border: "0", whiteSpace: "pre", font: "60px Arial", visibility: "hidden",
    pointerEvents: "none", contain: "layout style paint" });
  host.dir = "rtl"; host.setAttribute("aria-hidden", "true");
  const pieces = [{ text: "س", font: "60px Arial", contextual: "س\u200D" },
    { text: "ل", font: "40px Arial", contextual: "\u200Dل\u200D" },
    { text: "ام", font: "60px Arial", contextual: "\u200Dام" }];
  for (const piece of pieces) {
    const span = document.createElement("span"); span.style.font = piece.font;
    span.textContent = piece.text; host.appendChild(span);
  }
  document.body.appendChild(host);
  try {
    const nativeWidth = host.getBoundingClientRect().width;
    if (!(nativeWidth > 0) || !Number.isFinite(nativeWidth)) return false;
    const isolatedWidth = pieces.reduce((sum, piece) => sum + getLineWidth(piece.text, piece.font as FontString, "rtl"), 0);
    const contextualWidth = pieces.reduce((sum, piece) => sum + getLineWidth(piece.contextual, piece.font as FontString, "rtl"), 0);
    nativeJoinsAcrossTypography = Math.abs(nativeWidth - contextualWidth) < Math.abs(nativeWidth - isolatedWidth);
    return nativeJoinsAcrossTypography;
  } catch {
    return false;
  } finally { host.remove(); }
};

/**
 * Native engines differ at typography boundaries. Match their measured glyph
 * advances, using the fixed capability probe only when a monospaced font makes
 * isolated and contextual forms metrically indistinguishable.
 */
export const getClarinNativeFragmentShapingText = (
  text: string, from: number, to: number, font: FontString, nativeWidth: number,
  rtl = isRTL(text.slice(from, to)),
) => {
  const { prefix, suffix } = getClarinJoiningContext(text, from, to);
  const fragment = text.slice(from, to);
  if (!prefix && !suffix) return fragment;
  const preferContextual = prefersNativeContextualJoining();
  let best = fragment; let bestError = Infinity; let bestControls = 0;
  for (const before of prefix ? ["", prefix] : [""]) for (const after of suffix ? ["", suffix] : [""]) {
    const candidate = before + fragment + after;
    const error = Math.abs(getLineWidth(candidate, font, rtl ? "rtl" : "ltr") - nativeWidth);
    const controls = before.length + after.length;
    if (error < bestError - 0.05 || (Math.abs(error - bestError) <= 0.05
      && (preferContextual ? controls > bestControls : controls < bestControls))) {
      best = candidate; bestError = error; bestControls = controls;
    }
  }
  return best;
};

/**
 * Canvas cannot return contextual glyph advances (Arabic joining, ligatures,
 * kerning). Native inline ranges preserve that shaping across color changes.
 * Only compact geometry is cached; the temporary DOM is always removed.
 */
const getNativeGeometry = (
  element: ExcalidrawTextElement,
  runs: readonly ClarinStyledVisualRun[], font: FontString, rtl: boolean,
  prefix: string, suffix: string,
): NativeGeometry | null => {
  if (typeof document === "undefined" || !document.body || runs.length < 2) return null;
  const text = prefix + runs.map((run) => run.text).join("") + suffix;
  let fontsReady = true;
  try { fontsReady = document.fonts?.check(font, text) ?? true; } catch { /* Test/older DOM. */ }
  const key = JSON.stringify([font, rtl, fontsReady, prefix, suffix, runs.map((run) => [run.text, run.color])]);
  let cache = nativeGeometryCache.get(element);
  if (!cache || cache.version !== element.version || cache.text !== element.text || cache.customData !== element.customData) {
    cache = { version: element.version, text: element.text, customData: element.customData, entries: new Map(), characters: 0 };
    nativeGeometryCache.set(element, cache);
  }
  const cached = cache.entries.get(key);
  if (cached) return cached;
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed", left: "-100000px", top: "0", display: "inline-block",
    width: "max-content", minWidth: "0", maxWidth: "none", margin: "0", padding: "0",
    border: "0", whiteSpace: "pre", font, fontKerning: "auto",
    visibility: "hidden", pointerEvents: "none", contain: "layout style paint",
  });
  host.dir = rtl ? "rtl" : "ltr";
  host.setAttribute("aria-hidden", "true");
  // Color is paint-only. Separate spans disable kerning in WebKit even when
  // font-kerning is explicit; ranges on one text node retain native shaping.
  const node = document.createTextNode(text);
  host.appendChild(node);
  document.body.appendChild(host);
  try {
    const bounds = host.getBoundingClientRect();
    if (!(bounds.width > 0) || !Number.isFinite(bounds.width)) return null;
    let offset = prefix.length;
    const clips = runs.map((run) => {
      const range = document.createRange();
      range.setStart(node, offset); offset += run.text.length; range.setEnd(node, offset);
      return Array.from(range.getClientRects()).filter((rect) => rect.width > 0).map((rect) => ({
        x: Math.max(0, rect.left - bounds.left), width: rect.width,
      }));
    });
    if (runs.some((run, index) => run.text && !clips[index].length)) return null;
    const geometry = { width: bounds.width, clips };
    if (key.length <= MAX_NATIVE_GEOMETRY_CHARACTERS) {
      while (cache.entries.size && (cache.entries.size >= MAX_NATIVE_GEOMETRY_ENTRIES
        || cache.characters + key.length > MAX_NATIVE_GEOMETRY_CHARACTERS)) {
        const oldest = cache.entries.keys().next().value!;
        cache.characters -= oldest.length; cache.entries.delete(oldest);
      }
      cache.entries.set(key, geometry); cache.characters += key.length;
    }
    return geometry;
  } catch {
    // A non-layout DOM may expose ranges without client rectangles. Keep the
    // complete shaped text and use the bounded geometry fallback there.
    return null;
  } finally { host.remove(); }
};

/** Paint-only changes must never split the text passed to the shaping engine. */
export const getClarinCharacterShapingGroups = (
  element: ExcalidrawTextElement,
  runs: readonly ClarinStyledVisualRun[],
): ClarinCharacterShapingGroup[] => {
  const grouped: ClarinStyledVisualRun[][] = [];
  for (const run of runs) {
    const previous = grouped[grouped.length - 1];
    const anchor = previous?.[0];
    if (anchor && anchor.fontFamily === run.fontFamily && anchor.fontSize === run.fontSize
      && (anchor.marks & (CLARIN_TEXT_MARK.BOLD | CLARIN_TEXT_MARK.ITALIC))
        === (run.marks & (CLARIN_TEXT_MARK.BOLD | CLARIN_TEXT_MARK.ITALIC))) previous.push(run);
    else grouped.push([run]);
  }
  const rtl = isRTL(element.text);
  const fullText = runs.map((run) => run.text).join("");
  let groupOffset = 0;
  return grouped.map((parts) => {
    const text = parts.map((run) => run.text).join("");
    const { prefix, suffix, shapingText } = getClarinJoiningContext(fullText, groupOffset, groupOffset + text.length);
    groupOffset += text.length;
    const font = getClarinCharacterRunFont(parts[0]);
    const native = getNativeGeometry(element, parts, font, rtl, prefix, suffix);
    const width = native?.width ?? getLineWidth(shapingText, font, rtl ? "rtl" : "ltr");
    const independentWidths = native ? [] : parts.map((run) => getLineWidth(run.text, font));
    const independentTotal = independentWidths.reduce((sum, value) => sum + value, 0);
    let offset = 0;
    const segments = parts.map((run, index) => {
      // Non-layout environments still shape the complete group. The fallback
      // proportion only approximates color boundaries; browsers use DOM ranges.
      const advance = independentTotal ? independentWidths[index] * width / independentTotal : 0;
      const clips = native?.clips[index] ?? [{ x: rtl ? width - offset - advance : offset, width: advance }];
      offset += advance;
      return { run, clips };
    });
    return { text, shapingText, font, rtl, width, segments };
  });
};
