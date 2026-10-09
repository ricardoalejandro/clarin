import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContactAvatarControl, {
  contactAvatarCanvasDisplacement,
  contactAvatarMenuPosition,
  type ContactAvatarContextType,
} from './ContactAvatarControl'
import OperationalWindowShell from './operational-window/OperationalWindowShell'
import { OPERATIONAL_OVERLAY_LAYERS } from './operational-window/OperationalOverlayContext'
import { beginAuthIdentityChange, completeAuthIdentityChange, getAuthScope } from '@/lib/authScope'

const apiMocks = vi.hoisted(() => ({
  api: vi.fn(),
  apiUpload: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: apiMocks.api,
  apiUpload: apiMocks.apiUpload,
}))

const avatar = {
  contact_id: 'contact-1',
  avatar_url: 'https://example.test/contact-avatar.jpg',
  source: 'manual' as const,
  revision: 2,
}

const defaultProps = {
  contactId: 'contact-1',
  contextType: 'event_participant' as ContactAvatarContextType,
  contextId: 'participant-1',
  displayName: 'Ana Prueba',
  avatarUrl: avatar.avatar_url,
}

function mockApi() {
  apiMocks.api.mockImplementation(async (url: string) => {
    if (url.endsWith('/whatsapp-preview')) {
      return {
        success: true,
        data: {
          success: true,
          available: false,
          code: 'not_visible',
          message: 'Sin foto visible',
        },
      }
    }
    return {
      success: true,
      data: {
        success: true,
        avatar,
        devices: [],
      },
    }
  })
  apiMocks.apiUpload.mockResolvedValue({ success: true, data: { success: true, avatar } })
}

function renderLegacy(props: Partial<typeof defaultProps> = {}) {
  return render(<ContactAvatarControl {...defaultProps} {...props} />)
}

function renderOperational(onRequestClose = vi.fn()) {
  const result = render(
    <OperationalWindowShell
      open
      storageKey="contact-avatar-test"
      title="Participante"
      eyebrow="Evento"
      defaultMode="docked"
      onRequestClose={onRequestClose}
    >
      <ContactAvatarControl {...defaultProps} />
    </OperationalWindowShell>,
  )
  return { ...result, onRequestClose }
}

async function openMenu() {
  const trigger = await screen.findByRole('button', { name: 'Gestionar foto del contacto' })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu', { name: 'Opciones de foto del contacto' })
  await waitFor(() => expect(menu).toHaveStyle({ visibility: 'visible' }))
  return { trigger, menu }
}

async function findOperationalHost() {
  return waitFor(() => {
    const host = document.querySelector<HTMLElement>('[data-operational-overlay-host]')
    expect(host).toBeInTheDocument()
    return host as HTMLElement
  })
}

beforeEach(() => {
  localStorage.clear()
  apiMocks.api.mockReset()
  apiMocks.apiUpload.mockReset()
  mockApi()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('contactAvatarCanvasDisplacement', () => {
  it.each([512, 480, 309, 256])('mantiene 60 px visibles al arrastrar un canvas mostrado a %s px', width => {
    const result = contactAvatarCanvasDisplacement({ x: 60, y: -30 }, { width: 512, height: 512 }, { width, height: width })!
    expect(result.x * width / 512).toBeCloseTo(60)
    expect(result.y * width / 512).toBeCloseTo(-30)
  })

  it('convierte cada eje por su dimensión medida y rechaza geometría no visible', () => {
    expect(contactAvatarCanvasDisplacement({ x: 60, y: -30 }, { width: 512, height: 256 }, { width: 256, height: 64 })).toEqual({ x: 120, y: -120 })
    expect(contactAvatarCanvasDisplacement({ x: 60, y: 0 }, { width: 512, height: 512 }, { width: 0, height: 256 })).toBeNull()
    expect(contactAvatarCanvasDisplacement({ x: NaN, y: 0 }, { width: 512, height: 512 }, { width: 256, height: 256 })).toBeNull()
  })
})

describe('contactAvatarMenuPosition', () => {
  const viewport = { left: 100, top: 50, width: 320, height: 400 }

  it.each([
    {
      edge: 'superior izquierdo',
      anchor: { left: 102, right: 130, top: 52, bottom: 80 },
      expected: { top: 88, left: 108, width: 256, maxHeight: 354 },
    },
    {
      edge: 'superior derecho',
      anchor: { left: 390, right: 418, top: 52, bottom: 80 },
      expected: { top: 88, left: 156, width: 256, maxHeight: 354 },
    },
    {
      edge: 'inferior izquierdo',
      anchor: { left: 102, right: 130, top: 420, bottom: 448 },
      expected: { top: 112, left: 108, width: 256, maxHeight: 354 },
    },
    {
      edge: 'inferior derecho',
      anchor: { left: 390, right: 418, top: 420, bottom: 448 },
      expected: { top: 112, left: 156, width: 256, maxHeight: 354 },
    },
  ])('limita y voltea el menú en el borde $edge del visualViewport', ({ anchor, expected }) => {
    expect(contactAvatarMenuPosition(anchor, 300, viewport)).toEqual(expected)
  })

  it('adapta el ancho y descarta un disparador fuera del visualViewport', () => {
    expect(contactAvatarMenuPosition(
      { left: 205, right: 230, top: 30, bottom: 55 },
      500,
      { left: 20, top: 10, width: 240, height: 300 },
    )).toEqual({ top: 63, left: 28, width: 224, maxHeight: 239 })

    expect(contactAvatarMenuPosition(
      { left: 0, right: 10, top: 0, bottom: 10 },
      200,
      viewport,
    )).toBeNull()
  })
})

describe('ContactAvatarControl overlays', () => {
  it('entra con teclado solo después de mostrar el portal y conserva Inicio/Fin al reposicionar', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let sequence = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { const id = ++sequence; frames.set(id, callback); return id })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    const flushFrames = async () => {
      await act(async () => {
        const pending = [...frames.entries()]
        frames.clear()
        pending.forEach(([, callback]) => callback(16))
      })
    }
    const nativeFocus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      // JSDOM normally focuses hidden elements; browsers reject this focus.
      const menu = this.closest<HTMLElement>('[role="menu"]')
      if (menu && getComputedStyle(menu).visibility === 'hidden') return
      nativeFocus.call(this, options)
    })
    const view = renderLegacy()
    const trigger = await screen.findByRole('button', { name: 'Gestionar foto del contacto' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    // JSDOM does not dispatch the native button click generated by Enter.
    fireEvent.click(trigger)
    fireEvent.keyUp(trigger, { key: 'Enter' })
    await flushFrames()
    const menu = screen.getByRole('menu', { name: 'Opciones de foto del contacto' })
    const items = screen.getAllByRole('menuitem')
    expect(menu).toHaveStyle({ visibility: 'visible' })
    expect(items[0]).toHaveFocus()
    fireEvent.resize(window)
    expect(frames.size).toBeGreaterThan(0)
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(items.at(-1)).toHaveFocus()
    expect(frames.size).toBe(0)
    fireEvent.resize(window)
    await flushFrames()
    expect(items.at(-1)).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flushFrames()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    await flushFrames()
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()
    fireEvent.resize(window)
    expect(frames.size).toBeGreaterThan(0)
    view.rerender(<ContactAvatarControl {...defaultProps} contactId="contact-2" contextId="participant-2" />)
    expect(frames.size).toBe(0)
    await flushFrames()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(frames.size).toBe(0)
  })

  it('porta el menú y el visor al body con las capas globales de compatibilidad', async () => {
    renderLegacy()
    const { menu } = await openMenu()

    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveStyle({ zIndex: '95' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ver foto' }))

    const dialog = await screen.findByRole('dialog', { name: 'Gestionar foto del contacto' })
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog).toHaveStyle({ zIndex: '100' })
  })

  it('porta el menú y los diálogos al host operacional con capas semánticas', async () => {
    renderOperational()
    const host = await findOperationalHost()
    const { menu } = await openMenu()

    expect(menu.parentElement).toBe(host)
    expect(menu).toHaveClass('pointer-events-auto')
    expect(menu).toHaveStyle({ zIndex: String(OPERATIONAL_OVERLAY_LAYERS.menu) })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ver foto' }))

    const dialog = await screen.findByRole('dialog', { name: 'Gestionar foto del contacto' })
    expect(dialog.parentElement).toBe(host)
    expect(dialog).toHaveClass('pointer-events-auto')
    expect(dialog).toHaveStyle({ zIndex: String(OPERATIONAL_OVERLAY_LAYERS.dialog) })
  })

  it('cierra menú y diálogo con Escape, conserva la ventana y restaura el foco', async () => {
    const { onRequestClose } = renderOperational()
    const { trigger } = await openMenu()

    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Ver foto' })).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onRequestClose).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ver foto' }))
    const closeButton = await screen.findByRole('button', { name: 'Cerrar' })
    const cancelButton = screen.getByRole('button', { name: 'Cancelar' })
    await waitFor(() => expect(closeButton).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(cancelButton).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(closeButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Gestionar foto del contacto' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onRequestClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Participante' })).toBeInTheDocument()
  })

  it('permite navegar el menú con flechas, Inicio y Fin', async () => {
    renderLegacy()
    await openMenu()
    const items = screen.getAllByRole('menuitem')

    await waitFor(() => expect(items[0]).toHaveFocus())
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
    fireEvent.keyDown(items[1], { key: 'End' })
    expect(items.at(-1)).toHaveFocus()
    fireEvent.keyDown(items.at(-1)!, { key: 'Home' })
    expect(items[0]).toHaveFocus()
  })

  it.each([
    ['Actualizar desde WhatsApp', 'Comparar con WhatsApp'],
    ['Quitar foto', 'Quitar foto'],
  ])('abre %s en el host operacional', async (action, heading) => {
    renderOperational()
    const host = await findOperationalHost()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: action }))

    const dialog = await screen.findByRole('dialog', { name: 'Gestionar foto del contacto' })
    expect(dialog.parentElement).toBe(host)
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('abre el editor de subida en el host operacional y devuelve el foco a la cámara', async () => {
    renderOperational()
    const host = await findOperationalHost()
    const { trigger } = await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Subir o reemplazar' }))

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).toBeInTheDocument()
    fireEvent.change(input!, { target: { files: [new File(['texto'], 'avatar.txt', { type: 'text/plain' })] } })

    const dialog = await screen.findByRole('dialog', { name: 'Gestionar foto del contacto' })
    expect(dialog.parentElement).toBe(host)
    expect(screen.getByRole('heading', { name: 'Editar foto' })).toBeInTheDocument()
    expect(screen.getByText('Usa una imagen JPEG o PNG de hasta 8 MB')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})

describe('ContactAvatarControl context contract', () => {
  it('descarta metadata y eventos de una cuenta anterior aunque el Contact ID coincida', async () => {
    const previousScope = getAuthScope()
    let resolveOld: (value: unknown) => void = () => {}
    apiMocks.api.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    apiMocks.api.mockResolvedValue({ success: true, data: { avatar: { avatar_url: null, revision: 5 }, devices: [] } })
    renderLegacy()
    await waitFor(() => expect(apiMocks.api).toHaveBeenCalledTimes(1))
    act(() => { beginAuthIdentityChange(); completeAuthIdentityChange() })
    await waitFor(() => expect(apiMocks.api).toHaveBeenCalledTimes(2))
    await act(async () => { resolveOld({ success: true, data: { avatar, devices: [] } }) })
    act(() => window.dispatchEvent(new CustomEvent('clarin:contact-avatar-updated', { detail: { contactId: defaultProps.contactId, avatar: { ...avatar, revision: 99 }, authScope: previousScope } })))
    expect(screen.queryByRole('img', { name: 'Foto de Ana Prueba' })).not.toBeInTheDocument()
  })

  it('una actualización de foto no cierra un diálogo abierto y un cero canónico quita la imagen', async () => {
    const view = renderLegacy()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ver foto' }))
    expect(await screen.findByRole('dialog', { name: 'Gestionar foto del contacto' })).toBeInTheDocument()
    view.rerender(<ContactAvatarControl {...defaultProps} avatarUrl={null} />)
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Foto de Ana Prueba' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Gestionar foto del contacto' })).toBeInTheDocument()
    expect(apiMocks.api).toHaveBeenCalledTimes(1)
  })

  it.each<ContactAvatarContextType>([
    'contact',
    'lead',
    'chat',
    'event_participant',
    'program_participant',
  ])('conserva context_type y context_id para %s', async contextType => {
    const contextId = `${contextType}-42`
    renderLegacy({ contextType, contextId })

    await waitFor(() => expect(apiMocks.api).toHaveBeenCalled())
    const requestedURL = apiMocks.api.mock.calls[0]?.[0] as string
    const url = new URL(requestedURL, 'https://clarin.test')
    expect(url.searchParams.get('context_type')).toBe(contextType)
    expect(url.searchParams.get('context_id')).toBe(contextId)

    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Actualizar desde WhatsApp' }))
    await waitFor(() => expect(apiMocks.api.mock.calls.length).toBeGreaterThanOrEqual(2))
    const previewCall = apiMocks.api.mock.calls.find(call => String(call[0]).endsWith('/whatsapp-preview'))
    expect(previewCall).toBeDefined()
    expect(JSON.parse(String(previewCall?.[1]?.body))).toMatchObject({
      context_type: contextType,
      context_id: contextId,
    })
  })
})

describe('ContactAvatarControl manual image session', () => {
  class ControlledImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    src = ''
    naturalWidth = 1024
    naturalHeight = 1024
  }

  let images: ControlledImage[]
  let drawing: {
    clearRect: ReturnType<typeof vi.fn>
    fillRect: ReturnType<typeof vi.fn>
    save: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
    translate: ReturnType<typeof vi.fn>
    rotate: ReturnType<typeof vi.fn>
    scale: ReturnType<typeof vi.fn>
    drawImage: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    images = []
    vi.stubGlobal('Image', class extends ControlledImage {
      constructor() { super(); images.push(this) }
    })
    vi.stubGlobal('PointerEvent', MouseEvent)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:avatar-${images.length}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    drawing = {
      clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawing as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })))
  })

  async function selectFile(file = new File(['png'], 'photo.png', { type: 'image/png' })) {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Subir o reemplazar' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } })
    return images.at(-1)
  }

  async function loadImage() {
    const image = await selectFile()
    await act(async () => { image!.onload!() })
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    return image!
  }

  it('aplica la escala CSS al arrastre real del componente y permite deshacerlo', async () => {
    renderLegacy()
    await loadImage()
    const canvas = document.querySelector('canvas')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 256, height: 256 } as DOMRect)
    canvas.setPointerCapture = vi.fn()
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 70 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(drawing.translate).toHaveBeenLastCalledWith(376, 196)
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(drawing.translate).toHaveBeenLastCalledWith(256, 256)
  })

  it('al cerrar y reabrir con PNG corrupto no conserva bytes ni permite guardar, y recupera con un archivo válido', async () => {
    renderLegacy()
    const first = await loadImage()
    const lateLoad = first.onload!
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-0')
    expect(first.src).toBe('')
    const corrupt = await selectFile(new File(['corrupt'], 'broken.png', { type: 'image/png' }))
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeDisabled()
    await act(async () => { corrupt!.onerror!(); lateLoad() })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('No se pudo leer la imagen')
    expect(alert.closest('.overflow-y-auto')).toBeNull()
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    expect(apiMocks.apiUpload).not.toHaveBeenCalled()
    expect(drawing.drawImage).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    const replacement = await loadImage()
    expect(screen.queryByText('No se pudo leer la imagen')).not.toBeInTheDocument()
    expect(drawing.drawImage.mock.calls.at(-1)?.[0]).toBe(replacement)
  })

  it.each(['mime', 'size'] as const)('una selección inválida por %s invalida la carga pendiente y deja Guardar deshabilitado', async invalid => {
    renderLegacy()
    const pending = await selectFile()
    const lateLoad = pending!.onload!
    const lateError = pending!.onerror!
    const file = invalid === 'mime'
      ? new File(['text'], 'bad.txt', { type: 'text/plain' })
      : new File(['png'], 'large.png', { type: 'image/png' })
    if (invalid === 'size') Object.defineProperty(file, 'size', { value: 8 * 1024 * 1024 + 1 })
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } })
    await act(async () => { lateLoad(); lateError() })
    expect(screen.getByText('Usa una imagen JPEG o PNG de hasta 8 MB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeDisabled()
    expect(drawing.drawImage).not.toHaveBeenCalled()
    expect(pending!.onload).toBeNull()
    expect(pending!.onerror).toBeNull()
    expect(pending!.src).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-0')
  })

  it.each(['close', 'contact', 'account', 'unmount'] as const)('descarta callbacks de una imagen pendiente tras %s', async transition => {
    const view = renderLegacy()
    const image = await selectFile()
    const lateLoad = image!.onload!
    const lateError = image!.onerror!
    expect(screen.getByRole('status')).toHaveTextContent('Preparando imagen')
    if (transition === 'close') fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    else if (transition === 'contact') view.rerender(<ContactAvatarControl {...defaultProps} contactId="contact-2" contextId="participant-2" />)
    else if (transition === 'account') act(() => { beginAuthIdentityChange(); completeAuthIdentityChange() })
    else view.unmount()
    await act(async () => { lateLoad(); lateError() })
    expect(screen.queryByRole('dialog', { name: 'Gestionar foto del contacto' })).not.toBeInTheDocument()
    expect(drawing.drawImage).not.toHaveBeenCalled()
    expect(apiMocks.apiUpload).not.toHaveBeenCalled()
    expect(image!.onload).toBeNull()
    expect(image!.onerror).toBeNull()
    expect(image!.src).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('una segunda selección prevalece sobre los callbacks tardíos de la primera', async () => {
    renderLegacy()
    const first = await selectFile()
    const lateLoad = first!.onload!
    const lateError = first!.onerror!
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File(['jpeg'], 'second.jpg', { type: 'image/jpeg' })] } })
    const second = images.at(-1)!
    await act(async () => { second.onload!(); lateLoad(); lateError() })
    expect(drawing.drawImage.mock.calls.at(-1)?.[0]).toBe(second)
    expect(screen.queryByText('No se pudo leer la imagen')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-0')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:avatar-1')
  })

  it('conserva el recorte para reintentar errores de exportación y subida, y libera el recurso al guardar', async () => {
    const onChange = vi.fn()
    render(<ContactAvatarControl {...defaultProps} onChange={onChange} />)
    const image = await loadImage()
    fireEvent.click(screen.getByRole('button', { name: 'Girar' }))
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(callback => callback(null))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await screen.findByText('No se pudo preparar la imagen. Vuelve a intentarlo.')
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    expect(apiMocks.apiUpload).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    apiMocks.apiUpload.mockResolvedValueOnce({ success: false, error: 'Cuota agotada' })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await screen.findByText('Cuota agotada')
    expect(screen.getByRole('button', { name: 'Guardar foto' })).toBeEnabled()
    expect(drawing.drawImage.mock.calls.at(-1)?.[0]).toBe(image)
    expect(drawing.rotate).toHaveBeenLastCalledWith(Math.PI / 2)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar foto' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Gestionar foto del contacto' })).not.toBeInTheDocument())
    expect(onChange).toHaveBeenCalledWith(avatar)
    const [url, form] = apiMocks.apiUpload.mock.calls.at(-1)!
    expect(url).toBe('/api/contact-avatars/contact-1/upload')
    expect(form.get('context_type')).toBe('event_participant')
    expect(form.get('context_id')).toBe('participant-1')
    expect(form.get('image').type).toBe('image/jpeg')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-0')
    expect(image.src).toBe('')
  })
})
