import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskListTitleButton, { taskListTitleAction } from './TaskListTitleButton'

describe('TaskListTitleButton', () => {
  afterEach(cleanup)

  it('opens from a semantic, visibly interactive title button', () => {
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(<TaskListTitleButton title="Una tarea con título largo" metadata="Propaganda · Sin responsable" done={false} editable selectionMode={false} onOpen={onOpen} onSelect={onSelect} />)
    const button = screen.getByRole('button', { name: 'Abrir tarea Una tarea con título largo' })
    expect(button).toHaveClass('cursor-pointer')
    expect(button.querySelector('[data-task-title-text]')).toHaveClass('group-hover/title:text-emerald-700', 'group-hover/title:underline')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('preserves modifier and active-selection behavior without opening', () => {
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    const { rerender } = render(<TaskListTitleButton title="Seleccionable" metadata="Lista" done={false} editable selectionMode={false} onOpen={onOpen} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button'), { ctrlKey: true })
    expect(onSelect).toHaveBeenCalledWith(false)
    expect(onOpen).not.toHaveBeenCalled()

    rerender(<TaskListTitleButton title="Seleccionable" metadata="Lista" done={false} editable selectionMode onOpen={onOpen} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button'), { shiftKey: true })
    expect(onSelect).toHaveBeenLastCalledWith(true)
  })

  it('keeps read-only titles openable and never turns them into structural selection', () => {
    expect(taskListTitleAction({ editable: false, selectionMode: true, ctrlKey: true, metaKey: false, shiftKey: true })).toBe('open')
  })
})
