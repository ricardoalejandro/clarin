// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { readDocumentFile } from './documentFile'
import { getXmlDeclaredEncoding, JSON_INPUT_LIMIT, measureDocument, segmentDocumentText } from './jsonLimits'

it('checks file size before reading and rejects invalid UTF-8 without replacement characters', async () => {
  const arrayBuffer = vi.fn()
  const oversize = { size: JSON_INPUT_LIMIT + 1, name: 'data.json', arrayBuffer } as unknown as File
  expect(await readDocumentFile(oversize)).toMatchObject({ ok: false, message: expect.stringContaining('25 MiB') })
  expect(arrayBuffer).not.toHaveBeenCalled()
  expect(await readDocumentFile(new File([Uint8Array.from([0xff, 0xfe, 0x7b, 0x00])], 'data.json'))).toMatchObject({ ok: false, message: expect.stringContaining('UTF-8') })
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
