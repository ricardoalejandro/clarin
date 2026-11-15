import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DocumentModeIndicator } from './DocumentModeIndicator'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('only shows a display indicator for affected panels and explains it on demand', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const view = render(<DocumentModeIndicator />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  view.rerender(<DocumentModeIndicator status={{ lightPanels: ['a'], chunkedPanels: [] }} />)
  const trigger = screen.getByRole('button', { name: 'Modo ligero · Panel A' })
  expect(trigger).toHaveAttribute('title', expect.stringContaining('El archivo original'))
  fireEvent.click(trigger)
  expect(await screen.findByRole('dialog', { name: 'Modo ligero de este documento' })).toHaveTextContent('JSON/XML mantiene colores básicos')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  view.rerender(<DocumentModeIndicator status={{ lightPanels: [], chunkedPanels: [] }} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  view.rerender(<DocumentModeIndicator status={{ lightPanels: ['a'], chunkedPanels: [] }} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
