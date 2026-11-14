// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { originalDocumentAsset, prepareUtf8XmlDownload, readDocumentFile } from './documentFile'
import { getXmlDeclaredEncoding, JSON_INPUT_LIMIT, measureDocument, segmentDocumentText } from './jsonLimits'

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
