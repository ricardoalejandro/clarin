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

it('reports structural folding progress, explicit limits and recoverable failures without changing document data', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const view = render(<DocumentModeIndicator status={{ lightPanels: ['a'], chunkedPanels: [], folding: { a: { phase: 'preparing', regions: 0 } } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Modo ligero · Panel A' }))
  expect(screen.getByRole('status', { name: 'Plegado del panel A' })).toHaveTextContent('preparando plegado local')
  view.rerender(<DocumentModeIndicator status={{ lightPanels: ['a'], chunkedPanels: [], folding: { a: { phase: 'limited', regions: 5000, reason: 'regions' } } }} />)
  expect(screen.getByRole('status')).toHaveTextContent('5.000 bloques')
  expect(screen.getByRole('status')).toHaveTextContent('secciones principales')
  view.rerender(<DocumentModeIndicator status={{ lightPanels: ['a'], chunkedPanels: [], folding: { a: { phase: 'timeout', regions: 0 } } }} />)
  expect(screen.getByRole('status')).toHaveTextContent('10 segundos')
  expect(screen.getByRole('status')).toHaveTextContent('reintentar')
  expect(screen.getByRole('dialog')).toHaveTextContent('plegado estructural local')
})
