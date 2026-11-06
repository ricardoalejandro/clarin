import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import CryptoUtility from './CryptoUtility'

it('encodes and decodes Unicode with explicit result feedback and clears the draft on tool switch', async () => {
  render(<CryptoUtility />)
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(screen.getByRole('button', { name: 'Base64' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByRole('textbox', { name: 'Texto (UTF-8)' }), { target: { value: 'á' } })
  fireEvent.click(screen.getByRole('button', { name: 'Codificar' }))
  expect(await screen.findByRole('textbox', { name: 'Texto codificado' })).toHaveValue('w6E=')
  fireEvent.change(screen.getByRole('combobox', { name: 'Operación' }), { target: { value: 'decode' } })
  const encoded = screen.getByRole('textbox', { name: 'Entrada en Base64' })
  expect(encoded).toHaveValue('á')
  fireEvent.change(encoded, { target: { value: 'w6E=' } })
  fireEvent.click(screen.getByRole('button', { name: 'Decodificar' }))
  expect(await screen.findByRole('textbox', { name: 'Texto decodificado' })).toHaveValue('á')
  fireEvent.click(screen.getByRole('button', { name: 'Claves' }))
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(screen.getByRole('textbox', { name: 'Texto (UTF-8)' })).toHaveValue('')
})
