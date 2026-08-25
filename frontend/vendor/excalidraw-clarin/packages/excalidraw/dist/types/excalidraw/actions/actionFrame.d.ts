import type { ExcalidrawElement } from "../element/types";
import type { AppClassProperties, AppState } from "../types";
export declare const actionSelectAllElementsInFrame: {
    name: "selectAllElementsInFrame";
    label: string;
    trackEvent: {
        category: "canvas";
    };
    perform: (elements: readonly import("../element/types").OrderedExcalidrawElement[], appState: Readonly<AppState>, _: any, app: AppClassProperties) => {
        elements: readonly import("../element/types").OrderedExcalidrawElement[];
        appState: {
            selectedElementIds: Record<string, true>;
            contextMenu: {
                items: import("../components/ContextMenu").ContextMenuItems;
                top: number;
                left: number;
            } | null;
            showWelcomeScreen: boolean;
            isLoading: boolean;
            errorMessage: React.ReactNode;
            activeEmbeddable: {
                element: import("../element/types").NonDeletedExcalidrawElement;
                state: "hover" | "active";
            } | null;
            newElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawNonSelectionElement> | null;
            resizingElement: import("../element/types").NonDeletedExcalidrawElement | null;
            multiElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawLinearElement> | null;
            selectionElement: import("../element/types").NonDeletedExcalidrawElement | null;
            isBindingEnabled: boolean;
            startBoundElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawBindableElement> | null;
            suggestedBindings: import("../element/binding").SuggestedBinding[];
            frameToHighlight: import("../element/types").NonDeleted<import("../element/types").ExcalidrawFrameLikeElement> | null;
            frameRendering: {
                enabled: boolean;
                name: boolean;
                outline: boolean;
                clip: boolean;
            };
            editingFrame: string | null;
            elementsToHighlight: import("../element/types").NonDeleted<ExcalidrawElement>[] | null;
            editingTextElement: import("../element/types").NonDeletedExcalidrawElement | null;
            editingLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
            activeTool: {
                lastActiveTool: import("../types").ActiveTool | null;
                locked: boolean;
            } & import("../types").ActiveTool;
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
            currentItemStrokeVariability: import("../element/types").StrokeVariability;
            currentItemOpacity: number;
            currentItemFontFamily: import("../element/types").FontFamilyValues;
            currentItemFontSize: number;
            currentItemTextAlign: import("../element/types").TextAlign;
            currentItemStartArrowhead: import("../element/types").Arrowhead | null;
            currentItemEndArrowhead: import("../element/types").Arrowhead | null;
            currentHoveredFontFamily: import("../element/types").FontFamilyValues | null;
            currentItemRoundness: import("../element/types").StrokeRoundness;
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
            lastPointerDownWith: import("../element/types").PointerType;
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
            theme: import("../element/types").Theme;
            gridSize: number;
            gridStep: number;
            gridModeEnabled: boolean;
            viewModeEnabled: boolean;
            selectedGroupIds: {
                [groupId: string]: boolean;
            };
            editingGroupId: import("../element/types").GroupId | null;
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
            currentChartType: import("../element/types").ChartType;
            pasteDialog: {
                shown: false;
                data: null;
            } | {
                shown: true;
                data: import("../charts").Spreadsheet;
            };
            pendingImageElementId: import("../element/types").ExcalidrawImageElement["id"] | null;
            showHyperlinkPopup: false | "info" | "editor";
            selectedLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
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
        captureUpdate: "IMMEDIATELY";
    } | {
        elements: readonly import("../element/types").OrderedExcalidrawElement[];
        appState: Readonly<AppState>;
        captureUpdate: "EVENTUALLY";
    };
    predicate: (elements: readonly ExcalidrawElement[], appState: AppState, _: import("../types").ExcalidrawProps, app: AppClassProperties) => boolean;
} & {
    keyTest?: undefined;
};
export declare const actionRemoveAllElementsFromFrame: {
    name: "removeAllElementsFromFrame";
    label: string;
    trackEvent: {
        category: "history";
    };
    perform: (elements: readonly import("../element/types").OrderedExcalidrawElement[], appState: Readonly<AppState>, _: any, app: AppClassProperties) => {
        elements: readonly import("../element/types").OrderedExcalidrawElement[];
        appState: {
            selectedElementIds: {
                [x: string]: true;
            };
            contextMenu: {
                items: import("../components/ContextMenu").ContextMenuItems;
                top: number;
                left: number;
            } | null;
            showWelcomeScreen: boolean;
            isLoading: boolean;
            errorMessage: React.ReactNode;
            activeEmbeddable: {
                element: import("../element/types").NonDeletedExcalidrawElement;
                state: "hover" | "active";
            } | null;
            newElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawNonSelectionElement> | null;
            resizingElement: import("../element/types").NonDeletedExcalidrawElement | null;
            multiElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawLinearElement> | null;
            selectionElement: import("../element/types").NonDeletedExcalidrawElement | null;
            isBindingEnabled: boolean;
            startBoundElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawBindableElement> | null;
            suggestedBindings: import("../element/binding").SuggestedBinding[];
            frameToHighlight: import("../element/types").NonDeleted<import("../element/types").ExcalidrawFrameLikeElement> | null;
            frameRendering: {
                enabled: boolean;
                name: boolean;
                outline: boolean;
                clip: boolean;
            };
            editingFrame: string | null;
            elementsToHighlight: import("../element/types").NonDeleted<ExcalidrawElement>[] | null;
            editingTextElement: import("../element/types").NonDeletedExcalidrawElement | null;
            editingLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
            activeTool: {
                lastActiveTool: import("../types").ActiveTool | null;
                locked: boolean;
            } & import("../types").ActiveTool;
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
            currentItemStrokeVariability: import("../element/types").StrokeVariability;
            currentItemOpacity: number;
            currentItemFontFamily: import("../element/types").FontFamilyValues;
            currentItemFontSize: number;
            currentItemTextAlign: import("../element/types").TextAlign;
            currentItemStartArrowhead: import("../element/types").Arrowhead | null;
            currentItemEndArrowhead: import("../element/types").Arrowhead | null;
            currentHoveredFontFamily: import("../element/types").FontFamilyValues | null;
            currentItemRoundness: import("../element/types").StrokeRoundness;
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
            lastPointerDownWith: import("../element/types").PointerType;
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
            theme: import("../element/types").Theme;
            gridSize: number;
            gridStep: number;
            gridModeEnabled: boolean;
            viewModeEnabled: boolean;
            selectedGroupIds: {
                [groupId: string]: boolean;
            };
            editingGroupId: import("../element/types").GroupId | null;
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
            currentChartType: import("../element/types").ChartType;
            pasteDialog: {
                shown: false;
                data: null;
            } | {
                shown: true;
                data: import("../charts").Spreadsheet;
            };
            pendingImageElementId: import("../element/types").ExcalidrawImageElement["id"] | null;
            showHyperlinkPopup: false | "info" | "editor";
            selectedLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
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
        captureUpdate: "IMMEDIATELY";
    } | {
        elements: readonly import("../element/types").OrderedExcalidrawElement[];
        appState: Readonly<AppState>;
        captureUpdate: "EVENTUALLY";
    };
    predicate: (elements: readonly ExcalidrawElement[], appState: AppState, _: import("../types").ExcalidrawProps, app: AppClassProperties) => boolean;
} & {
    keyTest?: undefined;
};
export declare const actionupdateFrameRendering: {
    name: "updateFrameRendering";
    label: string;
    viewMode: true;
    trackEvent: {
        category: "canvas";
    };
    perform: (elements: readonly import("../element/types").OrderedExcalidrawElement[], appState: Readonly<AppState>) => {
        elements: readonly import("../element/types").OrderedExcalidrawElement[];
        appState: {
            frameRendering: {
                enabled: boolean;
                name: boolean;
                outline: boolean;
                clip: boolean;
            };
            contextMenu: {
                items: import("../components/ContextMenu").ContextMenuItems;
                top: number;
                left: number;
            } | null;
            showWelcomeScreen: boolean;
            isLoading: boolean;
            errorMessage: React.ReactNode;
            activeEmbeddable: {
                element: import("../element/types").NonDeletedExcalidrawElement;
                state: "hover" | "active";
            } | null;
            newElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawNonSelectionElement> | null;
            resizingElement: import("../element/types").NonDeletedExcalidrawElement | null;
            multiElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawLinearElement> | null;
            selectionElement: import("../element/types").NonDeletedExcalidrawElement | null;
            isBindingEnabled: boolean;
            startBoundElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawBindableElement> | null;
            suggestedBindings: import("../element/binding").SuggestedBinding[];
            frameToHighlight: import("../element/types").NonDeleted<import("../element/types").ExcalidrawFrameLikeElement> | null;
            editingFrame: string | null;
            elementsToHighlight: import("../element/types").NonDeleted<ExcalidrawElement>[] | null;
            editingTextElement: import("../element/types").NonDeletedExcalidrawElement | null;
            editingLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
            activeTool: {
                lastActiveTool: import("../types").ActiveTool | null;
                locked: boolean;
            } & import("../types").ActiveTool;
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
            currentItemStrokeVariability: import("../element/types").StrokeVariability;
            currentItemOpacity: number;
            currentItemFontFamily: import("../element/types").FontFamilyValues;
            currentItemFontSize: number;
            currentItemTextAlign: import("../element/types").TextAlign;
            currentItemStartArrowhead: import("../element/types").Arrowhead | null;
            currentItemEndArrowhead: import("../element/types").Arrowhead | null;
            currentHoveredFontFamily: import("../element/types").FontFamilyValues | null;
            currentItemRoundness: import("../element/types").StrokeRoundness;
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
            lastPointerDownWith: import("../element/types").PointerType;
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
            theme: import("../element/types").Theme;
            gridSize: number;
            gridStep: number;
            gridModeEnabled: boolean;
            viewModeEnabled: boolean;
            selectedGroupIds: {
                [groupId: string]: boolean;
            };
            editingGroupId: import("../element/types").GroupId | null;
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
            currentChartType: import("../element/types").ChartType;
            pasteDialog: {
                shown: false;
                data: null;
            } | {
                shown: true;
                data: import("../charts").Spreadsheet;
            };
            pendingImageElementId: import("../element/types").ExcalidrawImageElement["id"] | null;
            showHyperlinkPopup: false | "info" | "editor";
            selectedLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
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
    checked: (appState: AppState) => boolean;
} & {
    keyTest?: undefined;
};
export declare const actionSetFrameAsActiveTool: {
    name: "setFrameAsActiveTool";
    label: string;
    trackEvent: {
        category: "toolbar";
    };
    icon: import("react/jsx-runtime").JSX.Element;
    viewMode: false;
    perform: (elements: readonly import("../element/types").OrderedExcalidrawElement[], appState: Readonly<AppState>, _: any, app: AppClassProperties) => {
        elements: readonly import("../element/types").OrderedExcalidrawElement[];
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
                element: import("../element/types").NonDeletedExcalidrawElement;
                state: "hover" | "active";
            } | null;
            newElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawNonSelectionElement> | null;
            resizingElement: import("../element/types").NonDeletedExcalidrawElement | null;
            multiElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawLinearElement> | null;
            selectionElement: import("../element/types").NonDeletedExcalidrawElement | null;
            isBindingEnabled: boolean;
            startBoundElement: import("../element/types").NonDeleted<import("../element/types").ExcalidrawBindableElement> | null;
            suggestedBindings: import("../element/binding").SuggestedBinding[];
            frameToHighlight: import("../element/types").NonDeleted<import("../element/types").ExcalidrawFrameLikeElement> | null;
            frameRendering: {
                enabled: boolean;
                name: boolean;
                outline: boolean;
                clip: boolean;
            };
            editingFrame: string | null;
            elementsToHighlight: import("../element/types").NonDeleted<ExcalidrawElement>[] | null;
            editingTextElement: import("../element/types").NonDeletedExcalidrawElement | null;
            editingLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
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
            currentItemStrokeVariability: import("../element/types").StrokeVariability;
            currentItemOpacity: number;
            currentItemFontFamily: import("../element/types").FontFamilyValues;
            currentItemFontSize: number;
            currentItemTextAlign: import("../element/types").TextAlign;
            currentItemStartArrowhead: import("../element/types").Arrowhead | null;
            currentItemEndArrowhead: import("../element/types").Arrowhead | null;
            currentHoveredFontFamily: import("../element/types").FontFamilyValues | null;
            currentItemRoundness: import("../element/types").StrokeRoundness;
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
            lastPointerDownWith: import("../element/types").PointerType;
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
            theme: import("../element/types").Theme;
            gridSize: number;
            gridStep: number;
            gridModeEnabled: boolean;
            viewModeEnabled: boolean;
            selectedGroupIds: {
                [groupId: string]: boolean;
            };
            editingGroupId: import("../element/types").GroupId | null;
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
            currentChartType: import("../element/types").ChartType;
            pasteDialog: {
                shown: false;
                data: null;
            } | {
                shown: true;
                data: import("../charts").Spreadsheet;
            };
            pendingImageElementId: import("../element/types").ExcalidrawImageElement["id"] | null;
            showHyperlinkPopup: false | "info" | "editor";
            selectedLinearElement: import("../element/linearElementEditor").LinearElementEditor | null;
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
    keyTest: (event: KeyboardEvent | import("react").KeyboardEvent<Element>) => boolean;
} & {
    keyTest?: ((event: KeyboardEvent | import("react").KeyboardEvent<Element>) => boolean) | undefined;
};
export declare const actionWrapSelectionInFrame: {
    name: "wrapSelectionInFrame";
    label: string;
    trackEvent: {
        category: "element";
    };
    predicate: (elements: readonly ExcalidrawElement[], appState: AppState, _: import("../types").ExcalidrawProps, app: AppClassProperties) => boolean;
    perform: (elements: readonly import("../element/types").OrderedExcalidrawElement[], appState: Readonly<AppState>, _: any, app: AppClassProperties) => {
        elements: (import("../element/types").NonDeleted<import("../element/types").ExcalidrawFrameElement> | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & {
            type: "selection";
        } & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & {
            type: "rectangle";
        } & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & {
            type: "diamond";
        } & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & {
            type: "ellipse";
        } & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & Readonly<{
            type: "text";
            fontSize: number;
            fontFamily: import("../element/types").FontFamilyValues;
            text: string;
            textAlign: import("../element/types").TextAlign;
            verticalAlign: import("../element/types").VerticalAlign;
            containerId: import("../element/types").ExcalidrawGenericElement["id"] | null;
            originalText: string;
            autoResize: boolean;
            lineHeight: number & {
                _brand: "unitlessLineHeight";
            };
        }> & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & Readonly<{
            type: "line" | "arrow";
            points: readonly import("@excalidraw/math").LocalPoint[];
            lastCommittedPoint: import("@excalidraw/math").LocalPoint | null;
            startBinding: import("../element/types").PointBinding | null;
            endBinding: import("../element/types").PointBinding | null;
            startArrowhead: import("../element/types").Arrowhead | null;
            endArrowhead: import("../element/types").Arrowhead | null;
        }> & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & Readonly<{
            type: "freedraw";
            points: readonly import("@excalidraw/math").LocalPoint[];
            pressures: readonly number[];
            simulatePressure: boolean;
            strokeOptions: import("../element/types").StrokeOptions;
            lastCommittedPoint: import("@excalidraw/math").LocalPoint | null;
        }> & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & Readonly<{
            type: "image";
            fileId: import("../element/types").FileId | null;
            status: "pending" | "saved" | "error";
            scale: [number, number];
            crop: import("../element/types").ImageCrop | null;
        }> & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & {
            type: "frame";
            name: string | null;
        } & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & {
            type: "magicframe";
            name: string | null;
        } & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & Readonly<{
            type: "iframe";
            customData?: {
                generationData?: import("../element/types").MagicGenerationData;
            };
        }> & {
            index: import("../element/types").FractionalIndex;
        }) | (Readonly<{
            id: string;
            x: number;
            y: number;
            strokeColor: string;
            backgroundColor: string;
            fillStyle: import("../element/types").FillStyle;
            strokeWidth: number;
            strokeStyle: import("../element/types").StrokeStyle;
            roundness: null | {
                type: import("../element/types").RoundnessType;
                value?: number;
            };
            roughness: number;
            opacity: number;
            width: number;
            height: number;
            angle: import("@excalidraw/math").Radians;
            seed: number;
            version: number;
            versionNonce: number;
            index: import("../element/types").FractionalIndex | null;
            isDeleted: boolean;
            groupIds: readonly import("../element/types").GroupId[];
            frameId: string | null;
            boundElements: readonly import("../element/types").BoundElement[] | null;
            updated: number;
            link: string | null;
            locked: boolean;
            customData?: Record<string, any>;
        }> & Readonly<{
            type: "embeddable";
        }> & {
            index: import("../element/types").FractionalIndex;
        }))[];
        appState: {
            selectedElementIds: {
                [x: string]: true;
            };
        };
        captureUpdate: "IMMEDIATELY";
    };
} & {
    keyTest?: undefined;
};
