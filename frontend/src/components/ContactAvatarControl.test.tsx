import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContactAvatarControl, {
  contactAvatarMenuPosition,
  type ContactAvatarContextType,
} from './ContactAvatarControl'
import OperationalWindowShell from './operational-window/OperationalWindowShell'
import { OPERATIONAL_OVERLAY_LAYERS } from './operational-window/OperationalOverlayContext'

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
