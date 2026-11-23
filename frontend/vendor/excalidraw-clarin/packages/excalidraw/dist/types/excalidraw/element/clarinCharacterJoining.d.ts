export type ClarinJoiningType = "U" | "C" | "D" | "L" | "R" | "T";
export interface ClarinJoiningContext {
    prefix: "" | "\u200D";
    suffix: "" | "\u200D";
    shapingText: string;
}
export declare const getClarinJoiningType: (codePoint: number) => ClarinJoiningType;
export declare const getClarinJoiningContext: (text: string, from: number, to: number) => ClarinJoiningContext;
