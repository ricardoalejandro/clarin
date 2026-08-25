import type { InteractiveSceneRenderConfig, RenderableElementsMap } from "../scene/types";
declare const _renderInteractiveScene: ({ canvas, elementsMap, visibleElements, selectedElements, allElementsMap, scale, appState, renderConfig, device, }: InteractiveSceneRenderConfig) => {
    atLeastOneVisibleElement: boolean;
    elementsMap: RenderableElementsMap;
    scrollBars?: undefined;
} | {
    scrollBars: import("../scene/types").ScrollBars | undefined;
    atLeastOneVisibleElement: boolean;
    elementsMap: RenderableElementsMap;
};
/** throttled to animation framerate */
export declare const renderInteractiveSceneThrottled: {
    (config: InteractiveSceneRenderConfig): void;
    flush(): void;
    cancel(): void;
};
/**
 * Interactive scene is the ui-canvas where we render bounding boxes, selections
 * and other ui stuff.
 */
export declare const renderInteractiveScene: <U extends typeof _renderInteractiveScene, T extends boolean = false>(renderConfig: InteractiveSceneRenderConfig, throttle?: T) => T extends true ? void : ReturnType<U>;
export {};
