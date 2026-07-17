import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWhatsAppFormat, insertTextAtSelection } from './whatsappEditor'

test('inserts emoji at the saved caret and replaces a selection', () => {
  assert.deepEqual(insertTextAtSelection('hola mundo', { start: 5, end: 5 }, '👋 '), {
    value: 'hola 👋 mundo',
    selection: { start: 8, end: 8 },
  })
  assert.equal(insertTextAtSelection('hola mundo', { start: 5, end: 10 }, '👋').value, 'hola 👋')
})

test('wraps, unwraps and prepares an empty inline format', () => {
  const wrapped = applyWhatsAppFormat('hola mundo', { start: 5, end: 10 }, 'bold')
  assert.equal(wrapped.value, 'hola *mundo*')
  assert.deepEqual(wrapped.selection, { start: 6, end: 11 })
  assert.equal(applyWhatsAppFormat(wrapped.value, wrapped.selection, 'bold').value, 'hola mundo')
  assert.deepEqual(applyWhatsAppFormat('hola', { start: 4, end: 4 }, 'italic'), {
    value: 'hola__',
    selection: { start: 5, end: 5 },
  })
})

test('formats selected lines as WhatsApp lists and toggles them off', () => {
  const numbered = applyWhatsAppFormat('uno\ndos', { start: 0, end: 7 }, 'numbered_list')
  assert.equal(numbered.value, '1. uno\n2. dos')
  assert.equal(applyWhatsAppFormat(numbered.value, numbered.selection, 'numbered_list').value, 'uno\ndos')
})
