import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLARIN_CHARACTER_STYLE_KEY, clearClarinCharacterStyleProperty, createClarinCharacterStyle,
  getClarinCharacterStyle, getClarinCharacterStyleAtCaret, getClarinEffectiveCharacterStyle,
  getClarinStyledVisualLines, rebaseClarinCharacterStyle, replaceClarinCharacterStyleRange,
  setClarinCharacterStyle, updateClarinCharacterStyleCustomData, validateClarinCharacterStyle,
} from "../element/clarinCharacterStyle";
import { CLARIN_TEXT_MARK, createClarinTextFormat, getActiveClarinRichTextEditor, setActiveClarinRichTextEditor, updateClarinTextCustomData } from "../element/clarinRichText";
import { CLARIN_TEXT_WYSIWYG_TEST_API, textWysiwyg } from "../element/textWysiwyg";
import Scene from "../scene/Scene";
import { actionChangeStrokeColor, actionChangeFontSize, actionChangeFontFamily } from "../actions/actionProperties";
import { getDefaultAppState } from "../appState";
import type { ExcalidrawTextElement } from "../element/types";
import type { AppState } from "../types";
import { clearClarinTextColorHighlights } from "../element/clarinTextColorHighlights";

afterEach(() => { setActiveClarinRichTextEditor(null); document.body.replaceChildren(); });
const base = { originalText: "Alpha Beta", text: "Alpha Beta", strokeColor: "#112233", fontSize: 20, fontFamily: 2 };
const styled = (runs: Parameters<typeof createClarinCharacterStyle>[1]) => ({ ...base,
  customData: { [CLARIN_CHARACTER_STYLE_KEY]: createClarinCharacterStyle(base.originalText, runs) } });

describe("Clarin character styles", () => {
  it("changes only the selected property and range while preserving overlapping typography", () => {
    let format = createClarinCharacterStyle(base.originalText, [{ from: 0, to: 10, fontScale: 1.4 }]);
    format = setClarinCharacterStyle(format, base.originalText, 6, 10, { color: "#ff0000" });
    expect(format.runs).toEqual([{ from: 0, to: 6, fontScale: 1.4 }, { from: 6, to: 10, fontScale: 1.4, color: "#FF0000" }]);
    format = setClarinCharacterStyle(format, base.originalText, 7, 9, { fontFamily: 10014 });
    expect(getClarinEffectiveCharacterStyle({ ...base, customData: { clarinCharacterStyle: format } }, 8))
      .toEqual({ color: "#FF0000", fontFamily: 10014, fontSize: 28, fontScale: 1.4 });
  });
  it("snaps to complete graphemes, normalizes colors and removes redundant scale", () => {
    const format = createClarinCharacterStyle("A😀e\u0301B", [{ from: 2, to: 4, color: "#aabbcc", fontScale: 1 }]);
    expect(format.runs).toEqual([{ from: 1, to: 5, color: "#AABBCC" }]);
    expect(validateClarinCharacterStyle(format, "A😀e\u0301B", 20)).toBe(true);
  });
  it("clears one whole-object property and preserves marks and opaque custom data", () => {
    const format = createClarinCharacterStyle(base.originalText, [{ from: 0, to: 5, color: "#FF0000", fontScale: 2 }]);
    const customData = { clarinCharacterStyle: format, clarinTextFormat: { keep: true }, opaque: 7 };
    expect(clearClarinCharacterStyleProperty(customData, "color")).toEqual({ ...customData,
      clarinCharacterStyle: { ...format, runs: [{ from: 0, to: 5, fontScale: 2 }] } });
    expect(updateClarinCharacterStyleCustomData({ clarinCharacterStyle: format }, null)).toBeUndefined();
  });
  it("keeps future caret styles and shifts exact repeated-text ranges through edits", () => {
    const text = "uno uno uno";
    const format = createClarinCharacterStyle(text, [{ from: 8, to: 11, color: "#FF0000" }]);
    const deleted = replaceClarinCharacterStyleRange({ format, text, from: 4, to: 8, insertedText: "" });
    expect(deleted.runs).toEqual([{ from: 4, to: 7, color: "#FF0000" }]);
    const inserted = replaceClarinCharacterStyleRange({ format: deleted, text: "uno uno", from: 4, to: 4,
      insertedText: "nuevo ", insertedStyle: { fontFamily: 10014, fontScale: 2 } });
    expect(inserted.runs).toEqual([{ from: 4, to: 10, fontFamily: 10014, fontScale: 2 }, { from: 10, to: 13, color: "#FF0000" }]);
    expect(getClarinCharacterStyleAtCaret(inserted, "uno nuevo uno", 10)).toEqual({ fontFamily: 10014, fontScale: 2 });
  });
  it.each([
    ["unknown field", { future: true }], ["old hash", { textHash: 0 }], ["wrong length", { textLength: 1 }],
    ["unknown version", { version: 2 }], ["overlapping", { runs: [{ from: 0, to: 4, color: "#FF0000" }, { from: 3, to: 5, fontScale: 2 }] }],
    ["uncanonical", { runs: [{ from: 0, to: 2, color: "#ff0000" }] }],
    ["unsafe CSS", { runs: [{ from: 0, to: 2, color: "url(x)" }] }],
    ["unknown font", { runs: [{ from: 0, to: 2, fontFamily: 99999 }] }],
    ["zero scale", { runs: [{ from: 0, to: 2, fontScale: 0 }] }],
    ["redundant scale", { runs: [{ from: 0, to: 2, fontScale: 1 }] }],
    ["unbounded scale", { runs: [{ from: 0, to: 2, fontScale: Infinity }] }],
  ])("rejects %s", (_label, patch) => {
    const format = createClarinCharacterStyle(base.originalText, [{ from: 0, to: 5, color: "#FF0000" }]);
    expect(validateClarinCharacterStyle({ ...format, ...patch }, base.originalText, 20)).toBe(false);
  });
  it("rejects invalid base sizes even with empty runs and excessive runs without truncation", () => {
    const format = createClarinCharacterStyle("", []);
    expect(validateClarinCharacterStyle(format, "", 0)).toBe(false);
    expect(validateClarinCharacterStyle(format, "", Infinity)).toBe(false);
    expect(() => createClarinCharacterStyle("a".repeat(4097), Array.from({ length: 4097 }, (_, index) =>
      ({ from: index, to: index + 1, color: index % 2 ? "#FF0000" : "#0000FF" })))).toThrow("límite");
  });
  it("maps inline style offsets across soft wrapping without requiring a bold mark", () => {
    const element = styled([{ from: 6, to: 10, color: "#FF0000", fontScale: 2 }]);
    const lines = getClarinStyledVisualLines({ ...element, text: "Alpha\nBeta" });
    expect(lines[0].map(run => [run.text, run.fontSize, run.color])).toEqual([["Alpha", 20, "#112233"]]);
    expect(lines[1].map(run => [run.text, run.fontSize, run.color])).toEqual([["Beta", 40, "#FF0000"]]);
    expect(getClarinCharacterStyle({ ...element, originalText: "other" })).toBeNull();
  });
  it("rebases private copy/paste preserving effective defaults, family and sizes", () => {
    const source = { color: "#112233", fontFamily: 2, fontSize: 20 };
    const destination = { color: "#445566", fontFamily: 3, fontSize: 40 };
    const format = createClarinCharacterStyle("AB", [{ from: 1, to: 2, fontScale: 2 }]);
    expect(rebaseClarinCharacterStyle("AB", format, source, destination).runs).toEqual([
      { from: 0, to: 1, color: "#112233", fontFamily: 2, fontScale: 0.5 },
      { from: 1, to: 2, color: "#112233", fontFamily: 2 },
    ]);
  });
});

describe("WYSIWYG character rendering and clipboard", () => {
  it("types and undoes canonical mixed underline/strike through one highlighted shaping node", () => {
    vi.useFakeTimers();
    const css = Object.getOwnPropertyDescriptor(window, "CSS"); const highlight = Object.getOwnPropertyDescriptor(window, "Highlight");
    const registry = new Map<string, Set<Range>>();
    Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: registry } });
    Object.defineProperty(window, "Highlight", { configurable: true, value: class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } } });
    const scene = new Scene(); const root = document.createElement("div");
    const holder = document.createElement("div"); holder.className = "excalidraw-textEditorContainer"; root.appendChild(holder); document.body.appendChild(root);
    const text = "AV";
    const live = { ...base, id: "live-typography", type: "text", text, originalText: text, x: 0, y: 0, width: 100, height: 25,
      angle: 0, opacity: 100, lineHeight: 1.25, autoResize: true, isDeleted: false, containerId: null,
      textAlign: "left", verticalAlign: "top", version: 1, versionNonce: 1, index: "a0", groupIds: [], boundElements: [],
      customData: { clarinTextFormat: createClarinTextFormat(text, [{ from: 0, to: 1, marks: 4 }, { from: 1, to: 2, marks: 8 }]),
        clarinCharacterStyle: createClarinCharacterStyle(text, [{ from: 0, to: 2, color: "#FF0000" }]) } } as unknown as ExcalidrawTextElement;
    scene.replaceAllElements([live]);
    const state = { ...getDefaultAppState(), editingTextElement: live, width: 1024, height: 768, offsetTop: 0, offsetLeft: 0 };
    const app = { scene, state, props: { enableRichText: true }, setState: vi.fn(), onScrollChangeEmitter: { on: () => () => {} },
      actionManager: { executeAction: vi.fn() }, handleCanvasPanUsingWheelOrSpaceDrag: vi.fn() };
    let editable: HTMLDivElement | undefined;
    try {
      textWysiwyg({ id: live.id, element: live, app: app as never, canvas: document.createElement("canvas"), excalidrawContainer: root,
        getViewportCoords: (x, y) => [x, y], autoSelect: false, onSubmit: vi.fn(),
        onChange: (originalText, marks, _paragraphs, textAlign, typography) => {
          const previous = scene.getElement<ExcalidrawTextElement>(live.id)!;
          scene.replaceAllElements([{ ...previous, originalText, text: originalText, textAlign,
            customData: updateClarinCharacterStyleCustomData(updateClarinTextCustomData(previous.customData, marks), typography), version: previous.version + 1 }]);
        } });
      editable = holder.querySelector<HTMLDivElement>('[data-type="wysiwyg"]')!;
      CLARIN_TEXT_WYSIWYG_TEST_API.setEditableSelection(editable, 1, 1);
      document.dispatchEvent(new Event("selectionchange"));
      editable.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "X" }));
      expect(editable.textContent).toBe("AXV");
      expect(editable.querySelectorAll("[data-clarin-paragraph-start] > span")).toHaveLength(1);
      expect(scene.getElement<ExcalidrawTextElement>(live.id)!.customData?.clarinTextFormat).toMatchObject({ runs: [{ from: 0, to: 2, marks: 4 }, { from: 2, to: 3, marks: 8 }] });
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
      expect(editable.textContent).toBe("AV");
      expect(scene.getElement<ExcalidrawTextElement>(live.id)!.customData?.clarinTextFormat).toMatchObject({ runs: [{ from: 0, to: 1, marks: 4 }, { from: 1, to: 2, marks: 8 }] });
      expect(CLARIN_TEXT_WYSIWYG_TEST_API.getEditableSelection(editable)?.slice(0, 2)).toEqual([1, 1]);
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      expect(editable.textContent).toBe("AXV");
      expect([...registry.values()].flatMap(value => [...value].map(range => range.toString()))).toEqual(["AX", "V"]);
    } finally {
      editable?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      if (editable) clearClarinTextColorHighlights(editable); scene.destroy(); vi.useRealTimers();
      if (css) Object.defineProperty(window, "CSS", css); else Reflect.deleteProperty(window, "CSS");
      if (highlight) Object.defineProperty(window, "Highlight", highlight); else Reflect.deleteProperty(window, "Highlight");
    }
  });
  it("keeps underline and strike paint out of shaping spans on the character-style path", () => {
    const css = Object.getOwnPropertyDescriptor(window, "CSS"); const highlight = Object.getOwnPropertyDescriptor(window, "Highlight");
    const registry = new Map<string, Set<Range>>();
    Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: registry } });
    Object.defineProperty(window, "Highlight", { configurable: true, value: class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } } });
    const editable = CLARIN_TEXT_WYSIWYG_TEST_API.installEditableTextAPI(document.createElement("div"));
    editable.contentEditable = "true"; document.body.appendChild(editable);
    try {
      const typography = createClarinCharacterStyle("AV", [{ from: 0, to: 2, fontScale: 2 }]);
      const marks = createClarinTextFormat("AV", [{ from: 0, to: 1, marks: 4 }, { from: 1, to: 2, marks: 8 }]);
      CLARIN_TEXT_WYSIWYG_TEST_API.renderEditableRichText(editable, "AV", marks, null, "left", [0, 2, "backward"], typography, { ...base, lineHeight: 1.25 });
      const spans = editable.querySelectorAll<HTMLSpanElement>("[data-clarin-paragraph-start] > span");
      expect(spans).toHaveLength(1); expect(spans[0].textContent).toBe("AV"); expect(spans[0].style.textDecoration).toBe("none");
      const rules = document.querySelector("[data-clarin-text-colors]")!.textContent!;
      expect(rules).toContain("text-decoration-line: underline;"); expect(rules).toContain("text-decoration-line: line-through;");
      expect(CLARIN_TEXT_WYSIWYG_TEST_API.getEditableSelection(editable)).toEqual([0, 2, "backward"]);
    } finally {
      clearClarinTextColorHighlights(editable);
      if (css) Object.defineProperty(window, "CSS", css); else Reflect.deleteProperty(window, "CSS");
      if (highlight) Object.defineProperty(window, "Highlight", highlight); else Reflect.deleteProperty(window, "Highlight");
    }
  });
  it("coalesces paint-only color changes into one shaping node and preserves selection", () => {
    const css = Object.getOwnPropertyDescriptor(window, "CSS");
    const highlight = Object.getOwnPropertyDescriptor(window, "Highlight");
    const registry = new Map<string, Set<Range>>();
    Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: registry } });
    Object.defineProperty(window, "Highlight", { configurable: true, value: class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } } });
    const editable = CLARIN_TEXT_WYSIWYG_TEST_API.installEditableTextAPI(document.createElement("div"));
    editable.contentEditable = "true"; document.body.appendChild(editable);
    try {
      const format = createClarinCharacterStyle("AV", [{ from: 1, to: 2, color: "#FF0000" }]);
      CLARIN_TEXT_WYSIWYG_TEST_API.renderEditableRichText(editable, "AV", null, null, "left", [0, 2, "backward"], format, { ...base, lineHeight: 1.25 });
      expect(editable.querySelectorAll("[data-clarin-paragraph-start] > span")).toHaveLength(1);
      expect(editable.querySelector("[data-clarin-paragraph-start] > span")!.firstChild!.textContent).toBe("AV");
      expect(CLARIN_TEXT_WYSIWYG_TEST_API.getEditableSelection(editable)).toEqual([0, 2, "backward"]);
      expect([...registry.values()].flatMap(value => [...value].map(range => range.toString()))).toEqual(["A", "V"]);
      const oldNames = [...registry.keys()];
      CLARIN_TEXT_WYSIWYG_TEST_API.renderEditableRichText(editable, "AV", null, null, "left", [1, 1], null, { ...base, lineHeight: 1.25 });
      expect(oldNames.every(name => !registry.has(name))).toBe(true);
      expect(editable.dataset.clarinColorSession).toBeUndefined();
      expect(CLARIN_TEXT_WYSIWYG_TEST_API.getEditableSelection(editable)?.slice(0, 2)).toEqual([1, 1]);
    } finally {
      clearClarinTextColorHighlights(editable);
      if (css) Object.defineProperty(window, "CSS", css); else Reflect.deleteProperty(window, "CSS");
      if (highlight) Object.defineProperty(window, "Highlight", highlight); else Reflect.deleteProperty(window, "Highlight");
    }
  });
  it("keeps selection direction and canonical plain text through typography rerenders", () => {
    const editable = CLARIN_TEXT_WYSIWYG_TEST_API.installEditableTextAPI(document.createElement("div"));
    editable.contentEditable = "true"; document.body.appendChild(editable);
    const format = createClarinCharacterStyle(base.originalText, [{ from: 6, to: 10, color: "#FF0000", fontScale: 2, fontFamily: 3 }]);
    CLARIN_TEXT_WYSIWYG_TEST_API.renderEditableRichText(editable, base.originalText, null, null, "left", [2, 9, "backward"], format, { ...base, lineHeight: 1.25 });
    expect(editable.value).toBe(base.originalText);
    expect(CLARIN_TEXT_WYSIWYG_TEST_API.getEditableSelection(editable)).toEqual([2, 9, "backward"]);
    const styledSpan = Array.from(editable.querySelectorAll("span")).find(span => span.textContent === "Beta")!;
    expect(styledSpan.style.fontSize).toBe("40px");
    expect(styledSpan.style.color).toBe("rgb(255, 0, 0)");
    expect(styledSpan.style.lineHeight).toBe("1.25");
  });
  it("clips clipboard styles and ignores invalid new style while keeping valid legacy marks", () => {
    const text = "Alpha Beta";
    const selected = CLARIN_TEXT_WYSIWYG_TEST_API.createClarinRichTextClipboardSelection({ sourceText: text,
      format: createClarinTextFormat(text, [{ from: 6, to: 10, marks: CLARIN_TEXT_MARK.BOLD }]), paragraphFormat: null,
      textAlign: "left", from: 6, to: 10, characterStyle: createClarinCharacterStyle(text, [{ from: 6, to: 10, fontScale: 2 }]),
      baseStyle: { color: "#112233", fontFamily: 2, fontSize: 20 } });
    const parsed = CLARIN_TEXT_WYSIWYG_TEST_API.parseClarinRichTextClipboard(JSON.stringify({ version: 1, ...selected }), "Beta");
    expect(parsed?.characterStyle?.runs).toEqual([{ from: 0, to: 4, fontScale: 2 }]);
    const invalid = CLARIN_TEXT_WYSIWYG_TEST_API.parseClarinRichTextClipboard(JSON.stringify({ version: 1, ...selected, characterStyle: { broken: true } }), "Beta");
    expect(invalid?.format.runs).toEqual([{ from: 0, to: 4, marks: 1 }]);
    expect(invalid?.characterStyle).toBeUndefined();
  });
});

describe("typography action ownership", () => {
  it("delegates color, size and family to the active editor without returning stale elements", async () => {
    const element = { ...base, id: "active-editor-text", type: "text" } as ExcalidrawTextElement;
    const editor = { elementId: element.id, captureSelection: vi.fn(), toggleMark: vi.fn(), getMarkState: () => "off" as const,
      setParagraphAlignment: vi.fn(), getParagraphAlignmentState: () => "left" as const,
      setCharacterStyle: vi.fn(), getCharacterStyleState: () => "mixed", scaleFontSize: vi.fn(), restoreSelection: vi.fn() };
    setActiveClarinRichTextEditor(editor);
    const state = { ...getDefaultAppState(), editingTextElement: element } as AppState;
    const color = await actionChangeStrokeColor.perform([element], state, { currentItemStrokeColor: "#FF0000" }, {} as never);
    const size = await actionChangeFontSize.perform([element], state, 36, {} as never);
    const family = await actionChangeFontFamily.perform([element], state, { currentItemFontFamily: 10014 }, {} as never);
    expect(editor.setCharacterStyle.mock.calls).toEqual([["color", "#FF0000"], ["fontSize", 36], ["fontFamily", 10014]]);
    for (const result of [color, size, family]) expect(result).toEqual(expect.objectContaining({ captureUpdate: "NEVER" }));
    for (const result of [color, size, family]) expect(result).not.toHaveProperty("elements");
    editor.setCharacterStyle.mockClear();
    await actionChangeFontFamily.perform([element], state, { currentHoveredFontFamily: 10015 }, {} as never);
    expect(editor.setCharacterStyle).not.toHaveBeenCalled();
    expect(getActiveClarinRichTextEditor()).toBe(editor);
  });
});
