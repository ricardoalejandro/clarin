# Clarin patch surface

The fork is kept source-connected to Excalidraw `v0.18.1`. The maintained patch
surface is:

- `.8`: `element/clarinStrokeWidth.ts`, `actions/actionProperties.tsx` and the
  native icon implement four semantic width presets. Amplio resolves to 16 for
  constant free draw and 8 for other tools; historical numeric widths are never
  rewritten. A mixed selection changes in one action and unmatched widths have
  an honest custom-value readout. The former build-time fourth-option injection
  is removed. `scene/clarinExportBounds.ts` adds the rendered stroke outline to
  export-only bounds so thick strokes and taps fit PNG/SVG; editor hitboxes and
  deliberate frame cropping remain unchanged. Focused fork tests cover both.
  `subset/clarinSubsetWorkerUrl.ts` resolves the font-subsetting worker solely
  under the host's same-origin versioned asset directory. Clarin builds and
  publishes a self-contained ESM worker with embedded WOFF2/HarfBuzz WASM;
  it no longer depends on Next's build-time `file://` rewriting. A worker-only
  CSP permits WASM but forbids network access; document script policy is unchanged.
  The exact offline-v3/v4/v5 asset paths follow the same policy. WOFF2 embind
  wrappers use ordinary closures instead of runtime JavaScript compilation,
  preserving receivers, arity and conversion/destruction order. Active worker
  jobs have a bounded 15-second startup/work deadline; idle workers still close
  after one second. Regression tests cover a cold download above the old limit.

- `packages/excalidraw/mermaid.ts`, `components/App.tsx` and
  `components/TTDDialog/TTDDialog.tsx`: `.7` closes implicit Mermaid clipboard
  conversion and dialog/parser loading unless the host enables `mermaidEnabled`.
  This capability is independent of `aiEnabled`; Clarin currently enables local
  Mermaid while disabling AI. Without the capability, diagram-like clipboard
  text remains ordinary editable text. Both parser
  entry points use one tested capability boundary, including direct dialog use.
  Nanoid 3.3.19 and Radix Tabs 1.1.21 retain the same APIs with security fixes
  and React 19 support; remaining transitives are pinned by the root lock.
  Upstream's unused development dependency block is omitted from this vendored
  package: Clarin builds and tests it exclusively with the pinned tools in
  `frontend/package.json`. This avoids a second unmaintained test/build stack;
  the upstream application build scripts are provenance, not release commands.

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
  bounded, retryable local font preload. FontFace loading also runs without
  browser connectivity so the same local shell cache can satisfy it; completion
  depends on actual font results. Missing offline fonts retain the existing
  reconnection retry. Asset URLs, origin restrictions and catalog are unchanged.
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
