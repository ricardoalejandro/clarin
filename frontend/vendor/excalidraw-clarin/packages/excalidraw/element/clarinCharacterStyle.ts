import type { ExcalidrawTextElement } from "./types";
import {
  getClarinTextFormat,
  getGraphemeBoundaries,
  hashClarinText,
  MAX_CLARIN_TEXT_RUNS_PER_ELEMENT,
  snapClarinTextRange,
} from "./clarinRichText";

export const CLARIN_CHARACTER_STYLE_KEY = "clarinCharacterStyle";
export const CLARIN_CHARACTER_STYLE_VERSION = 1 as const;
export type ClarinCharacterStyleProperty = "color" | "fontFamily" | "fontScale";
export interface ClarinCharacterStyleValues {
  color?: string;
  fontFamily?: number;
  /** Relative to element.fontSize, so proportional transforms preserve typography. */
  fontScale?: number;
}
export interface ClarinCharacterStyleRun extends ClarinCharacterStyleValues {
  from: number;
  to: number;
}
export interface ClarinCharacterStyle {
  version: typeof CLARIN_CHARACTER_STYLE_VERSION;
  textLength: number;
  textHash: number;
  runs: ClarinCharacterStyleRun[];
}
export interface ClarinCharacterStyleBase { color: string; fontFamily: number; fontSize: number }
export const validateClarinCharacterStyleBase = (value: unknown): value is ClarinCharacterStyleBase => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const base = value as ClarinCharacterStyleBase;
  return Object.keys(base).sort().join(",") === "color,fontFamily,fontSize"
    && isClarinCharacterColor(base.color) && isClarinCharacterFontFamily(base.fontFamily)
    && Number.isFinite(base.fontSize) && base.fontSize >= 1;
};
export type ClarinCharacterStyleElement = Pick<ExcalidrawTextElement,
  "originalText" | "customData" | "strokeColor" | "fontFamily" | "fontSize">;
export const isClarinCharacterFontFamily = (value: unknown): value is number =>
  Number.isInteger(value) && ([1, 2, 3, 5, 6, 7, 8, 9].includes(value as number)
    || ((value as number) >= 10001 && (value as number) <= 10025));
export const isClarinCharacterColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9A-F]{6}$/.test(value);
const properties = ["color", "fontFamily", "fontScale"] as const;
const sameStyle = (left: ClarinCharacterStyleValues, right: ClarinCharacterStyleValues) =>
  properties.every((property) => left[property] === right[property]);
const hasStyle = (value: ClarinCharacterStyleValues) =>
  properties.some((property) => value[property] !== undefined);
const valuesAt = (format: ClarinCharacterStyle | null, offset: number): ClarinCharacterStyleValues => {
  const runs = format?.runs || [];
  let low = 0; let high = runs.length - 1;
  let run: ClarinCharacterStyleRun | undefined;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (offset < runs[middle].from) high = middle - 1;
    else if (offset >= runs[middle].to) low = middle + 1;
    else { run = runs[middle]; break; }
  }
  return run ? Object.fromEntries(properties.flatMap((property) =>
    run[property] === undefined ? [] : [[property, run[property]]])) : {};
};
export const getClarinCharacterStyleValuesAt = valuesAt;
export const getClarinCharacterStyleAtCaret = (format: ClarinCharacterStyle | null, text: string, offset: number) =>
  valuesAt(format, Math.max(0, Math.min(text.length, offset) - (offset > 0 ? 1 : 0)));

export const createClarinCharacterStyle = (
  text: string,
  input: readonly ClarinCharacterStyleRun[],
): ClarinCharacterStyle => {
  const runs: ClarinCharacterStyleRun[] = [];
  const boundaries = getGraphemeBoundaries(text);
  const boundaryAt = (offset: number, forward: boolean) => {
    const bounded = Math.max(0, Math.min(text.length, offset));
    let low = 0; let high = boundaries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (boundaries[middle] === bounded) return bounded;
      if (boundaries[middle] < bounded) low = middle + 1; else high = middle - 1;
    }
    return boundaries[forward ? low : high] ?? (forward ? text.length : 0);
  };
  const points = new Set<number>([0, text.length]);
  const bounded = input.filter((run) => Number.isInteger(run.from) && Number.isInteger(run.to)).map((run) => {
    const from = boundaryAt(Math.min(run.from, run.to), false);
    const to = boundaryAt(Math.max(run.from, run.to), true);
    const values: ClarinCharacterStyleValues = {};
    if (typeof run.color === "string" && /^#[0-9a-f]{6}$/i.test(run.color)) values.color = run.color.toUpperCase();
    if (isClarinCharacterFontFamily(run.fontFamily)) values.fontFamily = run.fontFamily;
    if (Number.isFinite(run.fontScale) && run.fontScale! > 0 && run.fontScale !== 1) values.fontScale = run.fontScale;
    points.add(from); points.add(to);
    return { from, to, ...values };
  }).filter((run) => run.from < run.to && hasStyle(run));
  const sorted = [...points].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length - 1; index++) {
    const from = sorted[index]; const to = sorted[index + 1];
    const values: ClarinCharacterStyleValues = {};
    for (const run of bounded) if (run.from <= from && to <= run.to) {
      for (const property of properties) if (run[property] !== undefined) Object.assign(values, { [property]: run[property] });
    }
    if (!hasStyle(values)) continue;
    const previous = runs[runs.length - 1];
    if (previous?.to === from && sameStyle(previous, values)) previous.to = to;
    else runs.push({ from, to, ...values });
  }
  if (runs.length > MAX_CLARIN_TEXT_RUNS_PER_ELEMENT) throw new Error("El texto supera el límite de segmentos de formato.");
  return { version: 1, textLength: text.length, textHash: hashClarinText(text), runs };
};

export const validateClarinCharacterStyle = (value: unknown, text: string, baseFontSize?: number): value is ClarinCharacterStyle => {
  if (baseFontSize !== undefined && (!Number.isFinite(baseFontSize) || baseFontSize < 1)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const format = value as ClarinCharacterStyle;
  if (Object.keys(format).sort().join(",") !== "runs,textHash,textLength,version"
    || format.version !== 1 || format.textLength !== text.length || format.textHash !== hashClarinText(text)
    || !Array.isArray(format.runs) || format.runs.length > MAX_CLARIN_TEXT_RUNS_PER_ELEMENT) return false;
  const boundaries = new Set(getGraphemeBoundaries(text));
  let previous: ClarinCharacterStyleRun | undefined;
  for (const run of format.runs) {
    if (!run || typeof run !== "object" || Array.isArray(run)
      || Object.keys(run).some((key) => !["from", "to", ...properties].includes(key as ClarinCharacterStyleProperty))
      || !Number.isInteger(run.from) || !Number.isInteger(run.to) || run.from >= run.to
      || !boundaries.has(run.from) || !boundaries.has(run.to) || !hasStyle(run)
      || (run.color !== undefined && !isClarinCharacterColor(run.color))
      || (run.fontFamily !== undefined && !isClarinCharacterFontFamily(run.fontFamily))
      || (run.fontScale !== undefined && (!Number.isFinite(run.fontScale) || run.fontScale <= 0 || run.fontScale === 1))
      || (baseFontSize !== undefined && (!Number.isFinite(baseFontSize * (run.fontScale ?? 1)) || baseFontSize * (run.fontScale ?? 1) < 1))
      || (previous && (previous.to > run.from || (previous.to === run.from && sameStyle(previous, run))))) return false;
    previous = run;
  }
  return true;
};

export const getClarinCharacterStyle = (element: Pick<ExcalidrawTextElement, "originalText" | "customData"> & { fontSize?: number }) => {
  const value = element.customData?.[CLARIN_CHARACTER_STYLE_KEY];
  return validateClarinCharacterStyle(value, element.originalText, element.fontSize) ? value : null;
};
export const updateClarinCharacterStyleCustomData = (customData: Record<string, unknown> | undefined, format: ClarinCharacterStyle | null) => {
  const next = { ...customData };
  if (format?.runs.length) next[CLARIN_CHARACTER_STYLE_KEY] = format;
  else delete next[CLARIN_CHARACTER_STYLE_KEY];
  return Object.keys(next).length ? next : undefined;
};
export const getClarinEffectiveCharacterStyle = (element: ClarinCharacterStyleElement, offset: number, format = getClarinCharacterStyle(element)) => {
  const values = valuesAt(format, offset);
  const fontScale = values.fontScale ?? 1;
  return { color: values.color ?? element.strokeColor, fontFamily: values.fontFamily ?? element.fontFamily,
    fontSize: element.fontSize * fontScale, fontScale };
};
export const getClarinCharacterStylePoints = (element: Pick<ExcalidrawTextElement, "originalText" | "customData">, from: number, to: number, format = getClarinCharacterStyle(element)) => {
  const points = new Set([from, to]);
  for (const run of format?.runs || []) if (run.from < to && from < run.to) {
    points.add(Math.max(from, run.from)); points.add(Math.min(to, run.to));
  }
  return [...points].sort((a, b) => a - b);
};
export const setClarinCharacterStyle = (format: ClarinCharacterStyle | null, text: string, from: number, to: number, patch: ClarinCharacterStyleValues) => {
  const [start, end] = snapClarinTextRange(text, from, to);
  const points = new Set([0, text.length, start, end]);
  for (const run of format?.runs || []) { points.add(run.from); points.add(run.to); }
  const sorted = [...points].sort((a, b) => a - b);
  return createClarinCharacterStyle(text, sorted.slice(0, -1).map((point, index) => ({
    from: point, to: sorted[index + 1], ...valuesAt(format, point),
    ...(start <= point && sorted[index + 1] <= end ? patch : {}),
  })));
};
export const clearClarinCharacterStyleProperty = (customData: Record<string, unknown> | undefined, property: ClarinCharacterStyleProperty) => {
  const format = customData?.[CLARIN_CHARACTER_STYLE_KEY] as ClarinCharacterStyle | undefined;
  if (!format?.runs) return customData;
  const runs = format.runs.map((run) => { const next = { ...run }; delete next[property]; return next; }).filter(hasStyle);
  const merged: ClarinCharacterStyleRun[] = [];
  for (const run of runs) { const previous = merged[merged.length - 1];
    if (previous?.to === run.from && sameStyle(previous, run)) previous.to = run.to;
    else merged.push(run);
  }
  return updateClarinCharacterStyleCustomData(customData, { ...format, runs: merged });
};
export const replaceClarinCharacterStyleRange = ({ format, text, from, to, insertedText, insertedStyle = {}, insertedFormat = null }: {
  format: ClarinCharacterStyle | null; text: string; from: number; to: number; insertedText: string;
  insertedStyle?: ClarinCharacterStyleValues; insertedFormat?: ClarinCharacterStyle | null;
}) => {
  const [start, end] = snapClarinTextRange(text, from, to);
  const nextText = text.slice(0, start) + insertedText + text.slice(end);
  const delta = insertedText.length - (end - start);
  const runs: ClarinCharacterStyleRun[] = [];
  for (const run of format?.runs || []) {
    if (run.from < start) runs.push({ ...run, to: Math.min(start, run.to) });
    if (run.to > end) runs.push({ ...run, from: Math.max(end, run.from) + delta, to: run.to + delta });
  }
  if (insertedText.length) {
    if (insertedFormat && validateClarinCharacterStyle(insertedFormat, insertedText)) {
      runs.push(...insertedFormat.runs.map((run) => ({ ...run, from: run.from + start, to: run.to + start })));
    } else runs.push({ from: start, to: start + insertedText.length, ...insertedStyle });
  }
  return createClarinCharacterStyle(nextText, runs);
};
export const getClarinMinimumEffectiveFontSize = (element: ClarinCharacterStyleElement) => Math.min(element.fontSize,
  ...(getClarinCharacterStyle(element)?.runs || []).map((run) => element.fontSize * (run.fontScale ?? 1)));

/** Clipboard styles carry source defaults; destination ratios preserve the actual visual size. */
export const rebaseClarinCharacterStyle = (text: string, format: ClarinCharacterStyle | null,
  source: ClarinCharacterStyleBase, destination: ClarinCharacterStyleBase) => {
  const points = new Set([0, text.length]);
  for (const run of format?.runs || []) { points.add(run.from); points.add(run.to); }
  const ordered = [...points].sort((a, b) => a - b);
  return createClarinCharacterStyle(text, ordered.slice(0, -1).map((from, index) => {
    const values = valuesAt(format, from);
    const color = values.color ?? source.color;
    const fontFamily = values.fontFamily ?? source.fontFamily;
    const fontScale = source.fontSize * (values.fontScale ?? 1) / destination.fontSize;
    return { from, to: ordered[index + 1],
      ...(color === destination.color ? {} : { color }),
      ...(fontFamily === destination.fontFamily ? {} : { fontFamily }),
      ...(fontScale === 1 ? {} : { fontScale }) };
  }));
};

export const getClarinStyledVisualLines = (element: ClarinCharacterStyleElement & Pick<ExcalidrawTextElement, "text">) => {
  const marks = getClarinTextFormat(element);
  const characterStyle = getClarinCharacterStyle(element);
  let offset = 0;
  return element.text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const runs: Array<ReturnType<typeof getClarinEffectiveCharacterStyle> & { from: number; to: number; text: string; marks: number }> = [];
    for (const character of Array.from(line)) {
      const found = element.originalText.indexOf(character, offset);
      const from = found < 0 ? offset : found;
      const values = valuesAt(characterStyle, from);
      const fontScale = values.fontScale ?? 1;
      const style = { color: values.color ?? element.strokeColor, fontFamily: values.fontFamily ?? element.fontFamily,
        fontSize: element.fontSize * fontScale, fontScale };
      const mark = marks?.runs.find((run) => run.from <= from && from < run.to)?.marks ?? 0;
      const previous = runs[runs.length - 1];
      if (previous && previous.to === from && previous.marks === mark && sameStyle(previous, style)) {
        previous.text += character; previous.to += character.length;
      } else runs.push({ from, to: from + character.length, text: character, marks: mark, ...style });
      offset = from + character.length;
    }
    // A soft wrap can trim horizontal whitespace before an explicit break.
    let next = offset;
    while (/[\t\f\v ]/.test(element.originalText[next] ?? "") && next < element.originalText.length) next++;
    if (element.originalText[next] === "\n") offset = next + 1;
    return runs.length ? runs : [{ from: offset, to: offset, text: "", marks: 0, ...getClarinEffectiveCharacterStyle(element, offset) }];
  });
};
