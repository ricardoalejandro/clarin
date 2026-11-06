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
    expect(process('validate', source)).toEqual({ ok: false, message: expect.stringContaining('línea 2, columna 2') })
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
    expect(process('validate', 'ñ'.repeat(JSON_INPUT_LIMIT / 2 + 1))).toMatchObject({ ok: false, message: expect.stringContaining('2 MiB') })
    expect(process('format', `${'['.repeat(161)}0${']'.repeat(161)}`)).toMatchObject({ ok: false, message: expect.stringContaining('160 niveles') })
  })
})
