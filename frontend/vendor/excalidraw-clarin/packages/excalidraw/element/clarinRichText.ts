import type { ExcalidrawTextElement } from "./types";

export const CLARIN_TEXT_FORMAT_KEY = "clarinTextFormat";
export const CLARIN_TEXT_FORMAT_VERSION = 1 as const;
export const MAX_CLARIN_TEXT_RUNS_PER_ELEMENT = 4096;
export const MAX_CLARIN_TEXT_RUNS_PER_SCENE = 50_000;

export const CLARIN_TEXT_MARK = {
  BOLD: 1,
  ITALIC: 2,
  UNDERLINE: 4,
  STRIKE: 8,
} as const;

export type ClarinTextMark =
  (typeof CLARIN_TEXT_MARK)[keyof typeof CLARIN_TEXT_MARK];

export interface ClarinTextFormatRun {
  from: number;
  to: number;
  marks: number;
}

export interface ClarinTextFormat {
  version: typeof CLARIN_TEXT_FORMAT_VERSION;
  textLength: number;
  textHash: number;
  runs: ClarinTextFormatRun[];
}

export type ClarinTextMarkState = "off" | "on" | "mixed";

export interface ClarinVisualTextRun extends ClarinTextFormatRun {
  text: string;
}

export interface ClarinRichTextEditorController {
  elementId: ExcalidrawTextElement["id"];
  captureSelection: () => void;
  toggleMark: (mark: ClarinTextMark) => void;
  getMarkState: (mark: ClarinTextMark) => ClarinTextMarkState;
  setParagraphAlignment: (
    align: ExcalidrawTextElement["textAlign"],
  ) => void;
  getParagraphAlignmentState: () =>
    | ExcalidrawTextElement["textAlign"]
    | "mixed";
}

let activeRichTextEditor: ClarinRichTextEditorController | null = null;
let richTextStateVersion = 0;
const richTextStateListeners = new Set<() => void>();

export const publishClarinRichTextState = () => {
  richTextStateVersion++;
  richTextStateListeners.forEach((listener) => listener());
};

export const setActiveClarinRichTextEditor = (
  controller: ClarinRichTextEditorController | null,
) => {
  activeRichTextEditor = controller;
  publishClarinRichTextState();
};

export const getActiveClarinRichTextEditor = () => activeRichTextEditor;

export const clearActiveClarinRichTextEditor = (
  controller: ClarinRichTextEditorController,
) => {
  if (activeRichTextEditor === controller) {
    setActiveClarinRichTextEditor(null);
  }
};

export const subscribeClarinRichTextState = (listener: () => void) => {
  richTextStateListeners.add(listener);
  return () => {
    richTextStateListeners.delete(listener);
  };
};

export const getClarinRichTextStateVersion = () => richTextStateVersion;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const CLARIN_TEXT_FORMAT_KEYS = new Set([
  "version",
  "textLength",
  "textHash",
  "runs",
]);
const CLARIN_TEXT_RUN_KEYS = new Set(["from", "to", "marks"]);
const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
) => {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

/** djb2 over UTF-16 code units, matching Excalidraw's hashString(). */
export const hashClarinText = (text: string): number => {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = (hash << 5) + hash + text.charCodeAt(index);
  }
  return hash >>> 0;
};

export const getGraphemeBoundaries = (text: string): number[] => {
  const boundaries = [0];
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "grapheme" },
    ) => { segment: (value: string) => Iterable<{ index: number }> };
  }).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    for (const part of segmenter.segment(text)) {
      if (part.index > 0 && part.index < text.length) {
        boundaries.push(part.index);
      }
    }
  } else {
    let offset = 0;
    for (const codePoint of Array.from(text)) {
      offset += codePoint.length;
      if (offset < text.length) {
        boundaries.push(offset);
      }
    }
  }
  if (boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }
  return boundaries;
};

const snapBoundary = (
  boundaries: readonly number[],
  offset: number,
  direction: "backward" | "forward",
) => {
  const bounded = Math.max(0, Math.min(boundaries[boundaries.length - 1], offset));
  if (boundaries.includes(bounded)) {
    return bounded;
  }
  if (direction === "backward") {
    for (let index = boundaries.length - 1; index >= 0; index--) {
      if (boundaries[index] < bounded) {
        return boundaries[index];
      }
    }
    return 0;
  }
  for (const boundary of boundaries) {
    if (boundary > bounded) {
      return boundary;
    }
  }
  return boundaries[boundaries.length - 1];
};

export const snapClarinTextRange = (
  text: string,
  from: number,
  to: number,
): readonly [number, number] => {
  const boundaries = getGraphemeBoundaries(text);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return [
    snapBoundary(boundaries, start, "backward"),
    snapBoundary(boundaries, end, "forward"),
  ];
};

const marksAt = (runs: readonly ClarinTextFormatRun[], offset: number) => {
  for (const run of runs) {
    if (run.from <= offset && offset < run.to) {
      return run.marks;
    }
    if (run.from > offset) {
      break;
    }
  }
  return 0;
};

export const normalizeClarinTextRuns = (
  text: string,
  inputRuns: readonly ClarinTextFormatRun[],
): ClarinTextFormatRun[] => {
  if (!text || !inputRuns.length) {
    return [];
  }
  const boundaries = getGraphemeBoundaries(text);
  const boundarySet = new Set(boundaries);
  const points = new Set<number>([0, text.length]);
  const snappedRuns: ClarinTextFormatRun[] = [];

  for (const input of inputRuns.slice(0, MAX_CLARIN_TEXT_RUNS_PER_ELEMENT)) {
    if (!input || !Number.isInteger(input.from) || !Number.isInteger(input.to)) {
      continue;
    }
    const marks = Number(input.marks) & 15;
    if (!marks) {
      continue;
    }
    const [from, to] = snapClarinTextRange(text, input.from, input.to);
    if (from >= to) {
      continue;
    }
    snappedRuns.push({ from, to, marks });
    points.add(from);
    points.add(to);
  }

  const orderedPoints = Array.from(points)
    .filter((point) => boundarySet.has(point))
    .sort((left, right) => left - right);
  const normalized: ClarinTextFormatRun[] = [];
  for (let index = 0; index < orderedPoints.length - 1; index++) {
    const from = orderedPoints[index];
    const to = orderedPoints[index + 1];
    let marks = 0;
    for (const run of snappedRuns) {
      if (run.from <= from && to <= run.to) {
        marks |= run.marks;
      }
    }
    if (!marks) {
      continue;
    }
    const previous = normalized[normalized.length - 1];
    if (previous && previous.to === from && previous.marks === marks) {
      previous.to = to;
    } else {
      normalized.push({ from, to, marks });
    }
  }
  return normalized.slice(0, MAX_CLARIN_TEXT_RUNS_PER_ELEMENT);
};

export const createClarinTextFormat = (
  text: string,
  runs: readonly ClarinTextFormatRun[],
): ClarinTextFormat => ({
  version: CLARIN_TEXT_FORMAT_VERSION,
  textLength: text.length,
  textHash: hashClarinText(text),
  runs: normalizeClarinTextRuns(text, runs),
});

export const validateClarinTextFormat = (
  value: unknown,
  text: string,
): value is ClarinTextFormat => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CLARIN_TEXT_FORMAT_KEYS) ||
    value.version !== CLARIN_TEXT_FORMAT_VERSION
  ) {
    return false;
  }
  if (
    value.textLength !== text.length ||
    value.textHash !== hashClarinText(text) ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_CLARIN_TEXT_RUNS_PER_ELEMENT
  ) {
    return false;
  }
  const boundarySet = new Set(getGraphemeBoundaries(text));
  let previous: ClarinTextFormatRun | null = null;
  for (const candidate of value.runs) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, CLARIN_TEXT_RUN_KEYS)) {
      return false;
    }
    const from = candidate.from;
    const to = candidate.to;
    const marks = candidate.marks;
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      !Number.isInteger(marks) ||
      (marks as number) < 1 ||
      (marks as number) > 15 ||
      (from as number) < 0 ||
      (from as number) >= (to as number) ||
      (to as number) > text.length ||
      !boundarySet.has(from as number) ||
      !boundarySet.has(to as number)
    ) {
      return false;
    }
    const run = candidate as unknown as ClarinTextFormatRun;
    if (
      previous &&
      (run.from < previous.to ||
        (run.from === previous.to && run.marks === previous.marks))
    ) {
      return false;
    }
    previous = run;
  }
  return true;
};

export const getClarinTextFormat = (
  element: Pick<ExcalidrawTextElement, "originalText" | "customData">,
): ClarinTextFormat | null => {
  const candidate = element.customData?.[CLARIN_TEXT_FORMAT_KEY];
  return validateClarinTextFormat(candidate, element.originalText)
    ? candidate
    : null;
};

export const updateClarinTextCustomData = (
  customData: Record<string, unknown> | undefined,
  format: ClarinTextFormat | null,
) => {
  const next = { ...(customData || {}) };
  if (format?.runs.length) {
    next[CLARIN_TEXT_FORMAT_KEY] = format;
  } else {
    delete next[CLARIN_TEXT_FORMAT_KEY];
  }
  return Object.keys(next).length ? next : undefined;
};

/**
 * `newElementWith()` intentionally treats `undefined` as "leave unchanged".
 * Rich-text metadata, however, must be able to remove the final customData
 * field. Callers use this predicate to force that otherwise invisible update.
 */
export const shouldForceClarinCustomDataRemoval = (
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) => typeof previous !== "undefined" && typeof next === "undefined";

export const getClarinMarksAtCaret = (
  format: ClarinTextFormat | null,
  offset: number,
) => {
  if (!format?.runs.length) {
    return 0;
  }
  const bounded = Math.max(0, Math.min(format.textLength, offset));
  return marksAt(format.runs, bounded > 0 ? bounded - 1 : bounded);
};

export const getClarinMarkState = (
  format: ClarinTextFormat | null,
  text: string,
  from: number,
  to: number,
  mark: ClarinTextMark,
): ClarinTextMarkState => {
  if (from === to) {
    return getClarinMarksAtCaret(format, from) & mark ? "on" : "off";
  }
  const [start, end] = snapClarinTextRange(text, from, to);
  const points = new Set<number>([start, end]);
  for (const run of format?.runs || []) {
    if (start < run.to && run.from < end) {
      points.add(Math.max(start, run.from));
      points.add(Math.min(end, run.to));
    }
  }
  const ordered = Array.from(points).sort((left, right) => left - right);
  let marked = 0;
  let unmarked = 0;
  let visibleMarked = 0;
  let visibleUnmarked = 0;
  for (let index = 0; index < ordered.length - 1; index++) {
    if (ordered[index] === ordered[index + 1]) {
      continue;
    }
    const isMarked = Boolean(
      marksAt(format?.runs || [], ordered[index]) & mark,
    );
    const hasVisibleText = /\S/u.test(
      text.slice(ordered[index], ordered[index + 1]),
    );
    if (isMarked) {
      marked++;
      if (hasVisibleText) {
        visibleMarked++;
      }
    } else {
      unmarked++;
      if (hasVisibleText) {
        visibleUnmarked++;
      }
    }
  }
  if (visibleMarked || visibleUnmarked) {
    return visibleMarked && visibleUnmarked
      ? "mixed"
      : visibleMarked
      ? "on"
      : "off";
  }
  return marked && unmarked ? "mixed" : marked ? "on" : "off";
};

export const toggleClarinTextMark = (
  format: ClarinTextFormat | null,
  text: string,
  from: number,
  to: number,
  mark: ClarinTextMark,
): ClarinTextFormat => {
  const [start, end] = snapClarinTextRange(text, from, to);
  if (start === end) {
    return createClarinTextFormat(text, format?.runs || []);
  }
  const remove = getClarinMarkState(format, text, start, end, mark) === "on";
  const points = new Set<number>([0, text.length, start, end]);
  for (const run of format?.runs || []) {
    points.add(run.from);
    points.add(run.to);
  }
  const ordered = Array.from(points).sort((left, right) => left - right);
  const nextRuns: ClarinTextFormatRun[] = [];
  for (let index = 0; index < ordered.length - 1; index++) {
    const segmentFrom = ordered[index];
    const segmentTo = ordered[index + 1];
    if (segmentFrom === segmentTo) {
      continue;
    }
    let marks = marksAt(format?.runs || [], segmentFrom);
    if (start <= segmentFrom && segmentTo <= end) {
      marks = remove ? marks & ~mark : marks | mark;
    }
    if (marks) {
      nextRuns.push({ from: segmentFrom, to: segmentTo, marks });
    }
  }
  return createClarinTextFormat(text, nextRuns);
};

export const setClarinTextMark = (
  format: ClarinTextFormat | null,
  text: string,
  from: number,
  to: number,
  mark: ClarinTextMark,
  enabled: boolean,
) => {
  const state = getClarinMarkState(format, text, from, to, mark);
  if ((enabled && state === "on") || (!enabled && state === "off")) {
    return createClarinTextFormat(text, format?.runs || []);
  }
  return toggleClarinTextMark(format, text, from, to, mark);
};

export interface ClarinTextEdit {
  format: ClarinTextFormat | null;
  text: string;
  from: number;
  to: number;
  insertedText: string;
  insertedMarks?: number;
  insertedFormat?: ClarinTextFormat | null;
}

/**
 * Applies one editor mutation using the exact replaced UTF-16 range.
 *
 * The WYSIWYG knows this range from Selection/beforeinput. Keeping it explicit
 * is essential for repeated text where a prefix/suffix diff is ambiguous.
 */
export const replaceClarinTextRange = ({
  format,
  text,
  from,
  to,
  insertedText,
  insertedMarks = 0,
  insertedFormat = null,
}: ClarinTextEdit): { text: string; format: ClarinTextFormat } => {
  const [start, end] = snapClarinTextRange(text, from, to);
  const nextText = `${text.slice(0, start)}${insertedText}${text.slice(end)}`;
  const delta = insertedText.length - (end - start);
  const nextRuns: ClarinTextFormatRun[] = [];

  for (const run of format?.runs || []) {
    if (run.from < start) {
      nextRuns.push({
        from: run.from,
        to: Math.min(run.to, start),
        marks: run.marks,
      });
    }
    if (run.to > end) {
      nextRuns.push({
        from: Math.max(run.from, end) + delta,
        to: run.to + delta,
        marks: run.marks,
      });
    }
  }

  if (insertedText.length > 0) {
    if (
      insertedFormat?.runs.length &&
      validateClarinTextFormat(insertedFormat, insertedText)
    ) {
      for (const run of insertedFormat.runs) {
        nextRuns.push({
          from: start + run.from,
          to: start + run.to,
          marks: run.marks,
        });
      }
    } else if (insertedMarks & 15) {
      nextRuns.push({
        from: start,
        to: start + insertedText.length,
        marks: insertedMarks & 15,
      });
    }
  }

  return {
    text: nextText,
    format: createClarinTextFormat(nextText, nextRuns),
  };
};

const commonPrefixLength = (left: string, right: string) => {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) {
    index++;
  }
  return index;
};

const commonSuffixLength = (
  left: string,
  right: string,
  prefixLength: number,
) => {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (
    length < limit &&
    left.charCodeAt(left.length - length - 1) ===
      right.charCodeAt(right.length - length - 1)
  ) {
    length++;
  }
  return length;
};

export const applyClarinTextEdit = ({
  format,
  previousText,
  nextText,
  insertedMarks = 0,
  insertedFormat = null,
}: {
  format: ClarinTextFormat | null;
  previousText: string;
  nextText: string;
  insertedMarks?: number;
  insertedFormat?: ClarinTextFormat | null;
}): ClarinTextFormat => {
  if (previousText === nextText) {
    return createClarinTextFormat(nextText, format?.runs || []);
  }
  const rawPrefix = commonPrefixLength(previousText, nextText);
  const previousBoundaries = getGraphemeBoundaries(previousText);
  const nextBoundaries = getGraphemeBoundaries(nextText);
  const prefix = Math.min(
    snapBoundary(previousBoundaries, rawPrefix, "backward"),
    snapBoundary(nextBoundaries, rawPrefix, "backward"),
  );
  const rawSuffix = commonSuffixLength(previousText, nextText, prefix);
  const previousDeleteTo = snapBoundary(
    previousBoundaries,
    previousText.length - rawSuffix,
    "forward",
  );
  const nextInsertTo = snapBoundary(
    nextBoundaries,
    nextText.length - rawSuffix,
    "forward",
  );
  const removedLength = previousDeleteTo - prefix;
  const insertedLength = nextInsertTo - prefix;
  const delta = insertedLength - removedLength;
  const nextRuns: ClarinTextFormatRun[] = [];

  for (const run of format?.runs || []) {
    if (run.from < prefix) {
      nextRuns.push({
        from: run.from,
        to: Math.min(run.to, prefix),
        marks: run.marks,
      });
    }
    if (run.to > previousDeleteTo) {
      nextRuns.push({
        from: Math.max(run.from, previousDeleteTo) + delta,
        to: run.to + delta,
        marks: run.marks,
      });
    }
  }

  if (insertedLength > 0) {
    if (insertedFormat?.runs.length) {
      for (const run of insertedFormat.runs) {
        nextRuns.push({
          from: prefix + run.from,
          to: prefix + Math.min(insertedLength, run.to),
          marks: run.marks,
        });
      }
    } else if (insertedMarks & 15) {
      nextRuns.push({
        from: prefix,
        to: prefix + insertedLength,
        marks: insertedMarks & 15,
      });
    }
  }
  return createClarinTextFormat(nextText, nextRuns);
};

/** Maps wrapped display text back to original UTF-16 offsets. */
export const getClarinVisualLines = (
  element: Pick<
    ExcalidrawTextElement,
    "text" | "originalText" | "customData"
  >,
): ClarinVisualTextRun[][] => {
  const format = getClarinTextFormat(element as ExcalidrawTextElement);
  const lines = element.text.replace(/\r\n?/g, "\n").split("\n");
  if (!format?.runs.length) {
    return lines.map((text) => [
      { from: 0, to: text.length, marks: 0, text },
    ]);
  }

  let originalOffset = 0;
  return lines.map((line, lineIndex) => {
    const visualRuns: ClarinVisualTextRun[] = [];
    for (const character of Array.from(line)) {
      let characterOffset = element.originalText.indexOf(
        character,
        originalOffset,
      );
      if (characterOffset < 0) {
        characterOffset = originalOffset;
      }
      const marks = marksAt(format.runs, characterOffset);
      const previous = visualRuns[visualRuns.length - 1];
      if (previous && previous.marks === marks && previous.to === characterOffset) {
        previous.text += character;
        previous.to = characterOffset + character.length;
      } else {
        visualRuns.push({
          from: characterOffset,
          to: characterOffset + character.length,
          marks,
          text: character,
        });
      }
      originalOffset = characterOffset + character.length;
    }
    if (
      lineIndex < lines.length - 1 &&
      element.originalText[originalOffset] === "\n"
    ) {
      originalOffset++;
    }
    return visualRuns.length
      ? visualRuns
      : [{ from: originalOffset, to: originalOffset, marks: 0, text: "" }];
  });
};

export const getClarinFontForMarks = (baseFont: string, marks: number) =>
  `${marks & CLARIN_TEXT_MARK.ITALIC ? "italic " : ""}${
    marks & CLARIN_TEXT_MARK.BOLD ? "700 " : ""
  }${baseFont}`.trim();

export const getClarinTextDecoration = (marks: number) =>
  [
    marks & CLARIN_TEXT_MARK.UNDERLINE ? "underline" : "",
    marks & CLARIN_TEXT_MARK.STRIKE ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");

export const shouldInsertClarinTextLineBreak = ({
  key,
  ctrlOrCmd,
  isComposing,
  keyCode,
}: {
  key: string;
  ctrlOrCmd: boolean;
  isComposing: boolean;
  keyCode: number;
}) =>
  key === "Enter" &&
  !ctrlOrCmd &&
  !isComposing &&
  keyCode !== 229;

export const getClarinBeforeInputText = ({
  inputType,
  data,
  isComposing,
}: {
  inputType: string;
  data: string | null;
  isComposing: boolean;
}) => {
  if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
    return "\n";
  }
  if (inputType === "insertText" && !isComposing && data !== null) {
    return data;
  }
  return null;
};
