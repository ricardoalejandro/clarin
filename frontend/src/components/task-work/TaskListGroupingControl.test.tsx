import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskListGroupingControl from './TaskListGroupingControl'

describe('TaskListGroupingControl', () => {
  afterEach(cleanup)

  it('adapts its label to measured density while preserving an accessible name', () => {
    const { rerender } = render(<TaskListGroupingControl groupBy="none" direction="asc" collapsedGroupKeys={[]} density="comfortable" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Agrupar tareas: Sin agrupación' })).toHaveTextContent('Agrupar: Sin agrupación')

    rerender(<TaskListGroupingControl groupBy="status" direction="asc" collapsedGroupKeys={[]} density="narrow" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Agrupar tareas: Estado' })
    expect(trigger).not.toHaveTextContent('Estado')
    expect(trigger.querySelector('span[aria-hidden="true"]')).toBeInTheDocument()
  })

  it('changes grouping and direction from one portaled control', async () => {
    const onChange = vi.fn()
    render(<TaskListGroupingControl groupBy="none" direction="asc" collapsedGroupKeys={['old']} density="compact" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agrupar tareas: Sin agrupación' }))
    const dialog = screen.getByRole('dialog', { name: 'Configurar agrupación' })
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Responsable Agrupa por responsable/i }))
    expect(onChange).toHaveBeenCalledWith('assignee', 'asc', [])
    fireEvent.click(screen.getByRole('button', { name: 'Descendente' }))
    expect(onChange).toHaveBeenCalledWith('none', 'desc', ['old'])

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Configurar agrupación' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agrupar tareas: Sin agrupación' })).toHaveFocus())
  })

  it('supports Arrow, Home and End navigation among grouping options', async () => {
    render(<TaskListGroupingControl groupBy="status" direction="asc" collapsedGroupKeys={[]} density="comfortable" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agrupar tareas: Estado' }))
    const dialog = screen.getByRole('dialog', { name: 'Configurar agrupación' })
    await waitFor(() => expect(screen.getByRole('button', { name: /Estado Separa las tareas/i })).toHaveFocus())
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: /Lista Organiza por lista/i })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'End' })
    expect(screen.getByRole('button', { name: /Fecha de vencimiento Separa por fecha/i })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Home' })
    expect(screen.getByRole('button', { name: /Sin agrupación Mantiene un orden/i })).toHaveFocus()
  })
})
