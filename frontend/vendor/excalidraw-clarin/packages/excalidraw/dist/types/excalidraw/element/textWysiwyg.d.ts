import type { ExcalidrawElement, ExcalidrawTextElement } from "./types";
import type App from "../components/App";
import { type ClarinTextFormat } from "./clarinRichText";
import { type ClarinParagraphFormat } from "./clarinParagraphFormat";
export declare const textWysiwyg: ({ id, onChange, onSubmit, getViewportCoords, element, canvas, excalidrawContainer, app, autoSelect, }: {
    id: ExcalidrawElement["id"];
    /**
     * textWysiwyg only deals with `originalText`
     *
     * Note: `text`, which can be wrapped and therefore different from `originalText`,
     *       is derived from `originalText`
     */
    onChange?: (nextOriginalText: string, clarinTextFormat: ClarinTextFormat | null, clarinParagraphFormat: ClarinParagraphFormat | null, textAlign: ExcalidrawTextElement["textAlign"]) => void;
    onSubmit: (data: {
        viaKeyboard: boolean;
        nextOriginalText: string;
        clarinTextFormat: ClarinTextFormat | null;
        clarinParagraphFormat: ClarinParagraphFormat | null;
        textAlign: ExcalidrawTextElement["textAlign"];
    }) => void;
    getViewportCoords: (x: number, y: number) => [number, number];
    element: ExcalidrawTextElement;
    canvas: HTMLCanvasElement;
    excalidrawContainer: HTMLDivElement | null;
    app: App;
    autoSelect?: boolean;
}) => void;
