import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const WHITEBOARD_CUSTOM_FONT_DEFINITIONS = [
  [10001, 'Caveat', 'handwriting'], [10002, 'Kalam', 'handwriting'], [10003, 'Patrick Hand', 'handwriting'],
  [10004, 'Architects Daughter', 'handwriting'], [10005, 'Permanent Marker', 'handwriting'], [10006, 'Shadows Into Light', 'handwriting'],
  [10007, 'Gloria Hallelujah', 'handwriting'], [10008, 'Bangers', 'display'], [10009, 'Bebas Neue', 'display'],
  [10010, 'Fredoka', 'display'], [10011, 'Lobster', 'display'], [10012, 'Alfa Slab One', 'display'],
  [10013, 'Abril Fatface', 'display'], [10014, 'Inter', 'sans'], [10015, 'Montserrat', 'sans'],
  [10016, 'Poppins', 'sans'], [10017, 'Raleway', 'sans'], [10018, 'Quicksand', 'sans'],
  [10019, 'Lora', 'serif'], [10020, 'Merriweather', 'serif'], [10021, 'Playfair Display', 'serif'],
  [10022, 'Libre Baskerville', 'serif'], [10023, 'JetBrains Mono', 'mono'], [10024, 'Space Mono', 'mono'],
  [10025, 'IBM Plex Mono', 'mono'],
]

const sha256 = value => createHash('sha256').update(value).digest('hex')
const validCategories = new Set(['handwriting', 'display', 'sans', 'serif', 'mono'])

export async function loadWhiteboardFontCatalog(frontendRoot = process.cwd()) {
  const root = join(frontendRoot, 'third_party', 'whiteboard-fonts')
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))
  return { catalog, root }
}

export async function verifyWhiteboardFontCatalog(catalog, root) {
  if (catalog.schemaVersion !== 1 || catalog.engineVersion !== '0.18.1-clarin.6') throw new Error('Versión inválida del catálogo de fuentes.')
  if (catalog.officialSelectableFonts !== 7 || catalog.customSelectableFonts !== 25 || catalog.totalSelectableFonts !== 32) throw new Error('El catálogo debe declarar exactamente 32 fuentes seleccionables (7 oficiales + 25 Clarin).')
  if (catalog.reservedIDRange?.start !== 10001 || catalog.reservedIDRange?.end !== 10025 || catalog.reservedIDRange?.recyclable !== false) throw new Error('El rango privado 10001–10025 debe permanecer reservado y no reciclable.')
  if (!Array.isArray(catalog.entries) || catalog.entries.length !== WHITEBOARD_CUSTOM_FONT_DEFINITIONS.length) throw new Error('El catálogo debe contener exactamente 25 familias Clarin.')
  const ids = new Set()
  const families = new Set()
  let fontFaceCount = 0
  for (let index = 0; index < WHITEBOARD_CUSTOM_FONT_DEFINITIONS.length; index += 1) {
    const entry = catalog.entries[index]
    const [id, family, category] = WHITEBOARD_CUSTOM_FONT_DEFINITIONS[index]
    if (entry.id !== id || entry.family !== family || entry.category !== category) throw new Error(`La entrada ${index + 1} no respeta el ID/familia/categoría reservados.`)
    if (ids.has(entry.id) || families.has(entry.family)) throw new Error(`ID o familia duplicados: ${entry.family}.`)
    ids.add(entry.id); families.add(entry.family)
    if (!validCategories.has(entry.category) || !entry.metrics || entry.metrics.unitsPerEm <= 0 || entry.metrics.lineHeight < 1) throw new Error(`Métricas inválidas para ${entry.family}.`)
    if (!entry.coverage?.includes('latin')) throw new Error(`${entry.family} debe incluir cobertura Latin.`)
    if (!Array.isArray(entry.fontFaces) || entry.fontFaces.length < 1 || entry.fontFaces.length > 2) throw new Error(`Cantidad de archivos inválida para ${entry.family}.`)
    for (const face of entry.fontFaces) {
      if (face.weight !== '400' || face.style !== 'normal' || !['latin', 'latin-ext'].includes(face.subset)) throw new Error(`Descriptor inválido para ${entry.family}.`)
      const bytes = await readFile(join(root, face.file))
      if (bytes.subarray(0, 4).toString('ascii') !== 'wOF2' || bytes.byteLength !== face.bytes || sha256(bytes) !== face.sha256) throw new Error(`Hash o formato WOFF2 inválido para ${entry.family} (${face.subset}).`)
      fontFaceCount++
    }
    const license = await readFile(join(root, entry.license.file))
    if (sha256(license) !== entry.license.sha256) throw new Error(`Hash de licencia inválido para ${entry.family}.`)
    const licenseText = license.toString('utf8')
    if (entry.license.spdx === 'OFL-1.1' && !licenseText.includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error(`Licencia OFL inválida para ${entry.family}.`)
    if (entry.license.spdx === 'Apache-2.0' && !licenseText.includes('Apache License')) throw new Error(`Licencia Apache inválida para ${entry.family}.`)
    if (entry.origin.provider !== 'Google Fonts' || entry.origin.repository !== 'google/fonts' || !/^[0-9a-f]{40}$/u.test(entry.origin.commit)) throw new Error(`Origen no auditable para ${entry.family}.`)
  }
  if (fontFaceCount !== 49) throw new Error(`Se esperaban 49 archivos WOFF2 y se encontraron ${fontFaceCount}.`)
  return { customFonts: catalog.entries.length, fontFaces: fontFaceCount, totalSelectableFonts: catalog.totalSelectableFonts }
}

export function runtimeWhiteboardFontCatalog(catalog) {
  return catalog.entries.map(entry => ({
    id: entry.id,
    family: entry.family,
    cssFamily: `Clarin ${entry.family}`,
    category: entry.category,
    metrics: entry.metrics,
    fontFaces: entry.fontFaces.map(face => ({
      uri: `./${face.file}`,
      descriptors: { unicodeRange: face.unicodeRange, weight: face.weight, style: face.style },
    })),
  }))
}
