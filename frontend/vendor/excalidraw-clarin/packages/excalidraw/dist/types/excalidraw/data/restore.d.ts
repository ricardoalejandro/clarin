import type { ExcalidrawElement, OrderedExcalidrawElement } from "../element/types";
import type { AppState, BinaryFiles, LibraryItem } from "../types";
import type { ImportedDataState } from "./types";
type RestoredAppState = Omit<AppState, "offsetTop" | "offsetLeft" | "width" | "height">;
export declare const AllowedExcalidrawActiveTools: Record<AppState["activeTool"]["type"], boolean>;
export type RestoredDataState = {
    elements: OrderedExcalidrawElement[];
    appState: RestoredAppState;
    files: BinaryFiles;
};
export declare const restoreElements: (elements: ImportedDataState["elements"], 
/** NOTE doesn't serve for reconciliation */
localElements: readonly ExcalidrawElement[] | null | undefined, opts?: {
    refreshDimensions?: boolean;
    repairBindings?: boolean;
} | undefined) => OrderedExcalidrawElement[];
export declare const restoreAppState: (appState: ImportedDataState["appState"], localAppState: Partial<AppState> | null | undefined) => RestoredAppState;
export declare const restore: (data: Pick<ImportedDataState, "appState" | "elements" | "files"> | null, 
/**
 * Local AppState (`this.state` or initial state from localStorage) so that we
 * don't overwrite local state with default values (when values not
 * explicitly specified).
 * Supply `null` if you can't get access to it.
 */
localAppState: Partial<AppState> | null | undefined, localElements: readonly ExcalidrawElement[] | null | undefined, elementsConfig?: {
    refreshDimensions?: boolean;
    repairBindings?: boolean;
}) => RestoredDataState;
export declare const restoreLibraryItems: (libraryItems: ImportedDataState["libraryItems"], defaultStatus: LibraryItem["status"]) => LibraryItem[];
export {};
