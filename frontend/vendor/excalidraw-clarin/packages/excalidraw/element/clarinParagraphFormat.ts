import type { ExcalidrawTextElement, TextAlign } from "./types";

import { hashClarinText } from "./clarinRichText";

export const CLARIN_PARAGRAPH_FORMAT_KEY = "clarinParagraphFormat";
export const CLARIN_PARAGRAPH_FORMAT_VERSION = 1 as const;
export const MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT = 4096;

export type ClarinParagraphAlignment = TextAlign;
export type ClarinParagraphAlignmentState =
  | ClarinParagraphAlignment
  | "mixed";

export interface ClarinParagraphAlignmentEntry {
  start: number;
  align: ClarinParagraphAlignment;
}

export interface ClarinParagraphFormat {
  version: typeof CLARIN_PARAGRAPH_FORMAT_VERSION;
  textLength: number;
  textHash: number;
  paragraphs: ClarinParagraphAlignmentEntry[];
}

export interface ClarinParagraphAlignmentUpdate {
  textAlign: ClarinParagraphAlignment;
  format: ClarinParagraphFormat | null;
}

export interface ClarinParagraphTextEdit {
  from: number;
  to: number;
  insertedText: string;
}

export interface ClarinParagraphTextEditResult
  extends ClarinParagraphAlignmentUpdate {
  nextText: string;
}

const PARAGRAPH_FORMAT_KEYS = new Set([
  "version",
  "textLength",
  "textHash",
  "paragraphs",
]);
const PARAGRAPH_ENTRY_KEYS = new Set(["start", "align"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
) => {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

export const isClarinParagraphAlignment = (
  value: unknown,
): value is ClarinParagraphAlignment =>
  value === "left" || value === "center" || value === "right";

/** Returns every logical paragraph start as a UTF-16 offset. */
export const getClarinParagraphStarts = (text: string): number[] => {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
};

const normalizeOffset = (offset: number, textLength: number) => {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.min(textLength, Math.trunc(offset)));
};

const normalizeSelection = (text: string, from: number, to: number) => {
  const first = normalizeOffset(from, text.length);
  const second = normalizeOffset(to, text.length);
  return first <= second ? ([first, second] as const) : ([second, first] as const);
};

/**
 * Resolves a caret to its logical paragraph. A caret positioned on a newline
 * belongs to the paragraph before it, while a caret after it belongs to the
 * following paragraph (including a final empty paragraph).
 */
export const getClarinParagraphStartAtCaret = (
  text: string,
  offset: number,
): number => {
  const bounded = normalizeOffset(offset, text.length);
  const starts = getClarinParagraphStarts(text);
  for (let index = starts.length - 1; index >= 0; index--) {
    if (starts[index] <= bounded) {
      return starts[index];
    }
  }
  return 0;
};

/**
 * Returns paragraph starts touched by a half-open selection. A collapsed
 * selection resolves the caret paragraph. Newline code units belong to the
 * paragraph they terminate, so ending exactly at the next paragraph start
 * does not include that next paragraph.
 */
export const getClarinTouchedParagraphStarts = (
  text: string,
  from: number,
  to: number,
): number[] => {
  const [start, end] = normalizeSelection(text, from, to);
  if (start === end) {
    return [getClarinParagraphStartAtCaret(text, start)];
  }

  const starts = getClarinParagraphStarts(text);
  return starts.filter((paragraphStart, index) => {
    const paragraphEnd = starts[index + 1] ?? text.length;
    return paragraphStart < end && start < paragraphEnd;
  });
};

export const createClarinParagraphFormat = (
  text: string,
  textAlign: ClarinParagraphAlignment,
  inputParagraphs: readonly ClarinParagraphAlignmentEntry[],
): ClarinParagraphFormat => {
  const validStarts = new Set(getClarinParagraphStarts(text));
  const byStart = new Map<number, ClarinParagraphAlignment>();

  // Last input wins for duplicate starts, after which output is canonical.
  for (const input of inputParagraphs) {
    if (
      !input ||
      !Number.isInteger(input.start) ||
      !validStarts.has(input.start) ||
      !isClarinParagraphAlignment(input.align)
    ) {
      continue;
    }
    if (input.align === textAlign) {
      byStart.delete(input.start);
    } else {
      byStart.set(input.start, input.align);
    }
  }

  const paragraphs = Array.from(byStart, ([start, align]) => ({ start, align }))
    .sort((left, right) => left.start - right.start)
    .slice(0, MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT);

  return {
    version: CLARIN_PARAGRAPH_FORMAT_VERSION,
    textLength: text.length,
    textHash: hashClarinText(text),
    paragraphs,
  };
};

export const validateClarinParagraphFormat = (
  value: unknown,
  text: string,
  textAlign: ClarinParagraphAlignment,
): value is ClarinParagraphFormat => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PARAGRAPH_FORMAT_KEYS) ||
    value.version !== CLARIN_PARAGRAPH_FORMAT_VERSION ||
    value.textLength !== text.length ||
    value.textHash !== hashClarinText(text) ||
    !Array.isArray(value.paragraphs) ||
    value.paragraphs.length > MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT ||
    !isClarinParagraphAlignment(textAlign)
  ) {
    return false;
  }

  const validStarts = new Set(getClarinParagraphStarts(text));
  let previousStart = -1;
  for (const candidate of value.paragraphs) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, PARAGRAPH_ENTRY_KEYS) ||
      !Number.isInteger(candidate.start) ||
      !validStarts.has(candidate.start as number) ||
      !isClarinParagraphAlignment(candidate.align) ||
      candidate.align === textAlign ||
      (candidate.start as number) <= previousStart
    ) {
      return false;
    }
    previousStart = candidate.start as number;
  }
  return true;
};

export const getClarinParagraphFormat = (
  element: Pick<
    ExcalidrawTextElement,
    "originalText" | "textAlign" | "customData"
  >,
): ClarinParagraphFormat | null => {
  const candidate = element.customData?.[CLARIN_PARAGRAPH_FORMAT_KEY];
  return validateClarinParagraphFormat(
    candidate,
    element.originalText,
    element.textAlign,
  )
    ? candidate
    : null;
};

export const updateClarinParagraphCustomData = (
  customData: Record<string, unknown> | undefined,
  format: ClarinParagraphFormat | null,
) => {
  const next = { ...(customData || {}) };
  if (format?.paragraphs.length) {
    next[CLARIN_PARAGRAPH_FORMAT_KEY] = format;
  } else {
    delete next[CLARIN_PARAGRAPH_FORMAT_KEY];
  }
  return Object.keys(next).length ? next : undefined;
};

const getValidatedParagraphs = (
  format: ClarinParagraphFormat | null,
  text: string,
  textAlign: ClarinParagraphAlignment,
) =>
  format && validateClarinParagraphFormat(format, text, textAlign)
    ? format.paragraphs
    : [];

const getEffectiveAlignmentMap = (
  format: ClarinParagraphFormat | null,
  text: string,
  textAlign: ClarinParagraphAlignment,
) => {
  const overrides = new Map(
    getValidatedParagraphs(format, text, textAlign).map(
      ({ start, align }) => [start, align] as const,
    ),
  );
  return new Map(
    getClarinParagraphStarts(text).map(
      (start) => [start, overrides.get(start) ?? textAlign] as const,
    ),
  );
};

export const getClarinEffectiveParagraphAlignment = (
  format: ClarinParagraphFormat | null,
  text: string,
  textAlign: ClarinParagraphAlignment,
  paragraphStart: number,
): ClarinParagraphAlignment => {
  const effective = getEffectiveAlignmentMap(format, text, textAlign);
  return effective.get(paragraphStart) ?? textAlign;
};

export const getClarinParagraphAlignmentState = (
  format: ClarinParagraphFormat | null,
  text: string,
  textAlign: ClarinParagraphAlignment,
  from: number,
  to: number,
): ClarinParagraphAlignmentState => {
  const touched = getClarinTouchedParagraphStarts(text, from, to);
  const effective = getEffectiveAlignmentMap(format, text, textAlign);
  const first = effective.get(touched[0]) ?? textAlign;
  return touched.every((start) => (effective.get(start) ?? textAlign) === first)
    ? first
    : "mixed";
};

const createUpdateFromEffectiveAlignments = (
  text: string,
  textAlign: ClarinParagraphAlignment,
  effective: ReadonlyMap<number, ClarinParagraphAlignment>,
): ClarinParagraphAlignmentUpdate => {
  const starts = getClarinParagraphStarts(text);
  const first = effective.get(starts[0]) ?? textAlign;
  if (starts.every((start) => (effective.get(start) ?? textAlign) === first)) {
    return { textAlign: first, format: null };
  }

  const format = createClarinParagraphFormat(
    text,
    textAlign,
    starts.map((start) => ({
      start,
      align: effective.get(start) ?? textAlign,
    })),
  );
  return { textAlign, format: format.paragraphs.length ? format : null };
};

export const setClarinParagraphAlignment = ({
  format,
  text,
  textAlign,
  from,
  to,
  align,
}: {
  format: ClarinParagraphFormat | null;
  text: string;
  textAlign: ClarinParagraphAlignment;
  from: number;
  to: number;
  align: ClarinParagraphAlignment;
}): ClarinParagraphAlignmentUpdate => {
  if (
    !isClarinParagraphAlignment(textAlign) ||
    !isClarinParagraphAlignment(align)
  ) {
    throw new TypeError("Unsupported paragraph alignment");
  }

  const effective = getEffectiveAlignmentMap(format, text, textAlign);
  for (const start of getClarinTouchedParagraphStarts(text, from, to)) {
    effective.set(start, align);
  }
  return createUpdateFromEffectiveAlignments(text, textAlign, effective);
};

/**
 * Applies one explicit UTF-16 replacement and transports paragraph alignment
 * without guessing a common prefix/suffix. New paragraphs inherit the
 * alignment at the edit start. Removing a newline keeps the alignment of the
 * leading paragraph that survives the merge.
 */
export const applyClarinParagraphTextEdit = ({
  format,
  previousText,
  textAlign,
  edit,
}: {
  format: ClarinParagraphFormat | null;
  previousText: string;
  textAlign: ClarinParagraphAlignment;
  edit: ClarinParagraphTextEdit;
}): ClarinParagraphTextEditResult => {
  if (!isClarinParagraphAlignment(textAlign)) {
    throw new TypeError("Unsupported paragraph alignment");
  }

  const [from, to] = normalizeSelection(previousText, edit.from, edit.to);
  const insertedText = String(edit.insertedText);
  const nextText =
    previousText.slice(0, from) + insertedText + previousText.slice(to);
  const previousStarts = getClarinParagraphStarts(previousText);
  const previousEffective = getEffectiveAlignmentMap(
    format,
    previousText,
    textAlign,
  );
  if (previousText.slice(from, to) === insertedText) {
    return {
      nextText,
      ...createUpdateFromEffectiveAlignments(
        nextText,
        textAlign,
        previousEffective,
      ),
    };
  }

  const previousStartSet = new Set(previousStarts);
  const inheritedStart = getClarinParagraphStartAtCaret(previousText, from);
  const inheritedAlignment =
    previousEffective.get(inheritedStart) ?? textAlign;
  const insertedEnd = from + insertedText.length;
  const delta = insertedText.length - (to - from);
  const insertedParagraphStarts = new Set<number>();
  for (let index = 0; index < insertedText.length; index++) {
    if (insertedText.charCodeAt(index) === 10) {
      insertedParagraphStarts.add(from + index + 1);
    }
  }

  const nextEffective = new Map<number, ClarinParagraphAlignment>();
  for (const nextStart of getClarinParagraphStarts(nextText)) {
    let align = inheritedAlignment;
    if (!insertedParagraphStarts.has(nextStart)) {
      let previousStart: number | null = null;
      if (nextStart <= from) {
        previousStart = nextStart;
      } else if (nextStart >= insertedEnd) {
        previousStart = nextStart - delta;
      }
      if (previousStart !== null && previousStartSet.has(previousStart)) {
        align = previousEffective.get(previousStart) ?? textAlign;
      }
    }
    nextEffective.set(nextStart, align);
  }

  return {
    nextText,
    ...createUpdateFromEffectiveAlignments(nextText, textAlign, nextEffective),
  };
};
