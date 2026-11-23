import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Lead } from '@/types/contact'
import DetachedLeadDetail from './DetachedLeadDetail'

function Panel(_props: { embedded?: boolean; onCountChange?: (count: number) => void; children?: React.ReactNode }) {
  return <div>{_props.children}</div>
}

const lead = {
  id: 'lead-1', contact_id: null, jid: '', title: 'Oportunidad histórica', name: 'Elena', last_name: null, short_name: null,
  phone: '51999999999', email: '', company: null, age: null, dni: null, birth_date: null, address: null, distrito: null,
  ocupacion: null, status: 'open', pipeline_id: 'pipeline-1', pipeline_name: 'Ventas', stage_id: 'stage-1', stage_name: 'Nuevo',
  stage_color: '#10b981', stage_position: 0, notes: '', tags: [], structured_tags: [], kommo_id: null, is_archived: false,
  archived_at: null, is_blocked: false, blocked_at: null, block_reason: '', kommo_deleted_at: null, assigned_to: '', created_at: '', updated_at: '',
} satisfies Lead

afterEach(cleanup)

describe('DetachedLeadDetail', () => {
  it('reports partial dates as dirty and saves the latest complete date only', async () => {
    const save = vi.fn().mockResolvedValue({ success: true }), dirty = vi.fn()
    render(<DetachedLeadDetail lead={lead} context={null} activity={null} tasks={null} onSave={save} onDirtyChange={dirty} />)
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
    const date = screen.getByRole('textbox', { name: 'Fecha de nacimiento' })
    fireEvent.change(date, { target: { value: '04/05/' } })
    expect(dirty).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    fireEvent.keyDown(date, { key: 'Enter' })
    expect(save).not.toHaveBeenCalled()
    expect(date).toHaveValue('04/05/')
    fireEvent.change(date, { target: { value: '04/05/1992' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ birth_date: '1992-05-04' })))
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false))
  })

  it('protects browser closure only while a real draft exists and releases the listener', () => {
    const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener')
    const view = render(<DetachedLeadDetail lead={lead} context={null} activity={null} tasks={null} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha de nacimiento' }), { target: { value: '04/05/' } })
    const registered = add.mock.calls.find(([name]) => String(name) === 'beforeunload')!
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(remove).toHaveBeenCalledWith('beforeunload', registered[1])
    const discarded = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(discarded)
    expect(discarded.defaultPrevented).toBe(false)
    view.unmount()
    add.mockRestore(); remove.mockRestore()
  })

  it('keeps the same ordered CRM hierarchy for a Lead without canonical Contact', () => {
    const html = renderToStaticMarkup(<DetachedLeadDetail lead={lead} context={<div>Contexto</div>} activity={<Panel>Actividad</Panel>} tasks={<Panel>Tareas</Panel>} onMessage={() => {}} onSave={async () => ({ success: true })} />)
    const headings = ['Información del contacto', 'Etiquetas', 'Observaciones de esta oportunidad', 'Historial general del contacto', 'Contexto de la oportunidad', 'Tareas relacionadas', 'Integraciones']
    headings.reduce((previous, heading) => {
      const next = html.indexOf(heading)
      expect(next).toBeGreaterThan(previous)
      return next
    }, -1)
    expect(html).toContain('Sin Contact canónico')
    expect(html).toContain('Observación')
    expect(html).toContain('Mensaje')
    expect(html).toContain('Editar')
  })

  it('uses the shared date-only picker and preserves the exact historical Lead value', async () => {
    const onSave = vi.fn().mockResolvedValue({ success: true })
    render(<DetachedLeadDetail lead={{ ...lead, birth_date: '1992-05-04' }} context={<div>Contexto</div>} activity={<Panel>Actividad</Panel>} tasks={<Panel>Tareas</Panel>} onSave={onSave} />)

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
    expect(document.querySelector('input[type="date"]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fecha de nacimiento: 04/05/1992' }))
    fireEvent.click(document.querySelector('[data-date-key="1992-05-09"]') as HTMLButtonElement)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ birth_date: '1992-05-09' })))
  })
})
