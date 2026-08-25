import type { ExcalidrawProps } from "../types";
import type { ExcalidrawElement, ExcalidrawIframeLikeElement, IframeData } from "./types";
import type { MarkRequired } from "../utility-types";
type IframeDataWithSandbox = MarkRequired<IframeData, "sandbox">;
export declare const createSrcDoc: (body: string) => string;
export declare const getEmbedLink: (link: string | null | undefined) => IframeDataWithSandbox | null;
export declare const createPlaceholderEmbeddableLabel: (element: ExcalidrawIframeLikeElement) => ExcalidrawElement;
export declare const actionSetEmbeddableAsActiveTool: {
    name: "setEmbeddableAsActiveTool";
    trackEvent: {
        category: "toolbar";
    };
    target: string;
    label: string;
    perform: (elements: readonly import("./types").OrderedExcalidrawElement[], appState: Readonly<import("../types").AppState>, _: any, app: import("../types").AppClassProperties) => {
        elements: readonly import("./types").OrderedExcalidrawElement[];
        appState: {
            activeTool: {
                lastActiveTool: import("../types").ActiveTool | null;
                locked: boolean;
            } & import("../types").ActiveTool;
            contextMenu: {
                items: import("../components/ContextMenu").ContextMenuItems;
                top: number;
                left: number;
            } | null;
            showWelcomeScreen: boolean;
            isLoading: boolean;
            errorMessage: React.ReactNode;
            activeEmbeddable: {
                element: import("./types").NonDeletedExcalidrawElement;
                state: "hover" | "active";
            } | null;
            newElement: import("./types").NonDeleted<import("./types").ExcalidrawNonSelectionElement> | null;
            resizingElement: import("./types").NonDeletedExcalidrawElement | null;
            multiElement: import("./types").NonDeleted<import("./types").ExcalidrawLinearElement> | null;
            selectionElement: import("./types").NonDeletedExcalidrawElement | null;
            isBindingEnabled: boolean;
            startBoundElement: import("./types").NonDeleted<import("./types").ExcalidrawBindableElement> | null;
            suggestedBindings: import("./binding").SuggestedBinding[];
            frameToHighlight: import("./types").NonDeleted<import("./types").ExcalidrawFrameLikeElement> | null;
            frameRendering: {
                enabled: boolean;
                name: boolean;
                outline: boolean;
                clip: boolean;
            };
            editingFrame: string | null;
            elementsToHighlight: import("./types").NonDeleted<ExcalidrawElement>[] | null;
            editingTextElement: import("./types").NonDeletedExcalidrawElement | null;
            editingLinearElement: import("./linearElementEditor").LinearElementEditor | null;
            penMode: boolean;
            penDetected: boolean;
            exportBackground: boolean;
            exportEmbedScene: boolean;
            exportWithDarkMode: boolean;
            exportScale: number;
            currentItemStrokeColor: string;
            currentItemBackgroundColor: string;
            currentItemFillStyle: ExcalidrawElement["fillStyle"];
            currentItemStrokeWidth: number;
            currentItemStrokeStyle: ExcalidrawElement["strokeStyle"];
            currentItemRoughness: number;
            currentItemOpacity: number;
            currentItemFontFamily: import("./types").FontFamilyValues;
            currentItemFontSize: number;
            currentItemTextAlign: import("./types").TextAlign;
            currentItemStartArrowhead: import("./types").Arrowhead | null;
            currentItemEndArrowhead: import("./types").Arrowhead | null;
            currentHoveredFontFamily: import("./types").FontFamilyValues | null;
            currentItemRoundness: import("./types").StrokeRoundness;
            currentItemArrowType: "sharp" | "round" | "elbow";
            viewBackgroundColor: string;
            scrollX: number;
            scrollY: number;
            cursorButton: "up" | "down";
            scrolledOutside: boolean;
            name: string | null;
            isResizing: boolean;
            isRotating: boolean;
            zoom: import("../types").Zoom;
            openMenu: "canvas" | "shape" | null;
            openPopup: "canvasBackground" | "elementBackground" | "elementStroke" | "fontFamily" | null;
            openSidebar: {
                name: import("../types").SidebarName;
                tab?: import("../types").SidebarTabName;
            } | null;
            openDialog: null | {
                name: "imageExport" | "help" | "jsonExport";
            } | {
                name: "ttd";
                tab: "text-to-diagram" | "mermaid";
            } | {
                name: "commandPalette";
            } | {
                name: "elementLinkSelector";
                sourceElementId: ExcalidrawElement["id"];
            };
            defaultSidebarDockedPreference: boolean;
            lastPointerDownWith: import("./types").PointerType;
            selectedElementIds: Readonly<{
                [id: string]: true;
            }>;
            hoveredElementIds: Readonly<{
                [id: string]: true;
            }>;
            previousSelectedElementIds: {
                [id: string]: true;
            };
            selectedElementsAreBeingDragged: boolean;
            shouldCacheIgnoreZoom: boolean;
            toast: {
                message: string;
                closable?: boolean;
                duration?: number;
            } | null;
            zenModeEnabled: boolean;
            theme: import("./types").Theme;
            gridSize: number;
            gridStep: number;
            gridModeEnabled: boolean;
            viewModeEnabled: boolean;
            selectedGroupIds: {
                [groupId: string]: boolean;
            };
            editingGroupId: import("./types").GroupId | null;
            width: number;
            height: number;
            offsetTop: number;
            offsetLeft: number;
            fileHandle: import("browser-fs-access").FileSystemHandle | null;
            collaborators: Map<import("../types").SocketId, import("../types").Collaborator>;
            stats: {
                open: boolean;
                panels: number;
            };
            currentChartType: import("./types").ChartType;
            pasteDialog: {
                shown: false;
                data: null;
            } | {
                shown: true;
                data: import("../charts").Spreadsheet;
            };
            pendingImageElementId: import("./types").ExcalidrawImageElement["id"] | null;
            showHyperlinkPopup: false | "info" | "editor";
            selectedLinearElement: import("./linearElementEditor").LinearElementEditor | null;
            snapLines: readonly import("../snapping").SnapLine[];
            originSnapOffset: {
                x: number;
                y: number;
            } | null;
            objectsSnapModeEnabled: boolean;
            userToFollow: import("../types").UserToFollow | null;
            followedBy: Set<import("../types").SocketId>;
            isCropping: boolean;
            croppingElementId: ExcalidrawElement["id"] | null;
            searchMatches: readonly {
                id: string;
                focus: boolean;
                matchedLines: {
                    offsetX: number;
                    offsetY: number;
                    width: number;
                    height: number;
                }[];
            }[];
        };
        captureUpdate: "EVENTUALLY";
    };
} & {
    keyTest?: undefined;
};
export declare const maybeParseEmbedSrc: (str: string) => string;
export declare const embeddableURLValidator: (url: string | null | undefined, validateEmbeddable: ExcalidrawProps["validateEmbeddable"]) => boolean;
export {};
