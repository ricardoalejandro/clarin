import type { Drawable } from "roughjs/bin/core";
import type { ExcalidrawElement, ExcalidrawSelectionElement } from "../element/types";
import type { ElementShape, ElementShapes } from "./types";
import type { AppState, EmbedsValidationStatus } from "../types";
export declare class ShapeCache {
    private static rg;
    private static cache;
    /**
     * Retrieves shape from cache if available. Use this only if shape
     * is optional and you have a fallback in case it's not cached.
     */
    static get: <T extends ExcalidrawElement>(element: T) => T["type"] extends keyof ElementShapes ? ElementShapes[T["type"]] | undefined : ElementShape | undefined;
    static set: <T extends ExcalidrawElement>(element: T, shape: T["type"] extends keyof ElementShapes ? ElementShapes[T["type"]] : Drawable) => WeakMap<ExcalidrawElement, ElementShape>;
    static delete: (element: ExcalidrawElement) => boolean;
    static destroy: () => void;
    /**
     * Generates & caches shape for element if not already cached, otherwise
     * returns cached shape.
     */
    static generateElementShape: <T extends Exclude<ExcalidrawElement, ExcalidrawSelectionElement>>(element: T, renderConfig: {
        isExporting: boolean;
        canvasBackgroundColor: AppState["viewBackgroundColor"];
        embedsValidationStatus: EmbedsValidationStatus;
    } | null) => ((T["type"] extends keyof ElementShapes ? ElementShapes[T["type"]] | undefined : ElementShape | undefined) & {}) | (T["type"] extends keyof ElementShapes ? ElementShapes[T["type"]] : Drawable | null);
}
