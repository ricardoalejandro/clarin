import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskSelectPicker } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import { TaskStatusPicker } from './TaskPropertyPicker'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import type { TaskWorkflowStatus } from '@/types/task'

afterEach(cleanup)

describe('task picker portals', () => {
  it('renders the list picker above the calendar composer layer', () => {
    render(<TaskSelectPicker value="a" options={[{ value: 'a', label: 'Generales' }]} onChange={() => undefined} label="Lista" />)
    fireEvent.click(screen.getByRole('button', { name: /Generales/i }))
    expect(screen.getByRole('listbox', { name: 'Lista' })).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.picker) })
    expect(screen.getByRole('button', { name: 'Cerrar Lista' })).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.pickerBackdrop) })
  })

  it('uses the same layer for responsible and status pickers', () => {
    const { unmount } = render(<TaskUserCombobox users={[{ id: 'u', display_name: 'Ricardo', username: 'ricardo' }]} value="u" onChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /Ricardo/i }))
    expect(screen.getByRole('listbox').parentElement).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.picker) })
    unmount()
    const status = { id: 's', workflow_id: 'w', name: 'Por hacer', category: 'not_started', color: '#64748b', sort_order: 0 } as TaskWorkflowStatus
    render(<TaskStatusPicker value="s" statuses={[status]} onChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /Por hacer/i }))
    expect(screen.getByRole('listbox', { name: 'Seleccionar estado' })).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.picker) })
  })
})
