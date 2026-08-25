import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'third_party', 'whiteboard-fonts')
const FONT_ROOT = join(ROOT, 'fonts', 'Clarin')
const LICENSE_ROOT = join(ROOT, 'licenses')
const GOOGLE_FONTS_API = 'https://fonts.googleapis.com/css2'
const GOOGLE_FONTS_REPOSITORY = 'https://api.github.com/repos/google/fonts/commits/main'
const GOOGLE_FONTS_RAW = 'https://raw.githubusercontent.com/google/fonts'
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

const definitions = [
  ['Caveat', 'caveat', 'handwriting'],
  ['Kalam', 'kalam', 'handwriting'],
  ['Patrick Hand', 'patrickhand', 'handwriting'],
  ['Architects Daughter', 'architectsdaughter', 'handwriting'],
  ['Permanent Marker', 'permanentmarker', 'handwriting'],
  ['Shadows Into Light', 'shadowsintolight', 'handwriting'],
  ['Gloria Hallelujah', 'gloriahallelujah', 'handwriting'],
  ['Bangers', 'bangers', 'display'],
  ['Bebas Neue', 'bebasneue', 'display'],
  ['Fredoka', 'fredoka', 'display'],
  ['Lobster', 'lobster', 'display'],
  ['Alfa Slab One', 'alfaslabone', 'display'],
  ['Abril Fatface', 'abrilfatface', 'display'],
  ['Inter', 'inter', 'sans'],
  ['Montserrat', 'montserrat', 'sans'],
  ['Poppins', 'poppins', 'sans'],
  ['Raleway', 'raleway', 'sans'],
  ['Quicksand', 'quicksand', 'sans'],
  ['Lora', 'lora', 'serif'],
  ['Merriweather', 'merriweather', 'serif'],
  ['Playfair Display', 'playfairdisplay', 'serif'],
  ['Libre Baskerville', 'librebaskerville', 'serif'],
  ['JetBrains Mono', 'jetbrainsmono', 'mono'],
  ['Space Mono', 'spacemono', 'mono'],
  ['IBM Plex Mono', 'ibmplexmono', 'mono'],
]

const normalizedMetrics = {
  handwriting: { unitsPerEm: 1000, ascender: 900, descender: -300, lineHeight: 1.3 },
  display: { unitsPerEm: 1000, ascender: 900, descender: -250, lineHeight: 1.2 },
  sans: { unitsPerEm: 1000, ascender: 950, descender: -250, lineHeight: 1.25 },
  serif: { unitsPerEm: 1000, ascender: 950, descender: -300, lineHeight: 1.3 },
  mono: { unitsPerEm: 1000, ascender: 950, descender: -250, lineHeight: 1.25 },
}

const sha256 = value => createHash('sha256').update(value).digest('hex')
const slug = family => family.toLowerCase().replace(/[^a-z0-9]+/gu, '-')

async function fetchStrict(url, headers = {}) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'error' })
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`)
  return response
}

async function fetchOptional(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'error' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`)
  return response
}

function parseFontFaces(css, family) {
  const faces = []
  const pattern = /\/\*\s*([^*]+?)\s*\*\/\s*@font-face\s*\{([\s\S]*?)\}/gu
  for (const match of css.matchAll(pattern)) {
    const subset = match[1].trim()
    if (subset !== 'latin' && subset !== 'latin-ext') continue
    const body = match[2]
    const declaredFamily = body.match(/font-family:\s*'([^']+)'/u)?.[1]
    const style = body.match(/font-style:\s*([^;]+);/u)?.[1].trim()
    const weight = body.match(/font-weight:\s*([^;]+);/u)?.[1].trim()
    const uri = body.match(/src:\s*url\(([^)]+)\)\s*format\('woff2'\)/u)?.[1]
    const unicodeRange = body.match(/unicode-range:\s*([^;]+);/u)?.[1].trim()
    if (declaredFamily !== family || style !== 'normal' || !weight?.includes('400') || !uri || !unicodeRange) {
      throw new Error(`Descriptor ${subset} incompleto para ${family}.`)
    }
    faces.push({ subset, sourceURL: uri, unicodeRange })
  }
  if (!faces.some(face => face.subset === 'latin') || new Set(faces.map(face => face.subset)).size !== faces.length) {
    throw new Error(`${family} no entregó un subconjunto Latin WOFF2 válido.`)
  }
  return faces.sort((left, right) => left.subset === 'latin-ext' ? -1 : right.subset === 'latin-ext' ? 1 : 0)
}

await mkdir(FONT_ROOT, { recursive: true })
await mkdir(LICENSE_ROOT, { recursive: true })

const commitResponse = await fetchStrict(GOOGLE_FONTS_REPOSITORY, { accept: 'application/vnd.github+json' })
const sourceCommit = (await commitResponse.json()).sha
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error('Google Fonts no devolvió un commit inmutable válido.')

const entries = []
for (let index = 0; index < definitions.length; index += 1) {
  const [family, repositoryDirectory, category] = definitions[index]
  const id = 10001 + index
  const familySlug = slug(family)
  const cssURL = `${GOOGLE_FONTS_API}?family=${encodeURIComponent(family)}:wght@400&display=swap`
  const css = await (await fetchStrict(cssURL)).text()
  const descriptors = parseFontFaces(css, family)
  const fontFaces = []
  for (const descriptor of descriptors) {
    const bytes = Buffer.from(await (await fetchStrict(descriptor.sourceURL)).arrayBuffer())
    if (bytes.subarray(0, 4).toString('ascii') !== 'wOF2') throw new Error(`${family} ${descriptor.subset} no es WOFF2.`)
    const filename = `${id}-${familySlug}-${descriptor.subset}-400.woff2`
    await writeFile(join(FONT_ROOT, filename), bytes)
    fontFaces.push({
      subset: descriptor.subset,
      file: `fonts/Clarin/${filename}`,
      unicodeRange: descriptor.unicodeRange,
      weight: '400',
      style: 'normal',
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      sourceURL: descriptor.sourceURL,
    })
  }

  let repositoryPath = `ofl/${repositoryDirectory}`
  let licenseName = 'OFL.txt'
  let spdx = 'OFL-1.1'
  let licenseResponse = await fetchOptional(`${GOOGLE_FONTS_RAW}/${sourceCommit}/${repositoryPath}/${licenseName}`)
  if (!licenseResponse) {
    repositoryPath = `apache/${repositoryDirectory}`
    licenseName = 'LICENSE.txt'
    spdx = 'Apache-2.0'
    licenseResponse = await fetchOptional(`${GOOGLE_FONTS_RAW}/${sourceCommit}/${repositoryPath}/${licenseName}`)
  }
  if (!licenseResponse) throw new Error(`No se encontró una licencia oficial para ${family}.`)
  const licenseBytes = Buffer.from(await licenseResponse.arrayBuffer())
  const licenseText = licenseBytes.toString('utf8')
  if (spdx === 'OFL-1.1' && !licenseText.includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error(`Licencia OFL inválida para ${family}.`)
  if (spdx === 'Apache-2.0' && !licenseText.includes('Apache License') && !licenseText.includes('Apache License, Version 2.0')) throw new Error(`Licencia Apache inválida para ${family}.`)
  const licenseFilename = `${id}-${familySlug}-${spdx}.txt`
  await writeFile(join(LICENSE_ROOT, licenseFilename), licenseBytes)

  entries.push({
    id,
    family,
    category,
    metrics: normalizedMetrics[category],
    coverage: fontFaces.map(face => face.subset),
    fontFaces,
    license: {
      spdx,
      file: `licenses/${licenseFilename}`,
      sha256: sha256(licenseBytes),
    },
    origin: {
      provider: 'Google Fonts',
      repository: 'google/fonts',
      repositoryPath,
      commit: sourceCommit,
      stylesheet: cssURL,
    },
  })
}

const catalog = {
  schemaVersion: 1,
  engineVersion: '0.18.1-clarin.5',
  officialSelectableFonts: 7,
  customSelectableFonts: entries.length,
  totalSelectableFonts: 7 + entries.length,
  reservedIDRange: { start: 10001, end: 10025, recyclable: false },
  sourceCommit,
  entries,
}
await writeFile(join(ROOT, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Catálogo local listo: ${entries.length} familias, ${entries.reduce((total, entry) => total + entry.fontFaces.length, 0)} WOFF2, commit ${sourceCommit}.`)
