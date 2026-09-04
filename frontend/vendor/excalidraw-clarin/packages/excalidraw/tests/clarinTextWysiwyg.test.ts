import { afterEach, describe, expect, it } from "vitest";

import {
  createClarinParagraphFormat,
  getClarinEffectiveParagraphAlignment,
} from "../element/clarinParagraphFormat";
import {
  CLARIN_TEXT_MARK,
  createClarinTextFormat,
} from "../element/clarinRichText";
import { CLARIN_TEXT_WYSIWYG_TEST_API } from "../element/textWysiwyg";

const {
  applyInsertedParagraphFormatting,
  createClarinRichTextClipboardSelection,
  createTargetRangeSelection,
  getEditablePlainText,
  getEditableSelection,
  installEditableTextAPI,
  isClarinCompositionInput,
  parseClarinRichTextClipboard,
  renderEditableRichText,
  setEditableSelection,
} = CLARIN_TEXT_WYSIWYG_TEST_API;

const createEditable = () => {
  const editable = installEditableTextAPI(document.createElement("div"));
  editable.contentEditable = "true";
  document.body.appendChild(editable);
  return editable;
};

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("Clarin rich-text WYSIWYG", () => {
  it("gives every empty logical paragraph a DOM-only line box and exact offset", () => {
    const editable = createEditable();
    const text = "A\n\n\nB";

    renderEditableRichText(editable, text, null, null, "left");

    const paragraphs = Array.from(
      editable.querySelectorAll<HTMLElement>(
        ":scope > [data-clarin-paragraph-start]",
      ),
    );
    expect(paragraphs).toHaveLength(4);
    expect(
      paragraphs.map((paragraph) => paragraph.dataset.clarinParagraphStart),
    ).toEqual(["0", "2", "3", "4"]);
    expect(
      editable.querySelectorAll("br[data-clarin-empty-paragraph]"),
    ).toHaveLength(2);
    expect(paragraphs[1].childNodes).toHaveLength(1);
    expect(paragraphs[1].firstChild).toBeInstanceOf(HTMLBRElement);
    expect(paragraphs[1].style.minHeight).toBe("1em");
    expect(paragraphs[1].style.lineHeight).toBe("inherit");
    expect(paragraphs[1].style.fontSize).toBe(
      "var(--clarin-wysiwyg-font-size, inherit)",
    );
    expect(editable.value).toBe(text);

    for (let offset = 0; offset <= text.length; offset++) {
      setEditableSelection(editable, offset);
      expect(getEditableSelection(editable)?.slice(0, 2)).toEqual([
        offset,
        offset,
      ]);
    }

    expect(editable.value).toBe(text);
    expect(paragraphs[1].childNodes).toHaveLength(1);
    expect(paragraphs[2].childNodes).toHaveLength(1);
  });

  it.each([
    { label: "leading", text: "\nA", emptyParagraphs: 1 },
    { label: "trailing", text: "A\n", emptyParagraphs: 1 },
    { label: "all-empty", text: "\n\n", emptyParagraphs: 3 },
  ])(
    "preserves $label empty paragraphs without changing canonical text",
    ({ text, emptyParagraphs }) => {
      const editable = createEditable();

      renderEditableRichText(editable, text, null, null, "left");

      expect(
        editable.querySelectorAll("br[data-clarin-empty-paragraph]"),
      ).toHaveLength(emptyParagraphs);
      expect(editable.value).toBe(text);
      for (let offset = 0; offset <= text.length; offset++) {
        setEditableSelection(editable, offset);
        expect(getEditableSelection(editable)?.slice(0, 2)).toEqual([
          offset,
          offset,
        ]);
      }
      expect(editable.value).toBe(text);
    },
  );

  it("preserves a backward selection through formatting and history-style rerenders", () => {
    const editable = createEditable();
    const text = "Alpha\n\nOmega";
    const backwardSelection = [1, 9, "backward"] as const;

    renderEditableRichText(
      editable,
      text,
      null,
      null,
      "left",
      backwardSelection,
    );
    expect(getEditableSelection(editable)).toEqual(backwardSelection);

    renderEditableRichText(
      editable,
      text,
      createClarinTextFormat(text, [
        { from: 1, to: 9, marks: CLARIN_TEXT_MARK.BOLD },
      ]),
      null,
      "left",
      backwardSelection,
    );
    expect(getEditableSelection(editable)).toEqual(backwardSelection);

    renderEditableRichText(
      editable,
      text,
      null,
      null,
      "left",
      backwardSelection,
    );
    expect(getEditableSelection(editable)).toEqual(backwardSelection);
    expect(window.getSelection()?.anchorNode).not.toBe(
      window.getSelection()?.focusNode,
    );
  });

  it("round-trips character and paragraph formatting through a compatible v1 clipboard payload", () => {
    const sourceText = "Uno\n\nTres";
    const sourceFormat = createClarinTextFormat(sourceText, [
      { from: 1, to: 3, marks: CLARIN_TEXT_MARK.ITALIC },
    ]);
    const sourceParagraphFormat = createClarinParagraphFormat(
      sourceText,
      "left",
      [
        { start: 4, align: "center" },
        { start: 5, align: "right" },
      ],
    );
    const copied = createClarinRichTextClipboardSelection({
      sourceText,
      format: sourceFormat,
      paragraphFormat: sourceParagraphFormat,
      textAlign: "left",
      from: 0,
      to: sourceText.length,
    });

    const parsed = parseClarinRichTextClipboard(
      JSON.stringify({ version: 1, ...copied }),
      sourceText,
    );
    expect(parsed).toEqual({
      format: copied.format,
      paragraphFormat: copied.paragraphFormat,
      textAlign: "left",
      formattedParagraphStarts: [0, 4, 5],
    });

    const destinationText = `${sourceText}\nDestino`;
    const applied = applyInsertedParagraphFormatting({
      format: null,
      text: destinationText,
      textAlign: "left",
      insertionStart: 0,
      insertedText: sourceText,
      insertedParagraphFormat: parsed?.paragraphFormat ?? null,
      insertedTextAlign: parsed?.textAlign ?? null,
      insertedFormattedParagraphStarts:
        parsed?.formattedParagraphStarts ?? [],
    });
    expect(
      [0, 4, 5, 10].map((start) =>
        getClarinEffectiveParagraphAlignment(
          applied.format,
          destinationText,
          applied.textAlign,
          start,
        ),
      ),
    ).toEqual(["left", "center", "right", "left"]);

    const legacy = parseClarinRichTextClipboard(
      JSON.stringify({
        version: 1,
        text: sourceText,
        format: sourceFormat,
      }),
      sourceText,
    );
    expect(legacy).toEqual({
      format: sourceFormat,
      paragraphFormat: null,
      textAlign: null,
      formattedParagraphStarts: [],
    });
  });

  it("does not transfer paragraph alignment from a partial inline copy", () => {
    const sourceText = "Texto centrado";
    const copied = createClarinRichTextClipboardSelection({
      sourceText,
      format: null,
      paragraphFormat: null,
      textAlign: "center",
      from: 1,
      to: 6,
    });

    expect(copied.text).toBe("exto ");
    expect(copied.formattedParagraphStarts).toEqual([]);
    const applied = applyInsertedParagraphFormatting({
      format: null,
      text: "Izexto quierda",
      textAlign: "left",
      insertionStart: 2,
      insertedText: copied.text,
      insertedParagraphFormat: copied.paragraphFormat,
      insertedTextAlign: copied.textAlign,
      insertedFormattedParagraphStarts: copied.formattedParagraphStarts,
    });

    expect(applied).toEqual({ format: null, textAlign: "left" });
  });

  it("transfers only complete copied paragraphs that remain paragraph starts", () => {
    const sourceText = "Parcial\nCentro\nFinal";
    const sourceParagraphFormat = createClarinParagraphFormat(
      sourceText,
      "left",
      [{ start: 8, align: "center" }],
    );
    const copied = createClarinRichTextClipboardSelection({
      sourceText,
      format: null,
      paragraphFormat: sourceParagraphFormat,
      textAlign: "left",
      from: 3,
      to: 15,
    });

    expect(copied.text).toBe("cial\nCentro\n");
    expect(copied.formattedParagraphStarts).toEqual([5]);
    const destinationText = "XXcial\nCentro\nYY";
    const applied = applyInsertedParagraphFormatting({
      format: null,
      text: destinationText,
      textAlign: "left",
      insertionStart: 2,
      insertedText: copied.text,
      insertedParagraphFormat: copied.paragraphFormat,
      insertedTextAlign: copied.textAlign,
      insertedFormattedParagraphStarts: copied.formattedParagraphStarts,
    });

    expect(
      [0, 7, 14].map((start) =>
        getClarinEffectiveParagraphAlignment(
          applied.format,
          destinationText,
          applied.textAlign,
          start,
        ),
      ),
    ).toEqual(["left", "center", "left"]);
  });

  it("keeps character formatting but rejects malformed paragraph start metadata", () => {
    const text = "Uno\nDos";
    const format = createClarinTextFormat(text, [
      { from: 0, to: 3, marks: CLARIN_TEXT_MARK.BOLD },
    ]);
    const parsed = parseClarinRichTextClipboard(
      JSON.stringify({
        version: 1,
        text,
        format,
        paragraphFormat: null,
        textAlign: "center",
        formattedParagraphStarts: [4, 0],
      }),
      text,
    );

    expect(parsed).toEqual({
      format,
      paragraphFormat: null,
      textAlign: null,
      formattedParagraphStarts: [],
    });
  });

  it("serializes native IME block and BR mutations without losing line breaks", () => {
    const editable = createEditable();
    const first = document.createElement("div");
    first.dataset.clarinParagraphStart = "0";
    first.textContent = "Uno";
    const nativeBlock = document.createElement("div");
    nativeBlock.textContent = "二";
    const nativeEmptyBlock = document.createElement("div");
    nativeEmptyBlock.appendChild(document.createElement("br"));
    const nativeBreaks = document.createElement("div");
    nativeBreaks.append("Tres", document.createElement("br"), "Cuatro");
    editable.replaceChildren(
      first,
      nativeBlock,
      nativeEmptyBlock,
      nativeBreaks,
    );

    expect(getEditablePlainText(editable)).toBe("Uno\n二\n\nTres\nCuatro");
  });

  it("serializes consecutive native empty blocks as distinct paragraphs", () => {
    const editable = createEditable();
    editable.replaceChildren(
      ...Array.from({ length: 3 }, () => {
        const block = document.createElement("div");
        block.appendChild(document.createElement("br"));
        return block;
      }),
    );

    expect(getEditablePlainText(editable)).toBe("\n\n");
  });

  it("keeps a native BR nested in an inline IME wrapper", () => {
    const editable = createEditable();
    const first = document.createElement("span");
    first.textContent = "A";
    const wrappedBreak = document.createElement("span");
    wrappedBreak.appendChild(document.createElement("br"));
    const last = document.createElement("span");
    last.textContent = "B";
    editable.replaceChildren(first, wrappedBreak, last);

    expect(getEditablePlainText(editable)).toBe("A\nB");
  });

  it("keeps a backward selection when beforeinput target bounds match it", () => {
    expect(createTargetRangeSelection(2, 5, [2, 5, "backward"])).toEqual([
      2,
      5,
      "backward",
    ]);
    expect(createTargetRangeSelection(3, 5, [2, 5, "backward"])).toEqual([
      3,
      5,
      "forward",
    ]);
  });

  it("leaves every active or composition-specific beforeinput mutation to the IME", () => {
    expect(isClarinCompositionInput("insertParagraph", true, false)).toBe(true);
    expect(isClarinCompositionInput("insertLineBreak", false, true)).toBe(true);
    expect(
      isClarinCompositionInput("deleteCompositionText", false, false),
    ).toBe(true);
    expect(
      isClarinCompositionInput("insertFromComposition", false, false),
    ).toBe(true);
    expect(isClarinCompositionInput("insertParagraph", false, false)).toBe(
      false,
    );
    expect(
      isClarinCompositionInput("deleteContentBackward", false, false),
    ).toBe(false);
  });
});
