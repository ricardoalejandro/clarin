import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineConflict } from '@/offline-v3/types'
import OfflineConflictsView from './OfflineConflictsView'

afterEach(cleanup)
const conflict: OfflineConflict = { operation_id:'op', selection_id:'selection', resource_id:'task', status:'conflict', error_code:'version_conflict', created_at:'2026-09-14T00:00:00Z', client_change:{title:'Informe conservado',status_category:'done',priority:'high'}, server_result:{task:{title:'Informe canónico',status_category:'active',priority:'urgent'}} }
const gateway = (fetch: NonNullable<OfflineDataGateway['conflicts']>) => ({conflicts:fetch} as OfflineDataGateway)

describe('private offline change review', () => {
  it('keeps client change separate from the canonical server version with no write control', async () => {
    render(<OfflineConflictsView gateway={gateway(vi.fn().mockResolvedValue({items:[conflict]}))} />)
    fireEvent.click(await screen.findByText('Informe conservado', {selector:'summary strong'}))
    expect(screen.getByText('Tu cambio guardado')).toBeVisible()
    expect(screen.getByText('Informe canónico')).toBeVisible()
    expect(screen.getByText('Completada')).toBeVisible()
    expect(screen.getByText('En curso')).toBeVisible()
    expect(screen.queryByRole('button',{name:/Aplicar|Sobrescribir|Eliminar/})).not.toBeInTheDocument()
  })
  it('does not hide an error behind a zero-conflict empty state and allows retry', async () => {
    const fetch=vi.fn().mockRejectedValueOnce(new Error('Copia bloqueada')).mockResolvedValue({items:[]})
    render(<OfflineConflictsView gateway={gateway(fetch)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Copia bloqueada')
    expect(screen.queryByText('No hay cambios por revisar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Actualizar'}))
    expect(await screen.findByText('No hay cambios por revisar')).toBeVisible()
  })
  it('discards a late previous-account result after a gateway change', async () => {
    let finish!:(result:unknown)=>void
    const previous=gateway(vi.fn(()=>new Promise(resolve=>{finish=resolve})) as NonNullable<OfflineDataGateway['conflicts']>)
    const current=gateway(vi.fn().mockResolvedValue({items:[]}))
    const view=render(<OfflineConflictsView gateway={previous} />)
    view.rerender(<OfflineConflictsView gateway={current} />)
    expect(await screen.findByText('No hay cambios por revisar')).toBeVisible()
    await act(async()=>finish({items:[conflict]}))
    expect(screen.queryByText('Informe conservado')).not.toBeInTheDocument()
  })
})
