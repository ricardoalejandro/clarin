import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskSelectPicker } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import TaskCollaboratorPicker from './TaskCollaboratorPicker'

const users = [
  { id: 'owner', display_name: 'Persona responsable', username: 'owner', role: 'Administrador' },
  { id: 'alpha', display_name: 'Ana Alpha', username: 'alpha', role: 'Agente' },
  { id: 'beta', display_name: 'Beto Beta', username: 'beta', role: 'Agente' },
]

async function advance(milliseconds: number) {
  await act(async () => { vi.advanceTimersByTime(milliseconds) })
}

describe('searchable task pickers', () => {
  afterEach(() => vi.useRealTimers())

  it('filters a generic local catalogue at exactly 500 ms', async () => {
    vi.useFakeTimers()
    render(<TaskSelectPicker value="" searchable label="Elegir catálogo" onChange={() => {}} options={[
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta', label: 'Beta' },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: /selecciona una opción/i }))
    const listbox = screen.getByRole('listbox', { name: 'Elegir catálogo' })
    const input = within(listbox).getByPlaceholderText('Buscar…')
    fireEvent.change(input, { target: { value: 'beta' } })
    expect(within(listbox).getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByLabelText('Esperando para buscar')).toBeInTheDocument()
    await advance(499)
    expect(within(listbox).getByText('Alpha')).toBeInTheDocument()
    await advance(1)
    expect(within(listbox).queryByText('Alpha')).not.toBeInTheDocument()
    expect(within(listbox).getByText('Beta')).toBeInTheDocument()
  })

  it('delays responsible-user matching without delaying the typed text', async () => {
    vi.useFakeTimers()
    render(<TaskUserCombobox users={users} value="" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /selecciona una persona/i }))
    const input = screen.getByPlaceholderText('Escribe un nombre o usuario…')
    fireEvent.change(input, { target: { value: 'beto' } })
    expect(input).toHaveValue('beto')
    expect(screen.getByText('Ana Alpha')).toBeInTheDocument()
    await advance(499)
    expect(screen.getByText('Ana Alpha')).toBeInTheDocument()
    await advance(1)
    expect(screen.queryByText('Ana Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beto Beta')).toBeInTheDocument()
  })

  it('delays collaborator matching and keeps clearing immediate', async () => {
    vi.useFakeTimers()
    render(<TaskCollaboratorPicker users={users} value={[]} ownerID="owner" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /añadir colaborador/i }))
    const input = screen.getByPlaceholderText('Buscar por nombre, usuario o rol…')
    fireEvent.change(input, { target: { value: 'beto' } })
    await advance(499)
    expect(screen.getByText('Ana Alpha')).toBeInTheDocument()
    await advance(1)
    expect(screen.queryByText('Ana Alpha')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('Ana Alpha')).toBeInTheDocument()
  })
})
