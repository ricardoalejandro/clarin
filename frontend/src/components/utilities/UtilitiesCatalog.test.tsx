import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { canUseUtilities, isUtilitiesPath, utilityById } from './catalog'
import { UtilitiesCatalog } from './UtilitiesCatalog'

describe('Utilitarios', () => {
  it('uses explicit role authorization and the same scope for nested links', () => {
    expect(canUseUtilities({ permissions: ['reports'] })).toBe(false)
    expect(canUseUtilities({ permissions: ['utilities'] })).toBe(true)
    expect(canUseUtilities({ permissions: ['*'] })).toBe(true)
    expect(canUseUtilities({ is_admin: true })).toBe(true)
    expect(isUtilitiesPath('/dashboard/utilities/json')).toBe(true)
    expect(isUtilitiesPath('/dashboard/utilities-other')).toBe(false)
    expect(utilityById('invalid')).toBeUndefined()
  })

  it('links the four selectable cards to separate workspaces', () => {
    render(<UtilitiesCatalog />)
    expect(screen.getAllByRole('link')).toHaveLength(4)
    expect(screen.getByRole('link', { name: /Editor JSON/ })).toHaveAttribute('href', '/dashboard/utilities/json')
    expect(screen.getByRole('link', { name: /Códigos QR/ })).toHaveAttribute('href', '/dashboard/utilities/qr')
    expect(screen.getByRole('link', { name: /Imagen ⇄ Base64/ })).toHaveAttribute('href', '/dashboard/utilities/imagen-base64')
    expect(screen.getByRole('link', { name: /Criptografía/ })).toHaveAttribute('href', '/dashboard/utilities/criptografia')
  })
})
