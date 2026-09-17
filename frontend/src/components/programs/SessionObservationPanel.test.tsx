import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionObservationPanel from './SessionObservationPanel'

const apiMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ api: apiMock }))

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({ success: true, data: { success: true, observations: [] } })
})

afterEach(cleanup)

describe('SessionObservationPanel', () => {
  it('keeps every mutation control disabled while attendance is saving', async () => {
    render(<SessionObservationPanel programId="program-1" sessionId="session-1" disabled />)

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1))
    expect(screen.getByPlaceholderText('Ej.: Se dictó el tema… Observaciones generales…')).toBeDisabled()
    const add = screen.getByRole('button', { name: 'Añadir' })
    expect(add).toBeDisabled()
    fireEvent.click(add)
    expect(apiMock).toHaveBeenCalledTimes(1)
  })
})
