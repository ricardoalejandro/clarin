import { describe, expect, it } from 'vitest'
import {
  buildWhiteboardCatalogImportPlan,
  whiteboardCatalogFilename,
  whiteboardLibraryDocument,
  whiteboardLibraryElements,
} from './whiteboardLibraryCatalog'

describe('whiteboard library catalog compatibility', () => {
  it('preserves unknown root fields while Clarin owns the canonical envelope', () => {
    expect(whiteboardLibraryDocument({
      type: 'excalidrawlib', source: 'https://excalidraw.com', libraryItems: [{ id: 'one' }], future: { keep: true },
    })).toMatchObject({
      type: 'excalidrawlib', version: 2, source: 'clarin', libraryItems: [{ id: 'one' }], future: { keep: true },
    })
  })

  it('builds the empty-first promotion plan for image catalogs and strips binary locations', () => {
    const items = [{ id: 'image-item', elements: [{ id: 'image', type: 'image', fileId: 'file-one' }] }]
    const plan = buildWhiteboardCatalogImportPlan({
      rawDocument: { future: 7, files: { ignored: { dataURL: 'data:image/png;base64,AA==' } } },
      officialDocument: { libraryItems: items },
      importedItems: items,
      importedFiles: { 'file-one': { id: 'file-one', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' } },
    })
    expect(plan.referencedFileIDs).toEqual(['file-one'])
    expect(plan.missingFileIDs).toEqual([])
    expect(plan.createDocument.libraryItems).toEqual([])
    expect(plan.document).toMatchObject({ future: 7, files: { 'file-one': { id: 'file-one', mimeType: 'image/png' } } })
    expect(JSON.stringify(plan.document)).not.toContain('data:image')
  })

  it('reports missing binaries, handles malformed items and creates safe filenames', () => {
    const items = [{ elements: [{ type: 'image', fileId: 'missing' }] }, null]
    const plan = buildWhiteboardCatalogImportPlan({ rawDocument: {}, officialDocument: { libraryItems: items }, importedItems: items, importedFiles: {} })
    expect(plan.missingFileIDs).toEqual(['missing'])
    expect(whiteboardLibraryElements(items)).toHaveLength(1)
    expect(whiteboardCatalogFilename('Catálogo Ventas / Perú')).toBe('Catalogo-Ventas-Peru.excalidrawlib')
    expect(whiteboardCatalogFilename('   ')).toBe('catalogo-clarin.excalidrawlib')
  })
})
