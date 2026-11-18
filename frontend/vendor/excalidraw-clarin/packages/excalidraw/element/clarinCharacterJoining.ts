import { CLARIN_JOINING_RANGES } from "./clarinJoiningTypes18";

export type ClarinJoiningType = "U" | "C" | "D" | "L" | "R" | "T";
export interface ClarinJoiningContext {
  prefix: "" | "\u200D";
  suffix: "" | "\u200D";
  /** Display-only shaping input; never replace canonical text or its UTF-16 offsets. */
  shapingText: string;
}

/** Unicode 18.0.0 facts, including default U, independent of the browser's Unicode version. */
export const getClarinJoiningType = (codePoint: number): ClarinJoiningType => {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return "U";
  let low = 0;
  let high = CLARIN_JOINING_RANGES.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [from, to, type] = CLARIN_JOINING_RANGES[middle];
    if (codePoint < from) high = middle - 1;
    else if (codePoint > to) low = middle + 1;
    else return type;
  }
  return "U";
};

const isHighSurrogate = (code: number) => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = (code: number) => code >= 0xDC00 && code <= 0xDFFF;
const splitsCodePoint = (text: string, offset: number) => offset > 0 && offset < text.length
  && isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));

/** Joining uses logical character order, not physical left/right positions. Only T is skipped. */
const joinsAcross = (text: string, boundary: number): boolean => {
  let before = boundary;
  let previous: ClarinJoiningType = "U";
  while (before > 0) {
    let at = before - 1;
    if (at > 0 && isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1))) at--;
    previous = getClarinJoiningType(text.codePointAt(at)!);
    if (previous !== "T") break;
    before = at;
  }
  if (previous !== "D" && previous !== "L" && previous !== "C") return false;
  let after = boundary;
  while (after < text.length) {
    const codePoint = text.codePointAt(after)!;
    const next = getClarinJoiningType(codePoint);
    if (next !== "T") return next === "D" || next === "R" || next === "C";
    after += codePoint > 0xFFFF ? 2 : 1;
  }
  return false;
};

/**
 * Preserve native joining when painting a UTF-16 fragment with a separate font.
 * The caller supplies the complete logical visual line; line edges, U characters
 * (including ZWNJ), and invalid/split-surrogate bounds never manufacture joins.
 * This has no DOM, network, persistence, clipboard, or content-cache side effects.
 */
export const getClarinJoiningContext = (text: string, from: number, to: number): ClarinJoiningContext => {
  const fragment = text.slice(from, to);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > text.length
    || from >= to || splitsCodePoint(text, from) || splitsCodePoint(text, to)) {
    return { prefix: "", suffix: "", shapingText: fragment };
  }
  const prefix = from > 0 && joinsAcross(text, from) ? "\u200D" : "";
  const suffix = to < text.length && joinsAcross(text, to) ? "\u200D" : "";
  return { prefix, suffix, shapingText: prefix + fragment + suffix };
};
