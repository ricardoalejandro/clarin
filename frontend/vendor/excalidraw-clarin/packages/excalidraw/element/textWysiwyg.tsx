import { CODES, KEYS } from "../keys";
import {
  isWritableElement,
  getFontString,
  getFontFamilyString,
  isTestEnv,
} from "../utils";
import Scene from "../scene/Scene";
import {
  isArrowElement,
  isBoundToContainer,
  isTextElement,
} from "./typeChecks";
import { CLASSES, POINTER_BUTTON } from "../constants";
import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElementWithContainer,
  ExcalidrawTextElement,
} from "./types";
import type { AppState } from "../types";
import { bumpVersion, mutateElement } from "./mutateElement";
import {
  getBoundTextElementId,
  getContainerElement,
  getTextElementAngle,
  redrawTextBoundingBox,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  computeContainerDimensionForBoundText,
  computeBoundTextPosition,
} from "./textElement";
import {
  actionDecreaseFontSize,
  actionIncreaseFontSize,
} from "../actions/actionProperties";
import {
  actionResetZoom,
  actionZoomIn,
  actionZoomOut,
} from "../actions/actionCanvas";
import type App from "../components/App";
import { LinearElementEditor } from "./linearElementEditor";
import {
  originalContainerCache,
  updateOriginalContainerCache,
} from "./containerCache";
import { normalizeText } from "./textMeasurements";
import {
  CLARIN_TEXT_MARK,
  clearActiveClarinRichTextEditor,
  createClarinTextFormat,
  getClarinMarkState,
  getClarinMarksAtCaret,
  getClarinBeforeInputText,
  getClarinTextDecoration,
  getClarinTextFormat,
  getGraphemeBoundaries,
  publishClarinRichTextState,
  replaceClarinTextRange,
  setActiveClarinRichTextEditor,
  shouldInsertClarinTextLineBreak,
  toggleClarinTextMark,
  validateClarinTextFormat,
  type ClarinTextFormat,
  type ClarinTextMark,
} from "./clarinRichText";
import {
  createClarinCharacterStyle, getClarinCharacterStyle, getClarinCharacterStyleAtCaret,
  getClarinEffectiveCharacterStyle, getClarinCharacterStylePoints,
  setClarinCharacterStyle, replaceClarinCharacterStyleRange,
  validateClarinCharacterStyle, isClarinCharacterColor, isClarinCharacterFontFamily,
  validateClarinCharacterStyleBase, rebaseClarinCharacterStyle,
  type ClarinCharacterStyle, type ClarinCharacterStyleValues,
  type ClarinCharacterStyleElement, type ClarinCharacterStyleBase,
} from "./clarinCharacterStyle";
import { applyClarinTextColorHighlights, clearClarinTextColorHighlights, supportsClarinTextColorHighlights,
  type ClarinTextColorPatch } from "./clarinTextColorHighlights";
import {
  applyClarinParagraphTextEdit,
  MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT,
  createClarinParagraphFormat,
  getClarinParagraphAlignmentState,
  getClarinParagraphFormat,
  getClarinParagraphStarts,
  isClarinParagraphAlignment,
  setClarinParagraphAlignment,
  validateClarinParagraphFormat,
  type ClarinParagraphFormat,
} from "./clarinParagraphFormat";

type RichTextEditable = HTMLDivElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  select: () => void;
  oncompositionstart: ((event: CompositionEvent) => void) | null;
  oncompositionend: ((event: CompositionEvent) => void) | null;
};

const CLARIN_RICH_TEXT_CLIPBOARD_TYPE =
  "application/x-clarin-rich-text+json";
const CLARIN_PARAGRAPH_START_ATTRIBUTE = "data-clarin-paragraph-start";
const CLARIN_EMPTY_PARAGRAPH_ATTRIBUTE = "data-clarin-empty-paragraph";

type EditableSelectionDirection = "forward" | "backward";
type EditableSelection = readonly [
  start: number,
  end: number,
  direction?: EditableSelectionDirection,
];

const createEditableSelection = (
  first: number,
  second = first,
  direction: EditableSelectionDirection = "forward",
): EditableSelection => {
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  return [start, end, start === end ? "forward" : direction];
};

const getEditableSelectionDirection = (
  selection: EditableSelection,
): EditableSelectionDirection => selection[2] ?? "forward";

const createTargetRangeSelection = (
  start: number,
  end: number,
  currentSelection: EditableSelection,
): EditableSelection => {
  const targetSelection = createEditableSelection(start, end);
  return targetSelection[0] === currentSelection[0] &&
    targetSelection[1] === currentSelection[1]
    ? createEditableSelection(
        start,
        end,
        getEditableSelectionDirection(currentSelection),
      )
    : targetSelection;
};

const getEditableParagraph = (editable: HTMLElement, node: Node) => {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  const paragraph = element?.closest<HTMLElement>(
    `[${CLARIN_PARAGRAPH_START_ATTRIBUTE}]`,
  );
  return paragraph && editable.contains(paragraph) ? paragraph : null;
};

const getParagraphStart = (paragraph: HTMLElement) => {
  const start = Number(paragraph.dataset.clarinParagraphStart);
  return Number.isInteger(start) ? start : 0;
};

const getEditableSelectionOffset = (
  editable: HTMLElement,
  node: Node | null,
  offset: number,
) => {
  if (!node || !editable.contains(node)) {
    return 0;
  }
  if (node === editable) {
    const child = editable.children.item(offset) as HTMLElement | null;
    if (child?.hasAttribute(CLARIN_PARAGRAPH_START_ATTRIBUTE)) {
      return getParagraphStart(child);
    }
    const previous = Array.from(editable.children)
      .slice(0, offset)
      .reverse()
      .find((candidate) =>
        candidate.hasAttribute(CLARIN_PARAGRAPH_START_ATTRIBUTE),
      ) as HTMLElement | undefined;
    return previous
      ? getParagraphStart(previous) + (previous.textContent?.length || 0)
      : 0;
  }
  const paragraph = getEditableParagraph(editable, node);
  if (paragraph) {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    try {
      range.setEnd(node, offset);
    } catch {
      return getParagraphStart(paragraph) + (paragraph.textContent?.length || 0);
    }
    return getParagraphStart(paragraph) + range.toString().length;
  }
  const range = document.createRange();
  range.selectNodeContents(editable);
  try {
    range.setEnd(node, offset);
  } catch {
    return editable.textContent?.length || 0;
  }
  return range.toString().length;
};

const getEditableSelection = (
  editable: HTMLElement,
): EditableSelection | null => {
  const selection = window.getSelection();
  if (
    !selection?.rangeCount ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !editable.contains(selection.anchorNode) ||
    !editable.contains(selection.focusNode)
  ) {
    return null;
  }
  const anchor = getEditableSelectionOffset(
    editable,
    selection.anchorNode,
    selection.anchorOffset,
  );
  const focus = getEditableSelectionOffset(
    editable,
    selection.focusNode,
    selection.focusOffset,
  );
  return createEditableSelection(
    anchor,
    focus,
    anchor > focus ? "backward" : "forward",
  );
};

const getEditablePointAtOffset = (editable: HTMLElement, offset: number) => {
  const paragraphs = Array.from(
    editable.querySelectorAll<HTMLElement>(
      `[${CLARIN_PARAGRAPH_START_ATTRIBUTE}]`,
    ),
  );
  let root: HTMLElement = editable;
  let remaining = Math.max(0, offset);
  if (paragraphs.length) {
    root = paragraphs[0];
    for (const paragraph of paragraphs) {
      if (getParagraphStart(paragraph) <= remaining) {
        root = paragraph;
      } else {
        break;
      }
    }
    remaining = Math.max(
      0,
      Math.min(
        root.textContent?.length || 0,
        remaining - getParagraphStart(root),
      ),
    );
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    last = node;
    if (remaining <= node.data.length) {
      return { node, offset: remaining };
    }
    remaining -= node.data.length;
  }
  if (last) {
    return { node: last, offset: last.data.length };
  }
  // Empty logical paragraphs contain a DOM-only BR so the browser can place
  // the caret on them. The canonical UTF-16 offset maps to the paragraph
  // itself because the BR must never become part of the persisted text.
  return { node: root, offset: 0 };
};

const isEditableParagraphSeparator = (node: Node) =>
  node instanceof HTMLElement &&
  node.dataset.clarinParagraphSeparator === "true";

const isEditableBlock = (node: Node) =>
  node instanceof HTMLElement &&
  (node.tagName === "DIV" || node.tagName === "P" || node.tagName === "LI");

const serializeNativeEditableNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }
  if (!(node instanceof HTMLElement) || isEditableParagraphSeparator(node)) {
    return "";
  }
  if (node.tagName === "BR") {
    const siblings = Array.from(node.parentNode?.childNodes || []).filter(
      (candidate) => !isEditableParagraphSeparator(candidate),
    );
    const parentIsEmptyBlock =
      node.parentNode instanceof HTMLElement &&
      isEditableBlock(node.parentNode) &&
      siblings.length === 1;
    return node.hasAttribute(CLARIN_EMPTY_PARAGRAPH_ATTRIBUTE) ||
      parentIsEmptyBlock
      ? ""
      : "\n";
  }

  let text = "";
  let seen = false;
  let previousWasBlock = false;
  let previousEndedWithLineBreak = false;
  for (const child of Array.from(node.childNodes)) {
    if (isEditableParagraphSeparator(child)) {
      continue;
    }
    const childIsBlock = isEditableBlock(child);
    if (
      seen &&
      (previousWasBlock || childIsBlock) &&
      !previousEndedWithLineBreak
    ) {
      text += "\n";
    }
    const childText = serializeNativeEditableNode(child);
    text += childText;
    seen = true;
    previousWasBlock = childIsBlock;
    previousEndedWithLineBreak = childText.endsWith("\n");
  }
  return text;
};

const hasCanonicalEditableStructure = (editable: HTMLElement) => {
  const children = Array.from(editable.childNodes).filter(
    (child) => !isEditableParagraphSeparator(child),
  );
  return (
    children.length > 0 &&
    children.every(
      (child) =>
        child instanceof HTMLElement &&
        child.hasAttribute(CLARIN_PARAGRAPH_START_ATTRIBUTE) &&
        !child.querySelector(
          `div, p, li, br:not([${CLARIN_EMPTY_PARAGRAPH_ATTRIBUTE}])`,
        ),
    )
  );
};

const getEditablePlainText = (editable: HTMLElement) => {
  if (hasCanonicalEditableStructure(editable)) {
    return Array.from(
      editable.querySelectorAll<HTMLElement>(
        `:scope > [${CLARIN_PARAGRAPH_START_ATTRIBUTE}]`,
      ),
    )
      .map((paragraph) => paragraph.textContent || "")
      .join("\n");
  }
  return serializeNativeEditableNode(editable);
};

const setEditableSelection = (
  editable: HTMLElement,
  from: number,
  to = from,
  direction: EditableSelectionDirection = "forward",
) => {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const start = getEditablePointAtOffset(editable, Math.min(from, to));
  const end = getEditablePointAtOffset(editable, Math.max(from, to));
  const isBackward = direction === "backward" && from !== to;
  const anchor = isBackward ? end : start;
  const focus = isBackward ? start : end;

  selection.removeAllRanges();
  if (typeof selection.setBaseAndExtent === "function") {
    try {
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        focus.node,
        focus.offset,
      );
      return;
    } catch {
      selection.removeAllRanges();
    }
  }

  if (isBackward && typeof selection.extend === "function") {
    try {
      selection.collapse(anchor.node, anchor.offset);
      selection.extend(focus.node, focus.offset);
      return;
    } catch {
      selection.removeAllRanges();
    }
  }

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.addRange(range);
};

const installEditableTextAPI = (editable: HTMLDivElement): RichTextEditable => {
  Object.defineProperties(editable, {
    value: {
      get: () => getEditablePlainText(editable),
      set: (value: string) => {
        editable.textContent = value;
      },
    },
    selectionStart: {
      get: () => getEditableSelection(editable)?.[0] ?? 0,
      set: (value: number) => {
        const end = getEditableSelection(editable)?.[1] ?? value;
        setEditableSelection(editable, value, Math.max(value, end));
      },
    },
    selectionEnd: {
      get: () => getEditableSelection(editable)?.[1] ?? 0,
      set: (value: number) => {
        const start = getEditableSelection(editable)?.[0] ?? value;
        setEditableSelection(editable, start, Math.max(start, value));
      },
    },
    select: {
      value: () => setEditableSelection(editable, 0, getEditablePlainText(editable).length),
    },
  });
  return editable as RichTextEditable;
};

const renderEditableRichText = (
  editable: RichTextEditable,
  text: string,
  format: ClarinTextFormat | null,
  paragraphFormat: ClarinParagraphFormat | null,
  textAlign: ExcalidrawTextElement["textAlign"],
  selection?: EditableSelection,
  characterStyle: ClarinCharacterStyle | null = null,
  baseStyle?: Pick<ExcalidrawTextElement, "strokeColor" | "fontFamily" | "fontSize" | "lineHeight">,
  usePaintHighlights = true,
) => {
  clearClarinTextColorHighlights(editable);
  const fragment = document.createDocumentFragment();
  const runs = format?.runs || [];
  const highlightColors = Boolean(usePaintHighlights && baseStyle && characterStyle?.runs.length
    && supportsClarinTextColorHighlights(editable));
  const colorPatches: ClarinTextColorPatch[] = [];
  let previousSpan: { parent: HTMLElement; span: HTMLSpanElement; node: Text; key: string; end: number } | undefined;
  const append = (parent: HTMLElement, value: string, marks: number, offset: number) => {
    if (!value) {
      return;
    }
    const style = baseStyle && characterStyle?.runs.length
      ? getClarinEffectiveCharacterStyle({ ...baseStyle, originalText: text }, offset, characterStyle) : null;
    const key = JSON.stringify([highlightColors ? marks & (CLARIN_TEXT_MARK.BOLD | CLARIN_TEXT_MARK.ITALIC) : marks, style?.fontFamily, style?.fontSize]);
    if (highlightColors && previousSpan?.parent === parent && previousSpan.key === key && previousSpan.end === offset) {
      const from = previousSpan.node.length;
      previousSpan.node.appendData(value); previousSpan.end += value.length;
      if (style) colorPatches.push({ node: previousSpan.node, from, to: from + value.length, color: style.color, marks });
      return;
    }
    const span = document.createElement("span");
    const node = document.createTextNode(value); span.appendChild(node);
    span.style.fontWeight = marks & CLARIN_TEXT_MARK.BOLD ? "700" : "400";
    span.style.fontStyle = marks & CLARIN_TEXT_MARK.ITALIC ? "italic" : "normal";
    span.style.textDecoration = highlightColors ? "none" : getClarinTextDecoration(marks) || "none";
    if (baseStyle && style) {
      span.style.color = highlightColors ? baseStyle.strokeColor : style.color;
      span.style.fontSize = `${style.fontSize}px`;
      span.style.fontFamily = getFontFamilyString({ fontFamily: style.fontFamily });
      span.style.lineHeight = String(baseStyle.lineHeight);
    }
    parent.appendChild(span);
    previousSpan = { parent, span, node, key, end: offset + value.length };
    if (highlightColors && style) colorPatches.push({ node, from: 0, to: value.length, color: style.color, marks });
  };
  const paragraphStarts = getClarinParagraphStarts(text);
  const paragraphAlignments = getEffectiveParagraphAlignmentMap(
    paragraphFormat,
    text,
    textAlign,
  );
  for (let index = 0; index < paragraphStarts.length; index++) {
    const paragraphStart = paragraphStarts[index];
    const paragraphEnd =
      index + 1 < paragraphStarts.length
        ? paragraphStarts[index + 1] - 1
        : text.length;
    const paragraph = document.createElement("div");
    paragraph.dataset.clarinParagraphStart = String(paragraphStart);
    paragraph.style.display = "block";
    paragraph.style.width = "100%";
    paragraph.style.minHeight = "1em";
    paragraph.style.lineHeight = "inherit";
    paragraph.style.fontSize =
      "var(--clarin-wysiwyg-font-size, inherit)";
    paragraph.style.textAlign =
      paragraphAlignments.get(paragraphStart) ?? textAlign;
    const points = new Set([paragraphStart, paragraphEnd]);
    for (const run of [...runs, ...(characterStyle?.runs || [])]) {
      if (run.from < paragraphEnd && paragraphStart < run.to) {
        points.add(Math.max(paragraphStart, run.from)); points.add(Math.min(paragraphEnd, run.to));
      }
    }
    const ordered = [...points].sort((a, b) => a - b);
    for (let point = 0; point < ordered.length - 1; point++) {
      const from = ordered[point]; const to = ordered[point + 1];
      append(paragraph, text.slice(from, to), runs.find((run) => run.from <= from && from < run.to)?.marks || 0, from);
    }
    if (!paragraph.textContent) {
      const emptyLine = document.createElement("br");
      emptyLine.setAttribute(CLARIN_EMPTY_PARAGRAPH_ATTRIBUTE, "true");
      paragraph.appendChild(emptyLine);
    }
    fragment.appendChild(paragraph);
    if (index + 1 < paragraphStarts.length) {
      const separator = document.createElement("span");
      separator.dataset.clarinParagraphSeparator = "true";
      separator.setAttribute("aria-hidden", "true");
      separator.contentEditable = "false";
      separator.style.display = "none";
      separator.textContent = "\n";
      fragment.appendChild(separator);
    }
  }
  editable.replaceChildren(fragment);
  if (highlightColors && !applyClarinTextColorHighlights(editable, colorPatches)) {
    renderEditableRichText(editable, text, format, paragraphFormat, textAlign, selection, characterStyle, baseStyle, false);
    return;
  }
  if (selection) {
    setEditableSelection(
      editable,
      selection[0],
      selection[1],
      getEditableSelectionDirection(selection),
    );
  }
};

const createClarinRichTextClipboardSelection = ({
  sourceText,
  format,
  paragraphFormat,
  textAlign,
  from,
  to,
  characterStyle = null,
  baseStyle,
}: {
  sourceText: string;
  format: ClarinTextFormat | null;
  paragraphFormat: ClarinParagraphFormat | null;
  textAlign: ExcalidrawTextElement["textAlign"];
  from: number;
  to: number;
  characterStyle?: ClarinCharacterStyle | null;
  baseStyle?: ClarinCharacterStyleBase;
}) => {
  const start = Math.max(0, Math.min(sourceText.length, Math.min(from, to)));
  const end = Math.max(start, Math.min(sourceText.length, Math.max(from, to)));
  const text = sourceText.slice(start, end);
  const runs = (format?.runs || []).flatMap((run) => {
    const runStart = Math.max(start, run.from);
    const runEnd = Math.min(end, run.to);
    return runStart < runEnd
      ? [{ from: runStart - start, to: runEnd - start, marks: run.marks }]
      : [];
  });
  const sourceParagraphStarts = getClarinParagraphStarts(sourceText);
  const sourceAlignments = getEffectiveParagraphAlignmentMap(
    paragraphFormat,
    sourceText,
    textAlign,
  );
  const paragraphAlignments = sourceParagraphStarts
    .flatMap((sourceParagraphStart, index) => {
      const sourceParagraphEnd =
        sourceParagraphStarts[index + 1] ?? sourceText.length;
      if (sourceParagraphStart < start || sourceParagraphEnd > end) {
        return [];
      }
      return [
        {
          start: sourceParagraphStart - start,
          align: sourceAlignments.get(sourceParagraphStart) ?? textAlign,
        },
      ];
    })
    .slice(0, MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT);
  const formattedParagraphStarts = paragraphAlignments.map(
    ({ start: paragraphStart }) => paragraphStart,
  );
  const clipboardParagraphFormat = createClarinParagraphFormat(
    text,
    textAlign,
    paragraphAlignments,
  );
  return {
    text,
    format: createClarinTextFormat(text, runs),
    paragraphFormat: clipboardParagraphFormat.paragraphs.length
      ? clipboardParagraphFormat
      : null,
    textAlign,
    formattedParagraphStarts,
    ...(baseStyle && validateClarinCharacterStyleBase(baseStyle) ? {
      baseStyle,
      characterStyle: createClarinCharacterStyle(text, (characterStyle?.runs || []).flatMap((run) => {
        const from = Math.max(start, run.from); const to = Math.min(end, run.to);
        return from < to ? [{ ...run, from: from - start, to: to - start }] : [];
      })),
    } : {}),
  };
};

type ParsedClarinRichTextClipboard = {
  format: ClarinTextFormat;
  paragraphFormat: ClarinParagraphFormat | null;
  textAlign: ExcalidrawTextElement["textAlign"] | null;
  formattedParagraphStarts: readonly number[];
  characterStyle?: ClarinCharacterStyle | null;
  baseStyle?: ClarinCharacterStyleBase;
};

const getEffectiveParagraphAlignmentMap = (
  format: ClarinParagraphFormat | null,
  text: string,
  textAlign: ExcalidrawTextElement["textAlign"],
) => {
  const overrides = new Map(
    format && validateClarinParagraphFormat(format, text, textAlign)
      ? format.paragraphs.map(
          ({ start, align }) => [start, align] as const,
        )
      : [],
  );
  return new Map(
    getClarinParagraphStarts(text).map(
      (start) => [start, overrides.get(start) ?? textAlign] as const,
    ),
  );
};

const createParagraphFormattingUpdate = (
  text: string,
  textAlign: ExcalidrawTextElement["textAlign"],
  effective: ReadonlyMap<number, ExcalidrawTextElement["textAlign"]>,
) => {
  const starts = getClarinParagraphStarts(text);
  const first = effective.get(starts[0]) ?? textAlign;
  if (starts.every((start) => (effective.get(start) ?? textAlign) === first)) {
    return { format: null, textAlign: first };
  }
  const format = createClarinParagraphFormat(
    text,
    textAlign,
    starts.map((start) => ({
      start,
      align: effective.get(start) ?? textAlign,
    })),
  );
  return {
    format: format.paragraphs.length ? format : null,
    textAlign,
  };
};

const validateFormattedParagraphStarts = (
  value: unknown,
  text: string,
): number[] | null => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT
  ) {
    return null;
  }
  const validStarts = new Set(getClarinParagraphStarts(text));
  const starts: number[] = [];
  let previous = -1;
  for (const candidate of value) {
    if (
      !Number.isInteger(candidate) ||
      !validStarts.has(candidate as number) ||
      (candidate as number) <= previous
    ) {
      return null;
    }
    previous = candidate as number;
    starts.push(previous);
  }
  return starts;
};

const parseClarinRichTextClipboard = (
  privateValue: string,
  text: string,
): ParsedClarinRichTextClipboard | null => {
  try {
    const parsed = JSON.parse(privateValue) as {
      version?: unknown;
      text?: unknown;
      format?: unknown;
      paragraphFormat?: unknown;
      textAlign?: unknown;
      formattedParagraphStarts?: unknown;
      characterStyle?: unknown;
      baseStyle?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.text !== text ||
      !validateClarinTextFormat(parsed.format, text)
    ) {
      return null;
    }
    const characterPayload = validateClarinCharacterStyleBase(parsed.baseStyle)
      && validateClarinCharacterStyle(parsed.characterStyle, text, parsed.baseStyle.fontSize)
      ? { characterStyle: parsed.characterStyle, baseStyle: parsed.baseStyle } : {};
    if (
      isClarinParagraphAlignment(parsed.textAlign) &&
      (parsed.paragraphFormat === null ||
        validateClarinParagraphFormat(
          parsed.paragraphFormat,
          text,
          parsed.textAlign,
        ))
    ) {
      const formattedParagraphStarts =
        parsed.formattedParagraphStarts === undefined
          ? getClarinParagraphStarts(text).slice(
              0,
              MAX_CLARIN_PARAGRAPH_ENTRIES_PER_ELEMENT,
            )
          : validateFormattedParagraphStarts(
              parsed.formattedParagraphStarts,
              text,
            );
      if (formattedParagraphStarts) {
        return {
          format: parsed.format,
          paragraphFormat: parsed.paragraphFormat,
          textAlign: parsed.textAlign,
          formattedParagraphStarts,
          ...characterPayload,
        };
      }
    }
    // Version 1 payloads written before paragraph formatting remain valid.
    return {
      format: parsed.format,
      paragraphFormat: null,
      textAlign: null,
      formattedParagraphStarts: [],
      ...characterPayload,
    };
  } catch {
    return null;
  }
};

const applyInsertedParagraphFormatting = ({
  format,
  text,
  textAlign,
  insertionStart,
  insertedText,
  insertedParagraphFormat,
  insertedTextAlign,
  insertedFormattedParagraphStarts,
}: {
  format: ClarinParagraphFormat | null;
  text: string;
  textAlign: ExcalidrawTextElement["textAlign"];
  insertionStart: number;
  insertedText: string;
  insertedParagraphFormat: ClarinParagraphFormat | null;
  insertedTextAlign: ExcalidrawTextElement["textAlign"] | null;
  insertedFormattedParagraphStarts: readonly number[];
}) => {
  if (!insertedTextAlign || !insertedFormattedParagraphStarts.length) {
    return { format, textAlign };
  }
  const effective = getEffectiveParagraphAlignmentMap(format, text, textAlign);
  const validTargetStarts = new Set(getClarinParagraphStarts(text));
  const insertedEffective = getEffectiveParagraphAlignmentMap(
    insertedParagraphFormat,
    insertedText,
    insertedTextAlign,
  );
  const boundedInsertionStart = Math.max(
    0,
    Math.min(text.length, Math.trunc(insertionStart)),
  );
  for (const paragraphStart of insertedFormattedParagraphStarts) {
    const targetStart = boundedInsertionStart + paragraphStart;
    if (!validTargetStarts.has(targetStart)) {
      continue;
    }
    effective.set(
      targetStart,
      insertedEffective.get(paragraphStart) ?? insertedTextAlign,
    );
  }
  return createParagraphFormattingUpdate(text, textAlign, effective);
};

const isClarinCompositionInput = (
  inputType: string,
  eventIsComposing: boolean,
  editorIsComposing: boolean,
) =>
  editorIsComposing ||
  eventIsComposing ||
  inputType.toLowerCase().includes("composition");

export const CLARIN_TEXT_WYSIWYG_TEST_API = {
  applyInsertedParagraphFormatting,
  createTargetRangeSelection,
  createClarinRichTextClipboardSelection,
  getEditablePlainText,
  getEditableSelection,
  getEditableSelectionOffset,
  installEditableTextAPI,
  isClarinCompositionInput,
  parseClarinRichTextClipboard,
  renderEditableRichText,
  setEditableSelection,
};

const getTransform = (
  width: number,
  height: number,
  angle: number,
  appState: AppState,
  maxWidth: number,
  maxHeight: number,
) => {
  const { zoom } = appState;
  const degree = (180 * angle) / Math.PI;
  let translateX = (width * (zoom.value - 1)) / 2;
  let translateY = (height * (zoom.value - 1)) / 2;
  if (width > maxWidth && zoom.value !== 1) {
    translateX = (maxWidth * (zoom.value - 1)) / 2;
  }
  if (height > maxHeight && zoom.value !== 1) {
    translateY = (maxHeight * (zoom.value - 1)) / 2;
  }
  return `translate(${translateX}px, ${translateY}px) scale(${zoom.value}) rotate(${degree}deg)`;
};

export const textWysiwyg = ({
  id,
  onChange,
  onSubmit,
  getViewportCoords,
  element,
  canvas,
  excalidrawContainer,
  app,
  autoSelect = true,
}: {
  id: ExcalidrawElement["id"];
  /**
   * textWysiwyg only deals with `originalText`
   *
   * Note: `text`, which can be wrapped and therefore different from `originalText`,
   *       is derived from `originalText`
   */
  onChange?: (
    nextOriginalText: string,
    clarinTextFormat: ClarinTextFormat | null,
    clarinParagraphFormat: ClarinParagraphFormat | null,
    textAlign: ExcalidrawTextElement["textAlign"],
    clarinCharacterStyle: ClarinCharacterStyle | null,
  ) => void;
  onSubmit: (data: {
    viaKeyboard: boolean;
    nextOriginalText: string;
    clarinTextFormat: ClarinTextFormat | null;
    clarinParagraphFormat: ClarinParagraphFormat | null;
    textAlign: ExcalidrawTextElement["textAlign"];
    clarinCharacterStyle: ClarinCharacterStyle | null;
  }) => void;
  getViewportCoords: (x: number, y: number) => [number, number];
  element: ExcalidrawTextElement;
  canvas: HTMLCanvasElement;
  excalidrawContainer: HTMLDivElement | null;
  app: App;
  autoSelect?: boolean;
}) => {
  const textPropertiesUpdated = (
    updatedTextElement: ExcalidrawTextElement,
    editable: RichTextEditable,
  ) => {
    if (!editable.style.fontFamily || !editable.style.fontSize) {
      return false;
    }
    const currentFont = editable.style.fontFamily.replace(/"/g, "");
    if (
      getFontFamilyString({ fontFamily: updatedTextElement.fontFamily }) !==
      currentFont
    ) {
      return true;
    }
    if (`${updatedTextElement.fontSize}px` !== editable.style.fontSize) {
      return true;
    }
    return false;
  };

  const updateWysiwygStyle = () => {
    const appState = app.state;
    const updatedTextElement =
      Scene.getScene(element)?.getElement<ExcalidrawTextElement>(id);

    if (!updatedTextElement) {
      return;
    }
    const { textAlign, verticalAlign } = updatedTextElement;
    const elementsMap = app.scene.getNonDeletedElementsMap();
    if (updatedTextElement && isTextElement(updatedTextElement)) {
      let coordX = updatedTextElement.x;
      let coordY = updatedTextElement.y;
      const container = getContainerElement(
        updatedTextElement,
        app.scene.getNonDeletedElementsMap(),
      );

      let width = updatedTextElement.width;

      // set to element height by default since that's
      // what is going to be used for unbounded text
      let height = updatedTextElement.height;

      let maxWidth = updatedTextElement.width;
      let maxHeight = updatedTextElement.height;

      if (container && updatedTextElement.containerId) {
        if (isArrowElement(container)) {
          const boundTextCoords =
            LinearElementEditor.getBoundTextElementPosition(
              container,
              updatedTextElement as ExcalidrawTextElementWithContainer,
              elementsMap,
            );
          coordX = boundTextCoords.x;
          coordY = boundTextCoords.y;
        }
        const propertiesUpdated = textPropertiesUpdated(
          updatedTextElement,
          editable,
        );

        let originalContainerData;
        if (propertiesUpdated) {
          originalContainerData = updateOriginalContainerCache(
            container.id,
            container.height,
          );
        } else {
          originalContainerData = originalContainerCache[container.id];
          if (!originalContainerData) {
            originalContainerData = updateOriginalContainerCache(
              container.id,
              container.height,
            );
          }
        }

        maxWidth = getBoundTextMaxWidth(container, updatedTextElement);

        maxHeight = getBoundTextMaxHeight(
          container,
          updatedTextElement as ExcalidrawTextElementWithContainer,
        );

        // autogrow container height if text exceeds
        if (!isArrowElement(container) && height > maxHeight) {
          const targetContainerHeight = computeContainerDimensionForBoundText(
            height,
            container.type,
          );

          mutateElement(container, { height: targetContainerHeight });
          return;
        } else if (
          // autoshrink container height until original container height
          // is reached when text is removed
          !isArrowElement(container) &&
          container.height > originalContainerData.height &&
          height < maxHeight
        ) {
          const targetContainerHeight = computeContainerDimensionForBoundText(
            height,
            container.type,
          );
          mutateElement(container, { height: targetContainerHeight });
        } else {
          const { y } = computeBoundTextPosition(
            container,
            updatedTextElement as ExcalidrawTextElementWithContainer,
            elementsMap,
          );
          coordY = y;
        }
      }
      const [viewportX, viewportY] = getViewportCoords(coordX, coordY);
      const initialSelectionStart = editable.selectionStart;
      const initialSelectionEnd = editable.selectionEnd;
      const initialLength = editable.value.length;

      // restore cursor position after value updated so it doesn't
      // go to the end of text when container auto expanded
      if (
        initialSelectionStart === initialSelectionEnd &&
        initialSelectionEnd !== initialLength
      ) {
        // get diff between length and selection end and shift
        // the cursor by "diff" times to position correctly
        const diff = initialLength - initialSelectionEnd;
        editable.selectionStart = editable.value.length - diff;
        editable.selectionEnd = editable.value.length - diff;
      }

      if (!container) {
        maxWidth = (appState.width - 8 - viewportX) / appState.zoom.value;
        width = Math.min(width, maxWidth);
      } else {
        width += 0.5;
      }

      // add 5% buffer otherwise it causes wysiwyg to jump
      height *= 1.05;

      const font = getFontString(updatedTextElement);

      // Make sure text editor height doesn't go beyond viewport
      const editorMaxHeight =
        (appState.height - viewportY) / appState.zoom.value;
      Object.assign(editable.style, {
        font,
        // must be defined *after* font ¯\_(ツ)_/¯
        lineHeight: updatedTextElement.lineHeight,
        width: `${width}px`,
        height: `${height}px`,
        left: `${viewportX}px`,
        top: `${viewportY}px`,
        transform: getTransform(
          width,
          height,
          getTextElementAngle(updatedTextElement, container),
          appState,
          maxWidth,
          editorMaxHeight,
        ),
        textAlign,
        verticalAlign,
        color: updatedTextElement.strokeColor,
        opacity: updatedTextElement.opacity / 100,
        filter: "var(--theme-filter)",
        maxHeight: `${editorMaxHeight}px`,
      });
      editable.style.setProperty(
        "--clarin-wysiwyg-font-size",
        `${updatedTextElement.fontSize}px`,
      );
      editable.scrollTop = 0;
      // For some reason updating font attribute doesn't set font family
      // hence updating font family explicitly for test environment
      if (isTestEnv()) {
        editable.style.fontFamily = getFontFamilyString(updatedTextElement);
      }

      mutateElement(updatedTextElement, { x: coordX, y: coordY });
    }
  };

  const editable = installEditableTextAPI(document.createElement("div"));

  editable.dir = "auto";
  editable.contentEditable = "true";
  editable.setAttribute("role", "textbox");
  editable.setAttribute("aria-multiline", "true");
  editable.tabIndex = 0;
  editable.dataset.type = "wysiwyg";
  editable.classList.add("excalidraw-wysiwyg");

  let whiteSpace = "pre";
  let wordBreak = "normal";

  if (isBoundToContainer(element) || !element.autoResize) {
    whiteSpace = "pre-wrap";
    wordBreak = "break-word";
  }
  Object.assign(editable.style, {
    position: "absolute",
    display: "inline-block",
    minHeight: "1em",
    backfaceVisibility: "hidden",
    margin: 0,
    padding: 0,
    border: 0,
    outline: 0,
    resize: "none",
    background: "transparent",
    overflow: "hidden",
    // must be specified because in dark mode canvas creates a stacking context
    zIndex: "var(--zIndex-wysiwyg)",
    wordBreak,
    // prevent line wrapping (`whitespace: nowrap` doesn't work on FF)
    whiteSpace,
    overflowWrap: "break-word",
    boxSizing: "content-box",
  });
  let currentFormat = getClarinTextFormat(element);
  let currentCharacterStyle = getClarinCharacterStyle(element);
  let currentParagraphFormat = getClarinParagraphFormat(element);
  let currentTextAlign = element.textAlign;
  let lastValue = element.originalText;
  let pendingMarks = getClarinMarksAtCaret(currentFormat, lastValue.length);
  let pendingMarksExplicit = false;
  let pendingMarksOffset: number | null = null;
  let pendingCharacterStyle = getClarinCharacterStyleAtCaret(currentCharacterStyle, lastValue, lastValue.length);
  let pendingCharacterStyleExplicit = false;
  let pendingCharacterStyleOffset: number | null = null;
  let characterFocusFrame: number | null = null;
  const currentBaseStyle = () => app.scene.getElement<ExcalidrawTextElement>(id) ?? element;
  const clipboardBaseStyle = (): ClarinCharacterStyleBase => {
    const base = currentBaseStyle();
    return { color: base.strokeColor.toUpperCase(), fontSize: base.fontSize, fontFamily: base.fontFamily };
  };
  const renderCurrentEditable = (selection?: EditableSelection) => renderEditableRichText(
    editable, lastValue, currentFormat, currentParagraphFormat, currentTextAlign,
    selection, currentCharacterStyle, currentBaseStyle(),
  );
  let isComposing = false;
  let lastSelection: EditableSelection = createEditableSelection(lastValue.length);
  let commandSelection: EditableSelection | null = null;
  let compositionStart: {
    text: string;
    format: ClarinTextFormat | null;
    selection: EditableSelection;
    pendingMarks: number;
    pendingMarksExplicit: boolean;
    pendingMarksOffset: number | null;
    paragraphFormat: ClarinParagraphFormat | null;
    textAlign: ExcalidrawTextElement["textAlign"];
    characterStyle: ClarinCharacterStyle | null;
    pendingCharacterStyle: ClarinCharacterStyleValues;
    pendingCharacterStyleExplicit: boolean;
    pendingCharacterStyleOffset: number | null;
  } | null = null;
  const getCurrentSelection = () =>
    getEditableSelection(editable) ?? lastSelection;
  type EditorHistoryEntry = {
    text: string;
    format: ClarinTextFormat | null;
    paragraphFormat: ClarinParagraphFormat | null;
    textAlign: ExcalidrawTextElement["textAlign"];
    selection: EditableSelection;
    pendingMarks: number;
    pendingMarksExplicit: boolean;
    pendingMarksOffset: number | null;
    characterStyle: ClarinCharacterStyle | null;
    pendingCharacterStyle: ClarinCharacterStyleValues;
    pendingCharacterStyleExplicit: boolean;
    pendingCharacterStyleOffset: number | null;
  };
  const undoStack: EditorHistoryEntry[] = [];
  const redoStack: EditorHistoryEntry[] = [];
  const historyEntry = (
    selection: EditableSelection = lastSelection,
  ): EditorHistoryEntry => ({
    text: lastValue,
    format: currentFormat
      ? {
          ...currentFormat,
          runs: currentFormat.runs.map((run) => ({ ...run })),
        }
      : null,
    paragraphFormat: currentParagraphFormat
      ? {
          ...currentParagraphFormat,
          paragraphs: currentParagraphFormat.paragraphs.map((paragraph) => ({
            ...paragraph,
          })),
        }
      : null,
    textAlign: currentTextAlign,
    selection,
    pendingMarks,
    pendingMarksExplicit,
    pendingMarksOffset,
    characterStyle: currentCharacterStyle ? { ...currentCharacterStyle, runs: currentCharacterStyle.runs.map((run) => ({ ...run })) } : null,
    pendingCharacterStyle: { ...pendingCharacterStyle },
    pendingCharacterStyleExplicit,
    pendingCharacterStyleOffset,
  });
  const pushHistory = (selection?: EditableSelection) => {
    undoStack.push(historyEntry(selection));
    if (undoStack.length > 200) {
      undoStack.shift();
    }
    redoStack.length = 0;
  };
  const restoreStateEntry = (entry: EditorHistoryEntry) => {
    lastValue = entry.text; currentFormat = entry.format; currentParagraphFormat = entry.paragraphFormat;
    currentTextAlign = entry.textAlign; currentCharacterStyle = entry.characterStyle;
    pendingMarks = entry.pendingMarks; pendingMarksExplicit = entry.pendingMarksExplicit; pendingMarksOffset = entry.pendingMarksOffset;
    pendingCharacterStyle = entry.pendingCharacterStyle; pendingCharacterStyleExplicit = entry.pendingCharacterStyleExplicit;
    pendingCharacterStyleOffset = entry.pendingCharacterStyleOffset; lastSelection = entry.selection;
  };
  const rejectTextMutation = (previous: EditorHistoryEntry, error: unknown) => {
    restoreStateEntry(previous);
    renderCurrentEditable(previous.selection);
    app.setState({ errorMessage: error instanceof Error ? error.message : "No se pudo aplicar el cambio al texto." });
  };
  const recordHistoryEntry = (entry: EditorHistoryEntry) => {
    undoStack.push(entry);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  };
  renderCurrentEditable();
  updateWysiwygStyle();

  const emitChange = () => {
    onChange?.(
      lastValue,
      currentFormat?.runs.length ? currentFormat : null,
      currentParagraphFormat?.paragraphs.length
        ? currentParagraphFormat
        : null,
      currentTextAlign,
      currentCharacterStyle?.runs.length ? currentCharacterStyle : null,
    );
  };

  type TextReplacement = {
    from: number;
    to: number;
    insertedText: string;
    insertedFormat?: ClarinTextFormat | null;
    insertedParagraphFormat?: ClarinParagraphFormat | null;
    insertedTextAlign?: ExcalidrawTextElement["textAlign"] | null;
    insertedFormattedParagraphStarts?: readonly number[];
    insertedMarks?: number;
    insertedCharacterStyle?: ClarinCharacterStyle | null;
  };

  const applyTextReplacementToState = ({
    from,
    to,
    insertedText,
    insertedFormat = null,
    insertedParagraphFormat = null,
    insertedTextAlign = null,
    insertedFormattedParagraphStarts = [],
    insertedMarks = pendingMarks,
    insertedCharacterStyle = null,
  }: TextReplacement) => {
    const normalizedInsertedText = normalizeText(insertedText);
    const insertionStart = Math.max(0, Math.min(lastValue.length, Math.min(from, to)));
    const paragraphResult = applyClarinParagraphTextEdit({
      format: currentParagraphFormat,
      previousText: lastValue,
      textAlign: currentTextAlign,
      edit: { from, to, insertedText: normalizedInsertedText },
    });
    const result = replaceClarinTextRange({
      format: currentFormat,
      text: lastValue,
      from,
      to,
      insertedText: normalizedInsertedText,
      insertedMarks,
      insertedFormat,
    });
    currentCharacterStyle = replaceClarinCharacterStyleRange({
      format: currentCharacterStyle, text: lastValue, from, to,
      insertedText: normalizedInsertedText, insertedStyle: pendingCharacterStyle,
      insertedFormat: insertedCharacterStyle,
    });
    currentFormat = result.format;
    lastValue = result.text;
    const pastedParagraphs = applyInsertedParagraphFormatting({
      format: paragraphResult.format,
      text: lastValue,
      textAlign: paragraphResult.textAlign,
      insertionStart,
      insertedText: normalizedInsertedText,
      insertedParagraphFormat,
      insertedTextAlign,
      insertedFormattedParagraphStarts,
    });
    currentParagraphFormat = pastedParagraphs.format;
    currentTextAlign = pastedParagraphs.textAlign;
    return normalizedInsertedText.length;
  };

  const commitTextReplacement = ({
    from,
    to,
    insertedText,
    insertedFormat = null,
    insertedParagraphFormat = null,
    insertedTextAlign = null,
    insertedFormattedParagraphStarts = [],
    selection,
    historySelection,
    captureHistory = true,
    insertedCharacterStyle = null,
  }: {
    from: number;
    to: number;
    insertedText: string;
    insertedFormat?: ClarinTextFormat | null;
    insertedParagraphFormat?: ClarinParagraphFormat | null;
    insertedTextAlign?: ExcalidrawTextElement["textAlign"] | null;
    insertedFormattedParagraphStarts?: readonly number[];
    selection?: EditableSelection;
    historySelection?: EditableSelection;
    captureHistory?: boolean;
    insertedCharacterStyle?: ClarinCharacterStyle | null;
  }) => {
    const previous = historyEntry(historySelection ?? createEditableSelection(from, to));
    let insertedLength: number;
    try { insertedLength = applyTextReplacementToState({
      from,
      to,
      insertedText,
      insertedFormat,
      insertedParagraphFormat,
      insertedTextAlign,
      insertedFormattedParagraphStarts,
      insertedCharacterStyle,
    }); } catch (error) { rejectTextMutation(previous, error); return; }
    if (captureHistory) recordHistoryEntry(previous);
    const caret = Math.min(from, to) + insertedLength;
    const nextSelection = selection || createEditableSelection(caret);
    lastSelection = nextSelection;
    renderCurrentEditable(nextSelection);
    emitChange();
    publishClarinRichTextState();
  };

  const commitTextReplacements = (
    replacements: readonly TextReplacement[],
    nextSelection: EditableSelection,
  ) => {
    if (!replacements.length) {
      return;
    }
    const previous = historyEntry(getCurrentSelection());
    try {
      for (const replacement of [...replacements].sort(
        (left, right) => right.from - left.from || right.to - left.to,
      )) applyTextReplacementToState(replacement);
    } catch (error) { rejectTextMutation(previous, error); return; }
    recordHistoryEntry(previous);
    lastSelection = nextSelection;
    renderCurrentEditable(nextSelection);
    emitChange();
    publishClarinRichTextState();
  };

  const replaceSelection = (
    insertedText: string,
    insertedFormat: ClarinTextFormat | null = null,
    insertedParagraphFormat: ClarinParagraphFormat | null = null,
    insertedTextAlign: ExcalidrawTextElement["textAlign"] | null = null,
    insertedFormattedParagraphStarts: readonly number[] = [],
    insertedCharacterStyle: ClarinCharacterStyle | null = null,
  ) => {
    const selection = getCurrentSelection();
    const [from, to] = selection;
    commitTextReplacement({
      from,
      to,
      insertedText,
      insertedFormat,
      insertedParagraphFormat,
      insertedTextAlign,
      insertedFormattedParagraphStarts,
      insertedCharacterStyle,
      historySelection: selection,
    });
  };

  const selectedClipboardPayload = () => {
    const [from, to] = getCurrentSelection();
    if (from === to) {
      return null;
    }
    return createClarinRichTextClipboardSelection({
      sourceText: lastValue,
      format: currentFormat,
      paragraphFormat: currentParagraphFormat,
      textAlign: currentTextAlign,
      from,
      to,
      characterStyle: currentCharacterStyle,
      baseStyle: clipboardBaseStyle(),
    });
  };

  const writeClipboardSelection = (event: ClipboardEvent) => {
    const selected = selectedClipboardPayload();
    if (!selected || !event.clipboardData) {
      return false;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", selected.text);
    event.clipboardData.setData(
      CLARIN_RICH_TEXT_CLIPBOARD_TYPE,
      JSON.stringify({ version: 1, ...selected }),
    );
    return true;
  };

  const getBeforeInputSelection = (event: InputEvent): EditableSelection => {
    const currentSelection = getCurrentSelection();
    const targetRanges = event.getTargetRanges?.() || [];
    const targetRange = targetRanges[0];
    if (
      targetRange &&
      editable.contains(targetRange.startContainer) &&
      editable.contains(targetRange.endContainer)
    ) {
      const start = getEditableSelectionOffset(
        editable,
        targetRange.startContainer,
        targetRange.startOffset,
      );
      const end = getEditableSelectionOffset(
        editable,
        targetRange.endContainer,
        targetRange.endOffset,
      );
      return createTargetRangeSelection(start, end, currentSelection);
    }
    return currentSelection;
  };

  const getDeletionSelection = (
    inputType: string,
    selection: EditableSelection,
  ): EditableSelection => {
    const [from, to] = selection;
    if (from !== to) {
      return selection;
    }
    const backward = inputType.endsWith("Backward");
    const forward = inputType.endsWith("Forward");
    if (!backward && !forward) {
      return selection;
    }
    if (inputType.includes("Word")) {
      if (backward) {
        const prefix = lastValue.slice(0, from);
        const match = prefix.match(/(?:\s+|[^\s]+)$/u);
        return [from - (match?.[0].length || 0), from];
      }
      const suffix = lastValue.slice(to);
      const match = suffix.match(/^(?:\s+|[^\s]+)/u);
      return [to, to + (match?.[0].length || 0)];
    }
    if (inputType.includes("Line") || inputType.includes("Paragraph")) {
      if (backward) {
        const lineStart = lastValue.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
        return [lineStart === from && from > 0 ? from - 1 : lineStart, from];
      }
      const lineEnd = lastValue.indexOf("\n", to);
      return [to, lineEnd < 0 ? lastValue.length : lineEnd + 1];
    }
    const boundaries = getGraphemeBoundaries(lastValue);
    if (backward) {
      const previous = [...boundaries].reverse().find((boundary) => boundary < from);
      return [previous ?? from, from];
    }
    const next = boundaries.find((boundary) => boundary > to);
    return [to, next ?? to];
  };

  if (onChange) {
    editable.oncopy = (event) => {
      writeClipboardSelection(event);
    };
    editable.oncut = (event) => {
      if (writeClipboardSelection(event)) {
        replaceSelection("");
      }
    };
    editable.onpaste = (event) => {
      event.preventDefault();
      const data = normalizeText(
        event.clipboardData?.getData("text/plain") || "",
      );
      if (!data) {
        return;
      }
      let insertedFormat: ClarinTextFormat | null = null;
      let insertedParagraphFormat: ClarinParagraphFormat | null = null;
      let insertedTextAlign: ExcalidrawTextElement["textAlign"] | null = null;
      let insertedFormattedParagraphStarts: readonly number[] = [];
      let insertedCharacterStyle: ClarinCharacterStyle | null = null;
      const privateValue = event.clipboardData?.getData(
        CLARIN_RICH_TEXT_CLIPBOARD_TYPE,
      );
      if (privateValue) {
        const parsed = parseClarinRichTextClipboard(privateValue, data);
        if (parsed) {
          insertedFormat = parsed.format;
          insertedParagraphFormat = parsed.paragraphFormat;
          insertedTextAlign = parsed.textAlign;
          insertedFormattedParagraphStarts = parsed.formattedParagraphStarts;
          if (parsed.baseStyle) {
            try { insertedCharacterStyle = rebaseClarinCharacterStyle(
              data, parsed.characterStyle ?? null, parsed.baseStyle, clipboardBaseStyle(),
            ); } catch (error) { rejectTextMutation(historyEntry(), error); return; }
          }
        }
      }
      replaceSelection(
        data,
        insertedFormat,
        insertedParagraphFormat,
        insertedTextAlign,
        insertedFormattedParagraphStarts,
        insertedCharacterStyle,
      );
    };
    editable.onbeforeinput = (event) => {
      if (
        isClarinCompositionInput(
          event.inputType,
          event.isComposing,
          isComposing,
        )
      ) {
        return;
      }
      if (event.inputType.startsWith("delete")) {
        const deletionSelection = getDeletionSelection(
          event.inputType,
          getBeforeInputSelection(event),
        );
        const [from, to] = deletionSelection;
        if (from !== to) {
          event.preventDefault();
          commitTextReplacement({
            from,
            to,
            insertedText: "",
            historySelection: deletionSelection,
          });
        }
        return;
      }
      const insertedText = getClarinBeforeInputText({
        inputType: event.inputType,
        data: event.data,
        isComposing: event.isComposing,
      });
      if (insertedText !== null) {
        event.preventDefault();
        replaceSelection(insertedText);
      }
    };
    editable.oncompositionstart = () => {
      isComposing = true;
      const selection = getCurrentSelection();
      compositionStart = {
        text: lastValue,
        format: currentFormat,
        selection,
        pendingMarks,
        pendingMarksExplicit,
        pendingMarksOffset,
        paragraphFormat: currentParagraphFormat,
        textAlign: currentTextAlign,
        characterStyle: currentCharacterStyle,
        pendingCharacterStyle: { ...pendingCharacterStyle },
        pendingCharacterStyleExplicit,
        pendingCharacterStyleOffset,
      };
    };
    editable.oncompositionend = () => {
      isComposing = false;
      const canonicalStructure = hasCanonicalEditableStructure(editable);
      const domSelection = canonicalStructure
        ? getEditableSelection(editable)
        : null;
      const nextValue = normalizeText(editable.value);
      const start = compositionStart;
      compositionStart = null;
      if (start && nextValue !== start.text) {
        pushHistory(start.selection);
        currentFormat = start.format;
        currentParagraphFormat = start.paragraphFormat;
        currentTextAlign = start.textAlign;
        lastValue = start.text;
        pendingMarks = start.pendingMarks;
        pendingMarksExplicit = start.pendingMarksExplicit;
        pendingMarksOffset = start.pendingMarksOffset;
        currentCharacterStyle = start.characterStyle;
        pendingCharacterStyle = start.pendingCharacterStyle;
        pendingCharacterStyleExplicit = start.pendingCharacterStyleExplicit;
        pendingCharacterStyleOffset = start.pendingCharacterStyleOffset;
        const suffixLength = start.text.length - start.selection[1];
        const insertedTo = Math.max(
          start.selection[0],
          nextValue.length - suffixLength,
        );
        const insertedText = nextValue.slice(
          start.selection[0],
          insertedTo,
        );
        commitTextReplacement({
          from: start.selection[0],
          to: start.selection[1],
          insertedText,
          selection:
            domSelection ??
            createEditableSelection(
              start.selection[0] + insertedText.length,
            ),
          captureHistory: false,
        });
      } else {
        renderCurrentEditable(domSelection ?? start?.selection ?? lastSelection);
      }
    };
    editable.oninput = () => {
      if (isComposing) {
        return;
      }
      const canonicalStructure = hasCanonicalEditableStructure(editable);
      const domSelection = canonicalStructure
        ? getEditableSelection(editable)
        : null;
      const nextValue = normalizeText(editable.value);
      if (nextValue === lastValue) {
        return;
      }
      // A browser path not covered by beforeinput is reconciled against the
      // last valid selection instead of a content-based prefix/suffix guess.
      const suffixLength = lastValue.length - lastSelection[1];
      const insertedTo = Math.max(
        lastSelection[0],
        nextValue.length - suffixLength,
      );
      const insertedText = nextValue.slice(lastSelection[0], insertedTo);
      commitTextReplacement({
        from: lastSelection[0],
        to: lastSelection[1],
        insertedText,
        selection:
          domSelection ??
          createEditableSelection(lastSelection[0] + insertedText.length),
        historySelection: lastSelection,
      });
    };
  }

  const consumeCommandSelection = () => {
    const selection = commandSelection ?? getCurrentSelection();
    commandSelection = null;
    return selection;
  };
  const readCharacterState = (property: "color" | "fontFamily" | "fontSize"): string | number => {
    const [from, to] = commandSelection ?? getCurrentSelection();
    const base = currentBaseStyle();
    const elementStyle = { ...base, originalText: lastValue };
    if (from === to) {
      return property === "color" ? pendingCharacterStyle.color ?? base.strokeColor.toUpperCase()
        : property === "fontFamily" ? pendingCharacterStyle.fontFamily ?? base.fontFamily
        : base.fontSize * (pendingCharacterStyle.fontScale ?? 1);
    }
    const points = new Set([from, to]);
    for (const run of currentCharacterStyle?.runs || []) if (run.from < to && from < run.to) {
      points.add(Math.max(from, run.from)); points.add(Math.min(to, run.to));
    }
    const values = [...points].filter((point) => point < to).map((point) =>
      getClarinEffectiveCharacterStyle(elementStyle, point, currentCharacterStyle)[property]);
    return values.every((value) => value === values[0]) ? values[0] : "mixed";
  };
  const restoreCharacterSelection = (selection: EditableSelection) => {
    lastSelection = selection;
    editable.focus({ preventScroll: true });
    renderCurrentEditable(selection);
    if (characterFocusFrame !== null) cancelAnimationFrame(characterFocusFrame);
    // Radix closes the picker after the action returns. Restore after its
    // focus scope has unmounted, rather than letting it retake editor focus.
    if (app.state.openPopup) characterFocusFrame = requestAnimationFrame(() => {
      characterFocusFrame = null;
      if (!isDestroyed) { editable.focus({ preventScroll: true }); setEditableSelection(editable, selection[0], selection[1], getEditableSelectionDirection(selection)); }
    });
  };

  const richTextController = {
    elementId: id,
    captureSelection: () => {
      temporarilyDisableSubmit();
      const selection = getEditableSelection(editable);
      if (selection) {
        lastSelection = selection;
        commandSelection = selection;
        if (selection[0] === selection[1] && (!pendingCharacterStyleExplicit || pendingCharacterStyleOffset !== selection[0])) {
          pendingCharacterStyle = getClarinCharacterStyleAtCaret(currentCharacterStyle, lastValue, selection[0]);
          pendingCharacterStyleExplicit = false; pendingCharacterStyleOffset = null;
        }
      }
    },
    toggleMark: (mark: ClarinTextMark) => {
      const selection = consumeCommandSelection();
      const [from, to] = selection;
      pushHistory(selection);
      if (from === to) {
        pendingMarks ^= mark;
        pendingMarksExplicit = true;
        pendingMarksOffset = from;
      } else {
        pendingMarksExplicit = false;
        pendingMarksOffset = null;
        currentFormat = toggleClarinTextMark(
          currentFormat,
          lastValue,
          from,
          to,
          mark,
        );
        renderCurrentEditable(selection);
        emitChange();
      }
      publishClarinRichTextState();
    },
    getMarkState: (mark: ClarinTextMark) => {
      const [from, to] = commandSelection ?? getCurrentSelection();
      if (from === to) {
        return pendingMarks & mark ? ("on" as const) : ("off" as const);
      }
      return getClarinMarkState(currentFormat, lastValue, from, to, mark);
    },
    getCharacterStyleState: readCharacterState,
    restoreSelection: () => restoreCharacterSelection(consumeCommandSelection()),
    setCharacterStyle: (property: "color" | "fontFamily" | "fontSize", value: string | number) => {
      const normalized = property === "color" && typeof value === "string" ? value.toUpperCase() : value;
      if ((property === "color" && !isClarinCharacterColor(normalized))
        || (property === "fontFamily" && !isClarinCharacterFontFamily(normalized))
        || (property === "fontSize" && (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 1))) return;
      const unchanged = readCharacterState(property) === normalized;
      const selection = consumeCommandSelection();
      if (unchanged) { restoreCharacterSelection(selection); return; }
      const base = currentBaseStyle();
      const patch: ClarinCharacterStyleValues = property === "color"
        ? { color: normalized === base.strokeColor.toUpperCase() ? undefined : normalized as string }
        : property === "fontFamily" ? { fontFamily: normalized === base.fontFamily ? undefined : normalized as number }
        : { fontScale: (normalized as number) / base.fontSize };
      let next = currentCharacterStyle;
      if (selection[0] !== selection[1]) {
        try { next = setClarinCharacterStyle(currentCharacterStyle, lastValue, selection[0], selection[1], patch); }
        catch (error) { app.setState({ errorMessage: error instanceof Error ? error.message : "No se pudo aplicar el formato." }); return; }
      }
      pushHistory(selection);
      if (selection[0] === selection[1]) {
        pendingCharacterStyle = { ...pendingCharacterStyle, ...patch };
        pendingCharacterStyleExplicit = true;
        pendingCharacterStyleOffset = selection[0];
      } else {
        currentCharacterStyle = next;
        pendingCharacterStyleExplicit = false; pendingCharacterStyleOffset = null;
        emitChange();
      }
      restoreCharacterSelection(selection);
      publishClarinRichTextState();
    },
    scaleFontSize: (factor: number) => {
      if (!Number.isFinite(factor) || factor <= 0) return;
      const selection = consumeCommandSelection();
      const [from, to] = selection;
      const base = currentBaseStyle();
      if (from === to) {
        const size = Math.max(1, Math.round(base.fontSize * (pendingCharacterStyle.fontScale ?? 1) * factor));
        commandSelection = selection;
        richTextController.setCharacterStyle("fontSize", size);
        return;
      }
      const elementStyle = { ...base, originalText: lastValue, customData: { clarinCharacterStyle: currentCharacterStyle } };
      const points = getClarinCharacterStylePoints(elementStyle, from, to);
      let next = currentCharacterStyle;
      try {
        for (let index = 0; index < points.length - 1; index++) {
          const size = getClarinEffectiveCharacterStyle(elementStyle, points[index], currentCharacterStyle).fontSize;
          next = setClarinCharacterStyle(next, lastValue, points[index], points[index + 1], { fontScale: Math.max(1, Math.round(size * factor)) / base.fontSize });
        }
      } catch (error) { rejectTextMutation(historyEntry(selection), error); return; }
      if (JSON.stringify(next?.runs) !== JSON.stringify(currentCharacterStyle?.runs)) {
        pushHistory(selection); currentCharacterStyle = next; emitChange();
      }
      restoreCharacterSelection(selection); publishClarinRichTextState();
    },
    setParagraphAlignment: (align: ExcalidrawTextElement["textAlign"]) => {
      const selection = consumeCommandSelection();
      const [from, to] = selection;
      if (
        getClarinParagraphAlignmentState(
          currentParagraphFormat,
          lastValue,
          currentTextAlign,
          from,
          to,
        ) === align
      ) {
        return;
      }
      pushHistory(selection);
      const result = setClarinParagraphAlignment({
        format: currentParagraphFormat,
        text: lastValue,
        textAlign: currentTextAlign,
        from,
        to,
        align,
      });
      currentParagraphFormat = result.format;
      currentTextAlign = result.textAlign;
      renderCurrentEditable(selection);
      emitChange();
      publishClarinRichTextState();
    },
    getParagraphAlignmentState: () => {
      const [from, to] = commandSelection ?? getCurrentSelection();
      return getClarinParagraphAlignmentState(
        currentParagraphFormat,
        lastValue,
        currentTextAlign,
        from,
        to,
      );
    },
  };
  if (app.props.enableRichText) {
    setActiveClarinRichTextEditor(richTextController);
  }

  const onDocumentSelectionChange = () => {
    const selection = window.getSelection();
    if (
      selection?.anchorNode &&
      selection.focusNode &&
      editable.contains(selection.anchorNode) &&
      editable.contains(selection.focusNode)
    ) {
      const editableSelection = getEditableSelection(editable);
      if (!editableSelection) {
        return;
      }
      const [from, to] = editableSelection;
      lastSelection = editableSelection;
      if (from === to) {
        if (!pendingMarksExplicit || pendingMarksOffset !== from) {
          pendingMarks = getClarinMarksAtCaret(currentFormat, from);
          pendingMarksExplicit = false;
          pendingMarksOffset = null;
        }
        if (!pendingCharacterStyleExplicit || pendingCharacterStyleOffset !== from) {
          pendingCharacterStyle = getClarinCharacterStyleAtCaret(currentCharacterStyle, lastValue, from);
          pendingCharacterStyleExplicit = false; pendingCharacterStyleOffset = null;
        }
      } else {
        pendingMarksExplicit = false;
        pendingMarksOffset = null;
        pendingCharacterStyleExplicit = false; pendingCharacterStyleOffset = null;
      }
      publishClarinRichTextState();
    }
  };
  document.addEventListener("selectionchange", onDocumentSelectionChange);

  const restoreEditorHistory = (direction: "undo" | "redo") => {
    const source = direction === "undo" ? undoStack : redoStack;
    const destination = direction === "undo" ? redoStack : undoStack;
    const entry = source.pop();
    if (!entry) {
      return;
    }
    destination.push(historyEntry(getCurrentSelection()));
    lastValue = entry.text;
    currentFormat = entry.format;
    currentParagraphFormat = entry.paragraphFormat;
    currentTextAlign = entry.textAlign;
    pendingMarks = entry.pendingMarks;
    pendingMarksExplicit = entry.pendingMarksExplicit;
    pendingMarksOffset = entry.pendingMarksOffset;
    currentCharacterStyle = entry.characterStyle;
    pendingCharacterStyle = entry.pendingCharacterStyle;
    pendingCharacterStyleExplicit = entry.pendingCharacterStyleExplicit;
    pendingCharacterStyleOffset = entry.pendingCharacterStyleOffset;
    commandSelection = null;
    lastSelection = entry.selection;
    renderCurrentEditable(entry.selection);
    emitChange();
    publishClarinRichTextState();
  };

  editable.onkeydown = (event) => {
    if (isComposing || event.isComposing || event.keyCode === 229) {
      return;
    }
    commandSelection = null;
    const key = event.key.toLowerCase();
    const historyDirection = event[KEYS.CTRL_OR_CMD]
      ? key === "z"
        ? event.shiftKey
          ? "redo"
          : "undo"
        : key === "y" && !event.shiftKey
        ? "redo"
        : null
      : null;
    const shortcutMark = event[KEYS.CTRL_OR_CMD]
      ? key === "b" && !event.shiftKey
        ? CLARIN_TEXT_MARK.BOLD
        : key === "i" && !event.shiftKey
        ? CLARIN_TEXT_MARK.ITALIC
        : key === "u" && !event.shiftKey
        ? CLARIN_TEXT_MARK.UNDERLINE
        : key === "x" && event.shiftKey
        ? CLARIN_TEXT_MARK.STRIKE
        : null
      : null;
    if (historyDirection) {
      event.preventDefault();
      restoreEditorHistory(historyDirection);
    } else if (
      shouldInsertClarinTextLineBreak({
        key: event.key,
        ctrlOrCmd: event[KEYS.CTRL_OR_CMD],
        isComposing: false,
        keyCode: event.keyCode,
      })
    ) {
      event.preventDefault();
      replaceSelection("\n");
    } else if (
      app.props.enableRichText &&
      shortcutMark
    ) {
      event.preventDefault();
      richTextController.toggleMark(shortcutMark);
    } else if (!event.shiftKey && actionZoomIn.keyTest(event)) {
      event.preventDefault();
      app.actionManager.executeAction(actionZoomIn);
      updateWysiwygStyle();
    } else if (!event.shiftKey && actionZoomOut.keyTest(event)) {
      event.preventDefault();
      app.actionManager.executeAction(actionZoomOut);
      updateWysiwygStyle();
    } else if (!event.shiftKey && actionResetZoom.keyTest(event)) {
      event.preventDefault();
      app.actionManager.executeAction(actionResetZoom);
      updateWysiwygStyle();
    } else if (actionDecreaseFontSize.keyTest(event)) {
      app.actionManager.executeAction(actionDecreaseFontSize);
    } else if (actionIncreaseFontSize.keyTest(event)) {
      app.actionManager.executeAction(actionIncreaseFontSize);
    } else if (event.key === KEYS.ESCAPE) {
      event.preventDefault();
      submittedViaKeyboard = true;
      handleSubmit();
    } else if (event.key === KEYS.ENTER && event[KEYS.CTRL_OR_CMD]) {
      event.preventDefault();
      submittedViaKeyboard = true;
      handleSubmit();
    } else if (
      event.key === KEYS.TAB ||
      (event[KEYS.CTRL_OR_CMD] &&
        (event.code === CODES.BRACKET_LEFT ||
          event.code === CODES.BRACKET_RIGHT))
    ) {
      event.preventDefault();
      if (event.shiftKey || event.code === CODES.BRACKET_LEFT) {
        outdent();
      } else {
        indent();
      }
    }
  };

  const TAB_SIZE = 4;
  const TAB = " ".repeat(TAB_SIZE);
  const RE_LEADING_TAB = new RegExp(`^ {1,${TAB_SIZE}}`);
  const indent = () => {
    const selection = getCurrentSelection();
    const [selectionStart, selectionEnd] = selection;
    const linesStartIndices = getSelectedLinesStartIndices();
    commitTextReplacements(
      linesStartIndices.map((startIndex) => ({
        from: startIndex,
        to: startIndex,
        insertedText: TAB,
        insertedMarks: getClarinMarksAtCaret(currentFormat, startIndex),
      })),
      createEditableSelection(
        selectionStart + TAB_SIZE,
        selectionEnd + TAB_SIZE * linesStartIndices.length,
        getEditableSelectionDirection(selection),
      ),
    );
  };

  const outdent = () => {
    const selection = getCurrentSelection();
    const [selectionStart, selectionEnd] = selection;
    const linesStartIndices = getSelectedLinesStartIndices();
    const removals = linesStartIndices.flatMap((startIndex) => {
      const tabMatch = lastValue
        .slice(startIndex, startIndex + TAB_SIZE)
        .match(RE_LEADING_TAB);
      return tabMatch
        ? [{ start: startIndex, length: tabMatch[0].length }]
        : [];
    });
    if (!removals.length) {
      return;
    }
    const mapOffset = (offset: number) =>
      offset -
      removals.reduce(
        (removed, removal) =>
          removed +
          Math.min(
            removal.length,
            Math.max(0, offset - removal.start),
          ),
        0,
      );
    const nextStart = mapOffset(selectionStart);
    const nextEnd = Math.max(nextStart, mapOffset(selectionEnd));
    commitTextReplacements(
      removals.map((removal) => ({
        from: removal.start,
        to: removal.start + removal.length,
        insertedText: "",
      })),
      createEditableSelection(
        nextStart,
        nextEnd,
        getEditableSelectionDirection(selection),
      ),
    );
  };

  /**
   * @returns indices of start positions of selected lines, in reverse order
   */
  const getSelectedLinesStartIndices = () => {
    let [selectionStart, selectionEnd] = getCurrentSelection();
    const value = lastValue;

    // chars before selectionStart on the same line
    const startOffset = value.slice(0, selectionStart).match(/[^\n]*$/)![0]
      .length;
    // put caret at the start of the line
    selectionStart = selectionStart - startOffset;

    const selected = value.slice(selectionStart, selectionEnd);

    return selected
      .split("\n")
      .reduce(
        (startIndices, line, idx, lines) =>
          startIndices.concat(
            idx
              ? // curr line index is prev line's start + prev line's length + \n
                startIndices[idx - 1] + lines[idx - 1].length + 1
              : // first selected line
                selectionStart,
          ),
        [] as number[],
      )
      .reverse();
  };

  const stopEvent = (event: Event) => {
    if (event.target instanceof HTMLCanvasElement) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // using a state variable instead of passing it to the handleSubmit callback
  // so that we don't need to create separate a callback for event handlers
  let submittedViaKeyboard = false;
  let isDestroyed = false;
  let bindBlurTimeout: number | null = null;
  let pointerDownListenerFrame: number | null = null;
  let submitFrame: number | null = null;
  const handleSubmit = () => {
    // prevent double submit
    if (isDestroyed) {
      return;
    }
    isDestroyed = true;
    // cleanup must be run before onSubmit otherwise when app blurs the wysiwyg
    // it'd get stuck in an infinite loop of blur→onSubmit after we re-focus the
    // wysiwyg on update
    cleanup();
    const updateElement = Scene.getScene(element)?.getElement(
      element.id,
    ) as ExcalidrawTextElement;
    if (!updateElement) {
      return;
    }
    const container = getContainerElement(
      updateElement,
      app.scene.getNonDeletedElementsMap(),
    );

    if (container) {
      if (editable.value.trim()) {
        const boundTextElementId = getBoundTextElementId(container);
        if (!boundTextElementId || boundTextElementId !== element.id) {
          mutateElement(container, {
            boundElements: (container.boundElements || []).concat({
              type: "text",
              id: element.id,
            }),
          });
        } else if (isArrowElement(container)) {
          // updating an arrow label may change bounds, prevent stale cache:
          bumpVersion(container);
        }
      } else {
        mutateElement(container, {
          boundElements: container.boundElements?.filter(
            (ele) =>
              !isTextElement(
                ele as ExcalidrawTextElement | ExcalidrawLinearElement,
              ),
          ),
        });
      }
      redrawTextBoundingBox(
        updateElement,
        container,
        app.scene.getNonDeletedElementsMap(),
      );
    }

    onSubmit({
      viaKeyboard: submittedViaKeyboard,
      nextOriginalText: lastValue,
      clarinTextFormat: currentFormat?.runs.length ? currentFormat : null,
      clarinParagraphFormat: currentParagraphFormat?.paragraphs.length
        ? currentParagraphFormat
        : null,
      textAlign: currentTextAlign,
      clarinCharacterStyle: currentCharacterStyle?.runs.length ? currentCharacterStyle : null,
    });
  };

  const cleanup = () => {
    clearClarinTextColorHighlights(editable);
    // remove events to ensure they don't late-fire
    editable.onblur = null;
    editable.onbeforeinput = null;
    editable.oncompositionstart = null;
    editable.oncompositionend = null;
    editable.oncopy = null;
    editable.oncut = null;
    editable.oninput = null;
    editable.onkeydown = null;
    editable.onpaste = null;
    editable.onpointerdown = null;
    document.removeEventListener("selectionchange", onDocumentSelectionChange);
    clearActiveClarinRichTextEditor(richTextController);
    if (characterFocusFrame !== null) { cancelAnimationFrame(characterFocusFrame); characterFocusFrame = null; }

    if (bindBlurTimeout !== null) {
      window.clearTimeout(bindBlurTimeout);
      bindBlurTimeout = null;
    }
    if (pointerDownListenerFrame !== null) {
      cancelAnimationFrame(pointerDownListenerFrame);
      pointerDownListenerFrame = null;
    }
    if (submitFrame !== null) {
      cancelAnimationFrame(submitFrame);
      submitFrame = null;
    }

    if (observer) {
      observer.disconnect();
    }

    window.removeEventListener("resize", updateWysiwygStyle);
    window.removeEventListener("wheel", stopEvent, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", bindBlurEvent);
    window.removeEventListener("blur", handleSubmit);
    window.removeEventListener("beforeunload", handleSubmit);
    unbindUpdate();
    unbindOnScroll();

    editable.remove();
  };

  const bindBlurEvent = (event?: MouseEvent) => {
    window.removeEventListener("pointerup", bindBlurEvent);
    // Deferred so that the pointerdown that initiates the wysiwyg doesn't
    // trigger the blur on ensuing pointerup.
    // Also to handle cases such as picking a color which would trigger a blur
    // in that same tick.
    const target = event?.target;

    const isPropertiesTrigger =
      target instanceof Element &&
      Boolean(target.closest(".properties-trigger"));

    if (bindBlurTimeout !== null) {
      window.clearTimeout(bindBlurTimeout);
    }
    bindBlurTimeout = window.setTimeout(() => {
      bindBlurTimeout = null;
      if (isDestroyed) {
        return;
      }
      editable.onblur = handleSubmit;

      // case: clicking on the same property → no change → no update → no focus
      if (!isPropertiesTrigger) {
        editable.focus();
      }
    });
  };

  const temporarilyDisableSubmit = () => {
    if (isDestroyed) {
      return;
    }
    editable.onblur = null;
    window.addEventListener("pointerup", bindBlurEvent);
    // handle edge-case where pointerup doesn't fire e.g. due to user
    // alt-tabbing away
    window.addEventListener("blur", handleSubmit);
  };

  // prevent blur when changing properties from the menu
  const onPointerDown = (event: MouseEvent) => {
    if (isDestroyed) {
      return;
    }
    const target = event?.target;

    // panning canvas
    if (event.button === POINTER_BUTTON.WHEEL) {
      // trying to pan by clicking inside text area itself -> handle here
      if (target instanceof Node && editable.contains(target)) {
        event.preventDefault();
        app.handleCanvasPanUsingWheelOrSpaceDrag(event);
      }
      temporarilyDisableSubmit();
      return;
    }

    const isPropertiesTrigger =
      target instanceof Element &&
      Boolean(target.closest(".properties-trigger"));

    if (
      ((event.target instanceof HTMLElement ||
        event.target instanceof SVGElement) &&
        event.target.closest(
          `.${CLASSES.SHAPE_ACTIONS_MENU}, .${CLASSES.ZOOM_ACTIONS}`,
        ) &&
        !isWritableElement(event.target)) ||
      isPropertiesTrigger
    ) {
      temporarilyDisableSubmit();
    } else if (
      event.target instanceof HTMLCanvasElement &&
      // Vitest simply ignores stopPropagation, capture-mode, or rAF
      // so without introducing crazier hacks, nothing we can do
      !isTestEnv()
    ) {
      // On mobile, blur event doesn't seem to always fire correctly,
      // so we want to also submit on pointerdown outside the wysiwyg.
      // Done in the next frame to prevent pointerdown from creating a new text
      // immediately (if tools locked) so that users on mobile have chance
      // to submit first (to hide virtual keyboard).
      // Note: revisit if we want to differ this behavior on Desktop
      submitFrame = requestAnimationFrame(() => {
        submitFrame = null;
        if (!isDestroyed) {
          handleSubmit();
        }
      });
    }
  };

  // handle updates of textElement properties of editing element
  const unbindUpdate = app.scene.onUpdate(() => {
    if (isDestroyed) {
      return;
    }
    updateWysiwygStyle();
    const isPopupOpened = !!document.activeElement?.closest(
      ".properties-content",
    );
    if (!isPopupOpened) {
      editable.focus();
    }
  });

  const unbindOnScroll = app.onScrollChangeEmitter.on(() => {
    updateWysiwygStyle();
  });

  // ---------------------------------------------------------------------------

  if (autoSelect) {
    // select on init (focusing is done separately inside the bindBlurEvent()
    // because we need it to happen *after* the blur event from `pointerdown`)
    editable.select();
  }
  bindBlurEvent();

  // reposition wysiwyg in case of canvas is resized. Using ResizeObserver
  // is preferred so we catch changes from host, where window may not resize.
  let observer: ResizeObserver | null = null;
  if (canvas && "ResizeObserver" in window) {
    observer = new window.ResizeObserver(() => {
      if (!isDestroyed) {
        updateWysiwygStyle();
      }
    });
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", updateWysiwygStyle);
  }

  editable.onpointerdown = (event) => {
    commandSelection = null;
    event.stopPropagation();
  };

  // rAF (+ capture to by doubly sure) so we don't catch te pointerdown that
  // triggered the wysiwyg
  pointerDownListenerFrame = requestAnimationFrame(() => {
    pointerDownListenerFrame = null;
    if (!isDestroyed) {
      window.addEventListener("pointerdown", onPointerDown, { capture: true });
    }
  });
  window.addEventListener("beforeunload", handleSubmit);
  excalidrawContainer
    ?.querySelector(".excalidraw-textEditorContainer")!
    .appendChild(editable);
};
