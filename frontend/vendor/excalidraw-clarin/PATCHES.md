# Clarin patch surface

The fork is kept source-connected to Excalidraw `v0.18.1`. The maintained patch
surface is:

- `packages/excalidraw/element/clarinRichText.ts`: canonical partial-text marks.
- `packages/excalidraw/element/clarinParagraphFormat.ts`: canonical partial
  paragraph-alignment model.
- `packages/excalidraw/element/textWysiwyg.tsx`: controlled contenteditable editor.
  Empty paragraphs keep a DOM `<br>` placeholder so native vertical caret
  navigation stops on every intentionally blank line without persisting HTML.
  UTF-16 selections retain their real forward/backward anchor and focus across
  formatting, history and DOM rerenders. Native IME DOM is reconciled back to
  canonical plain text without swallowing block or `<br>` line breaks. The
  private version-1 clipboard remains backward compatible and transports
  paragraph alignment only for complete source paragraphs, without changing a
  destination paragraph when an inline fragment is pasted into it.
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
- `packages/excalidraw/element`, `actions`, `components`, `renderer` and
  `data/restore.ts`: source-level backport of the MIT-licensed constant/variable
  freedraw pressure contract from upstream PRs #11507
  (`cd514d72d6350082c7f173f7147607c7dc4cb523`) and #11551
  (`2a82821ec5970691199e1ffc6a49ac31f311ab59`), while preserving the v0.18.1
  variable renderer for legacy scenes. Clarin deliberately omits the upstream
  first-stylus auto-switch so both Lápiz and Resaltador start constant.

No HTML is persisted. Plain Excalidraw text remains in `text` and `originalText`;
Clarin formatting is stored only in `customData.clarinTextFormat` and
`customData.clarinParagraphFormat`.
