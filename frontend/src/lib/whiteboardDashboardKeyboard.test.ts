import { describe, expect, it } from 'vitest'
import {
  dashboardKeyboardTargetIsWritable,
  shouldToggleErosFromKeyboard,
} from './dashboardKeyboard'

function keyboardEvent(
  target: EventTarget,
  overrides: Partial<Pick<KeyboardEvent,
    'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey'
  >> = {},
) {
  return {
    ctrlKey: true,
    defaultPrevented: false,
    key: 'i',
    metaKey: false,
    target,
    ...overrides,
  }
}

describe('atajo global de Eros durante la edición de Pizarras', () => {
  it('cede Ctrl/Cmd+I al contenteditable y a cualquiera de sus descendientes', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const paragraph = document.createElement('div')
    const span = document.createElement('span')
    const text = document.createTextNode('Texto con cursiva')
    span.append(text)
    paragraph.append(span)
    editable.append(paragraph)

    for (const target of [editable, paragraph, span, text]) {
      expect(dashboardKeyboardTargetIsWritable(target)).toBe(true)
      expect(shouldToggleErosFromKeyboard(keyboardEvent(target))).toBe(false)
    }
  })

  it('cede el atajo a controles de formulario y sus objetivos anidados', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const option = document.createElement('option')
    select.append(option)

    for (const target of [input, textarea, select, option]) {
      expect(shouldToggleErosFromKeyboard(keyboardEvent(target))).toBe(false)
    }
  })

  it('respeta eventos ya consumidos y conserva el atajo desde canvas o body', () => {
    const canvas = document.createElement('canvas')

    expect(shouldToggleErosFromKeyboard(keyboardEvent(canvas))).toBe(true)
    expect(shouldToggleErosFromKeyboard(keyboardEvent(document.body, {
      ctrlKey: false,
      metaKey: true,
    }))).toBe(true)
    expect(shouldToggleErosFromKeyboard(keyboardEvent(canvas, {
      defaultPrevented: true,
    }))).toBe(false)
    expect(shouldToggleErosFromKeyboard(keyboardEvent(canvas, {
      key: 'b',
    }))).toBe(false)
    expect(shouldToggleErosFromKeyboard(keyboardEvent(canvas, {
      ctrlKey: false,
    }))).toBe(false)
  })

  it('no considera editable una isla contenteditable=false', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const readonlyIsland = document.createElement('span')
    readonlyIsland.setAttribute('contenteditable', 'false')
    const child = document.createElement('strong')
    readonlyIsland.append(child)
    editable.append(readonlyIsland)

    expect(dashboardKeyboardTargetIsWritable(child)).toBe(false)
    expect(shouldToggleErosFromKeyboard(keyboardEvent(child))).toBe(true)
  })
})
