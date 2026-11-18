import type { ExcalidrawTextElement } from "./types";
export declare const CLARIN_CHARACTER_STYLE_KEY = "clarinCharacterStyle";
export declare const CLARIN_CHARACTER_STYLE_VERSION: 1;
export type ClarinCharacterStyleProperty = "color" | "fontFamily" | "fontScale";
export interface ClarinCharacterStyleValues { color?: string; fontFamily?: number; fontScale?: number }
export interface ClarinCharacterStyleRun extends ClarinCharacterStyleValues { from: number; to: number }
export interface ClarinCharacterStyle { version: 1; textLength: number; textHash: number; runs: ClarinCharacterStyleRun[] }
export interface ClarinCharacterStyleBase { color: string; fontFamily: number; fontSize: number }
export type ClarinCharacterStyleElement = Pick<ExcalidrawTextElement, "originalText" | "customData" | "strokeColor" | "fontFamily" | "fontSize">;
export declare const isClarinCharacterFontFamily: (value: unknown) => value is number;
export declare const isClarinCharacterColor: (value: unknown) => value is string;
export declare const validateClarinCharacterStyleBase: (value: unknown) => value is ClarinCharacterStyleBase;
export declare const createClarinCharacterStyle: (text: string, input: readonly ClarinCharacterStyleRun[]) => ClarinCharacterStyle;
export declare const validateClarinCharacterStyle: (value: unknown, text: string, baseFontSize?: number) => value is ClarinCharacterStyle;
export declare const getClarinCharacterStyle: (element: Pick<ExcalidrawTextElement, "originalText" | "customData"> & { fontSize?: number }) => ClarinCharacterStyle | null;
export declare const getClarinCharacterStyleValuesAt: (format: ClarinCharacterStyle | null, offset: number) => ClarinCharacterStyleValues;
export declare const getClarinCharacterStyleAtCaret: (format: ClarinCharacterStyle | null, text: string, offset: number) => ClarinCharacterStyleValues;
export declare const updateClarinCharacterStyleCustomData: (customData: Record<string, unknown> | undefined, format: ClarinCharacterStyle | null) => Record<string, unknown> | undefined;
export declare const getClarinEffectiveCharacterStyle: (element: ClarinCharacterStyleElement, offset: number, format?: ClarinCharacterStyle | null) => { color: string; fontFamily: number; fontSize: number; fontScale: number };
export declare const getClarinCharacterStylePoints: (element: Pick<ExcalidrawTextElement, "originalText" | "customData">, from: number, to: number, format?: ClarinCharacterStyle | null) => number[];
export declare const setClarinCharacterStyle: (format: ClarinCharacterStyle | null, text: string, from: number, to: number, patch: ClarinCharacterStyleValues) => ClarinCharacterStyle;
export declare const clearClarinCharacterStyleProperty: (customData: Record<string, unknown> | undefined, property: ClarinCharacterStyleProperty) => Record<string, unknown> | undefined;
export declare const replaceClarinCharacterStyleRange: (input: { format: ClarinCharacterStyle | null; text: string; from: number; to: number; insertedText: string; insertedStyle?: ClarinCharacterStyleValues; insertedFormat?: ClarinCharacterStyle | null }) => ClarinCharacterStyle;
export declare const getClarinMinimumEffectiveFontSize: (element: ClarinCharacterStyleElement) => number;
export declare const rebaseClarinCharacterStyle: (text: string, format: ClarinCharacterStyle | null, source: ClarinCharacterStyleBase, destination: ClarinCharacterStyleBase) => ClarinCharacterStyle;
export declare const getClarinStyledVisualLines: (element: ClarinCharacterStyleElement & Pick<ExcalidrawTextElement, "text">) => Array<Array<{ from: number; to: number; text: string; marks: number; color: string; fontFamily: number; fontSize: number; fontScale: number }>>;
