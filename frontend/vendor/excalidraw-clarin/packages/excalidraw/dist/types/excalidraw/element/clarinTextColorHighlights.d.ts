export interface ClarinTextColorPatch { node: Text; from: number; to: number; color: string; marks?: number }
export declare const supportsClarinTextColorHighlights: (editable: HTMLElement) => boolean;
export declare const clearClarinTextColorHighlights: (editable: HTMLElement) => void;
export declare const clearClarinTextColorsWithin: (root: HTMLElement | null) => void;
export declare const applyClarinTextColorHighlights: (editable: HTMLElement, patches: readonly ClarinTextColorPatch[]) => boolean;
