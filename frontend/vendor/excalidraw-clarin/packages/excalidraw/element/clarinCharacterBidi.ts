import { getFontString, isRTL } from "../utils";
import { getGraphemeBoundaries } from "./clarinRichText";
import type { ExcalidrawTextElement } from "./types";
import type { ClarinCharacterShapingGroup, ClarinShapingClip } from "./clarinCharacterShaping";

export interface ClarinNativeBidiFragment {
  groupIndex: number;
  /** UTF-16 offsets local to the original shaping group's text. */
  from: number;
  to: number;
  x: number;
  width: number;
  rtl: boolean;
  /** Indexed by original group.segments; horizontal coordinates are fragment-local. */
  clips: ClarinShapingClip[][];
}
export interface ClarinNativeBidiGeometry { width: number; fragments: ClarinNativeBidiFragment[] }
type VisualRect = { x: number; width: number };
type LogicalFragment = Omit<ClarinNativeBidiFragment, "groupIndex" | "clips">;
type MeasureRange = (from: number, to: number) => VisualRect[];
const EPSILON = 0.025;
const MAX_CACHE_CHARACTERS = 262_144;
const MAX_CACHE_ENTRIES = 128;
type GeometryCache = { version: number; customData: unknown; entries: Map<string, ClarinNativeBidiGeometry>; characters: number };
let geometryCache = new WeakMap<ExcalidrawTextElement, GeometryCache>();

/** Font load/retry can change advances even when a browser check previously passed. */
export const invalidateClarinNativeBidiGeometry = () => { geometryCache = new WeakMap(); };

/**
 * A native text node has one range rectangle per directional visual fragment.
 * Find maximal logical fragments with binary range queries, rather than forcing
 * a layout for every character in a potentially very long paragraph.
 */
export const partitionClarinBidiRanges = (text: string, measure: MeasureRange, parentRTL: boolean,
  neutralDirection: (from: number, to: number) => boolean = () => parentRTL,
): LogicalFragment[] => {
  if (!text) return [];
  const boundaries = getGraphemeBoundaries(text);
  const result: LogicalFragment[] = [];
  let start = 0;
  while (start < boundaries.length - 1) {
    let low = start + 1;
    let high = boundaries.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure(boundaries[start], boundaries[middle]).length <= 1) low = middle;
      else high = middle - 1;
    }
    const from = boundaries[start]; const to = boundaries[low];
    const rects = measure(from, to);
    if (rects.length) {
      const left = Math.min(...rects.map((rect) => rect.x));
      const right = Math.max(...rects.map((rect) => rect.x + rect.width));
      const first = measure(from, boundaries[start + 1])[0];
      const last = measure(boundaries[low - 1], to)[0];
      const fragmentText = text.slice(from, to);
      const firstCenter = first ? first.x + first.width / 2 : null;
      const lastCenter = last ? last.x + last.width / 2 : null;
      const rtl = firstCenter !== null && lastCenter !== null && Math.abs(firstCenter - lastCenter) > EPSILON
        ? firstCenter > lastCenter : /[\p{L}\p{N}]/u.test(fragmentText) ? isRTL(fragmentText) : neutralDirection(from, to);
      const fragment = { from, to, x: left, width: right - left, rtl };
      const previous = result[result.length - 1];
      const adjacent = previous && (rtl
        ? Math.abs(fragment.x + fragment.width - previous.x) <= EPSILON
        : Math.abs(previous.x + previous.width - fragment.x) <= EPSILON);
      if (previous && previous.rtl === rtl && previous.to === from && adjacent) {
        previous.to = to; previous.x = Math.min(previous.x, left); previous.width += fragment.width;
      } else result.push(fragment);
    }
    start = low;
  }
  return result;
};

/**
 * Font groups share one native paragraph before any visual positions are read.
 * This preserves bidi ordering across typography boundaries without splitting
 * same-font Arabic/ligature groups merely because their paint color changes.
 */
export const getClarinNativeBidiFragments = (
  element: ExcalidrawTextElement,
  groups: readonly ClarinCharacterShapingGroup[],
  options: { widthOnly?: boolean } = {},
): ClarinNativeBidiGeometry | null => {
  if (groups.length < 2 || typeof document === "undefined" || !document.body) return null;
  const parentRTL = isRTL(element.text);
  const fullText = groups.map((group) => group.text).join("");
  const strongDirection = (character: string): boolean | null => /[\p{L}\p{N}]/u.test(character) ? isRTL(character) : null;
  const resolveNeutralDirection = (from: number, to: number) => {
    let before: boolean | null = null; let after: boolean | null = null;
    for (let index = from - 1; index >= 0 && before === null; index--) before = strongDirection(String.fromCodePoint(fullText.codePointAt(index)!));
    for (let index = to; index < fullText.length && after === null; index++) after = strongDirection(String.fromCodePoint(fullText.codePointAt(index)!));
    return before !== null && before === after ? before : parentRTL;
  };
  let readiness: boolean[] = [];
  try { readiness = groups.map((group) => document.fonts?.check(group.font, group.text) ?? true); } catch { /* Non-layout DOM. */ }
  const key = JSON.stringify([parentRTL, Boolean(options.widthOnly), readiness, groups.map((group) => [group.font, group.text, group.segments.map(({ run }) => run.text.length)])]);
  let cache = geometryCache.get(element);
  if (!cache || cache.version !== element.version || cache.customData !== element.customData) {
    cache = { version: element.version, customData: element.customData, entries: new Map(), characters: 0 };
    geometryCache.set(element, cache);
  }
  const cached = cache.entries.get(key);
  if (cached) return cached;
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed", left: "-100000px", top: "0", display: "inline-block",
    width: "max-content", minWidth: "0", maxWidth: "none", margin: "0", padding: "0", border: "0",
    whiteSpace: "pre", font: getFontString(element), fontKerning: "auto", visibility: "hidden",
    pointerEvents: "none", contain: "layout style paint",
  });
  host.dir = parentRTL ? "rtl" : "ltr";
  host.setAttribute("aria-hidden", "true");
  const nodes = groups.map((group) => {
    const span = document.createElement("span");
    span.style.font = group.font;
    const node = document.createTextNode(group.text);
    span.appendChild(node); host.appendChild(span); return node;
  });
  document.body.appendChild(host);
  try {
    const bounds = host.getBoundingClientRect();
    if (!(bounds.width > 0) || !Number.isFinite(bounds.width)) return null;
    const fragments: ClarinNativeBidiFragment[] = [];
    let groupOffset = 0;
    for (let groupIndex = 0; !options.widthOnly && groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]; const node = nodes[groupIndex];
      const range = document.createRange();
      const measure: MeasureRange = (from, to) => {
        range.setStart(node, from); range.setEnd(node, to);
        return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && Number.isFinite(rect.width)).map((rect) => ({
          x: rect.left - bounds.left, width: rect.width,
        }));
      };
      const sourceOffset = groupOffset;
      groupOffset += group.text.length;
      const pieces = partitionClarinBidiRanges(group.text, measure, parentRTL,
        (from, to) => resolveNeutralDirection(sourceOffset + from, sourceOffset + to));
      if (group.text.trim() && !pieces.length) return null;
      for (const piece of pieces) {
        let offset = 0;
        const clips = group.segments.map(({ run }) => {
          const from = Math.max(piece.from, offset); const to = Math.min(piece.to, offset + run.text.length);
          offset += run.text.length;
          return from < to ? measure(from, to).map((rect) => ({ x: rect.x - piece.x, width: rect.width })) : [];
        });
        fragments.push({ ...piece, groupIndex, clips });
      }
    }
    const geometry = { width: bounds.width, fragments: fragments.sort((left, right) => left.x - right.x || left.groupIndex - right.groupIndex) };
    if (key.length <= MAX_CACHE_CHARACTERS) {
      while (cache.entries.size && (cache.entries.size >= MAX_CACHE_ENTRIES || cache.characters + key.length > MAX_CACHE_CHARACTERS)) {
        const oldest = cache.entries.keys().next().value!;
        cache.characters -= oldest.length; cache.entries.delete(oldest);
      }
      cache.entries.set(key, geometry); cache.characters += key.length;
    }
    return geometry;
  } catch { return null; }
  finally { host.remove(); }
};
