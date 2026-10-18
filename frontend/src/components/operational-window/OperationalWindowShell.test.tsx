import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OperationalWindowShell from './OperationalWindowShell'

const props = { open: true, storageKey: 'test-window', title: 'Configuración', eyebrow: 'Programa', onRequestClose: vi.fn() }
beforeEach(() => {
  localStorage.clear()
  props.onRequestClose.mockReset()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function clickCallback(element: HTMLElement): () => void {
  const key = Object.keys(element).find(value => value.startsWith('__reactProps$'))!
  return (element as any)[key].onClick
}

describe('operational window suspension and focus', () => {
  it('restores the same draft and field after suspension and returns focus to its trigger when closed', async () => {
    const initialFocusRef = createRef<HTMLInputElement>()
    const view = render(<><button>Invocador</button><OperationalWindowShell {...props} open={false} initialFocusRef={initialFocusRef}><input ref={initialFocusRef} aria-label="Nombre"/><textarea aria-label="Descripción"/></OperationalWindowShell></>)
    const trigger = screen.getByRole('button', { name: 'Invocador' }); trigger.focus()
    const content = <><input ref={initialFocusRef} aria-label="Nombre"/><textarea aria-label="Descripción"/></>
    view.rerender(<><button>Invocador</button><OperationalWindowShell {...props} initialFocusRef={initialFocusRef}>{content}</OperationalWindowShell></>)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveFocus())
    const description = screen.getByRole('textbox', { name: 'Descripción' })
    fireEvent.change(description, { target: { value: 'Borrador retenido' } }); description.focus()
    const oldClose = clickCallback(screen.getByRole('button', { name: 'Cerrar Configuración' }))
    view.rerender(<><button>Invocador</button><OperationalWindowShell {...props} suspended initialFocusRef={initialFocusRef}>{content}</OperationalWindowShell></>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-operational-window-shell]')).toHaveAttribute('inert')
    expect(description).not.toHaveFocus()
    await act(async () => oldClose())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onRequestClose).not.toHaveBeenCalled()
    view.rerender(<><button>Invocador</button><OperationalWindowShell {...props} initialFocusRef={initialFocusRef}>{content}</OperationalWindowShell></>)
    await waitFor(() => expect(description).toHaveFocus())
    expect(description).toHaveValue('Borrador retenido')
    view.rerender(<><button>Invocador</button><OperationalWindowShell {...props} open={false} initialFocusRef={initialFocusRef}>{content}</OperationalWindowShell></>)
    expect(trigger).toHaveFocus()
    await act(async () => oldClose())
    expect(props.onRequestClose).not.toHaveBeenCalled()
  })

  it.each(['hidden', 'disabled'] as const)('falls back to the initial field when retained focus becomes %s', async condition => {
    const initialFocusRef = createRef<HTMLInputElement>()
    const content = (unavailable = false) => <><input ref={initialFocusRef} aria-label="Nombre"/><div hidden={condition === 'hidden' && unavailable}><input aria-label="Preferencia" disabled={condition === 'disabled' && unavailable}/></div></>
    const view = render(<OperationalWindowShell {...props} initialFocusRef={initialFocusRef}>{content()}</OperationalWindowShell>)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveFocus())
    screen.getByRole('textbox', { name: 'Preferencia' }).focus()
    view.rerender(<OperationalWindowShell {...props} suspended initialFocusRef={initialFocusRef}>{content()}</OperationalWindowShell>)
    view.rerender(<OperationalWindowShell {...props} initialFocusRef={initialFocusRef}>{content(true)}</OperationalWindowShell>)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveFocus())
  })

  it('excludes collapsed controls from modal keyboard wrap and ignores hidden picker backdrops', async () => {
    render(<OperationalWindowShell {...props} temporaryMode="maximized"><button>Última visible</button><div hidden><button>Botón oculto</button><div data-operational-picker-backdrop/></div></OperationalWindowShell>)
    const first = screen.getByRole('button', { name: 'Cerrar Configuración' })
    const last = screen.getByRole('button', { name: 'Última visible' })
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())
    last.focus(); fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onRequestClose).toHaveBeenCalledOnce()
  })

  it('rejects an old close callback while busy', async () => {
    const view = render(<OperationalWindowShell {...props}><input aria-label="Nombre"/></OperationalWindowShell>)
    const oldClose = clickCallback(screen.getByRole('button', { name: 'Cerrar Configuración' }))
    view.rerender(<OperationalWindowShell {...props} busy><input aria-label="Nombre"/></OperationalWindowShell>)
    await act(async () => oldClose())
    expect(props.onRequestClose).not.toHaveBeenCalled()
  })
})
