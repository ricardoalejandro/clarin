import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageRecommendations } from './StorageRecommendations'
import type { StorageUsage } from './storageModel'

afterEach(cleanup)
const usage = { scope: 'authorized', catalog_status: 'ready', inventory_complete: true, recommendations: [{ id: 'large_files', count: 2, bytes: 20971520, filters: { min_size: 10485760 } }] } as StorageUsage

describe('storage authorized recommendations', () => {
  it('offers only actual positive candidates and forwards the exact canonical filter', () => {
    const onChoose = vi.fn()
    render(<StorageRecommendations usage={{ ...usage, recommendations: [...usage.recommendations!, { id: 'unused_uploads', count: 0, bytes: 0, filters: { status: 'unused_uploads' } }] }} onChoose={onChoose} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Archivos grandes/ }))
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(usage.recommendations![0])
    expect(screen.getByText(/todavía no es espacio liberado/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Mis cargas sin utilizar/ })).toBeNull()
  })
  it('makes an incomplete inventory explicit without inventing a verification date', () => {
    render(<StorageRecommendations usage={{ ...usage, catalog_status: 'degraded', inventory_complete: false, last_verified_at: 'invalid' }} onChoose={vi.fn()} disabled />)
    expect(screen.getByRole('status').textContent).toContain('La verificación del inventario no está completa')
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
    expect(screen.getByRole('button', { name: /Archivos grandes/ })).toBeDisabled()
  })
  it('uses singular for one candidate and plural for multiple candidates', () => {
    render(<StorageRecommendations usage={{ ...usage, recommendations: [{ id: 'large_files', count: 1, bytes: 12582912, filters: { min_size: 10485760 } }, { id: 'trash_ready', count: 2, bytes: 2048, filters: { status: 'trash_ready' } }] }} onChoose={vi.fn()} disabled={false} />)
    expect(screen.getByText('1 archivo · 12 MiB')).toBeTruthy()
    expect(screen.getByText('2 archivos · 2.0 KiB')).toBeTruthy()
    expect(screen.queryByText(/1 archivos/)).toBeNull()
  })

})
