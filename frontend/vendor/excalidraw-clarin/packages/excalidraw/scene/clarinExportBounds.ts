import { getCommonBounds, getElementAbsoluteCoords } from "../element/bounds";
import type { Bounds } from "../element/bounds";
import type { NonDeletedExcalidrawElement } from "../element/types";
import { getFreedrawOutlinePoints } from "../renderer/renderElement";
import { arrayToMap } from "../utils";

/** Export-only ink bounds. Selection, hit testing and explicit frame crops stay unchanged. */
export const getClarinExportBounds = (
  elements: readonly NonDeletedExcalidrawElement[],
): Bounds => {
  let [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const elementsMap = arrayToMap(elements);
  for (const element of elements) {
    if (element.type !== "freedraw") continue;
    const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
    const cos = Math.cos(element.angle);
    const sin = Math.sin(element.angle);
    for (const [localX, localY] of getFreedrawOutlinePoints(element)) {
      const dx = localX + element.x - cx;
      const dy = localY + element.y - cy;
      const x = cx + dx * cos - dy * sin;
      const y = cy + dx * sin + dy * cos;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
};
