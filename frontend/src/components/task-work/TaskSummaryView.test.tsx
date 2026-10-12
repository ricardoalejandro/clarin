import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TaskSummaryView from './TaskSummaryView'

afterEach(cleanup)

describe('authoritative task summary', () => {
  it('renders all authorized rows and aggregates independently of paginated cards', () => {
    render(<TaskSummaryView summary={{ total: 150, done: 25, active: 100, overdue: 6, owners: 2, progress: 40,
      by_status: [{ id: 'status', name: 'En revisión', color: '#123456', count: 100 }],
      by_owner: [{ id: 'owner', name: 'Responsable completo', count: 125, overdue: 6 }],
    }} />)
    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.getByText('En revisión')).toBeInTheDocument()
    expect(screen.getByText('Responsable completo')).toBeInTheDocument()
    expect(screen.getByText('125 · 6 vencidas')).toBeInTheDocument()
  })

  it('does not display zero totals before receiving an authoritative summary', () => {
    render(<TaskSummaryView summary={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('Cargando resumen')
    expect(screen.queryByText('Total')).not.toBeInTheDocument()
  })
})
