export declare const selectClarinFontPreloadTargets: ({ orderedFamilyIds, readyFamilyIds, failedFamilyIds, retryFailed, }: {
    orderedFamilyIds: readonly number[];
    readyFamilyIds: ReadonlySet<number>;
    failedFamilyIds: ReadonlySet<number>;
    retryFailed: boolean;
}) => number[];
export declare const shouldResetClarinFontFace: ({ retryFailed, familyFailed, status, }: {
    retryFailed: boolean;
    familyFailed: boolean;
    status: FontFaceLoadStatus;
}) => boolean;
