import { FONT_FAMILY } from "../constants";
import { FONT_METADATA } from "../fonts/FontMetadata";
import type { ExcalidrawTextElement } from "./types";
import { getClarinStyledVisualLines } from "./clarinCharacterStyle";
import { getClarinCharacterShapingGroups, getClarinNativeFragmentShapingText } from "./clarinCharacterShaping";
import { getClarinNativeBidiFragments } from "./clarinCharacterBidi";
export { getClarinCharacterRunFont } from "./clarinCharacterShaping";

/** The same half-leading and alphabetic baseline as the editor's inline boxes. */
export const getClarinInlineFontMetrics = (
  fontFamily: number,
  fontSize: number,
  lineHeight: number,
) => {
  const { unitsPerEm, ascender, descender } =
    (FONT_METADATA[fontFamily] || FONT_METADATA[FONT_FAMILY.Virgil]).metrics;
  const height = fontSize * lineHeight;
  const ascent = height / 2 + (fontSize * (ascender + descender)) / (2 * unitsPerEm);
  return { ascent, descent: height - ascent, height };
};

/**
 * Every line retains the base-font strut, including empty paragraphs. Larger
 * inline runs expand ascent/descent independently instead of clipping or
 * shifting the baseline differently between Canvas, SVG and contenteditable.
 */
export const getClarinCharacterLineMetrics = (
  element: ExcalidrawTextElement,
  text = element.text,
) => {
  const strut = getClarinInlineFontMetrics(
    element.fontFamily,
    element.fontSize,
    element.lineHeight,
  );
  let top = 0;
  const displayElement = text === element.text ? element : { ...element, text };
  return getClarinStyledVisualLines(displayElement).map((runs) => {
    let ascent = strut.ascent;
    let descent = strut.descent;
    for (const run of runs) {
      if (run.text) {
        const metrics = getClarinInlineFontMetrics(
          run.fontFamily,
          run.fontSize,
          element.lineHeight,
        );
        ascent = Math.max(ascent, metrics.ascent);
        descent = Math.max(descent, metrics.descent);
      }
    }
    const originalGroups = getClarinCharacterShapingGroups(displayElement, runs);
    const bidi = getClarinNativeBidiFragments(displayElement, originalGroups);
    const fullText = originalGroups.map((group) => group.text).join("");
    let groupOffset = 0;
    const groupOffsets = originalGroups.map((group) => {
      const offset = groupOffset; groupOffset += group.text.length; return offset;
    });
    const groups = bidi ? bidi.fragments.map((fragment) => {
      const group = originalGroups[fragment.groupIndex];
      let offset = 0;
      const segments = group.segments.flatMap(({ run }, index) => {
        const start = offset; offset += run.text.length;
        const from = Math.max(start, fragment.from); const to = Math.min(offset, fragment.to);
        if (from >= to || !fragment.clips[index].length) return [];
        return [{ run: { ...run, text: run.text.slice(from - start, to - start),
          from: run.from + from - start, to: run.from + to - start }, clips: fragment.clips[index] }];
      });
      const shapingText = getClarinNativeFragmentShapingText(fullText,
        groupOffsets[fragment.groupIndex] + fragment.from, groupOffsets[fragment.groupIndex] + fragment.to,
        group.font, fragment.width, fragment.rtl);
      return { ...group, text: group.text.slice(fragment.from, fragment.to), shapingText, segments,
        width: fragment.width, rtl: fragment.rtl, nativeX: fragment.x };
    }) : originalGroups;
    const widths = groups.flatMap((group) => group.segments.map((segment) => segment.clips.reduce((sum, clip) => sum + clip.width, 0)));
    const height = ascent + descent;
    const line = {
      runs,
      groups,
      widths,
      width: bidi?.width ?? groups.reduce((sum, group) => sum + group.width, 0),
      top,
      height,
      ascent,
      descent,
      baseline: top + ascent,
    };
    top += height;
    return line;
  });
};
