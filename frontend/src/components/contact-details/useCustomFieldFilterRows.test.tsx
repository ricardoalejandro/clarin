import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OperationalDatePicker from '@/components/operational-date/OperationalDatePicker'
import { useOperationalDateFields } from '@/components/operational-date/useOperationalDateFields'
import type { CustomFieldFilter } from '@/types/custom-field'
import { customFieldFilterDateKey, customFieldFilterRowKey, identifyCustomFieldFilterRows, useCustomFieldFilterRows } from './useCustomFieldFilterRows'

afterEach(cleanup)
const initial: CustomFieldFilter[] = [
  { field_id: 'date-a', operator: 'eq', value: '2026-01-01' },
  { field_id: 'date-b', operator: 'eq', value: '2026-01-02' },
]

function Filters({ save }: { save: (filters: CustomFieldFilter[]) => void }) {
  const [rows, setRows] = useCustomFieldFilterRows()
  const dates = useOperationalDateFields()
  useEffect(() => { setRows(initial) }, [setRows])
  return <>
    {rows.map((row, index) => <div key={customFieldFilterRowKey(row)}>
      <OperationalDatePicker key={row.field_id} mode="date" label={`Fecha ${index + 1}`} value={String(row.value)}
        onDraftStateChange={dates.track(customFieldFilterDateKey(row))}
        onChange={value => setRows(current => current.map((filter, position) => position === index ? { ...filter, value } : filter))} />
    </div>)}
    <button onClick={() => setRows(current => current.map((row, index) => index === 0 ? { ...row, field_id: 'date-b', value: '' } : row))}>Cambiar definición</button>
    <button onClick={() => setRows(current => current.slice(1))}>Eliminar primera fila</button>
    <button onClick={() => { if (dates.validate()) save(rows.map(row => ({ ...row, value: dates.value(customFieldFilterDateKey(row), String(row.value)) }))) }}>Aplicar</button>
  </>
}

describe('custom date-filter row identity', () => {
  it('keeps local identity through edits without putting it in JSON or cloned API data', () => {
    const rows = identifyCustomFieldFilterRows(initial)
    const edited = identifyCustomFieldFilterRows([{ ...rows[0], value: '2026-02-15' }, rows[1]])
    expect(customFieldFilterRowKey(edited[0])).toBe(customFieldFilterRowKey(rows[0]))
    expect(customFieldFilterRowKey(edited[1])).toBe(customFieldFilterRowKey(rows[1]))
    expect(JSON.parse(JSON.stringify(rows))).toEqual(initial)
    expect(Object.getOwnPropertySymbols(structuredClone(rows)[0])).toHaveLength(0)
    expect(Object.keys(rows[0])).toEqual(['field_id', 'operator', 'value'])
  })

  it('starts clean when changing date definition and does not apply the previous draft to it', () => {
    const save = vi.fn()
    render(<Filters save={save} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha 1' }), { target: { value: '15/02/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar definición' }))
    expect(screen.getByRole('textbox', { name: 'Fecha 1' })).toHaveValue('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha 1' }), { target: { value: '20/02/2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(JSON.parse(JSON.stringify(save.mock.calls[0][0]))).toEqual([
      { field_id: 'date-b', operator: 'eq', value: '2026-02-20' }, initial[1],
    ])
  })

  it('preserves the surviving row draft after deleting the first row and still blocks its partial date', () => {
    const save = vi.fn()
    render(<Filters save={save} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha 1' }), { target: { value: '17/02/2026' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha 2' }), { target: { value: '20/02/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar primera fila' }))
    const remaining = screen.getByRole('textbox', { name: 'Fecha 1' })
    expect(remaining).toHaveValue('20/02/')
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(remaining, { target: { value: '20/02/2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(JSON.parse(JSON.stringify(save.mock.calls[0][0]))).toEqual([{ field_id: 'date-b', operator: 'eq', value: '2026-02-20' }])
  })
})
