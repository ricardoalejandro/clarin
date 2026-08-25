import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskWorkflowStatus } from '@/types/task'
import { TaskStatusPicker } from './TaskPropertyPicker'

const statuses: TaskWorkflowStatus[] = [
  { id: 'todo', account_id: 'a', workflow_id: 'w', name: 'Pendiente', color: '#64748B', category: 'not_started', sort_order: 1, is_default: true, created_at: '', updated_at: '' },
  { id: 'doing', account_id: 'a', workflow_id: 'w', name: 'En curso', color: '#3B82F6', category: 'active', sort_order: 2, is_default: true, created_at: '', updated_at: '' },
  { id: 'done', account_id: 'a', workflow_id: 'w', name: 'Finalizada', color: '#10B981', category: 'done', sort_order: 3, is_default: true, created_at: '', updated_at: '' },
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TaskStatusPicker', () => {
  it('groups statuses and waits exactly 500ms before filtering', () => {
    vi.useFakeTimers()
    render(<TaskStatusPicker value="todo" statuses={statuses} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /pendiente/i }))
    expect(screen.getByRole('group', { name: 'No iniciado' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Activo' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar estado' }), { target: { value: 'final' } })
    expect(screen.getByLabelText('Esperando para filtrar')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /pendiente/i })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(499))
    expect(screen.getByRole('option', { name: /pendiente/i })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('option', { name: /pendiente/i })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /finalizada/i })).toBeInTheDocument()
  })

  it('selects once and restores focus to the trigger', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<TaskStatusPicker value="todo" statuses={statuses} onChange={onChange} />)
    const trigger = document.querySelector<HTMLButtonElement>('[data-task-status-picker]')!
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /en curso/i }))
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('doing')
    act(() => { vi.runAllTimers() })
    expect(trigger).toHaveFocus()
  })

  it('clamps the portaled picker to the visual viewport on mobile', () => {
    vi.stubGlobal('visualViewport', {
      offsetLeft: 20,
      offsetTop: 100,
      width: 320,
      height: 400,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    render(<TaskStatusPicker value="todo" statuses={statuses} onChange={vi.fn()} />)
    const trigger = document.querySelector<HTMLButtonElement>('[data-task-status-picker]')!
    trigger.getBoundingClientRect = () => ({ x: 500, y: 500, left: 500, top: 500, right: 620, bottom: 540, width: 120, height: 40, toJSON: () => ({}) })
    fireEvent.click(trigger)

    const picker = screen.getByRole('dialog', { name: 'Seleccionar estado' })
    expect(picker).toHaveStyle({ left: '48px', top: '128px', width: '280px', maxHeight: '360px' })
  })

  it('never forces a minimum panel larger than a reduced visual viewport', () => {
    vi.stubGlobal('visualViewport', {
      offsetLeft: 20,
      offsetTop: 100,
      width: 150,
      height: 120,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    render(<TaskStatusPicker value="todo" statuses={statuses} onChange={vi.fn()} />)
    const trigger = document.querySelector<HTMLButtonElement>('[data-task-status-picker]')!
    trigger.getBoundingClientRect = () => ({ x: 500, y: 500, left: 500, top: 500, right: 620, bottom: 540, width: 120, height: 40, toJSON: () => ({}) })
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: 'Seleccionar estado' })).toHaveStyle({
      left: '32px',
      top: '112px',
      width: '126px',
      maxHeight: '96px',
    })
  })
})
