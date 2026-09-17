import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchTaskLocationViewAccessCandidates } from '@/lib/taskLocationViewsApi'
import TaskLocationViewVisibilityFields, { selectedVisibilityMembers } from './TaskLocationViewVisibilityFields'

vi.mock('@/lib/taskLocationViewsApi', () => ({
  searchTaskLocationViewAccessCandidates: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskLocationViewVisibilityFields', () => {
  it('only offers users who already have access to the Work location', async () => {
    vi.mocked(searchTaskLocationViewAccessCandidates).mockResolvedValue({
      success: true,
      data: {
        users: [{
          user_id: 'user-2',
          display_name: 'Ana Operaciones',
          username: 'ana',
          effective_access_level: 'edit',
        }],
      },
      status: 200,
    })
    const onSelected = vi.fn()
    render(<TaskLocationViewVisibilityFields
      scopeType="list"
      scopeID="list-1"
      canManageAccess
      mode="restricted"
      selected={[]}
      onMode={vi.fn()}
      onSelected={onSelected}
    />)

    fireEvent.click(await screen.findByRole('button', { name: /Ana Operaciones/i }))
    await waitFor(() => expect(onSelected).toHaveBeenCalledWith([expect.objectContaining({
      user_id: 'user-2',
      effective_access_level: 'edit',
    })]))
  })

  it('keeps revoked members visible for explicit removal and blocks restricted mode without governance', () => {
    expect(selectedVisibilityMembers([{
      user_id: 'user-3',
      display_name: 'Luis',
      username: 'luis',
      effective_access_level: 'none',
      eligible: false,
    }])).toEqual([expect.objectContaining({ user_id: 'user-3', eligible: false })])

    const onMode = vi.fn()
    render(<TaskLocationViewVisibilityFields
      scopeType="folder"
      scopeID="folder-1"
      canManageAccess={false}
      mode="inherit"
      selected={[]}
      onMode={onMode}
      onSelected={vi.fn()}
    />)
    const restricted = screen.getByRole('button', { name: /Personas seleccionadas/i })
    expect(restricted).toBeDisabled()
    fireEvent.click(restricted)
    expect(onMode).not.toHaveBeenCalled()
  })
})
