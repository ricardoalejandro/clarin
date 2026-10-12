import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ImportCSVModal from '@/components/ImportCSVModal'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
// Approved Kommo export fixture, independent of the modal's parsing implementation.
vi.mock('xlsx', () => ({ read: () => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }), utils: {
 sheet_to_csv: () => 'ID,Contacto principal\n1,Contacto de prueba',
 sheet_to_json: () => [[
  'ID', 'Nombre del lead', 'Compañía', 'Contacto principal', 'Compañía del lead', 'Responsable', 'Estatus del lead', 'Embudo de ventas', 'Presupuesto', 'Fecha de creación', 'Creado por', 'Última modificación el', 'Modificado por', 'Etiquetas del lead', 'Tareas próximas', 'Cerrado el', 'Próxima cita', 'BOT 1.0', 'Atención', '✅ RED SOCIAL', '‼️MOTIVO PERDIDA', '✅ SEDE', '✅ Acepto invitación?', '✅ Acepto Clase Gratuita', '✅ Desea inscripción?', '✅ Tipo de cliente', '✅ Campaña', '✅ Consulta', '✅ Fecha', 'PRUEBA', 'STATUS', 'DETEC CAM', 'GRUPO', 'OTRAS', '✅ Exportado', 'utm_content', 'utm_medium', 'utm_campaign', 'utm_source', 'utm_term', 'utm_referrer', 'referrer', 'gclientid', 'gclid', 'fbclid', 'ttad_name', 'ttad_id', 'Cargo (contacto)', 'Correo (contacto)', 'E-mail priv. (contacto)', 'Otro e-mail (contacto)', 'Teléfono oficina (contacto)', 'Teléfono oficina directo (contacto)', 'Teléfono celular (contacto)', 'Fax (contacto)', 'Teléfono de casa (contacto)', 'Otro teléfono (contacto)', 'Nota 1', 'Nota 2', 'Nota 3', 'Nota 4', 'Nota 5',
 ]],
} }))
const tags = [{ id: 'first', name: 'Campaña junio', color: '#2563EB' }, { id: 'second', name: 'Grupo tarde', color: '#16A34A' }]
beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags, can_create: false } }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const settleSearch = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(500) }) }
const chooseFile = async (container: HTMLElement) => {
 const file = new File(['fixture'], 'exportacion.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
 Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
 await act(async () => { fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } }) })
}
const previewResponse = { success: true, preview: { total_rows: 1, new_opportunities: 1, import_tag: tags[0].name, rows: [] } }
describe('ImportCSVModal shared tag selection', () => {
 it('uses bounded lookup, replaces the import choice and clears it without assigning entities', async () => {
  const { rerender } = render(<ImportCSVModal open onClose={vi.fn()} onSuccess={vi.fn()} />)
  expect(api).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Usar etiqueta' }))
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'camp' } }); await settleSearch()
  expect(api).toHaveBeenCalledWith('/api/tags/search?context_type=lead_import&q=camp&limit=20', expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }))
  fireEvent.click(screen.getByRole('option', { name: tags[0].name }))
  rerender(<ImportCSVModal open onClose={vi.fn()} onSuccess={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Quitar etiqueta Campaña junio' })).toBeInTheDocument()
  fireEvent.change(input, { target: { value: 'grupo' } }); await settleSearch()
  fireEvent.click(screen.getByRole('option', { name: tags[1].name }))
  expect(screen.queryByRole('button', { name: 'Quitar etiqueta Campaña junio' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Quitar etiqueta Grupo tarde' }))
  expect(screen.getByText(/Selecciona una etiqueta existente/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Sin etiqueta' }))
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true)
 }, 10000)
 it('lets Escape dismiss the picker before the owning modal', async () => {
  const close = vi.fn()
  render(<ImportCSVModal open onClose={close} onSuccess={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Usar etiqueta' }))
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'camp' } }); await settleSearch()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
 })
 it('keeps the chosen tag and import mode stable while preview is pending', async () => {
  let finishPreview!: (response: Response) => void
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishPreview = resolve })).mockResolvedValue({ json: async () => ({ success: true, summary: { created: 1 } }) })
  vi.stubGlobal('fetch', fetchMock)
  const { container } = render(<ImportCSVModal open onClose={vi.fn()} onSuccess={vi.fn()} />)
  await chooseFile(container)
  fireEvent.click(screen.getByRole('button', { name: 'Usar etiqueta' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'camp' } }); await settleSearch()
  fireEvent.click(screen.getByRole('option', { name: tags[0].name }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Analizar Excel' })) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Sin etiqueta' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Usar etiqueta' })).toBeDisabled()
  expect(container.querySelector('input[type=file]')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Sin etiqueta' }))
  expect(screen.getByRole('button', { name: 'Quitar etiqueta Campaña junio' })).toBeInTheDocument()
  expect((fetchMock.mock.calls[0][1].body as FormData).get('import_tag')).toBe(tags[0].name)
  await act(async () => { finishPreview({ json: async () => previewResponse } as Response) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Crear 1 oportunidades' })) })
  expect((fetchMock.mock.calls[1][1].body as FormData).get('import_tag')).toBe(tags[0].name)
 }, 10000)
 it('aborts and ignores a preview that completes after closing and reopening', async () => {
  let finishPreview!: (response: Response) => void
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(resolve => { finishPreview = resolve }))
  vi.stubGlobal('fetch', fetchMock)
  const close = vi.fn(), success = vi.fn()
  const { container, rerender } = render(<ImportCSVModal open onClose={close} onSuccess={success} />)
  await chooseFile(container)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Analizar Excel' })) })
  const signal = fetchMock.mock.calls[0][1]!.signal as AbortSignal
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  rerender(<ImportCSVModal open={false} onClose={close} onSuccess={success} />)
  rerender(<ImportCSVModal open onClose={close} onSuccess={success} />)
  expect(signal.aborted).toBe(true)
  await act(async () => { finishPreview({ json: async () => previewResponse } as Response) })
  expect(screen.queryByText('Modo seguro activo')).not.toBeInTheDocument()
  expect(screen.queryByText('Vista previa')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Analizar Excel' })).toBeDisabled()
  expect(success).not.toHaveBeenCalled()
 }, 10000)
 it('does not add the lead-import choice to the contact Excel workflow', () => {
  render(<ImportCSVModal open defaultType="contacts" onClose={vi.fn()} onSuccess={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Usar etiqueta' })).not.toBeInTheDocument()
  expect(api).not.toHaveBeenCalled()
 })
})
