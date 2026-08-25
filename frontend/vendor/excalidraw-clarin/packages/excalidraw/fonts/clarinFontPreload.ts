export const selectClarinFontPreloadTargets = ({
  orderedFamilyIds,
  readyFamilyIds,
  failedFamilyIds,
  retryFailed,
}: {
  orderedFamilyIds: readonly number[];
  readyFamilyIds: ReadonlySet<number>;
  failedFamilyIds: ReadonlySet<number>;
  retryFailed: boolean;
}) => {
  const retryOnlyFailures = retryFailed && failedFamilyIds.size > 0;
  return orderedFamilyIds.filter((family) =>
    retryOnlyFailures
      ? failedFamilyIds.has(family)
      : !readyFamilyIds.has(family),
  );
};

export const shouldResetClarinFontFace = ({
  retryFailed,
  familyFailed,
  status,
}: {
  retryFailed: boolean;
  familyFailed: boolean;
  status: FontFaceLoadStatus;
}) => retryFailed && familyFailed && status === "error";
