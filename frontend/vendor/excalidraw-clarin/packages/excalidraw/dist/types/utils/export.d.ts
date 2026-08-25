import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, ExcalidrawFrameLikeElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import { MIME_TYPES } from "@excalidraw/excalidraw/constants";
export { MIME_TYPES };
type ExportOpts = {
    elements: readonly NonDeleted<ExcalidrawElement>[];
    appState?: Partial<Omit<AppState, "offsetTop" | "offsetLeft">>;
    files: BinaryFiles | null;
    maxWidthOrHeight?: number;
    exportingFrame?: ExcalidrawFrameLikeElement | null;
    getDimensions?: (width: number, height: number) => {
        width: number;
        height: number;
        scale?: number;
    };
};
export declare const exportToCanvas: ({ elements, appState, files, maxWidthOrHeight, getDimensions, exportPadding, exportingFrame, }: ExportOpts & {
    exportPadding?: number;
}) => Promise<HTMLCanvasElement>;
export declare const exportToBlob: (opts: ExportOpts & {
    mimeType?: string;
    quality?: number;
    exportPadding?: number;
}) => Promise<Blob>;
export declare const exportToSvg: ({ elements, appState, files, exportPadding, renderEmbeddables, exportingFrame, skipInliningFonts, reuseImages, }: Omit<ExportOpts, "getDimensions"> & {
    exportPadding?: number;
    renderEmbeddables?: boolean;
    skipInliningFonts?: true;
    reuseImages?: boolean;
}) => Promise<SVGSVGElement>;
export declare const exportToClipboard: (opts: ExportOpts & {
    mimeType?: string;
    quality?: number;
    type: "png" | "svg" | "json";
}) => Promise<void>;
