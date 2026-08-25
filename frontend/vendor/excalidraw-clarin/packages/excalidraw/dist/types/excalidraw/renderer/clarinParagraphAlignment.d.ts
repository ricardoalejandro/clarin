import type { ExcalidrawTextElement, TextAlign } from "../element/types";
export interface ClarinVisualLineLayout {
    /** UTF-16 offset of the first rendered code point in originalText. */
    originalOffset: number;
    /** UTF-16 offset of the logical paragraph start in originalText. */
    paragraphStart: number;
    textAlign: TextAlign;
}
export declare const getClarinSvgTextAnchor: (textAlign: TextAlign, direction: "ltr" | "rtl") => "start" | "middle" | "end";
/**
 * Maps wrapped visual lines back to originalText without treating soft wraps
 * as persisted paragraph breaks. All offsets are UTF-16, matching DOM ranges,
 * Excalidraw text metadata and String#slice/indexOf.
 */
export declare const getClarinVisualLineOriginalOffsets: (originalText: string, visualText: string) => number[];
/** Resolves the physical alignment for every wrapped display line. */
export declare const getClarinVisualLineLayouts: (element: Pick<ExcalidrawTextElement, "text" | "originalText" | "textAlign" | "customData">) => ClarinVisualLineLayout[];
