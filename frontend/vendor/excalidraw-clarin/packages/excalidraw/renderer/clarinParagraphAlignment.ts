import {
  getClarinParagraphFormat,
  getClarinParagraphStarts,
} from "../element/clarinParagraphFormat";
import type {
  ExcalidrawTextElement,
  TextAlign,
} from "../element/types";

export interface ClarinVisualLineLayout {
  /** UTF-16 offset of the first rendered code point in originalText. */
  originalOffset: number;
  /** UTF-16 offset of the logical paragraph start in originalText. */
  paragraphStart: number;
  textAlign: TextAlign;
}

export const getClarinSvgTextAnchor = (
  textAlign: TextAlign,
  direction: "ltr" | "rtl",
): "start" | "middle" | "end" => {
  if (textAlign === "center") {
    return "middle";
  }
  if (textAlign === "right") {
    return direction === "rtl" ? "start" : "end";
  }
  return direction === "rtl" ? "end" : "start";
};

const normalizeVisualText = (text: string) =>
  text.replace(/\r\n?/g, "\n");

const advancePastOriginalLineBreak = (text: string, offset: number) => {
  let candidate = offset;

  // Wrapping may trim horizontal whitespace immediately before a hard break.
  // Only skip whitespace here: skipping visible characters could turn a soft
  // wrap into a hard paragraph boundary.
  while (
    candidate < text.length &&
    /[\t\f\v ]/u.test(text[candidate])
  ) {
    candidate++;
  }

  if (text[candidate] === "\r" && text[candidate + 1] === "\n") {
    return candidate + 2;
  }
  if (text[candidate] === "\n" || text[candidate] === "\r") {
    return candidate + 1;
  }
  return offset;
};

/**
 * Maps wrapped visual lines back to originalText without treating soft wraps
 * as persisted paragraph breaks. All offsets are UTF-16, matching DOM ranges,
 * Excalidraw text metadata and String#slice/indexOf.
 */
export const getClarinVisualLineOriginalOffsets = (
  originalText: string,
  visualText: string,
): number[] => {
  const lines = normalizeVisualText(visualText).split("\n");
  let originalOffset = 0;

  return lines.map((line, lineIndex) => {
    let firstOffset = originalOffset;
    let hasCharacter = false;

    // Array.from keeps surrogate pairs together while `character.length`
    // still advances by their exact UTF-16 width.
    for (const character of Array.from(line)) {
      let characterOffset = originalText.indexOf(character, originalOffset);
      if (characterOffset < 0) {
        // Defensive fallback for canonically equivalent normalized glyphs.
        // Keeping the cursor monotonic is more important than guessing a
        // different paragraph from content that is not present verbatim.
        characterOffset = originalOffset;
      }
      if (!hasCharacter) {
        firstOffset = characterOffset;
        hasCharacter = true;
      }
      originalOffset = Math.min(
        originalText.length,
        characterOffset + character.length,
      );
    }

    if (lineIndex < lines.length - 1) {
      originalOffset = advancePastOriginalLineBreak(
        originalText,
        originalOffset,
      );
    }

    return Math.min(firstOffset, originalText.length);
  });
};

/** Resolves the physical alignment for every wrapped display line. */
export const getClarinVisualLineLayouts = (
  element: Pick<
    ExcalidrawTextElement,
    "text" | "originalText" | "textAlign" | "customData"
  >,
): ClarinVisualLineLayout[] => {
  const paragraphStarts = getClarinParagraphStarts(element.originalText);
  const format = getClarinParagraphFormat(element);
  const overrides = new Map(
    format?.paragraphs.map(({ start, align }) => [start, align] as const) || [],
  );
  let paragraphIndex = 0;

  return getClarinVisualLineOriginalOffsets(
    element.originalText,
    element.text,
  ).map((originalOffset) => {
    while (
      paragraphIndex + 1 < paragraphStarts.length &&
      paragraphStarts[paragraphIndex + 1] <= originalOffset
    ) {
      paragraphIndex++;
    }
    const paragraphStart = paragraphStarts[paragraphIndex] || 0;
    return {
      originalOffset,
      paragraphStart,
      textAlign: overrides.get(paragraphStart) || element.textAlign,
    };
  });
};
