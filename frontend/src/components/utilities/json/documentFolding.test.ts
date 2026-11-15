import { describe, expect, it } from 'vitest'
import { DOCUMENT_DEPTH_LIMIT } from './jsonLimits'
import { DocumentFoldingScanner, FOLD_MAX_REGIONS } from './documentFolding'

function scan(source: string, format: 'json' | 'xml', size = source.length || 1) {
  const scanner = new DocumentFoldingScanner(format)
  for (let start = 0; start < source.length; start += size) scanner.append(source.slice(start, start + size))
  return scanner.finish()
}

describe('streaming structural folding', () => {
  it('folds JSON containers without treating escaped strings, numbers or JSONC comments as structure', () => {
    const source = ['{', '"string":"{ \\" [ ] }",', '"data":[', '1,', '{"x":false}', ']', '}'].join('\n')
    const result = scan(source, 'json')
    expect(result).toEqual({ ranges: [{ start: 1, end: 6 }, { start: 3, end: 5 }], reason: undefined })
    for (const size of [1, 2, 3, 7, 64]) expect(scan(source, 'json', size)).toEqual(result)
    expect(scan(['{', '/* {', ' ]', '*/', '"value":true // }', '}'].join('\n'), 'json', 1).ranges).toEqual([
      { start: 1, end: 5 }, { start: 2, end: 3, kind: 'comment' },
    ])
  })

  it('matches XML qualified names and ignores quoted markup, comments, CDATA and instructions', () => {
    const source = ['<r:Root xmlns:r="urn:r" test=">">', '<!-- <fake>', '</r:Root>', '-->', '<r:Body value="</wrong>">', '<![CDATA[', '<bad></r:Body>', ']]>', '<r:Leaf/>', '</r:Body>', '</r:Root>'].join('\n')
    const result = { ranges: [{ start: 1, end: 10 }, { start: 2, end: 3, kind: 'comment' }, { start: 5, end: 9 }, { start: 6, end: 7, kind: 'region' }], reason: undefined }
    expect(scan(source, 'xml')).toEqual(result)
    for (const size of [1, 2, 3, 9, 64]) expect(scan(source, 'xml', size)).toEqual(result)
    const pi = ['<?instruction', '<ignored>', '?>', '<Root', ' attr="a > / <"', '>', '<Leaf', ' attr="v"', '/>', '</Root>'].join('\n')
    expect(scan(pi, 'xml', 1).ranges).toEqual([{ start: 1, end: 2, kind: 'region' }, { start: 4, end: 9 }, { start: 7, end: 8 }])
  })

  it('keeps CRLF, Unicode names and surrogate pairs coherent at every block boundary', () => {
    const xml = '<raíz>\r\n<niño valor="😀">\r\nárbol\r\n</niño>\r\n</raíz>'
    const json = '{\r\n"😀":[\r\n"\\\" } 😀",\r\ntrue\r\n]\r\n}'
    for (const [source, format] of [[xml, 'xml'], [json, 'json']] as const) {
      const whole = scan(source, format)
      expect(whole.reason).toBeUndefined()
      for (let size = 1; size < source.length; size++) expect(scan(source, format, size)).toEqual(whole)
    }
    expect(scan(xml, 'xml').ranges).toEqual([{ start: 1, end: 4 }, { start: 2, end: 3 }])
  })

  it('retains closed safe sections while editing incomplete or mismatched documents', () => {
    expect(scan('[\n{\n"x":1\n},\n[}', 'json', 1)).toEqual({ ranges: [{ start: 2, end: 3 }], reason: 'syntax' })
    expect(scan('<Root>\n<Good>\nx\n</Good>\n<Bad>\n</Wrong>\n</Root>', 'xml', 2)).toEqual({ ranges: [{ start: 2, end: 3 }], reason: 'syntax' })
    expect(scan('<x>\nx\n</X>', 'xml').ranges).toEqual([])
    expect(scan('<!DOCTYPE Root SYSTEM "https://invalid.example">\n<Root>\nx\n</Root>', 'xml', 1)).toEqual({ ranges: [], reason: 'doctype' })
    expect(scan('{"nested": {\n"value":1\n}}', 'json').ranges).toEqual([{ start: 1, end: 2 }])
    expect(scan('{"single": [1,2,3]}', 'json').ranges).toEqual([])
  })

  it('bounds candidate storage while preserving the root and the earliest shallow sections', () => {
    const source = '[\n' + '{\n"number":123\n},\n'.repeat(FOLD_MAX_REGIONS + 20) + ']'
    const result = scan(source, 'json', 65536)
    expect(result.reason).toBe('regions')
    expect(result.ranges).toHaveLength(FOLD_MAX_REGIONS)
    expect(result.ranges[0]).toEqual({ start: 1, end: 3 * (FOLD_MAX_REGIONS + 20) + 1 })
    expect(result.ranges[1]).toEqual({ start: 2, end: 3 })
    expect(result.ranges.at(-1)?.start).toBe(2 + 3 * (FOLD_MAX_REGIONS - 2))
  })

  it('uses the canonical depth limit and never interprets a huge opaque token as nesting', () => {
    const allowed = '{\n'.repeat(DOCUMENT_DEPTH_LIMIT) + '1\n' + '}\n'.repeat(DOCUMENT_DEPTH_LIMIT)
    expect(scan(allowed, 'json', 1).reason).toBeUndefined()
    expect(scan('{\n0\n}\n' + '{\n'.repeat(DOCUMENT_DEPTH_LIMIT + 1), 'json', 1)).toEqual({ ranges: [{ start: 1, end: 2 }], reason: 'depth' })
    const scanner = new DocumentFoldingScanner('xml')
    scanner.append('<Root>\n<![CDATA[\n')
    for (let index = 0; index < 64; index++) scanner.append('<fake>{[😀]}'.repeat(4096))
    scanner.append('\n]]>\n</Root>')
    expect(scanner.finish()).toEqual({ ranges: [{ start: 1, end: 4 }, { start: 2, end: 3, kind: 'region' }], reason: undefined })
  })
})
