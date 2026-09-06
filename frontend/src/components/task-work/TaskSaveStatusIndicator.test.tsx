import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskSaveStatusIndicator from './TaskSaveStatusIndicator'

const savedAt = '2026-09-05T10:00:00.000Z'

describe('TaskSaveStatusIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(savedAt))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('updates relative time without making the timer the live announcement', () => {
    render(<TaskSaveStatusIndicator model={{ phase: 'saved', updatedAt: savedAt }} />)

    expect(screen.getByText('Guardado automáticamente · ahora')).toBeInTheDocument()
    expect(screen.getByText('Todos los cambios están guardados.')).toHaveClass('sr-only')
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('Guardado automáticamente · hace 1 min')).toBeInTheDocument()
  })

  it('uses compact and read-only copy', () => {
    const view = render(<TaskSaveStatusIndicator compact model={{ phase: 'saved', updatedAt: savedAt }} />)
    expect(screen.getByText('Guardado · ahora')).toBeInTheDocument()

    view.rerender(<TaskSaveStatusIndicator model={{ phase: 'readonly', updatedAt: savedAt }} />)
    expect(screen.getByText('Actualizado · ahora')).toBeInTheDocument()
  })

  it('makes error and conflict feedback actionable without making normal status interactive', () => {
    const onAction = vi.fn()
    const view = render(<TaskSaveStatusIndicator model={{ phase: 'saved', updatedAt: savedAt }} onAction={onAction} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    view.rerender(<TaskSaveStatusIndicator model={{ phase: 'error', updatedAt: savedAt }} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'No se pudo guardar · Reintentar' }))
    expect(onAction).toHaveBeenCalledTimes(1)

    view.rerender(<TaskSaveStatusIndicator model={{ phase: 'conflict', updatedAt: savedAt }} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conflicto de cambios · Revisar' }))
    expect(onAction).toHaveBeenCalledTimes(2)

    view.rerender(<TaskSaveStatusIndicator model={{ phase: 'comment-error', updatedAt: savedAt }} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'No se pudo publicar · Reintentar' }))
    expect(onAction).toHaveBeenCalledTimes(3)
  })

  it('can suppress a duplicate live announcement while keeping the visual status', () => {
    render(<TaskSaveStatusIndicator announce={false} model={{ phase: 'saved', updatedAt: savedAt }} />)

    expect(screen.getByText('Guardado automáticamente · ahora')).toBeInTheDocument()
    expect(screen.queryByText('Todos los cambios están guardados.')).not.toBeInTheDocument()
  })
})
