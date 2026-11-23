import type { ExcalidrawTextElement } from "../element/types";
import { getClarinCharacterStyle } from "../element/clarinCharacterStyle";
import { getClarinJoiningContext } from "../element/clarinCharacterJoining";

/** Inline families must be loaded and embedded with their actual Unicode set. */
export const getClarinCharacterFontSegments = (element: ExcalidrawTextElement) => {
  const segments: Array<{ fontFamily: number; text: string }> = [];
  const format = getClarinCharacterStyle(element);
  const textForSubset = (from: number, to: number) => format?.runs.length
    ? getClarinJoiningContext(element.originalText, from, to).shapingText
    : element.originalText.slice(from, to);
  let offset = 0;
  for (const run of format?.runs || []) {
    if (run.from > offset) segments.push({ fontFamily: element.fontFamily, text: textForSubset(offset, run.from) });
    segments.push({ fontFamily: run.fontFamily ?? element.fontFamily, text: textForSubset(run.from, run.to) });
    offset = run.to;
  }
  if (offset < element.originalText.length || !segments.length) {
    segments.push({ fontFamily: element.fontFamily, text: textForSubset(offset, element.originalText.length) });
  }
  return segments;
};
