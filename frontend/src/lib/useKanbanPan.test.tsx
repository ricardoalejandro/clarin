import { cleanup, render } from '@testing-library/react'
import React, { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useKanbanPan } from './useKanbanPan'

function Harness() {
  const ref = useRef<HTMLDivElement>(null)
  useKanbanPan(ref)
  return <div ref={ref} data-testid="board" />
}

describe('useKanbanPan', () => {
  afterEach(() => { cleanup(); document.documentElement.classList.remove('kanban-ctrl-held', 'kanban-panning') })

  it('desplaza con Ctrl y evita que el gesto se convierta en un click de tarjeta', () => {
    const { getByTestId } = render(<Harness />)
    const board = getByTestId('board') as HTMLDivElement
    board.scrollLeft = 100
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }))
    board.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 200, bubbles: true, cancelable: true }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, bubbles: true, cancelable: true }))
    expect(board.scrollLeft).toBe(150)
    expect(document.documentElement).toHaveClass('kanban-panning')
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }))
    expect(document.documentElement).not.toHaveClass('kanban-panning')
  })

  it('también desplaza con el botón central sin requerir Ctrl', () => {
    const { getByTestId } = render(<Harness />)
    const board = getByTestId('board') as HTMLDivElement
    board.scrollLeft = 40
    board.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: 100, bubbles: true, cancelable: true }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, bubbles: true, cancelable: true }))
    expect(board.scrollLeft).toBe(60)
    document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }))
  })
})
