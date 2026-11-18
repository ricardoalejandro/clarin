import type { ExcalidrawTextElement, FontString } from "./types";
import { getClarinStyledVisualLines } from "./clarinCharacterStyle";
import type { ClarinCharacterShapingGroup } from "./clarinCharacterShaping";
export declare const getClarinInlineFontMetrics: (fontFamily: number, fontSize: number, lineHeight: number) => {
    ascent: number;
    descent: number;
    height: number;
};
export declare const getClarinCharacterRunFont: (run: {
    fontFamily: number;
    fontSize: number;
    marks: number;
}) => FontString;
export declare const getClarinCharacterLineMetrics: (element: ExcalidrawTextElement, text?: string) => {
    runs: ReturnType<typeof getClarinStyledVisualLines>[number];
    groups: ClarinCharacterShapingGroup[];
    widths: number[];
    width: number;
    top: number;
    height: number;
    ascent: number;
    descent: number;
    baseline: number;
}[];
