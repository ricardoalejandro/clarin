// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { processJson, type JsonOperation } from './jsonOperations'

function process(operation: JsonOperation, source: string, xmlSpacing: 'safe' | 'structure' = 'safe') {
  return processJson({ operation, source, xmlSpacing, language: 'xml', mode: 'strict', indent: '2' })
}

describe('local XML operations', () => {
  it('accepts XML 1.0 namespaces and reports locations for malformed documents', () => {
    expect(process('validate', '<?xml version="1.0"?><p:r xmlns:p="urn:example"/>')).toMatchObject({ ok: true })
    expect(process('validate', '<r>\n<p:a/>\n</r>')).toMatchObject({ ok: false, line: 2, message: expect.stringContaining('Prefijo') })
    expect(process('validate', '<r>\n<x></r>')).toMatchObject({ ok: false, line: 2 })
    expect(process('validate', '<x/><y/>')).toMatchObject({ ok: false })
    expect(process('validate', '<r a="1" a="2"/>')).toMatchObject({ ok: false })
    expect(process('validate', '<r>&#0;</r>')).toMatchObject({ ok: false })
    expect(process('validate', '<?xml version="1.1"?><r/>')).toMatchObject({ ok: false, message: expect.stringContaining('XML 1.0') })
  })

  it('blocks external and internal DTDs and preserves CDATA and comment text that resembles declarations', () => {
    expect(process('validate', '<!DOCTYPE r SYSTEM "https://example.invalid/dtd"><r/>')).toMatchObject({ ok: false, message: expect.stringContaining('DOCTYPE') })
    expect(process('format', '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///sensitive">]><r>&x;</r>')).toMatchObject({ ok: false, message: expect.stringContaining('DOCTYPE') })
    const source = '<r><!-- <!DOCTYPE root> --><![CDATA[<!DOCTYPE root>]]>&amp;&#x20;</r>'
    expect(process('minify', source, 'structure')).toMatchObject({ ok: true, text: source })
    expect(process('validate', '<r>&unknown;</r>')).toMatchObject({ ok: false, message: expect.stringContaining('Entidad') })
  })

  it('formats only markup whitespace by default, retaining raw XML content and attributes', () => {
    const source = '<?xml version="1.0"?>\r\n<?target hello <? stay?>\r\n<r a = "x>y"\n b = \'&amp;\'><x>  </x>\r\n<!-- keep <tag> -->\n<y />\n</r>'
    const result = process('format', source)
    expect(result).toMatchObject({ ok: true, text: '<?xml version="1.0"?>\n<?target hello <? stay?>\n<r\n  a="x>y"\n  b=\'&amp;\'><x>  </x>\r\n<!-- keep <tag> -->\n<y />\n</r>' })
    expect(process('minify', source)).toMatchObject({ ok: true, text: '<?xml version="1.0"?><?target hello <? stay?><r a="x>y" b=\'&amp;\'><x>  </x>\r\n<!-- keep <tag> -->\n<y/>\n</r>' })
  })

  it('changes structural gaps only when requested and protects mixed content and whitespace references', () => {
    const source = '<r><a/><p>Hola <b>mundo</b> !</p><w><x/>&#x20;<y/></w><z>  </z></r>'
    expect(process('format', source)).toMatchObject({ ok: true, text: '<r><a /><p>Hola <b>mundo</b> !</p><w><x/>&#x20;<y/></w><z>  </z></r>' })
    const formatted = process('format', source, 'structure')
    expect(formatted).toMatchObject({ ok: true, text: '<r>\n  <a />\n  <p>Hola <b>mundo</b> !</p>\n  <w><x/>&#x20;<y/></w>\n  <z>  </z>\n</r>', extension: 'xml' })
    if (!formatted.ok || !formatted.text) throw new Error('Expected formatted XML')
    expect(process('minify', formatted.text, 'structure')).toMatchObject({ ok: true, text: source })
  })

  it('inherits xml:space and honors its default override only inside the child', () => {
    const source = '<r xml:space="pre&#115;erve"> <a   /> <b xml:space="default"><c/></b> </r>'
    const result = process('format', source, 'structure')
    expect(result).toMatchObject({ ok: true, text: '<r xml:space="pre&#115;erve"> <a   /> <b xml:space="default">\n    <c />\n  </b> </r>' })
    expect(process('minify', '<r xml:space="custom"> <x   /> </r>', 'structure')).toMatchObject({ ok: true, text: '<r xml:space="custom"> <x   /> </r>' })
  })

  it('protects signed XML and reports declared encoding for download decisions', () => {
    const signed = '<r xmlns:s="http://www.w3.org/2000/09/xmldsig#"><s:Signature/></r>'
    expect(process('validate', signed)).toMatchObject({ ok: true, warnings: [expect.stringContaining('firma XML')] })
    expect(process('minify', signed)).toMatchObject({ ok: false, message: expect.stringContaining('firma XML') })
    expect(process('format', '<?xml version="1.0" encoding="ISO-8859-1"?><r/>')).toMatchObject({ ok: true, xmlEncoding: 'ISO-8859-1', warnings: [expect.stringContaining('UTF-8')] })
  })
})
