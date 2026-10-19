import { describe, expect, it } from 'vitest'
import { chatReadError } from './chatReadError'

describe('chat read error feedback', () => {
  it('keeps a generic failed request visible with its HTTP status in Spanish', () => {
    expect(chatReadError('Bad Request', 'No se pudo cargar esta vista.', 400)).toBe('No se pudo cargar esta vista (error 400).')
    expect(chatReadError('Internal Server Error', 'No se pudo cargar el historial.', 500)).toBe('No se pudo cargar el historial (error 500).')
  })
  it('preserves actionable API errors and gives network failures a calm retry message', () => {
    expect(chatReadError('Historial no disponible', 'Reintenta.', 502)).toBe('Historial no disponible')
    expect(chatReadError(new TypeError('Failed to fetch'), 'No se pudo cargar el historial. Reintenta.')).toBe('No se pudo cargar el historial. Reintenta.')
  })
  it('does not reinterpret a malformed successful response as an empty collection', () => {
    expect(chatReadError(undefined, 'No se pudo cargar el historial.', 200)).toBe('No se pudo cargar el historial.')
  })
})
