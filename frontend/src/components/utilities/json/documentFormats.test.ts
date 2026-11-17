import { describe, expect, it } from 'vitest'
import { DOCUMENT_FORMATS, documentExportExtension, filterDocumentFormats, formatFromFileName, isDocumentFormat, isStructuredFormat } from './documentFormats'
import { documentLanguage } from './editorWorkspaceState'
import { validJsonPreference } from './editorPreferences'

describe('text and code format contract', () => {
  it('recognizes every supported suffix and restores the same independent panel modes', () => {
    for (const format of DOCUMENT_FORMATS) {
      for (const suffix of format.extensions) expect(formatFromFileName(`Example.${suffix.toUpperCase()}`)).toBe(format.id)
      expect(validJsonPreference('json.formats', { a: format.id, b: 'strict' })).toBe(true)
      expect(documentExportExtension(format.id)).toBe(format.extension)
    }
    expect(formatFromFileName('notes.unknown')).toBe('plaintext')
    expect(formatFromFileName('README')).toBe('plaintext')
    expect(isDocumentFormat('other')).toBe(false)
  })

  it('keeps original textual suffixes, uses the chosen mode after switching, and preserves legacy unescape export', () => {
    expect(documentExportExtension('yaml', 'settings.YML')).toBe('yml')
    expect(documentExportExtension('csv', 'data.tsv')).toBe('tsv')
    expect(documentExportExtension('javascript', 'view.jsx')).toBe('jsx')
    expect(documentExportExtension('plaintext', 'notes.unknown')).toBe('unknown')
    expect(documentExportExtension('plaintext', 'README')).toBe('txt')
    expect(documentExportExtension('xml', 'example.json')).toBe('xml')
    expect(documentExportExtension('strict', 'example.json', true)).toBe('txt')
  })

  it('limits structural operations to JSON/JSONC/XML and bounds highlighting for large files', () => {
    const state = { reduced: false, huge: false, plainText: false }
    for (const format of DOCUMENT_FORMATS) {
      expect(isStructuredFormat(format.id)).toBe(['strict', 'jsonc', 'xml'].includes(format.id))
      expect(documentLanguage(format.id, state)).toBe(format.language)
      expect(documentLanguage(format.id, { ...state, huge: true })).toBe('plaintext')
      expect(documentLanguage(format.id, { ...state, plainText: true })).toBe('plaintext')
      if (!isStructuredFormat(format.id)) expect(documentLanguage(format.id, { ...state, reduced: true })).toBe('plaintext')
    }
  })

  it('searches human labels and extensions without interpreting source text', () => {
    expect(filterDocumentFormats('comentarios').map(format => format.id)).toEqual(['jsonc'])
    expect(filterDocumentFormats('  TSX ').map(format => format.id)).toEqual(['typescript'])
    expect(filterDocumentFormats('missing')).toEqual([])
  })
})
