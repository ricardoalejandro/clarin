import { describe, expect, it } from 'vitest'
import { isWysiwygTarget } from '../../vendor/excalidraw-clarin/packages/excalidraw/wysiwygTarget'

describe('propiedad de eventos del editor de texto de Pizarras', () => {
  it('reconoce la raíz y todos los objetivos anidados del contenteditable', () => {
    const editable = document.createElement('div')
    editable.dataset.type = 'wysiwyg'
    const paragraph = document.createElement('div')
    const span = document.createElement('span')
    const text = document.createTextNode('sdfsdf')
    const breakElement = document.createElement('br')
    span.append(text)
    paragraph.append(span, breakElement)
    editable.append(paragraph)

    for (const target of [editable, paragraph, span, text, breakElement]) {
      expect(isWysiwygTarget(target)).toBe(true)
    }
  })

  it('no confunde contenido ordinario con el editor WYSIWYG', () => {
    const container = document.createElement('div')
    const span = document.createElement('span')
    const text = document.createTextNode('fuera del editor')
    span.append(text)
    container.append(span)

    for (const target of [container, span, text]) {
      expect(isWysiwygTarget(target)).toBe(false)
    }
  })

  it('rechaza objetivos nulos o ajenos al DOM', () => {
    expect(isWysiwygTarget(null)).toBe(false)
    expect(isWysiwygTarget(new EventTarget())).toBe(false)
  })
})
