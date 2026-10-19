import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgramAvatarControl, { ProgramAvatar } from './ProgramAvatarControl'
import type { Program } from '@/types/program'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'

const mocks = vi.hoisted(() => ({ api: vi.fn(), apiBlob: vi.fn(), apiUpload: vi.fn(), validate: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mocks.api, apiBlob: mocks.apiBlob, apiUpload: mocks.apiUpload }))
vi.mock('@/lib/avatarImageEditor', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/avatarImageEditor')>()), validateProgramAvatarFile: mocks.validate }))

const program = { id: 'program-1', name: 'Grupo Azul', color: '#10B981', avatar_url: null, avatar_revision: 0 } as Program
class ControlledImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
  naturalWidth = 1600
  naturalHeight = 1200
}
let images: ControlledImage[]
let nextURL = 0
const photo = { ...program, avatar_url: '/api/programs/program-1/avatar/content?v=1', avatar_revision: 1 }

beforeEach(() => {
  localStorage.clear(); completeAuthIdentityChange()
  images = []; nextURL = 0
  mocks.api.mockReset(); mocks.apiUpload.mockReset(); mocks.apiBlob.mockReset(); mocks.validate.mockReset()
  mocks.api.mockResolvedValue({ success: true, data: photo })
  mocks.apiUpload.mockResolvedValue({ success: true, data: photo })
  mocks.apiBlob.mockResolvedValue({ success: true, blob: new Blob(['photo'], { type: 'image/jpeg' }) })
  mocks.validate.mockResolvedValue({ width: 1600, height: 1200 })
  vi.stubGlobal('Image', class extends ControlledImage { constructor() { super(); images.push(this) } })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:photo-${++nextURL}`), revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), restore: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function selectPhoto() {
  fireEvent.click(screen.getByRole('button', { name: /Subir foto|Cambiar foto/ }))
  fireEvent.change(screen.getByLabelText('Seleccionar foto del programa'), { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } })
  await waitFor(() => expect(images.length).toBeGreaterThan(0))
  await act(async () => images.at(-1)!.onload?.())
  return images.at(-1)!
}
function callback(button: HTMLElement) {
  return (button as any)[Object.keys(button).find(key => key.startsWith('__reactProps$'))!].onClick as () => unknown
}

describe('Program photo editing and responsive ownership', () => {
  it('uploads one normalized JPEG after explicit confirmation and publishes canonical program once', async () => {
    const onChange = vi.fn(); const onDraftChange = vi.fn()
    render(<ProgramAvatarControl program={program} onChange={onChange} onDraftChange={onDraftChange} />)
    await selectPhoto()
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '1.5' } })
    expect(mocks.apiUpload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(photo))
    const [url, body] = mocks.apiUpload.mock.calls[0]
    expect(url).toBe('/api/programs/program-1/avatar')
    expect(body.get('expected_revision')).toBe('0')
    expect(body.get('file')).toMatchObject({ type: 'image/jpeg', name: 'program-avatar.jpg' })
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1')
  })
  it('retains crop, errors and exact focus while suspended; stale save and deletion callbacks cannot write', async () => {
    const view = render(<ProgramAvatarControl program={program} />)
    await selectPhoto()
    const zoom = screen.getByRole('slider', { name: 'Zoom' })
    fireEvent.change(zoom, { target: { value: '1.5' } }); zoom.focus()
    const save = callback(screen.getByRole('button', { name: 'Guardar foto' }))
    view.rerender(<ProgramAvatarControl program={program} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-program-avatar-dialog][hidden][inert]')).not.toBeNull()
    expect(zoom).not.toHaveFocus()
    await act(async () => { await save() })
    expect(mocks.apiUpload).not.toHaveBeenCalled()
    view.rerender(<ProgramAvatarControl program={program} />)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('1.5')
    expect(zoom).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    view.rerender(<ProgramAvatarControl program={photo} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar' }))
    const remove = callback(screen.getByRole('button', { name: 'Quitar foto' }))
    view.rerender(<ProgramAvatarControl program={photo} suspended />)
    await act(async () => { await remove() })
    expect(mocks.api).not.toHaveBeenCalled()
  })
  it('blocks a queued compression continuation on mobile, allowing an explicit retry on desktop', async () => {
    let encode!: BlobCallback
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(callback => { encode = callback })
    const view = render(<ProgramAvatarControl program={program} />)
    await selectPhoto()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    view.rerender(<ProgramAvatarControl program={program} suspended />)
    await act(async () => encode(new Blob(['jpeg'], { type: 'image/jpeg' })))
    expect(mocks.apiUpload).not.toHaveBeenCalled()
    view.rerender(<ProgramAvatarControl program={program} />)
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await waitFor(() => expect(mocks.apiUpload).toHaveBeenCalledTimes(1))
  })
  it('reconciles an upload already sent exactly once after suspension', async () => {
    let resolve!: (value: unknown) => void
    mocks.apiUpload.mockImplementation(() => new Promise(done => { resolve = done }))
    const onChange = vi.fn()
    const view = render(<ProgramAvatarControl program={program} onChange={onChange} />)
    await selectPhoto()
    const save = screen.getByRole('button', { name: 'Guardar foto' })
    save.focus(); fireEvent.click(save)
    await waitFor(() => expect(mocks.apiUpload).toHaveBeenCalledTimes(1))
    view.rerender(<ProgramAvatarControl program={program} onChange={onChange} suspended />)
    expect(save).not.toHaveFocus()
    await act(async () => resolve({ success: true, data: photo }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(photo)
    view.rerender(<ProgramAvatarControl program={photo} onChange={onChange} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('preserves crop on error/conflict and requires explicit version refresh before retry', async () => {
    mocks.apiUpload.mockResolvedValueOnce({ success: false, status: 500, error: 'No se pudo guardar' }).mockResolvedValueOnce({ success: false, status: 409 })
    mocks.api.mockResolvedValue({ success: true, data: { ...photo, avatar_revision: 4 } })
    render(<ProgramAvatarControl program={program} />)
    await selectPhoto()
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '1.8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Actualizar versión' }))
    expect(await screen.findByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('1.8')
    expect(mocks.apiUpload).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await waitFor(() => expect(mocks.apiUpload).toHaveBeenCalledTimes(3))
    expect(mocks.apiUpload.mock.calls[2][1].get('expected_revision')).toBe('4')
  })
  it('preserves a selected source whose validation finishes during suspension', async () => {
    let validate!: (value: unknown) => void
    mocks.validate.mockImplementation(() => new Promise(done => { validate = done }))
    const view = render(<ProgramAvatarControl program={program} />)
    fireEvent.click(screen.getByRole('button', { name: 'Subir foto' }))
    fireEvent.change(screen.getByLabelText('Seleccionar foto del programa'), { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } })
    view.rerender(<ProgramAvatarControl program={program} suspended />)
    await act(async () => validate({ width: 100, height: 100 }))
    await act(async () => images[0].onload?.())
    view.rerender(<ProgramAvatarControl program={program} />)
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    expect(mocks.apiUpload).not.toHaveBeenCalled()
  })
  it('rejects invalid original before Image decode and clears all source resources on owner change', async () => {
    mocks.validate.mockRejectedValueOnce(new Error('La imagen supera 40 megapíxeles'))
    const view = render(<ProgramAvatarControl program={program} />)
    fireEvent.click(screen.getByRole('button', { name: 'Subir foto' }))
    fireEvent.change(screen.getByLabelText('Seleccionar foto del programa'), { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('40 megapíxeles')
    expect(images).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    const image = await selectPhoto()
    view.rerender(<ProgramAvatarControl program={{ ...program, id: 'program-2' }} />)
    expect(image.src).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('drops stale upload completion after account change', async () => {
    let resolve!: (value: unknown) => void
    mocks.apiUpload.mockImplementation(() => new Promise(done => { resolve = done }))
    const onChange = vi.fn()
    render(<ProgramAvatarControl program={program} onChange={onChange} />)
    await selectPhoto(); fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await waitFor(() => expect(mocks.apiUpload).toHaveBeenCalledTimes(1))
    act(() => { beginAuthIdentityChange() })
    await act(async () => resolve({ success: true, data: photo }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('removes with explicit current revision and no duplicate confirmation', async () => {
    const onChange = vi.fn()
    render(<ProgramAvatarControl program={photo} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar' }))
    const confirm = screen.getByRole('button', { name: 'Quitar foto' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(mocks.api).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({ expected_revision: 1 })
  })
})

describe('Program photo consultation', () => {
  it('shares a pending download across program surfaces and reuses the same revision after remount', async () => {
    let finish!: (value: unknown) => void
    mocks.apiBlob.mockImplementationOnce(() => new Promise(done => { finish = done }))
    const first = render(<ProgramAvatar program={photo} />)
    const second = render(<ProgramAvatar program={photo} />)
    expect(mocks.apiBlob).toHaveBeenCalledTimes(1)
    await act(async () => finish({ success: true, blob: new Blob(['photo'], { type: 'image/jpeg' }) }))
    expect(screen.getAllByAltText('Foto de Grupo Azul')).toHaveLength(2)
    first.unmount(); second.unmount()
    render(<ProgramAvatar program={photo} />)
    await screen.findByAltText('Foto de Grupo Azul')
    expect(mocks.apiBlob).toHaveBeenCalledTimes(1)
  })
  it('fetches new revisions, clears removed photos and drops cached bytes on account change', async () => {
    const view = render(<ProgramAvatar program={photo} />)
    await screen.findByAltText('Foto de Grupo Azul')
    view.rerender(<ProgramAvatar program={{ ...photo, avatar_revision: 2 }} />)
    await waitFor(() => expect(screen.getByAltText('Foto de Grupo Azul')).toHaveAttribute('src', 'blob:photo-2'))
    expect(mocks.apiBlob).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1')
    view.rerender(<ProgramAvatar program={{ ...photo, avatar_url: null, avatar_revision: 3 }} />)
    expect(screen.queryByAltText('Foto de Grupo Azul')).not.toBeInTheDocument()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-2')
    view.rerender(<ProgramAvatar program={photo} />)
    await screen.findByAltText('Foto de Grupo Azul')
    act(() => { beginAuthIdentityChange() })
    expect(screen.queryByAltText('Foto de Grupo Azul')).not.toBeInTheDocument()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-3')
    act(() => { completeAuthIdentityChange() })
    await waitFor(() => expect(screen.getByAltText('Foto de Grupo Azul')).toHaveAttribute('src', 'blob:photo-4'))
    expect(mocks.apiBlob).toHaveBeenCalledTimes(4)
  })
  it('retains the fixed avatar box during downloading, success and failure', async () => {
    let finish!: (value: unknown) => void
    mocks.apiBlob.mockImplementationOnce(() => new Promise(done => { finish = done }))
    const view = render(<ProgramAvatar program={photo} className="h-10 w-10 shadow-sm" />)
    const box = view.container.firstElementChild
    expect(box).toHaveClass('h-10', 'w-10', 'shrink-0', 'overflow-hidden')
    await act(async () => finish({ success: true, blob: new Blob(['photo']) }))
    expect(view.container.firstElementChild).toBe(box)
    fireEvent.error(screen.getByAltText('Foto de Grupo Azul'))
    expect(view.container.firstElementChild).toBe(box)
    expect(box).toHaveClass('h-10', 'w-10')
  })
  it('retries a decoded image failure by invalidating cached bytes', async () => {
    render(<ProgramAvatar program={photo} interactive />)
    fireEvent.error(await screen.findByAltText('Foto de Grupo Azul'))
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto de Grupo Azul' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(mocks.apiBlob).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByAltText('Foto de Grupo Azul')[0]).toHaveAttribute('src', 'blob:photo-2'))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1')
  })
  it('pauses an open viewer without capturing keyboard events and restores its focus and image', async () => {
    const content = (suspended = false) => <><button>Fuera del visor</button><ProgramAvatarControl program={photo} readOnly suspended={suspended} /></>
    const view = render(content())
    await waitFor(() => expect(screen.getByAltText('Foto de Grupo Azul')).toHaveAttribute('src', 'blob:photo-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto de Grupo Azul' }))
    const close = screen.getByRole('button', { name: 'Cerrar foto' })
    expect(close).toHaveFocus()
    view.rerender(content(true))
    const dialog = document.querySelector('[data-program-avatar-dialog]')!
    expect(dialog).toHaveAttribute('hidden')
    expect(dialog).toHaveAttribute('inert')
    expect(close).not.toHaveFocus()
    const outside = screen.getByRole('button', { name: 'Fuera del visor' }); outside.focus()
    expect(fireEvent.keyDown(document, { key: 'Tab', cancelable: true })).toBe(true)
    expect(fireEvent.keyDown(document, { key: 'Escape', cancelable: true })).toBe(true)
    expect(outside).toHaveFocus()
    expect(document.querySelector('[data-program-avatar-dialog]')).toBe(dialog)
    view.rerender(content())
    expect(screen.getByRole('dialog', { name: 'Foto del programa' })).toBe(dialog)
    expect(close).toHaveFocus()
    expect(mocks.apiBlob).toHaveBeenCalledTimes(1)
    expect(mocks.apiUpload).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('times out a stalled download, retries explicitly and ignores its late completion', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    mocks.apiBlob.mockImplementationOnce(() => new Promise(done => { finish = done }))
    render(<ProgramAvatar program={photo} interactive />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto de Grupo Azul' }))
    expect(screen.getByRole('status')).toHaveTextContent('Cargando foto')
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar')
    expect(mocks.apiBlob.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reintentar' })))
    await act(async () => finish({ success: true, blob: new Blob(['stale']) }))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('loads private photo via authenticated blob and exposes only viewing in read-only mode', async () => {
    const view = render(<ProgramAvatarControl program={photo} readOnly />)
    expect(screen.queryByRole('button', { name: 'Cambiar foto' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByAltText('Foto de Grupo Azul')).toHaveAttribute('src', 'blob:photo-1'))
    expect(mocks.apiBlob.mock.calls[0][0]).toBe('/api/programs/program-1/avatar/content?v=1')
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto de Grupo Azul' }))
    expect(screen.getByRole('dialog', { name: 'Foto del programa' })).toBeInTheDocument()
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo-1')
    expect(mocks.apiUpload).not.toHaveBeenCalled()
  })
  it('uses a noninteractive fallback inside cards and ignores untrusted avatar URLs', async () => {
    const view = render(<ProgramAvatar program={program} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(mocks.apiBlob).not.toHaveBeenCalled()
    view.rerender(<ProgramAvatar program={{ ...photo, avatar_url: 'https://untrusted.test/picture' }} />)
    await waitFor(() => expect(mocks.apiBlob).toHaveBeenCalledTimes(1))
    expect(mocks.apiBlob.mock.calls[0][0]).toBe('/api/programs/program-1/avatar/content?v=1')
  })
})
