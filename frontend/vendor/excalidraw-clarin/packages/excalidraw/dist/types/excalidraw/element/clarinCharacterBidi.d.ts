import type { ExcalidrawTextElement } from "./types";
import type { ClarinCharacterShapingGroup, ClarinShapingClip } from "./clarinCharacterShaping";
export interface ClarinNativeBidiFragment {
    groupIndex: number;
    from: number;
    to: number;
    x: number;
    width: number;
    rtl: boolean;
    clips: ClarinShapingClip[][];
}
export interface ClarinNativeBidiGeometry {
    width: number;
    fragments: ClarinNativeBidiFragment[];
}
type VisualRect = { x: number; width: number };
type LogicalFragment = Omit<ClarinNativeBidiFragment, "groupIndex" | "clips">;
type MeasureRange = (from: number, to: number) => VisualRect[];
export declare const invalidateClarinNativeBidiGeometry: () => void;
export declare const partitionClarinBidiRanges: (text: string, measure: MeasureRange, parentRTL: boolean, neutralDirection?: (from: number, to: number) => boolean) => LogicalFragment[];
export declare const getClarinNativeBidiFragments: (element: ExcalidrawTextElement, groups: readonly ClarinCharacterShapingGroup[], options?: { widthOnly?: boolean }) => ClarinNativeBidiGeometry | null;
