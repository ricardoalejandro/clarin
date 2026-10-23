import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiGet } from '@/lib/api'
import TaskContainerRemovalDestinationPicker from './TaskContainerRemovalDestinationPicker'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

vi.mock('@/lib/api', () => ({ apiGet: vi.fn() }))
const destination = { id: 'target', name: 'Destino', environment_id: 'env-1', lifecycle: 'archived', folder_name: 'Histórico' }
beforeEach(() => { vi.mocked(apiGet).mockResolvedValue({ success: true, data: { lists: [destination], next_cursor: 'page-2' } }) })
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers() })

describe('removal destination catalog', () => {
  it('loads a bounded server-authorized catalog, pages it and stages a choice without performing a mutation', async () => {
    const change = vi.fn()
    render(<TaskContainerRemovalDestinationPicker type="folder" id="source" selected={null} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lista de destino' }))
    const option = await screen.findByRole('option', { name: /Destino/ })
    expect(apiGet).toHaveBeenCalledWith('/api/tasks/folders/source/removal-destinations?limit=50', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.getByRole('dialog', { name: 'Elegir lista de destino' })).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.picker) })
    expect(option).toHaveTextContent('Histórico · Archivo')
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más destinos' }))
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2))
    expect(vi.mocked(apiGet).mock.calls[1][0]).toContain('cursor=page-2')
    await waitFor(() => expect(option).toBeEnabled())
    fireEvent.click(option)
    expect(change).toHaveBeenCalledOnce()
    expect(change).toHaveBeenCalledWith(destination)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('waits exactly 500 ms for typed search and aborts the prior catalog immediately', async () => {
    render(<TaskContainerRemovalDestinationPicker type="list" id="source" selected={null} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lista de destino' }))
    await screen.findByRole('option', { name: /Destino/ })
    const previousSignal = vi.mocked(apiGet).mock.calls[0][1]?.signal
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar listas de destino' }), { target: { value: 'nuevo' } })
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => vi.advanceTimersByTime(499))
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(vi.mocked(apiGet).mock.calls[1][0]).toContain('search=nuevo')
  })

  it('lets keyboard users choose a destination and restores trigger focus on Escape', async () => {
    render(<TaskContainerRemovalDestinationPicker type="list" id="source" selected={null} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Lista de destino' })
    trigger.focus(); fireEvent.click(trigger)
    const option = await screen.findByRole('option', { name: /Destino/ })
    const search = screen.getByRole('textbox', { name: 'Buscar listas de destino' })
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(option).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
