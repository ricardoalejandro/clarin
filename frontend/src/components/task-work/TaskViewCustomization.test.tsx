import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskViewCustomization from './TaskViewCustomization'

afterEach(cleanup)
describe('view customization draft', () => {
  it('applies grouping and subtasks together and resets only changed grouping collapses', () => {
    const onGrouping = vi.fn(), onSubtasks = vi.fn()
    render(<TaskViewCustomization groupBy="status" direction="asc" collapsedGroupKeys={['old']} subtaskMode="collapsed" onGrouping={onGrouping} onSubtasks={onSubtasks} />)
    fireEvent.click(screen.getByRole('button', { name: 'Personalizar vista' }))
    fireEvent.click(screen.getByRole('button', { name: 'Prioridad' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expandidas' }))
    expect(onGrouping).not.toHaveBeenCalled()
    expect(onSubtasks).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(onGrouping).toHaveBeenCalledWith('priority', 'asc', [])
    expect(onSubtasks).toHaveBeenCalledWith('expanded')
  })
  it('discards only the configuration draft when cancelled', () => {
    const onGrouping = vi.fn(), onSubtasks = vi.fn()
    render(<TaskViewCustomization groupBy="status" direction="asc" collapsedGroupKeys={[]} subtaskMode="collapsed" onGrouping={onGrouping} onSubtasks={onSubtasks} />)
    fireEvent.click(screen.getByRole('button', { name: 'Personalizar vista' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descendente' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(onGrouping).not.toHaveBeenCalled()
    expect(onSubtasks).not.toHaveBeenCalled()
  })
})
