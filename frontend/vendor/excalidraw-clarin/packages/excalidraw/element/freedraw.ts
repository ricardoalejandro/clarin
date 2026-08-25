import {
  DEFAULT_STROKE_STREAMLINE,
  DEFAULT_STROKE_STREAMLINE_PRECISE,
} from "../constants";
import type {
  PointerType,
  StrokeOptions,
  StrokeVariability,
} from "./types";

export const getFreedrawStrokeOptions = (
  pointerType: PointerType,
  variability: StrokeVariability,
): StrokeOptions => ({
  variability,
  streamline: pointerType === "mouse"
    ? DEFAULT_STROKE_STREAMLINE
    : DEFAULT_STROKE_STREAMLINE_PRECISE,
});
