import type { ExcalidrawTextElement, TextAlign } from "./types";
export declare const CLARIN_PARAGRAPH_FORMAT_KEY = "clarinParagraphFormat";
export declare const CLARIN_PARAGRAPH_FORMAT_VERSION: 1;
export declare const MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT = 4096;
export type ClarinParagraphAlignment = TextAlign;
export type ClarinParagraphAlignmentState = ClarinParagraphAlignment | "mixed";
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
export interface ClarinParagraphTextEditResult extends ClarinParagraphAlignmentUpdate {
    nextText: string;
}
export declare const isClarinParagraphAlignment: (value: unknown) => value is ClarinParagraphAlignment;
/** Returns every logical paragraph start as a UTF-16 offset. */
export declare const getClarinParagraphStarts: (text: string) => number[];
/**
 * Resolves a caret to its logical paragraph. A caret positioned on a newline
 * belongs to the paragraph before it, while a caret after it belongs to the
 * following paragraph (including a final empty paragraph).
 */
export declare const getClarinParagraphStartAtCaret: (text: string, offset: number) => number;
/**
 * Returns paragraph starts touched by a half-open selection. A collapsed
 * selection resolves the caret paragraph. Newline code units belong to the
 * paragraph they terminate, so ending exactly at the next paragraph start
 * does not include that next paragraph.
 */
export declare const getClarinTouchedParagraphStarts: (text: string, from: number, to: number) => number[];
export declare const createClarinParagraphFormat: (text: string, textAlign: ClarinParagraphAlignment, inputParagraphs: readonly ClarinParagraphAlignmentEntry[]) => ClarinParagraphFormat;
export declare const validateClarinParagraphFormat: (value: unknown, text: string, textAlign: ClarinParagraphAlignment) => value is ClarinParagraphFormat;
export declare const getClarinParagraphFormat: (element: Pick<ExcalidrawTextElement, "originalText" | "textAlign" | "customData">) => ClarinParagraphFormat | null;
export declare const updateClarinParagraphCustomData: (customData: Record<string, unknown> | undefined, format: ClarinParagraphFormat | null) => {
    [x: string]: unknown;
} | undefined;
export declare const getClarinEffectiveParagraphAlignment: (format: ClarinParagraphFormat | null, text: string, textAlign: ClarinParagraphAlignment, paragraphStart: number) => ClarinParagraphAlignment;
export declare const getClarinParagraphAlignmentState: (format: ClarinParagraphFormat | null, text: string, textAlign: ClarinParagraphAlignment, from: number, to: number) => ClarinParagraphAlignmentState;
export declare const setClarinParagraphAlignment: ({ format, text, textAlign, from, to, align, }: {
    format: ClarinParagraphFormat | null;
    text: string;
    textAlign: ClarinParagraphAlignment;
    from: number;
    to: number;
    align: ClarinParagraphAlignment;
}) => ClarinParagraphAlignmentUpdate;
/**
 * Applies one explicit UTF-16 replacement and transports paragraph alignment
 * without guessing a common prefix/suffix. New paragraphs inherit the
 * alignment at the edit start. Removing a newline keeps the alignment of the
 * leading paragraph that survives the merge.
 */
export declare const applyClarinParagraphTextEdit: ({ format, previousText, textAlign, edit, }: {
    format: ClarinParagraphFormat | null;
    previousText: string;
    textAlign: ClarinParagraphAlignment;
    edit: ClarinParagraphTextEdit;
}) => ClarinParagraphTextEditResult;
