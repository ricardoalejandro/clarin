# Clarin patch surface

The fork is kept source-connected to Excalidraw `v0.18.1`. The maintained patch
surface is:

- `packages/excalidraw/element/clarinRichText.ts`: canonical partial-text marks.
- `packages/excalidraw/element/clarinParagraphFormat.ts`: canonical partial
  paragraph-alignment model.
- `packages/excalidraw/element/textWysiwyg.tsx`: controlled contenteditable editor.
- `packages/excalidraw/actions/actionProperties.tsx` and UI components: accessible
  bold, italic, underline, strike-through, and mixed paragraph-alignment controls.
- `packages/excalidraw/renderer/*` plus text measurement/wrapping: run-aware and
  paragraph-alignment-aware canvas and SVG rendering.
- `packages/excalidraw/fonts/Fonts.ts` and `clarinFontPreload.ts`: eager,
  bounded, retryable local font preload.
- `packages/excalidraw/types.ts` and `components/App.tsx`: opt-in and imperative API.
- `packages/excalidraw/wysiwygTarget.ts`, `utils.ts` and `components/App.tsx`:
  WYSIWYG clipboard ownership for nested `contenteditable` nodes, preventing
  canvas copy/cut/paste handlers from overwriting selected text.

No HTML is persisted. Plain Excalidraw text remains in `text` and `originalText`;
Clarin formatting is stored only in `customData.clarinTextFormat` and
`customData.clarinParagraphFormat`.
