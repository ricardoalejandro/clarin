import type { ExcalidrawTextElement, FontString } from "./types";
import { getClarinStyledVisualLines } from "./clarinCharacterStyle";
export type ClarinStyledVisualRun = ReturnType<typeof getClarinStyledVisualLines>[number][number];
export interface ClarinShapingClip { x: number; width: number }
export interface ClarinShapedCharacterSegment { run: ClarinStyledVisualRun; clips: ClarinShapingClip[] }
export interface ClarinCharacterShapingGroup {
    text: string;
    shapingText?: string;
    font: FontString;
    rtl: boolean;
    width: number;
    nativeX?: number;
    segments: ClarinShapedCharacterSegment[];
}
export declare const getClarinCharacterRunFont: (run: { fontFamily: number; fontSize: number; marks: number }) => FontString;
export declare const getClarinCharacterShapingGroups: (element: ExcalidrawTextElement, runs: readonly ClarinStyledVisualRun[]) => ClarinCharacterShapingGroup[];
export declare const invalidateClarinCharacterShapingGeometry: () => void;
export declare const getClarinNativeFragmentShapingText: (text: string, from: number, to: number, font: FontString, nativeWidth: number, rtl?: boolean) => string;
