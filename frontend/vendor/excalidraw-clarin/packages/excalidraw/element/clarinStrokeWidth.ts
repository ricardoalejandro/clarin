import type { ExcalidrawElement, StrokeVariability } from "./types";

export type ClarinStrokePreset = 1 | 2 | 4 | "wide";
type StrokeContext = {
  type: string;
  strokeOptions?: { variability?: StrokeVariability };
};

/** Presets describe intent; persisted strokeWidth always remains a number. */
export const resolveClarinStrokeWidth = (
  preset: ClarinStrokePreset,
  context: StrokeContext,
): number => preset === "wide"
  ? context.type === "freedraw" && context.strokeOptions?.variability === "constant"
    ? 16
    : 8
  : preset;

export const getClarinStrokePreset = (
  strokeWidth: number,
  context: StrokeContext,
): ClarinStrokePreset | null => {
  if (strokeWidth === 1 || strokeWidth === 2 || strokeWidth === 4) return strokeWidth;
  return strokeWidth === resolveClarinStrokeWidth("wide", context) ? "wide" : null;
};

export const getElementStrokePreset = (element: ExcalidrawElement) =>
  getClarinStrokePreset(element.strokeWidth, element);
