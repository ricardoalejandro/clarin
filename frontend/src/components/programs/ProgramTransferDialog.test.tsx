import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProgramTransferDialog } from './ProgramTransferDialog'
import {
  canConfirmTransfer, normalizeTransferPreview, parseProgramTransferFile, programTransferAllowed, programTransferFilename, programTransferField, programTransferValue,
} from './programTransfer'

const fixture = vi.hoisted(() => ({ api: vi.fn(), scope: 'account-A' }))
vi.mock('@/lib/api', () => ({ api: fixture.api }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => fixture.scope, isAuthIdentityChanging: () => false }))

const portable = { version: 1, records: [{ kind: 'program', id: 'source-program' }], signature: 'installation-signed' }
const fieldConflict = { key: 'attendance-status', kind: 'attendance', label: 'Asistencia de Ana', field: 'status', local: 'present', incoming: 'absent' }
const preview = (conflicts: unknown[] = [], token = 'ready-token') => ({
  token, program_name: 'Programa portátil', summary: { create: 4, update: 1, unchanged: 2, conflicts: conflicts.length }, conflicts,
})
const result = { program_id: 'destination', summary: { create: 4, update: 1, unchanged: 2, conflicts: 0 } }
const target = { id: 'destination', name: 'Grupo destino', type: 'course', status: 'active' }
const payloads = () => fixture.api.mock.calls.filter(([url]) => url.startsWith('/api/programs/transfer/'))
  .map(([url, init]) => [url, JSON.parse(init.body)])

beforeEach(() => {
  fixture.scope = 'account-A'
  fixture.api.mockReset()
  fixture.api.mockImplementation(async (url: string) => {
    if (url.endsWith('/preview')) return { success: true, data: preview([fieldConflict]) }
    if (url.endsWith('/confirm')) return { success: true, data: result }
    return { success: true, data: [target, { id: 'closed', name: 'Grupo cerrado', type: 'course', status: 'completed' }] }
  })
})
afterEach(cleanup)

const newDialog = () => {
  const onClose = vi.fn()
  const onImported = vi.fn()
  const view = render(<ProgramTransferDialog scope={fixture.scope} onClose={onClose} onImported={onImported} />)
  return { onClose, onImported, view }
}

async function selectPackage(text = JSON.stringify(portable)) {
  fireEvent.change(screen.getByLabelText('Archivo de programa'), { target: { files: [new File([text], 'programa.clarin-program.json', { type: 'application/json' })] } })
  if (text === JSON.stringify(portable)) await screen.findByText('Seleccionado: programa.clarin-program.json')
}

describe('Program transfer dialog', () => {
  it('never writes before confirmation; resolves conflicts and requests one import', async () => {
    const { onImported } = newDialog()
    expect(screen.getByRole('button', { name: 'Generar vista previa' })).toBeDisabled()
    await selectPackage()
    fireEvent.click(screen.getByRole('radio', { name: 'Fusionar con un programa' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Grupo destino' }))
    expect(screen.queryByText('Grupo cerrado')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generar vista previa' }))
    expect(await screen.findByRole('heading', { name: /Vista previa · Programa portátil/ })).toBeInTheDocument()
    expect(payloads()).toEqual([
      ['/api/programs/transfer/preview', { file: portable, target_program_id: target.id }],
    ])
    expect(screen.getByText('Presente')).toBeInTheDocument()
    expect(screen.getByText('Ausente')).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Confirmar importación' })
    expect(confirm).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Conservar el dato local' }))
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
    expect(payloads()).toHaveLength(2)
    expect(payloads()[1]).toEqual(['/api/programs/transfer/confirm', {
      file: portable, target_program_id: target.id, token: 'ready-token', decisions: { [fieldConflict.key]: 'local' },
    }])
    expect(screen.getByRole('link', { name: 'Ver programa' })).toHaveAttribute('href', '/dashboard/programs/destination')
    expect(screen.queryByText('Seleccionado: programa.clarin-program.json')).not.toBeInTheDocument()
  })

  it('resolves a contact match through a fresh review before allowing a write', async () => {
    fixture.api.mockResolvedValueOnce({ success: true, data: preview([{
      key: 'contact-match', kind: 'contact', label: 'Coincidencia de contacto', mapping_key: 'portable-A',
      choices: [{ value: 'existing-contact', label: 'Vincular a Ana' }, { value: 'create', label: 'Crear otro contacto' }],
    }], 'first-token') }).mockResolvedValueOnce({ success: true, data: preview([], 'new-token') })
      .mockResolvedValueOnce({ success: true, data: result })
    newDialog()
    await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Generar vista previa' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Vincular a Ana' }))
    expect(screen.queryByRole('button', { name: 'Confirmar importación' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar vista previa' }))
    const confirm = await screen.findByRole('button', { name: 'Confirmar importación' })
    expect(payloads()[1]).toEqual(['/api/programs/transfer/preview', { file: portable, mappings: { 'portable-A': 'existing-contact' } }])
    fireEvent.click(confirm)
    await screen.findByText('Importación finalizada.')
    expect(payloads()[2]).toEqual(['/api/programs/transfer/confirm', { file: portable, mappings: { 'portable-A': 'existing-contact' }, token: 'new-token', decisions: {} }])
  })

  it('invalidates a stale preview and preserves the file for retry', async () => {
    fixture.api.mockResolvedValueOnce({ success: true, data: preview() })
      .mockResolvedValueOnce({ success: false, status: 409, data: { code: 'program_transfer_preview_stale' } })
    const { onImported } = newDialog()
    await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Generar vista previa' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar importación' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('El destino cambió o la vista previa caducó.')
    expect(screen.queryByRole('button', { name: 'Confirmar importación' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generar vista previa' })).toBeEnabled()
    expect(onImported).not.toHaveBeenCalled()
  })

  it('does not surface a late preview after an account switch', async () => {
    let respond!: (value: unknown) => void
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { respond = resolve }))
    const { onImported, view } = newDialog()
    await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Generar vista previa' }))
    const signal = fixture.api.mock.calls[0][1].signal as AbortSignal
    fixture.scope = 'account-B'
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => respond({ success: true, data: preview() }))
    const incoming = newDialog()
    expect(screen.getByRole('button', { name: 'Generar vista previa' })).toBeDisabled()
    expect(onImported).not.toHaveBeenCalled()
    expect(incoming.onImported).not.toHaveBeenCalled()
  })

  it('rejects invalid files locally and asks before losing staged decisions', async () => {
    const { onClose } = newDialog()
    await selectPackage('not a program file')
    expect(await screen.findByRole('alert')).toHaveTextContent('El archivo no contiene JSON válido')
    expect(fixture.api).not.toHaveBeenCalled()
    await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('alert')).toHaveTextContent('¿Descartar el archivo')
    fireEvent.click(screen.getByRole('button', { name: 'Seguir revisando' }))
    expect(screen.getByRole('button', { name: 'Generar vista previa' })).toBeEnabled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('restores the original opener after suspending and resuming the dialog', async () => {
    const trigger = document.createElement('button')
    const replacement = document.createElement('button')
    const other = document.createElement('button')
    document.body.append(trigger, replacement, other)
    const returnFocusRef = { current: trigger }
    trigger.focus()
    const onClose = vi.fn()
    const onImported = vi.fn()
    const view = render(<ProgramTransferDialog scope={fixture.scope} onClose={onClose} onImported={onImported} returnFocusRef={returnFocusRef} />)
    view.rerender(<ProgramTransferDialog scope={fixture.scope} inactive onClose={onClose} onImported={onImported} returnFocusRef={returnFocusRef} />)
    trigger.remove()
    returnFocusRef.current = replacement
    other.focus()
    view.rerender(<ProgramTransferDialog scope={fixture.scope} onClose={onClose} onImported={onImported} returnFocusRef={returnFocusRef} />)
    await act(async () => view.unmount())
    expect(replacement).toHaveFocus()
    replacement.remove()
    other.remove()
  })
})

describe('Program transfer boundaries', () => {
  it('accepts only the portable object envelope and validates previews', () => {
    expect(parseProgramTransferFile('\uFEFF' + JSON.stringify(portable))).toEqual(portable)
    expect(() => parseProgramTransferFile('[]')).toThrow(/formato/)
    expect(normalizeTransferPreview(preview([fieldConflict, fieldConflict]))).toBeNull()
    const candidate = normalizeTransferPreview(preview([fieldConflict]))!
    expect(canConfirmTransfer(candidate, { 'attendance-status': 'other' })).toBe(false)
    expect(canConfirmTransfer(candidate, { 'attendance-status': 'incoming' })).toBe(true)
    expect(programTransferField('topics')).toBe('Temas de la clase')
    expect(programTransferValue(['Introducción', 'Ética'], 'topics')).toBe('Introducción, Ética')
  })

  it('requires both module permissions unless the current user is an admin', () => {
    expect(programTransferAllowed({ permissions: ['contacts'] })).toBe(false)
    expect(programTransferAllowed({ permissions: ['programs'] })).toBe(false)
    expect(programTransferAllowed({ permissions: ['programs', 'contacts'] })).toBe(true)
    expect(programTransferAllowed({ is_admin: true })).toBe(true)
    expect(programTransferFilename('Filosofía / Taller')).toBe('Filosofia-Taller.clarin-program.json')
  })
})
