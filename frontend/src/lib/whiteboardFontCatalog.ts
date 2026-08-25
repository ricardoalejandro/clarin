export type WhiteboardFontCategory = 'handwriting' | 'display' | 'sans' | 'serif' | 'mono'

export interface WhiteboardFontFaceCatalogEntry {
  subset: 'latin' | 'latin-ext'
  file: string
  unicodeRange: string
  weight: '400'
  style: 'normal'
  bytes: number
  sha256: string
}

export interface WhiteboardFontCatalogEntry {
  id: number
  family: string
  category: WhiteboardFontCategory
  metrics: {
    unitsPerEm: number
    ascender: number
    descender: number
    lineHeight: number
  }
  coverage: Array<'latin' | 'latin-ext'>
  fontFaces: WhiteboardFontFaceCatalogEntry[]
  license: {
    spdx: 'OFL-1.1' | 'Apache-2.0'
    file: string
    sha256: string
  }
  origin: {
    provider: 'Google Fonts'
    repository: 'google/fonts'
    repositoryPath: string
    commit: string
  }
}
