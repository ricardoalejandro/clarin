import type { ExcalidrawTextElement } from "./types";
export declare const CLARIN_TEXT_FORMAT_KEY = "clarinTextFormat";
export declare const CLARIN_TEXT_FORMAT_VERSION: 1;
export declare const MAX_CLARIN_TEXT_RUNS_PER_ELEMENT = 4096;
export declare const MAX_CLARIN_TEXT_RUNS_PER_SCENE = 50000;
export declare const CLARIN_TEXT_MARK: {
    readonly BOLD: 1;
    readonly ITALIC: 2;
    readonly UNDERLINE: 4;
    readonly STRIKE: 8;
};
export type ClarinTextMark = (typeof CLARIN_TEXT_MARK)[keyof typeof CLARIN_TEXT_MARK];
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
    setParagraphAlignment: (align: ExcalidrawTextElement["textAlign"]) => void;
    getParagraphAlignmentState: () => ExcalidrawTextElement["textAlign"] | "mixed";
}
export declare const publishClarinRichTextState: () => void;
export declare const setActiveClarinRichTextEditor: (controller: ClarinRichTextEditorController | null) => void;
export declare const getActiveClarinRichTextEditor: () => ClarinRichTextEditorController | null;
export declare const clearActiveClarinRichTextEditor: (controller: ClarinRichTextEditorController) => void;
export declare const subscribeClarinRichTextState: (listener: () => void) => () => void;
export declare const getClarinRichTextStateVersion: () => number;
/** djb2 over UTF-16 code units, matching Excalidraw's hashString(). */
export declare const hashClarinText: (text: string) => number;
export declare const getGraphemeBoundaries: (text: string) => number[];
export declare const snapClarinTextRange: (text: string, from: number, to: number) => readonly [number, number];
export declare const normalizeClarinTextRuns: (text: string, inputRuns: readonly ClarinTextFormatRun[]) => ClarinTextFormatRun[];
export declare const createClarinTextFormat: (text: string, runs: readonly ClarinTextFormatRun[]) => ClarinTextFormat;
export declare const validateClarinTextFormat: (value: unknown, text: string) => value is ClarinTextFormat;
export declare const getClarinTextFormat: (element: Pick<ExcalidrawTextElement, "originalText" | "customData">) => ClarinTextFormat | null;
export declare const updateClarinTextCustomData: (customData: Record<string, unknown> | undefined, format: ClarinTextFormat | null) => {
    [x: string]: unknown;
} | undefined;
/**
 * `newElementWith()` intentionally treats `undefined` as "leave unchanged".
 * Rich-text metadata, however, must be able to remove the final customData
 * field. Callers use this predicate to force that otherwise invisible update.
 */
export declare const shouldForceClarinCustomDataRemoval: (previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) => boolean;
export declare const getClarinMarksAtCaret: (format: ClarinTextFormat | null, offset: number) => number;
export declare const getClarinMarkState: (format: ClarinTextFormat | null, text: string, from: number, to: number, mark: ClarinTextMark) => ClarinTextMarkState;
export declare const toggleClarinTextMark: (format: ClarinTextFormat | null, text: string, from: number, to: number, mark: ClarinTextMark) => ClarinTextFormat;
export declare const setClarinTextMark: (format: ClarinTextFormat | null, text: string, from: number, to: number, mark: ClarinTextMark, enabled: boolean) => ClarinTextFormat;
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
export declare const replaceClarinTextRange: ({ format, text, from, to, insertedText, insertedMarks, insertedFormat, }: ClarinTextEdit) => {
    text: string;
    format: ClarinTextFormat;
};
export declare const applyClarinTextEdit: ({ format, previousText, nextText, insertedMarks, insertedFormat, }: {
    format: ClarinTextFormat | null;
    previousText: string;
    nextText: string;
    insertedMarks?: number;
    insertedFormat?: ClarinTextFormat | null;
}) => ClarinTextFormat;
/** Maps wrapped display text back to original UTF-16 offsets. */
export declare const getClarinVisualLines: (element: Pick<ExcalidrawTextElement, "text" | "originalText" | "customData">) => ClarinVisualTextRun[][];
export declare const getClarinFontForMarks: (baseFont: string, marks: number) => string;
export declare const getClarinTextDecoration: (marks: number) => string;
export declare const shouldInsertClarinTextLineBreak: ({ key, ctrlOrCmd, isComposing, keyCode, }: {
    key: string;
    ctrlOrCmd: boolean;
    isComposing: boolean;
    keyCode: number;
}) => boolean;
export declare const getClarinBeforeInputText: ({ inputType, data, isComposing, }: {
    inputType: string;
    data: string | null;
    isComposing: boolean;
}) => string | null;
