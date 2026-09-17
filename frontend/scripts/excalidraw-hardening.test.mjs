import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hardenEditorBundle } from './excalidraw-hardening.mjs'
import { loadWhiteboardFontCatalog, runtimeWhiteboardFontCatalog } from './whiteboard-font-catalog.mjs'

test('all Mermaid parser imports are behind the host capability boundary', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/excalidraw-clarin/packages/excalidraw')
  const app = await readFile(resolve(root, 'components/App.tsx'), 'utf8')
  const dialog = await readFile(resolve(root, 'components/TTDDialog/TTDDialog.tsx'), 'utf8')
  const loader = await readFile(resolve(root, 'mermaid.ts'), 'utf8')
  assert.doesNotMatch(app + dialog, /import\(["']@excalidraw\/mermaid-to-excalidraw["']\)/u)
  assert.match(app, /isMermaidEnabled\(this\.props\.mermaidEnabled\) && isMaybeMermaidDefinition/u)
  assert.match(app, /loadMermaidParser\(this\.props\.mermaidEnabled\)/u)
  assert.match(dialog, /\? !isMermaidEnabled\(app\.props\.mermaidEnabled\)/u)
  assert.match(dialog, /api: loadMermaidParser\(app\.props\.mermaidEnabled\)/u)
  assert.match(loader, /if \(!isMermaidEnabled\(mermaidEnabled\)\)/u)
  assert.doesNotMatch(app + dialog + loader, /loadMermaidParser\([^)]*aiEnabled/u)
})

test('neutralizes external URLs in literals and dynamic template helpers', () => {
  const source = [
    'const docs = "https://docs.example.invalid/help";',
    'const video = (id) => `https://player.vimeo.com/video/${id}`;',
    'const playlist = (id) => `https://www.youtube.com/embed/videoseries?list=${id}`;',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-fixture.js')
  assert.doesNotMatch(result.hardened, /https?:\/\//i)
  assert.doesNotMatch(result.hardened, /(?:youtube|vimeo)\.com/i)
  assert.match(result.hardened, /about:blank#clarin-external-disabled/)
  assert.equal(result.disabledRoutes, 3)
})

test('keeps XML namespaces and rewrites the audited font fallback to an absolute same-origin URL', () => {
  const source = [
    'const svg = "http://www.w3.org/2000/svg";',
    'const pkg = { name: "@excalidraw/excalidraw", version: "0.18.1-clarin.7" };',
    'const fallback = `https://esm.sh/${pkg.name}@${pkg.version}/dist/prod/`;',
    'const fontURL = (asset) => new URL(asset, fallback).href;',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-local-fixture.js')
  assert.match(result.hardened, /http:\/\/www\.w3\.org\/2000\/svg/)
  assert.match(result.hardened, /\/vendor\/whiteboards-editor\/0\.18\.1-clarin\.7\//)
  assert.doesNotMatch(result.hardened, /\/dist\/prod\//)
  assert.equal(result.localFallbacks, 1)
  const resolveFont = new Function(
    'globalThis',
    `${result.hardened}\nreturn fontURL("fonts/Excalifont/Excalifont-Regular.woff2")`,
  )
  assert.equal(
    resolveFont({ location: { origin: 'https://clarin.example.invalid' } }),
    'https://clarin.example.invalid/vendor/whiteboards-editor/0.18.1-clarin.7/fonts/Excalifont/Excalifont-Regular.woff2',
  )
})

test('repairs bundles transformed with a relative fork fallback', () => {
  const source = [
    'const pkg = { name: "@excalidraw/excalidraw", version: "0.18.1-clarin.7" };',
    'const fallback = `/vendor/whiteboards-editor/0.18.1-clarin.7/${pkg.name}@${pkg.version}/dist/prod/`;',
    'const fontURL = (asset) => new URL(asset, fallback).href;',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-legacy-local-fixture.js')
  const resolveFont = new Function(
    'globalThis',
    `${result.hardened}\nreturn fontURL("fonts/Virgil/Virgil.woff2")`,
  )
  assert.equal(result.localFallbacks, 1)
  assert.equal(
    resolveFont({ location: { origin: 'https://clarin.example.invalid' } }),
    'https://clarin.example.invalid/vendor/whiteboards-editor/0.18.1-clarin.7/fonts/Virgil/Virgil.woff2',
  )
})

test('delegates the native library browser only to the audited same-origin start path', () => {
  const source = [
    'const env = { VITE_APP_LIBRARY_URL: "https://libraries.example.invalid" };',
    'const labels = { libraries: "Browse libraries" };',
    'const library = { hint_emptyLibrary: "Select an item on canvas to add it here, or install a library from the public repository, below." };',
    'const makeBrowseLink = ({ libraryReturnUrl, theme, id }) => {',
    '  const referrer = libraryReturnUrl || window.location.origin + window.location.pathname;',
    '  return {',
    '    className: "library-menu-browse-button",',
    '    href: `${env.VITE_APP_LIBRARY_URL}?target=${window.name || "_blank"}&referrer=${referrer}&useHash=true&token=${id}&theme=${theme}&version=${2}`,',
    '    target: "_excalidraw_libraries",',
    '  };',
    '};',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-library-browser-fixture.js')
  assert.equal(result.libraryBrowseRoutes, 1)
  assert.equal(result.securedLibraryBrowseTargets, 1)
  assert.equal(result.rewrittenLibraryBrowseMessages, 1)
  assert.doesNotMatch(result.hardened, /\?target=|useHash=true|VITE_APP_LIBRARY_URL\}/u)
  assert.doesNotMatch(result.hardened, /_excalidraw_libraries/u)
  assert.doesNotMatch(result.hardened, /public repository/u)
  assert.match(result.hardened, /Browse libraries/u)
  assert.match(result.hardened, /library-menu-browse-button/u)

  const buildLink = new Function(
    'globalThis',
    `${result.hardened}\nreturn makeBrowseLink({ libraryReturnUrl: "/ignored", theme: "light", id: "editor" })`,
  )
  const startPath = '/api/whiteboards/11111111-1111-4111-8111-111111111111/public-library-import/start?library_id=22222222-2222-4222-8222-222222222222'
  assert.deepEqual(buildLink({ __CLARIN_WHITEBOARD_LIBRARY_START_URL__: startPath }), {
    className: 'library-menu-browse-button',
    href: startPath,
    target: '_self',
    rel: 'noreferrer',
    referrerPolicy: 'no-referrer',
    'aria-label': 'Explorar bibliotecas. Abre el sitio oficial, que puede usar analítica externa. Clarin validará el archivo antes de guardarlo.',
    title: 'Abre el sitio oficial, que puede usar analítica externa. Clarin validará el archivo antes de guardarlo.',
  })
  assert.equal(
    buildLink({ __CLARIN_WHITEBOARD_LIBRARY_START_URL__: 'https://attacker.example/library' }).href,
    'about:blank#clarin-external-disabled',
  )
})

test('upgrades an already-hardened library button with the complete accessible disclosure', () => {
  const source = [
    'const makeBrowseLink = () => ({',
    '  className: "library-menu-browse-button",',
    '  href: globalThis.__CLARIN_WHITEBOARD_LIBRARY_START_URL__,',
    '  target: "_self",',
    '  rel: "noreferrer",',
    '  referrerPolicy: "no-referrer",',
    '  title: "Clarin validará la biblioteca antes de importarla.",',
    '});',
  ].join('\n')
  const result = hardenEditorBundle(source, 'hardening-legacy-library-browser-fixture.js')
  const buildLink = new Function('globalThis', `${result.hardened}\nreturn makeBrowseLink()`)

  assert.equal(result.securedLibraryBrowseTargets, 1)
  assert.equal(
    buildLink({ __CLARIN_WHITEBOARD_LIBRARY_START_URL__: '/safe' })['aria-label'],
    'Explorar bibliotecas. Abre el sitio oficial, que puede usar analítica externa. Clarin validará el archivo antes de guardarlo.',
  )
  assert.equal(
    buildLink({ __CLARIN_WHITEBOARD_LIBRARY_START_URL__: '/safe' }).title,
    'Abre el sitio oficial, que puede usar analítica externa. Clarin validará el archivo antes de guardarlo.',
  )
})

test('adds one native, idempotent highlighter tool while preserving freedraw scene compatibility', () => {
  const source = [
    'const FreedrawIcon = "draw-icon";',
    'const SHAPES = [{ value: "freedraw", icon: FreedrawIcon }];',
    'const Item = "item";',
    'const jsx = (component, props) => ({ component, props });',
    'const clsx = (name, state) => ({ name, state });',
    'const app = { setActiveTool() {}, state: { activeTool: { type: "selection" } } };',
    'const frameToolSelected = false;',
    'const trigger = clsx("trigger", { "App-toolbar__extra-tools-trigger--selected": frameToolSelected });',
    'const menu = [',
    '  jsx(Item, { onSelect: () => app.setActiveTool({ type: "laser" }), icon: "laser", "data-testid": "toolbar-laser", children: "Laser" }),',
    '  jsx("div", { style: { margin: "6px 0" }, children: "Generate" }),',
    '];',
    'const bind = (owner, key, value) => { owner[key] = value; };',
    'class App {',
    '  constructor() {',
    '    this.state = { currentItemStrokeColor: "#111111", currentItemStrokeWidth: 1, currentItemStrokeVariability: "constant", currentItemOpacity: 100, currentItemRoughness: 1, currentItemStrokeStyle: "dashed" };',
    '    this.setState = (next) => { Object.assign(this.state, typeof next === "function" ? next(this.state) : next); };',
    '    bind(this, "setActiveTool", (tool) => { this.lastTool = tool; });',
    '  }',
    '}',
  ].join('\n')
  const result = hardenEditorBundle(source, 'highlighter-fixture.js')
  assert.equal(result.highlighterMenus, 1)
  assert.equal(result.highlighterToolLifecycles, 1)
  assert.equal(result.hiddenGenerateSections, 1)
  assert.match(result.hardened, /toolbar-highlighter/u)
  assert.match(result.hardened, /children: "Resaltador"/u)
  assert.match(result.hardened, /currentItemStrokeColor: "#FFD43B"/u)
  assert.match(result.hardened, /currentItemStrokeWidth: 4/u)
  assert.match(result.hardened, /currentItemStrokeVariability: "constant"/u)
  assert.match(result.hardened, /currentItemOpacity: 40/u)
  assert.match(result.hardened, /"aria-pressed": app\.__clarinHighlighterActive === true/u)
  assert.match(result.hardened, /setActiveTool\(\{ type: "freedraw" \}\)/u)
  assert.doesNotMatch(result.hardened, /children: "Generate"/u)

  const runtime = new Function(`${result.hardened}\nreturn { App, menu }`)()
  const editor = new runtime.App()
  editor.__clarinHighlighterRequested = true
  editor.setActiveTool({ type: 'freedraw' })
  assert.equal(editor.__clarinHighlighterActive, true)
  assert.deepEqual({
    color: editor.state.currentItemStrokeColor,
    width: editor.state.currentItemStrokeWidth,
    variability: editor.state.currentItemStrokeVariability,
    opacity: editor.state.currentItemOpacity,
    roughness: editor.state.currentItemRoughness,
    style: editor.state.currentItemStrokeStyle,
  }, { color: '#FFD43B', width: 4, variability: 'constant', opacity: 40, roughness: 0, style: 'solid' })
  editor.state.currentItemStrokeColor = '#F59E0B'
  editor.state.currentItemStrokeVariability = 'variable'
  editor.setActiveTool({ type: 'selection' })
  assert.equal(editor.__clarinHighlighterActive, false)
  assert.equal(editor.__clarinHighlighterStyles.currentItemStrokeColor, '#F59E0B')
  assert.equal(editor.__clarinHighlighterStyles.currentItemStrokeVariability, 'variable')
  assert.equal(editor.state.currentItemStrokeColor, '#111111')
  assert.equal(editor.state.currentItemStrokeWidth, 1)
  assert.equal(editor.state.currentItemStrokeVariability, 'constant')
  assert.equal(editor.state.currentItemOpacity, 100)

  editor.state.currentItemStrokeVariability = 'variable'
  editor.__clarinHighlighterRequested = true
  editor.setActiveTool({ type: 'freedraw' })
  assert.equal(editor.state.currentItemStrokeColor, '#F59E0B')
  assert.equal(editor.state.currentItemStrokeVariability, 'variable')

  editor.__clarinHighlighterRequested = true
  editor.setActiveTool({ type: 'freedraw' })
  assert.equal(editor.state.currentItemStrokeColor, '#F59E0B')
  assert.equal(editor.state.currentItemStrokeVariability, 'variable')

  editor.state.currentItemStrokeVariability = 'constant'
  editor.setActiveTool({ type: 'selection' })
  assert.equal(editor.state.currentItemStrokeColor, '#111111')
  assert.equal(editor.state.currentItemStrokeVariability, 'variable')

  editor.__clarinHighlighterRequested = true
  editor.setActiveTool({ type: 'freedraw' })
  assert.equal(editor.state.currentItemStrokeColor, '#F59E0B')
  assert.equal(editor.state.currentItemStrokeVariability, 'constant')
  editor.setActiveTool({ type: 'selection' })
  assert.equal(editor.state.currentItemStrokeVariability, 'variable')

  const repeated = hardenEditorBundle(result.hardened, 'highlighter-fixture-repeated.js')
  assert.equal(repeated.highlighterMenus, 0)
  assert.equal(repeated.highlighterToolLifecycles, 0)
  assert.equal(repeated.hiddenGenerateSections, 0)
  assert.equal(repeated.hardened, result.hardened)

  const driftedIcon = result.hardened.replace(
    /icon: "laser",\s*className: "clarin-highlighter-tool"/u,
    'icon: FreedrawIcon,\n        className: "clarin-highlighter-tool"',
  )
  const normalizedIcon = hardenEditorBundle(driftedIcon, 'highlighter-fixture-icon-drift.js')
  assert.match(normalizedIcon.hardened, /icon: "laser",\s*className: "clarin-highlighter-tool"/u)
})

test('adds one native, idempotent 8 px stroke option after the upstream levels', () => {
  const source = [
    'const STROKE_WIDTH = { thin: 1, bold: 2, extraBold: 4 };',
    'const thinIcon = "thin";',
    'const boldIcon = "bold";',
    'const extraBoldIcon = "extra-bold";',
    'const options = [',
    '  { value: STROKE_WIDTH.thin, text: "Fino", icon: thinIcon, testId: "strokeWidth-thin" },',
    '  { value: STROKE_WIDTH.bold, text: "Grueso", icon: boldIcon, testId: "strokeWidth-bold" },',
    '  { value: STROKE_WIDTH.extraBold, text: "Muy grueso upstream", icon: extraBoldIcon, testId: "strokeWidth-extraBold" },',
    '];',
  ].join('\n')

  const result = hardenEditorBundle(source, 'stroke-width-fixture.js')
  assert.equal(result.ultraBoldStrokeWidths, 1)
  assert.match(result.hardened, /clarin-ultra-bold-stroke/u)
  assert.match(result.hardened, /value: 8/u)
  assert.match(result.hardened, /text: "Muy grueso"/u)
  assert.match(result.hardened, /icon: extraBoldIcon/u)
  assert.match(result.hardened, /testId: "strokeWidth-ultraBold"/u)

  const runtime = new Function(`${result.hardened}\nreturn options`)()
  assert.deepEqual(runtime.map(option => option.value), [1, 2, 4, 8])
  assert.equal(runtime.at(-1).text, 'Muy grueso')
  assert.equal(runtime.at(-1).icon, 'extra-bold')

  const repeated = hardenEditorBundle(result.hardened, 'stroke-width-fixture-repeated.js')
  assert.equal(repeated.ultraBoldStrokeWidths, 0)
  assert.equal(repeated.hardened, result.hardened)
})

test('adds the complete local font catalog, category search and accessible trigger idempotently', async () => {
  const { catalog } = await loadWhiteboardFontCatalog()
  const fontCatalog = runtimeWhiteboardFontCatalog(catalog)
  const source = [
    'const FAMILY = { Virgil: 1, Helvetica: 2, Cascadia: 3, Excalifont: 5, Nunito: 6, "Lilita One": 7, "Comic Shanns": 8, "Liberation Sans": 9 };',
    'const METADATA = {',
    '  [FAMILY.Excalifont]: { metrics: {} }, [FAMILY.Nunito]: { metrics: {} }, [FAMILY["Lilita One"]]: { metrics: {} },',
    '  [FAMILY["Comic Shanns"]]: { metrics: {} }, [FAMILY.Virgil]: { metrics: {} }, [FAMILY.Helvetica]: { metrics: {} }, [FAMILY.Cascadia]: { metrics: {} },',
    '};',
    'const init = () => {}; const faces = [];',
    'function initFonts() {',
    '  init("Cascadia", ...faces); init("Comic Shanns", ...faces); init("Excalifont", ...faces); init("Helvetica", ...faces);',
    '  init("Liberation Sans", ...faces); init("Lilita One", ...faces); init("Nunito", ...faces); init("Virgil", ...faces);',
    '}',
    'const useState = (value) => [value, () => {}]; const useMemo = (callback) => callback(); const useEffect = () => {}; const debounce = (callback) => callback; const t = (key) => key;',
    'const useExcalidrawContainer = () => ({ container: { querySelector: () => null } });',
    'const useApp = () => ({ fonts: { registered: new Map() } });',
    'class Fonts { static registered = new Map(); }',
    'const jsx = (...args) => args;',
    'const ButtonIcon = (props) => { const { title, className, testId, icon, onClick } = props; return jsx("button", { type: "button", title, "data-testid": testId, className, onClick, children: icon }, title); };',
    'const FontPickerList = ({ onHover, onOpen, onClose, onSelect }) => {',
    '  const { container } = useExcalidrawContainer();',
    '  const { fonts } = useApp();',
    '  const allFonts = Array.from(Fonts.registered.entries());',
    '  const [search, setSearch] = useState("");',
    '  const metadata = { icon: "font" }; const item = { value: 1, icon: metadata.icon, text: "Excalifont" };',
    '  const filtered = useMemo(() => [item].filter((font) => font.text.includes(search)), [item, search]);',
    '  const hoveredFont = { value: 1 }; const selectedFontFamily = 1;',
    '  const rendered = { value: item.value, textStyle: { fontFamily: "Excalifont" }, hovered: item.value === hoveredFont.value, selected: item.value === selectedFontFamily, onClick: (event) => { onSelect(Number(event.currentTarget.value)); }, onMouseMove: () => onHover(item.value) };',
    '  const keyboard = { onHover };',
    '  useEffect(() => { onOpen(); return () => onClose(); }, []);',
    '  t("fontList.availableFonts"); t("fontList.sceneFonts");',
    '  return [jsx("QuickSearch", { placeholder: t("quickSearch.placeholder"), onChange: debounce(setSearch, 20) }), filtered, rendered];',
    '};',
    'const FontPickerTrigger = () => { labels.showFonts; return jsx("button", { testId: "font-family-show-fonts", title: t("labels.showFonts") }); };',
  ].join('\n')

  const result = hardenEditorBundle(source, 'font-catalog-fixture.js', fontCatalog)
  assert.equal(result.customFontFamilyCatalogs, 1)
  assert.equal(result.customFontMetadataCatalogs, 1)
  assert.equal(result.customFontRegistrations, 1)
  assert.equal(result.fontPickerCategoryFilters, 1)
  assert.equal(result.fontPickerVisiblePreviews, 0)
  assert.equal(result.fontPickerTriggers, 1)
  assert.equal(result.buttonIconAccessibilityLabels, 1)
  assert.match(result.hardened, /"Clarin Caveat": 10001/u)
  assert.match(result.hardened, /"Clarin IBM Plex Mono": 10025/u)
  assert.match(result.hardened, /clarin-font-category-filters/u)
  assert.doesNotMatch(result.hardened, /clarin-font-(?:visible|preview|lazy-preview)/u)
  assert.doesNotMatch(result.hardened, /__clarinLoadFont(?:Option|Fully)/u)
  assert.doesNotMatch(result.hardened, /IntersectionObserver|document\.fonts\.load|new FontFace|cache: "reload"/u)
  assert.match(result.hardened, /Manuales/u)
  assert.match(result.hardened, /quickSearch\.placeholder/u)
  assert.match(result.hardened, /debounce\(setSearch, 500\)/u)
  assert.match(result.hardened, /\[item, search, __clarinFontCategory\]/u)
  assert.match(result.hardened, /category: metadata\.category \|\| "official"/u)
  assert.match(result.hardened, /clarin-font-display-label[^\n]*metadata\.label/u)
  assert.match(result.hardened, /textStyle: \{ fontFamily: "Excalifont" \}/u)
  assert.match(result.hardened, /"aria-label": "Más fuentes · 32"/u)
  assert.match(result.hardened, /clarin-button-icon-label[^\n]*"aria-label": title/u)

  const repeated = hardenEditorBundle(result.hardened, 'font-catalog-fixture-repeated.js', fontCatalog)
  assert.equal(repeated.customFontFamilyCatalogs, 0)
  assert.equal(repeated.customFontMetadataCatalogs, 0)
  assert.equal(repeated.customFontRegistrations, 0)
  assert.equal(repeated.fontPickerCategoryFilters, 0)
  assert.equal(repeated.fontPickerVisiblePreviews, 0)
  assert.equal(repeated.fontPickerTriggers, 1)
  assert.equal(repeated.buttonIconAccessibilityLabels, 0)
  assert.equal(repeated.hardened, result.hardened)

  assert.throws(
    () => hardenEditorBundle(result.hardened.replace('const allFonts', 'const __clarinLoadFontOption = () => fetch("/font"); const allFonts'), 'font-selector-download-drift.js', fontCatalog),
    /descarga tipográfica activada por interacción/u,
  )
  const minifiedBinding = result.hardened.replace(/icon: metadata\.icon/u, 'icon: R.icon').replace(/category: metadata\.category/u, 'category: metadata.category')
  const repairedBinding = hardenEditorBundle(`const R = { icon: "font" };\n${minifiedBinding}`, 'font-catalog-minified-binding.js', fontCatalog)
  assert.equal(repairedBinding.fontPickerCategoryFilters, 1)
  assert.match(repairedBinding.hardened, /category: R\.category \|\| "official"/u)
  assert.doesNotMatch(repairedBinding.hardened, /category: metadata\.category/u)
  assert.throws(
    () => hardenEditorBundle(result.hardened.replace('"Clarin Caveat": 10001', '"Clarin Caveat": 10002'), 'font-id-drift.js', fontCatalog),
    /ID privado de Caveat cambió/u,
  )
})

test('patches minified return-sequence font initialization without breaking syntax', async () => {
  const { catalog } = await loadWhiteboardFontCatalog()
  const fontCatalog = runtimeWhiteboardFontCatalog(catalog)
  const source = 'const f=()=>{const n=()=>{},x=[];return n("Cascadia",...x),n("Comic Shanns",...x),n("Excalifont",...x),n("Helvetica",...x),n("Liberation Sans",...x),n("Lilita One",...x),n("Nunito",...x),n("Virgil",...x),true};'
  const result = hardenEditorBundle(source, 'font-sequence-fixture.js', fontCatalog)
  assert.equal(result.customFontRegistrations, 1)
  assert.match(result.hardened, /n\("Clarin Caveat",/u)
  assert.match(result.hardened, /n\("Clarin IBM Plex Mono",/u)
  const repeated = hardenEditorBundle(result.hardened, 'font-sequence-fixture-repeated.js', fontCatalog)
  assert.equal(repeated.customFontRegistrations, 0)
  assert.equal(repeated.hardened, result.hardened)
})

test('embeds complete private WOFF2 data in SVG without depending on the upstream subset worker', async () => {
  const { catalog } = await loadWhiteboardFontCatalog()
  const fontCatalog = runtimeWhiteboardFontCatalog(catalog)
  const source = [
    'const subsetWoff2GlyphsByCodepoints = async () => "upstream-subset";',
    'class FontContent {',
    '  constructor() { this.fontFace = { family: "\\\"Clarin Caveat\\\"" }; this.urls = ["/caveat.woff2"]; }',
    '  async fetchFont() { return new Uint8Array([1, 2, 3]).buffer; }',
    '  async getContent(codePoints) { const content = await this.fetchFont(this.urls[0]); return subsetWoff2GlyphsByCodepoints(content, codePoints); }',
    '}',
  ].join('\n')

  const result = hardenEditorBundle(source, 'font-svg-embed-fixture.js', fontCatalog)
  assert.match(result.hardened, /clarin-font-full-svg-embed/u)
  const Content = new Function(`${result.hardened}\nreturn FontContent`)()
  assert.equal(await new Content().getContent([65]), 'data:font/woff2;base64,AQID')

  const repeated = hardenEditorBundle(result.hardened, 'font-svg-embed-fixture-repeated.js', fontCatalog)
  assert.equal(repeated.hardened, result.hardened)
})

test('namespaces private CSS families while preserving their human-facing catalog names', async () => {
  const { catalog } = await loadWhiteboardFontCatalog()
  const fontCatalog = runtimeWhiteboardFontCatalog(catalog)
  assert.equal(fontCatalog.find(entry => entry.family === 'Inter')?.cssFamily, 'Clarin Inter')
  assert.equal(new Set(fontCatalog.map(entry => entry.cssFamily)).size, 25)
  assert.ok(fontCatalog.every(entry => entry.cssFamily.startsWith('Clarin ')))
})

test('keeps the Docker branding policy synchronized with the maintenance skill', async () => {
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
  const localPolicy = JSON.parse(await readFile(resolve(scriptsDirectory, 'visible-branding-policy.json'), 'utf8'))
  const canonicalPolicy = JSON.parse(await readFile(
    resolve(scriptsDirectory, '../../.codex/skills/clarin-excalidraw-development/references/visible-branding-policy.json'),
    'utf8',
  ))

  assert.equal(localPolicy.schemaVersion, canonicalPolicy.schemaVersion)
  assert.equal(localPolicy.policyId, canonicalPolicy.policyId)
  assert.deepEqual(localPolicy.legalArtifactBasenames, canonicalPolicy.legalArtifactBasenames)
  assert.deepEqual(localPolicy.forbiddenVisibleText, canonicalPolicy.forbiddenVisibleText)
})
