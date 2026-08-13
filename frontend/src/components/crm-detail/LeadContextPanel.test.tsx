import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Lead, PipelineStage } from '@/types/contact'
import LeadContextPanel, { crmStagePickerPlacement } from './LeadContextPanel'

const stages: PipelineStage[] = [
  { id: 'stage-active', pipeline_id: 'pipeline-1', name: 'Seguimiento', color: '#2563eb', position: 0, stage_type: 'active' },
  { id: 'stage-won', pipeline_id: 'pipeline-1', name: 'Ganada', color: '#10b981', position: 1, stage_type: 'won' },
]

const lead = {
  id: 'lead-1', contact_id: 'contact-1', jid: '', title: 'Oportunidad Iquitos', name: 'Claudia', last_name: null, short_name: null,
  phone: '51999999999', email: '', company: null, age: null, dni: null, birth_date: null, address: null, distrito: null,
  ocupacion: null, status: 'open', pipeline_id: 'pipeline-1', pipeline_name: 'Incoming leads', stage_id: 'stage-active', stage_name: 'Seguimiento',
  stage_color: '#2563eb', stage_position: 0, notes: '', tags: [], structured_tags: [], kommo_id: null, is_archived: false,
  archived_at: null, is_blocked: false, blocked_at: null, block_reason: '', kommo_deleted_at: null, assigned_to: '', created_at: '', updated_at: '',
} satisfies Lead

afterEach(cleanup)

describe('LeadContextPanel stage picker', () => {
  it('selects current-pipeline stages and canonical Sin etapa with mouse', async () => {
    const onStageChange = vi.fn().mockResolvedValue(true)
    render(<LeadContextPanel lead={lead} stages={stages} onStageChange={onStageChange} />)

    fireEvent.click(screen.getByRole('combobox', { name: 'Etapa actual: Seguimiento' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Ganada' }))
    await waitFor(() => expect(onStageChange).toHaveBeenCalledWith(stages[1]))

    fireEvent.click(screen.getByRole('combobox', { name: 'Etapa actual: Seguimiento' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Sin etapa' }))
    await waitFor(() => expect(onStageChange).toHaveBeenLastCalledWith(null))
  })

  it('supports listbox keyboard navigation, Escape and focus restoration', async () => {
    const onStageChange = vi.fn().mockResolvedValue(true)
    render(<LeadContextPanel lead={lead} stages={stages} onStageChange={onStageChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Etapa actual: Seguimiento' })

    fireEvent.click(trigger)
    const listbox = await screen.findByRole('listbox', { name: 'Etapas del pipeline actual' })
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'Enter' })
    await waitFor(() => expect(onStageChange).toHaveBeenCalledWith(stages[1]))
    await waitFor(() => expect(trigger).toHaveFocus())

    fireEvent.click(trigger)
    fireEvent.keyDown(await screen.findByRole('listbox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('exposes pending and rollback error states without inventing a new stage', async () => {
    let resolveChange: ((value: boolean) => void) | undefined
    const onStageChange = vi.fn(() => new Promise<boolean>(resolve => { resolveChange = resolve }))
    render(<LeadContextPanel lead={lead} stages={stages} onStageChange={onStageChange} />)

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Ganada' }))
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByText('Guardando etapa…')).toBeInTheDocument()

    resolveChange?.(false)
    expect(await screen.findByRole('alert')).toHaveTextContent('Se restauró el valor anterior')
    expect(screen.getByRole('combobox', { name: 'Etapa actual: Seguimiento' })).toBeEnabled()
    expect(screen.getByText('Seguimiento')).toBeInTheDocument()
  })

  it('places the portal above when the trigger is near the viewport bottom', () => {
    expect(crmStagePickerPlacement(
      { left: 860, top: 690, right: 1040, bottom: 744, width: 180 },
      { left: 0, top: 0, width: 1024, height: 768 },
      300,
    )).toMatchObject({ placement: 'top', left: 756, width: 260 })
  })
})
