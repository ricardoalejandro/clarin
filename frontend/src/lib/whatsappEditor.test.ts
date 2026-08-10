import { expect, test } from 'vitest'
import { applyWhatsAppFormat, insertTextAtSelection } from './whatsappEditor'

test('inserts emoji at the saved caret and replaces a selection', () => {
  expect(insertTextAtSelection('hola mundo', { start: 5, end: 5 }, '👋 ')).toEqual({
    value: 'hola 👋 mundo',
    selection: { start: 8, end: 8 },
  })
  expect(insertTextAtSelection('hola mundo', { start: 5, end: 10 }, '👋').value).toBe('hola 👋')
})

test('wraps, unwraps and prepares an empty inline format', () => {
  const wrapped = applyWhatsAppFormat('hola mundo', { start: 5, end: 10 }, 'bold')
  expect(wrapped.value).toBe('hola *mundo*')
  expect(wrapped.selection).toEqual({ start: 6, end: 11 })
  expect(applyWhatsAppFormat(wrapped.value, wrapped.selection, 'bold').value).toBe('hola mundo')
  expect(applyWhatsAppFormat('hola', { start: 4, end: 4 }, 'italic')).toEqual({
    value: 'hola__',
    selection: { start: 5, end: 5 },
  })
})

test('formats selected lines as WhatsApp lists and toggles them off', () => {
  const numbered = applyWhatsAppFormat('uno\ndos', { start: 0, end: 7 }, 'numbered_list')
  expect(numbered.value).toBe('1. uno\n2. dos')
  expect(applyWhatsAppFormat(numbered.value, numbered.selection, 'numbered_list').value).toBe('uno\ndos')
})
