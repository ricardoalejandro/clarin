import type { LibraryItem } from "../types";
import "./LibraryUnit.scss";
import type { SvgCache } from "../hooks/useLibraryItemSvg";
export declare const LibraryUnit: import("react").MemoExoticComponent<({ id, elements, isPending, onClick, selected, onToggle, onDrag, svgCache, }: {
    id: LibraryItem["id"] | /** for pending item */ null;
    elements?: LibraryItem["elements"];
    isPending?: boolean;
    onClick: (id: LibraryItem["id"] | null) => void;
    selected: boolean;
    onToggle: (id: string, event: React.MouseEvent) => void;
    onDrag: (id: string, event: React.DragEvent) => void;
    svgCache: SvgCache;
}) => import("react/jsx-runtime").JSX.Element>;
export declare const EmptyLibraryUnit: () => import("react/jsx-runtime").JSX.Element;
