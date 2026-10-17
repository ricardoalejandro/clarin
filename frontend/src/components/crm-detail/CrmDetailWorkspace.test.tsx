import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CrmDetailWorkspace from './CrmDetailWorkspace'

vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: () => {}, width: 560 }) }))
afterEach(cleanup)

describe('CRM conversation suspension', () => {
  it('retains the same child and draft while mobile details remain usable', () => {
    const unmounted = vi.fn()
    function Draft() {
      const [value, setValue] = useState('')
      useEffect(() => () => unmounted(), [])
      return <input aria-label="Borrador retenido" value={value} onChange={event => setValue(event.target.value)} />
    }
    const query = vi.fn()
    const back = vi.fn()
    const view = (suspended: boolean) => <CrmDetailWorkspace chatOpen chatSuspended={suspended} onBackToDetail={back} detail={<button onClick={query}>Consultar participante</button>} chat={<Draft />} />
    const panel = render(view(false))
    const editor = screen.getByRole('textbox', { name: 'Borrador retenido' })
    fireEvent.change(editor, { target: { value: 'Continúa al volver a escritorio' } })
    panel.rerender(view(true))
    expect(editor.closest('[hidden][inert]')).not.toBeNull()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Consultar participante' }))
    expect(query).toHaveBeenCalledOnce()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(back).not.toHaveBeenCalled()
    expect(unmounted).not.toHaveBeenCalled()
    panel.rerender(view(false))
    expect(screen.getByRole('textbox', { name: 'Borrador retenido' })).toBe(editor)
    expect(editor).toHaveValue('Continúa al volver a escritorio')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(back).toHaveBeenCalledOnce()
  })
})
