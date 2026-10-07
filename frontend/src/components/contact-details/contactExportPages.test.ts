import { describe, expect, it } from 'vitest'
import { fetchContactExportPages } from './contactExportPages'

describe('contact export pagination', () => {
  it('keeps all applied filters on each bounded page and exports a stable complete result', async () => {
    const queries: URLSearchParams[] = []
    const rows = await fetchContactExportPages('cf_filter=synthetic&sort_by=name', async query => {
      const params = new URLSearchParams(query)
      queries.push(params)
      return Number(params.get('offset')) === 0
        ? { contacts: Array.from({ length: 200 }, (_, i) => ({ id: String(i) })), total: 202 }
        : { contacts: [{ id: '200' }, { id: '201' }], total: 202 }
    }, () => true)
    expect(rows).toHaveLength(202)
    expect(queries.map(query => query.get('limit'))).toEqual(['200', '200'])
    expect(queries.map(query => query.get('offset'))).toEqual(['0', '200'])
    expect(queries.every(query => query.get('cf_filter') === 'synthetic' && query.get('sort_by') === 'name')).toBe(true)
  })
  it('rejects overlapping pages instead of silently downloading a partial result', async () => {
    await expect(fetchContactExportPages('', async query => Number(new URLSearchParams(query).get('offset')) === 0
      ? { contacts: Array.from({ length: 200 }, (_, index) => ({ id: String(index) })), total: 202 }
      : { contacts: [{ id: '199' }, { id: '200' }], total: 202 }, () => true)).rejects.toThrow('La lista cambió')
  })
  it('rejects a changing total between pages', async () => {
    await expect(fetchContactExportPages('', async query => Number(new URLSearchParams(query).get('offset')) === 0
      ? { contacts: Array.from({ length: 200 }, (_, index) => ({ id: String(index) })), total: 202 }
      : { contacts: [{ id: '200' }], total: 201 }, () => true)).rejects.toThrow('La lista cambió')
  })
  it('rejects a completion after the account or query has changed', async () => {
    let current = true
    expect(await fetchContactExportPages('', async () => {
      current = false
      return { contacts: [{ id: 'old' }], total: 1 }
    }, () => current)).toBeNull()
  })
})
