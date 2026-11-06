// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { processJson, type JsonOperation } from './jsonOperations'
import { JSON_INPUT_LIMIT } from './jsonLimits'

function process(operation: JsonOperation, source: string, mode: 'strict' | 'jsonc' = 'strict') {
  return processJson({ operation, source, mode, indent: '2' })
}

describe('JSON operations', () => {
  it('formats and compacts without parsing numbers and keys into JavaScript objects', () => {
    const raw = '{"id":9007199254740993,"id":-0,"price":1.000e+3,"literal":"\\u0061 // no comment"}'
    const formatted = process('format', raw)
    expect(formatted).toMatchObject({ ok: true, text: expect.stringContaining('  "id": 9007199254740993') })
    if (!formatted.ok || formatted.text === undefined) throw new Error('Expected formatted JSON')
    expect(formatted.warnings).toEqual([expect.stringContaining('repetidas'), expect.stringContaining('precisión')])
    expect(process('minify', formatted.text)).toMatchObject({ ok: true, text: raw })
    expect(process('validate', '[{"id":1},{"id":2}]')).toMatchObject({ ok: true, warnings: [] })
  })

  it('validates strict JSON with line and column and preserves JSONC comments', () => {
    const source = '{\n // comentario\n "id":1,\n}'
    expect(process('validate', source)).toEqual({ ok: false, message: expect.stringContaining('línea 2, columna 2'), line: 2, column: 2 })
    expect(process('minify', source, 'jsonc')).toMatchObject({ ok: true, text: '{// comentario\n"id":1,}', extension: 'jsonc' })
    expect(process('format', source, 'jsonc')).toMatchObject({ ok: true, text: expect.stringContaining('// comentario') })
    expect(process('validate', '{"id":1,}')).toMatchObject({ ok: false })
  })

  it('escapes and unwraps one layer without mutating nested content', () => {
    const content = '{"nombre":"Línea\\n🎉"}'
    const quoted = JSON.stringify(content)
    expect(process('escape', content)).toMatchObject({ ok: true, text: quoted })
    expect(process('unescape', JSON.stringify(quoted))).toMatchObject({ ok: true, text: quoted })
    expect(process('unescape', quoted)).toMatchObject({ ok: true, text: content })
    expect(process('unescape', '""')).toMatchObject({ ok: true, text: '' })
    expect(process('unescape', content)).toMatchObject({ ok: false })
  })

  it('shows original text that a repair can remove', () => {
    const ambiguous = '{//id://dfdf}'
    expect(process('repair', ambiguous)).toMatchObject({ ok: true, text: '{}', changedSource: '//id://dfdf' })
    expect(process('repair', "{id:'abc',}")).toMatchObject({ ok: true, text: '{"id":"abc"}' })
    expect(process('repair', '{"id":1}')).toMatchObject({ ok: true, text: '{"id":1}', changedSource: undefined })
  })

  it('bounds byte size and nesting', () => {
    expect(process('validate', 'ñ'.repeat(JSON_INPUT_LIMIT / 2 + 1))).toMatchObject({ ok: false, message: expect.stringContaining('25 MiB') })
    expect(process('format', `${'['.repeat(161)}0${']'.repeat(161)}`)).toMatchObject({ ok: false, message: expect.stringContaining('160 niveles') })
    expect(process('repair', ' '.repeat(2 * 1024 * 1024 + 1))).toMatchObject({ ok: false, message: expect.stringContaining('2 MiB') })
    expect(process('escape', '\0'.repeat(9 * 1024 * 1024))).toMatchObject({ ok: false, message: expect.stringContaining('50 MiB') })
  }, 20_000)

  it('formats an input of exactly 25 MiB and reports the resulting longest line', () => {
    const prefix = '{"id":9007199254740993,"value":"'
    const suffix = '"}'
    const source = prefix + 'x'.repeat(JSON_INPUT_LIMIT - prefix.length - suffix.length) + suffix
    const result = process('format', source)
    expect(result).toMatchObject({ ok: true, metrics: { lines: 4, longestLine: expect.any(Number) } })
    if (!result.ok || !result.text || !result.metrics) throw new Error('Expected formatted document')
    expect(result.text.startsWith('{\n  "id": 9007199254740993,\n  "value": "')).toBe(true)
    expect(result.metrics.bytes).toBeGreaterThan(JSON_INPUT_LIMIT)
    expect(result.metrics.longestLine).toBeGreaterThan(100_000)
  }, 20_000)

  it('formats comments around colons and commas without changing the JSONC tokens', () => {
    const source = '{ /* start */ "a" // key\n: 1 // value\n, "b": [/* nested */ 2,], } // end'
    const original = process('minify', source, 'jsonc')
    const formatted = process('format', source, 'jsonc')
    if (!formatted.ok || !formatted.text) throw new Error('Expected formatted JSONC')
    expect(process('minify', formatted.text, 'jsonc')).toEqual(original)
  })

  it('keeps short containers inline and expands only containers that cannot fit', () => {
    expect(process('smart', '{"id":9007199254740993,"items":[1,2,3]}')).toMatchObject({ ok: true, text: '{"id": 9007199254740993, "items": [1, 2, 3]}' })
    const long = 'x'.repeat(100)
    const source = `{"short":[1,2,3],"long":["${long}","end"],"other":{"a":1,"b":2}}`
    const formatted = `{
  "short": [1, 2, 3],
  "long": [
    "${long}",
    "end"
  ],
  "other": {"a": 1, "b": 2}
}`
    expect(process('smart', source)).toMatchObject({ ok: true, text: formatted })
    expect(process('smart', formatted)).toMatchObject({ ok: true, text: formatted })
  })

  it('keeps the 100-column boundary, preserves comments and performs no repair or unwrapping', () => {
    const fit = `["${'x'.repeat(96)}"]`
    expect(fit).toHaveLength(100)
    expect(process('smart', fit)).toMatchObject({ ok: true, text: fit })
    expect(process('smart', `["${'x'.repeat(97)}"]`)).toMatchObject({ ok: true, metrics: { lines: 3 } })
    expect(process('smart', '[1,// note\n2]', 'jsonc')).toMatchObject({ ok: true, text: '[\n  1,\n  // note\n  2\n]' })
    expect(process('smart', '{name:1}')).toMatchObject({ ok: false, line: 1 })
    const escaped = JSON.stringify('{"name":1}')
    expect(process('smart', escaped)).toMatchObject({ ok: true, text: escaped })
  })
})
