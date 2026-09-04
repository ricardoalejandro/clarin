import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState, type FormEvent } from 'react'
import { UserRoundPlus } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminFormDialog, { type AdminFormDialogSize } from './AdminFormDialog'

let offsetParentSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  offsetParentSpy = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)
})

afterEach(() => {
  cleanup()
  offsetParentSpy.mockRestore()
})

function DialogFixture({
  open = true,
  busy = false,
  size = 'user',
  onClose = vi.fn(),
}: {
  open?: boolean
  busy?: boolean
  size?: AdminFormDialogSize
  onClose?: () => void
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null)

  return (
    <AdminFormDialog
      open={open}
      size={size}
      title="Crear usuario"
      description="Configura su acceso a Clarin."
      icon={UserRoundPlus}
      busy={busy}
      onClose={onClose}
      initialFocusRef={firstFieldRef}
      footer={<button type="button">Cancelar</button>}
    >
      <label>
        Nombre
        <input ref={firstFieldRef} />
      </label>
    </AdminFormDialog>
  )
}

describe('AdminFormDialog', () => {
  it('portals a labelled modal with one scroll owner and fixed header/footer geometry', () => {
    const { container } = render(<DialogFixture />)

    expect(container).toBeEmptyDOMElement()
    const dialog = screen.getByRole('dialog', { name: 'Crear usuario' })
    const title = screen.getByText('Crear usuario')
    const description = screen.getByText('Configura su acceso a Clarin.')
    const backdrop = dialog.parentElement

    expect(backdrop?.parentElement).toBe(document.body)
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', title.id)
    expect(dialog).toHaveAttribute('aria-describedby', description.id)
    expect(dialog).toHaveClass('overflow-hidden')
    expect(dialog.querySelectorAll('[data-admin-dialog-scroll-owner]')).toHaveLength(1)
    expect(dialog.querySelector('header')).toHaveClass('shrink-0')
    expect(dialog.querySelector('footer')).toHaveClass('shrink-0', 'flex-col', 'sm:flex-row')
    expect(screen.getByRole('button', { name: 'Cerrar Crear usuario' })).toHaveClass('h-11', 'w-11')
  })

  it.each([
    ['role', 'sm:max-w-[512px]'],
    ['account', 'sm:max-w-[576px]'],
    ['user', 'sm:max-w-[672px]'],
    ['password', 'sm:max-w-[448px]'],
  ] as const)('uses the %s width and shared responsive height contract', (size, widthClass) => {
    render(<DialogFixture size={size} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-admin-dialog-size', size)
    expect(dialog).toHaveClass(widthClass)
    expect(dialog).toHaveClass(
      'h-[var(--app-height,100dvh)]',
      'rounded-none',
      'sm:h-auto',
      'sm:max-h-[min(720px,calc(100dvh-32px))]',
      'sm:rounded-3xl',
    )
  })

  it('traps focus and restores it to the control that opened the dialog', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      const firstFieldRef = useRef<HTMLInputElement>(null)

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Añadir usuario</button>
          <AdminFormDialog
            open={open}
            size="user"
            title="Crear usuario"
            description="Configura su acceso a Clarin."
            icon={UserRoundPlus}
            onClose={() => setOpen(false)}
            initialFocusRef={firstFieldRef}
            footer={<button type="button">Cancelar</button>}
          >
            <input ref={firstFieldRef} aria-label="Nombre de usuario" />
          </AdminFormDialog>
        </>
      )
    }

    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Añadir usuario' })
    opener.focus()
    fireEvent.click(opener)

    const firstField = await screen.findByRole('textbox', { name: 'Nombre de usuario' })
    await waitFor(() => expect(firstField).toHaveFocus())

    const close = screen.getByRole('button', { name: 'Cerrar Crear usuario' })
    const last = screen.getByRole('button', { name: 'Cancelar' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.click(close)
    await waitFor(() => expect(opener).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks Escape, backdrop dismissal, close, and repeated submission while busy', () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault())

    render(
      <AdminFormDialog
        open
        size="account"
        title="Crear cuenta"
        description="Configura la cuenta."
        icon={UserRoundPlus}
        busy
        onClose={onClose}
        onSubmit={onSubmit}
        footer={<button type="submit">Guardar</button>}
      >
        <input aria-label="Nombre" />
      </AdminFormDialog>,
    )

    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.parentElement as HTMLElement
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Cerrar Crear cuenta' })).toBeDisabled()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(backdrop)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar Crear cuenta' }))
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar' }).closest('form') as HTMLFormElement)

    expect(onClose).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits through the semantic form and closes from Escape or the backdrop when idle', () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault())
    const { rerender } = render(
      <AdminFormDialog
        open
        size="role"
        title="Crear rol"
        description="Configura sus permisos."
        icon={UserRoundPlus}
        onClose={onClose}
        onSubmit={onSubmit}
        footer={<button type="submit">Crear rol</button>}
      >
        <input aria-label="Nombre del rol" />
      </AdminFormDialog>,
    )

    const submit = screen.getByRole('button', { name: 'Crear rol' })
    expect(submit.closest('form')).toBeInTheDocument()
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledOnce()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    onClose.mockClear()
    rerender(
      <AdminFormDialog
        open
        size="role"
        title="Crear rol"
        description="Configura sus permisos."
        icon={UserRoundPlus}
        onClose={onClose}
        footer={<button type="button">Cancelar</button>}
      >
        Contenido
      </AdminFormDialog>,
    )
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
