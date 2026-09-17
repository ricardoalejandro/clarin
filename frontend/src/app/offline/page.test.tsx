import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import OfflinePage from './page'

it('offers explicit online recovery without instructing deletion of encrypted pending work', () => {
  render(<OfflinePage />)
  expect(screen.getByText(/No borres los datos del navegador/)).toBeVisible()
  expect(screen.getByRole('link', { name: 'Volver a iniciar sesión con conexión' })).toHaveAttribute('href', '/login?offline_fresh_login=1')
  expect(screen.queryByText(/no guarda datos de tu cuenta/)).not.toBeInTheDocument()
})
