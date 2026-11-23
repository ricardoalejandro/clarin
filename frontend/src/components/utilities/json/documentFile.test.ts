// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { originalDocumentAsset, prepareUtf8XmlDownload, readDocumentFile } from './documentFile'
import { getXmlDeclaredEncoding, JSON_INPUT_LIMIT, measureDocument, segmentDocumentText } from './jsonLimits'
import { DOCUMENT_FORMATS } from './documentFormats'

it('opens supported text/code files and unknown text without JSON/XML coercion, rejecting binary nulls', async () => {
  const source = 'first, Pe\u00f1a\r\nsecond, \u4e2d\u6587 \ud83d\ude00\n'
  for (const format of DOCUMENT_FORMATS) {
    expect(await readDocumentFile(new File([source], `sample.${format.extension}`))).toMatchObject({ ok: true, source, syntaxHint: format.id })
  }
  expect(await readDocumentFile(new File(['<root/>'], 'literal.unknown'))).toMatchObject({ ok: true, source: '<root/>', syntaxHint: 'plaintext' })
  expect(await readDocumentFile(new File(['a\u0000b'], 'binary.txt'))).toMatchObject({ ok: false, message: expect.stringContaining('binarios') })
})

it('checks file size before reading and rejects invalid UTF-8 without replacement characters', async () => {
  const arrayBuffer = vi.fn()
  const oversize = { size: JSON_INPUT_LIMIT + 1, name: 'data.json', arrayBuffer } as unknown as File
  expect(await readDocumentFile(oversize)).toMatchObject({ ok: false, message: expect.stringContaining('60 MiB') })
  expect(arrayBuffer).not.toHaveBeenCalled()
  expect(await readDocumentFile(new File([Uint8Array.from([0xff, 0x7b])], 'data.json'))).toMatchObject({ ok: false, encodingConflict: true, message: expect.stringContaining('UTF-8') })
})

it('detects UTF-16 XML and preserves original declaration until explicit UTF-8 export', async () => {
  const source = '<?xml version="1.0" encoding="UTF-16"?><r>ñ😀</r>'
  const bytes = new Uint8Array(2 + source.length * 2)
  bytes.set([0xff, 0xfe])
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < source.length; index++) view.setUint16(2 + index * 2, source.charCodeAt(index), true)
  expect(await readDocumentFile(new File([bytes], 'utf16.xml'))).toMatchObject({ ok: true, source, encoding: 'utf-16le', converted: true })
  expect(prepareUtf8XmlDownload(source, false)).toEqual({ ok: true, source: source.replace('UTF-16', 'UTF-8') })
  expect(prepareUtf8XmlDownload(source, true)).toMatchObject({ ok: false })
  const original = originalDocumentAsset(new File([bytes], 'utf16.xml', { type: 'application/xml' }))
  expect(original.type).toBe('application/octet-stream')
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes)
})

it('requires an explicit choice for BOM/declaration conflicts and supports real ISO-8859-1', async () => {
  const source = '<?xml version="1.0" encoding="ISO-8859-1"?><r>ñ</r>'
  const file = new File(['\uFEFF', source], 'conflict.xml')
  expect(await readDocumentFile(file)).toMatchObject({ ok: false, encodingConflict: true })
  expect(await readDocumentFile(file, 'utf-8')).toMatchObject({ ok: true, source })
  const bytes = Uint8Array.from([...source].map(char => char.charCodeAt(0)))
  expect(await readDocumentFile(new File([bytes], 'latin.xml'))).toMatchObject({ ok: true, source, encoding: 'iso-8859-1' })
  expect(await readDocumentFile(new File([Uint8Array.from([0x80])], 'latin.txt'), 'iso-8859-1')).toMatchObject({ ok: true, source: '\u0080' })
})

it('reads XML source with a UTF-8 BOM and exposes metadata without normalizing interior whitespace', async () => {
  const source = '<?xml version="1.0" encoding="UTF-8"?>\r\n<r>ñ😀\rdata</r>'
  expect(await readDocumentFile(new File(['\uFEFF', source], 'data.XML'))).toEqual({
    ok: true, source, syntaxHint: 'xml', metrics: measureDocument(source), xmlEncoding: 'UTF-8',
  })
  expect(await readDocumentFile(new File(['{}'], 'data.jsonc'))).toMatchObject({ ok: true, syntaxHint: 'jsonc' })
})

it('counts UTF-8 bytes and physical lines, and slices giant view chunks across surrogate pairs', () => {
  const source = 'a😀\r\nñ\rb\n'
  expect(measureDocument(source)).toEqual({ bytes: new TextEncoder().encode(source).byteLength, lines: 4, longestLine: 3 })
  expect(segmentDocumentText('abcd😀rest', 5)).toEqual(['abcd', '😀res', 't'])
  expect(measureDocument('')).toEqual({ bytes: 0, lines: 1, longestLine: 0 })
  expect(getXmlDeclaredEncoding('<?xml-stylesheet encoding="ISO-8859-1"?><r/>')).toBeUndefined()
})

it('offers a legacy candidate for invalid UTF-8 and applies it only after an explicit choice', async () => {
  const source = '<?xml version="1.0" encoding="UTF-8"?><r name="Peña">“café” €</r>'
  const encoded = [...source].map(char => ({ '“': 0x93, '”': 0x94, '€': 0x80 })[char as '“' | '”' | '€'] ?? char.charCodeAt(0))
  const bytes = Uint8Array.from(encoded)
  const file = new File([bytes], 'legacy.xml')
  const result = await readDocumentFile(file)
  expect(result).toMatchObject({ ok: false, encodingConflict: true, suggestedEncoding: 'windows-1252' })
  expect(result).not.toHaveProperty('source')
  const accepted = await readDocumentFile(file, 'windows-1252')
  expect(accepted).toMatchObject({ ok: true, source, encoding: 'windows-1252', warnings: [expect.stringContaining('el XML declara UTF-8')] })
  expect(new Uint8Array(await originalDocumentAsset(file).arrayBuffer())).toEqual(bytes)
})

it('requires a choice when a legacy XML declaration would garble otherwise valid UTF-8', async () => {
  const source = '<?xml version="1.0" encoding="ISO-8859-1"?><r>Peña, café, €</r>'
  const file = new File([source], 'ambiguous.xml')
  expect(await readDocumentFile(file)).toMatchObject({ ok: false, encodingConflict: true, suggestedEncoding: 'utf-8' })
  expect(await readDocumentFile(file, 'utf-8')).toMatchObject({ ok: true, source, warnings: [expect.stringContaining('el XML declara ISO-8859-1')] })
  const legacy = await readDocumentFile(file, 'iso-8859-1')
  expect(legacy.ok && legacy.source.includes('PeÃ±a')).toBe(true)
  expect(await readDocumentFile(new File(['<?xml version="1.0" encoding="ISO-8859-1"?><r>ASCII</r>'], 'ascii.xml'))).toMatchObject({ ok: true, encoding: 'iso-8859-1' })
})

it('checks UTF-8 beyond the header and handles a multibyte sequence across bounded decoder blocks', async () => {
  const prefix = '<?xml version="1.0" encoding="windows-1252"?><r>'
  const source = prefix + 'x'.repeat(65_535 - prefix.length) + 'ñ' + 'x'.repeat(80_000) + '😀</r>'
  expect(await readDocumentFile(new File([source], 'distant.xml'))).toMatchObject({ ok: false, suggestedEncoding: 'utf-8' })
  expect(await readDocumentFile(new File([source], 'distant.xml'), 'utf-8')).toMatchObject({ ok: true, source })
})

it('reports a replacement character already encoded in the original without rewriting or promising recovery', async () => {
  const source = '<?xml version="1.0" encoding="UTF-8"?><r>Shop � ñ 😀</r>'
  const file = new File([source], 'replacement.xml')
  const result = await readDocumentFile(file)
  expect(result).toMatchObject({ ok: true, source, warnings: [expect.stringContaining('ya contiene caracteres de sustitución')] })
  expect(result).not.toHaveProperty('suggestedEncoding')
  expect(await originalDocumentAsset(file).text()).toBe(source)
  expect(await readDocumentFile(new File(['<r>Peña, 中文, 😀</r>'], 'unicode.xml'))).toMatchObject({ ok: true, source: '<r>Peña, 中文, 😀</r>' })
  expect(await readDocumentFile(new File(['<r>Peña, 中文, 😀</r>'], 'unicode.xml'))).not.toHaveProperty('warnings')
})

it('keeps BOM conflicts explicit and does not recommend a single-byte encoding for binary data', async () => {
  const source = '<?xml version="1.0" encoding="ISO-8859-1"?><r>ñ</r>'
  const file = new File(['\uFEFF', source], 'signature.xml')
  expect(await readDocumentFile(file)).toMatchObject({ ok: false, encodingConflict: true, suggestedEncoding: 'utf-8' })
  expect(await readDocumentFile(file, 'utf-8')).toMatchObject({ ok: true, source, warnings: [expect.stringContaining('el XML declara ISO-8859-1')] })
  expect(await readDocumentFile(new File([Uint8Array.from([0, 0xff, 0xfe, 0])], 'binary.dat'))).not.toHaveProperty('suggestedEncoding')
})
