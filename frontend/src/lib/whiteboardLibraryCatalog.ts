import { referencedWhiteboardFileIDs } from './whiteboardMedia'
import { sanitizeWhiteboardFilesForPersistence } from './whiteboards'

export type WhiteboardLibraryDocument = Record<string, unknown> & { libraryItems: readonly unknown[] }

export function whiteboardLibraryDocument(value: unknown): WhiteboardLibraryDocument {
  const parsed = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    ...parsed,
    type: 'excalidrawlib',
    version: 2,
    source: 'clarin',
    libraryItems: Array.isArray(parsed.libraryItems) ? parsed.libraryItems : [],
  }
}

export function whiteboardLibraryElements(items: readonly unknown[]) {
  return items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const elements = (item as Record<string, unknown>).elements
    return Array.isArray(elements) ? elements : []
  })
}

export function whiteboardCatalogFilename(name: string) {
  const safe = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  return `${safe || 'catalogo-clarin'}.excalidrawlib`
}

export function buildWhiteboardCatalogImportPlan(input: {
  rawDocument: unknown
  officialDocument: unknown
  importedItems: readonly unknown[]
  importedFiles: Record<string, unknown>
}) {
  const raw = input.rawDocument && typeof input.rawDocument === 'object' && !Array.isArray(input.rawDocument)
    ? input.rawDocument as Record<string, unknown>
    : {}
  const official = input.officialDocument && typeof input.officialDocument === 'object' && !Array.isArray(input.officialDocument)
    ? input.officialDocument as Record<string, unknown>
    : {}
  const document = whiteboardLibraryDocument({
    ...raw,
    ...official,
    files: sanitizeWhiteboardFilesForPersistence(input.importedFiles),
  })
  const referencedFileIDs = referencedWhiteboardFileIDs(whiteboardLibraryElements(input.importedItems))
  const missingFileIDs = referencedFileIDs.filter(fileID => !input.importedFiles[fileID])
  return {
    document,
    referencedFileIDs,
    missingFileIDs,
    createDocument: referencedFileIDs.length > 0 ? { ...document, libraryItems: [] } : document,
  }
}
