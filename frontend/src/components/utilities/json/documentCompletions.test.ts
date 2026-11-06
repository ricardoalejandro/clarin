import { expect, it } from 'vitest'
import { jsonLiteralCompletions, xmlClosingTagCompletion } from './documentCompletions'

it('recognizes incomplete JSON literals only in a value position', () => {
  expect(jsonLiteralCompletions('{"activo": tr')).toEqual([{ label: 'true', partial: 'tr' }])
  expect(jsonLiteralCompletions('{"list":[0, nu')).toEqual([{ label: 'null', partial: 'nu' }])
  expect(jsonLiteralCompletions('{"id": 1, fa')).toEqual([])
  expect(jsonLiteralCompletions('{"id": "tr')).toEqual([])
  expect(jsonLiteralCompletions('{ "id": // tr')).toEqual([])
})

it('completes the current XML closing tag, ignoring comments, CDATA and attribute text', () => {
  expect(xmlClosingTagCompletion('<root><!-- <x> --><![CDATA[<y>]]><ns:item x=">"><child/></ns:')).toEqual({ label: 'ns:item', partial: 'ns:' })
  expect(xmlClosingTagCompletion('<root><!-- </')).toBeUndefined()
  expect(xmlClosingTagCompletion('<root x="</')).toBeUndefined()
  expect(xmlClosingTagCompletion('<root><a></b></')).toBeUndefined()
})
