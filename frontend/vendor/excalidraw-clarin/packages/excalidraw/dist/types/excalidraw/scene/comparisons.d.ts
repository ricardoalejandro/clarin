import type { ElementOrToolType } from "../types";
export declare const hasBackground: (type: ElementOrToolType) => type is "line" | "iframe" | "embeddable" | "rectangle" | "diamond" | "ellipse" | "freedraw";
export declare const hasStrokeColor: (type: ElementOrToolType) => type is "text" | "line" | "arrow" | "iframe" | "embeddable" | "selection" | "rectangle" | "diamond" | "ellipse" | "freedraw" | "eraser" | "hand" | "laser" | "custom";
export declare const hasStrokeWidth: (type: ElementOrToolType) => type is "line" | "arrow" | "iframe" | "embeddable" | "rectangle" | "diamond" | "ellipse" | "freedraw";
export declare const hasStrokeStyle: (type: ElementOrToolType) => type is "line" | "arrow" | "iframe" | "embeddable" | "rectangle" | "diamond" | "ellipse";
export declare const hasFreedrawMode: (type: ElementOrToolType) => type is "freedraw";
export declare const canChangeRoundness: (type: ElementOrToolType) => type is "line" | "image" | "iframe" | "embeddable" | "rectangle" | "diamond";
export declare const toolIsArrow: (type: ElementOrToolType) => type is "arrow";
export declare const canHaveArrowheads: (type: ElementOrToolType) => type is "arrow";
