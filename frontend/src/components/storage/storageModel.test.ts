import { describe, expect, it } from 'vitest'
import { canSelectStorageFile, EMPTY_FILTERS, formatStorageBytes, nextStorageTab, reconcileStorageSelection, resultStorageMessage, safeStorageOriginHref, STORAGE_SELECTION_LIMIT, storageContentPath, storageDate, storageFilesQuery, storagePreviewExpired, toggleStorageSelection, type StorageFile, type StorageResult } from './storageModel'

const file = (key: string, extra: Partial<StorageFile> = {}): StorageFile => ({ object_key: key, filename: `${key}.jpg`, media_type: 'image', size_bytes: 4096, origins: [{ type: 'chats', label: 'Chat' }], references_count: 1, status: 'active', can_remove: true, ...extra })

describe('storage self-service rules', () => {
  it('keeps remote filters, types, large offsets and trash scope in one request', () => {
    const params = new URLSearchParams(storageFilesQuery({ ...EMPTY_FILTERS, query: '  informe anual  ', type: 'document', origin: 'chats', minSize: '10485760', age: '90', status: 'removable', sort: 'name' }, 'trash', 240))
    expect(Object.fromEntries(params)).toEqual({ limit: '40', offset: '240', sort: 'name', order: 'asc', status: 'trash', q: 'informe anual', type: 'document', origin: 'chats', min_size: '10485760', older_than_days: '90' })
  })
  it('clamps invalid negative offsets and keeps default requests bounded', () => {
    const params = new URLSearchParams(storageFilesQuery(EMPTY_FILTERS, 'files', -20))
    expect(params.get('offset')).toBe('0'); expect(params.get('limit')).toBe('40'); expect(params.has('q')).toBe(false)
  })
  it('never renders a raw remote preview URL', () => {
    const input = file('cuenta-a/foto & nombre.png')
    expect(storageContentPath(input)).toBe('/api/storage/content?object_key=cuenta-a%2Ffoto+%26+nombre.png')
  })
  it.each(['https://outside.test', '//outside.test', 'javascript:alert(1)', '/dashboard/chats\\evil', '/dashboard/admin', '/dashboard/chats\n'])('rejects unsafe origin link %s', href => { expect(safeStorageOriginHref(href)).toBeUndefined() })
  it('accepts only familiar module links', () => { expect(safeStorageOriginHref('/dashboard/chats?chatId=abc')).toBe('/dashboard/chats?chatId=abc') })
  it('requires both management permission and action capability', () => {
    expect(canSelectStorageFile(file('a'), 'files', false)).toBe(false)
    expect(canSelectStorageFile(file('a', { can_remove: false }), 'files', true)).toBe(false)
    expect(canSelectStorageFile(file('a', { status: 'trash', can_restore: true }), 'trash', true)).toBe(true)
    expect(canSelectStorageFile(file('a', { status: 'trash', can_remove: true }), 'trash', true)).toBe(false)
  })
  it('deduplicates selections, preserves order and caps bulk writes at 100', () => {
    let selected = new Map<string, StorageFile>()
    for (let i = 0; i <= STORAGE_SELECTION_LIMIT; i++) selected = toggleStorageSelection(selected, file(String(i)))
    expect(selected.size).toBe(100); expect(selected.has('100')).toBe(false)
    const cleared = toggleStorageSelection(selected, file('10')); expect(cleared.has('10')).toBe(false); expect(selected.has('10')).toBe(true)
  })
  it('keeps only blocked and failed files selected after a partial operation', () => {
    const selected = new Map(['a', 'b', 'c'].map(key => [key, file(key)]))
    const result: StorageResult = { success: true, operation_id: 'op', status: 'partial', action: 'trash', freed_bytes: 0, retained_bytes: 4096, items: [{ object_key: 'a', filename: 'a.jpg', status: 'completed' }, { object_key: 'b', filename: 'b.jpg', status: 'blocked' }, { object_key: 'c', filename: 'c.jpg', status: 'failed' }] }
    expect([...reconcileStorageSelection(selected, result).keys()]).toEqual(['b', 'c'])
    expect(resultStorageMessage(result)).toContain('Todavía no se ha liberado espacio')
    expect(resultStorageMessage(result)).toContain('2 no se pudieron procesar')
    expect(selected.size).toBe(3)
  })
  it('never presents retained bytes as freed bytes', () => {
    const result: StorageResult = { success: true, operation_id: 'op', status: 'completed', action: 'purge', freed_bytes: 2048, retained_bytes: 9999999, items: [{ object_key: 'a', filename: 'a', status: 'completed' }] }
    expect(resultStorageMessage(result)).toContain('2.0 KB'); expect(resultStorageMessage(result)).not.toContain('9.5 MB')
  })
  it('expires reviews at the boundary and fails closed on invalid dates', () => {
    expect(storagePreviewExpired({ expires_at: '2026-10-10T10:00:00Z' }, Date.parse('2026-10-10T09:59:59Z'))).toBe(false)
    expect(storagePreviewExpired({ expires_at: '2026-10-10T10:00:00Z' }, Date.parse('2026-10-10T10:00:00Z'))).toBe(true)
    expect(storagePreviewExpired({ expires_at: '' })).toBe(true)
  })
  it('keeps pending operations explicit and navigates tabs without entering a forbidden view', () => {
    expect(resultStorageMessage({ success: true, operation_id: 'op', status: 'processing', action: 'purge', freed_bytes: 0, retained_bytes: 0, items: [] })).toContain('sigue pendiente')
    expect(nextStorageTab('trash', 'ArrowRight', false)).toBe('files')
    expect(nextStorageTab('files', 'ArrowLeft', true)).toBe('activity')
    expect(nextStorageTab('files', 'End', true)).toBe('activity')
    expect(nextStorageTab('activity', 'Home', true)).toBe('files')
    expect(nextStorageTab('files', 'Enter', true)).toBeNull()
  })
  it('formats missing and invalid measurements without fake quota claims', () => {
    expect(formatStorageBytes(-1)).toBe('0 B'); expect(formatStorageBytes(NaN)).toBe('0 B'); expect(storageDate('invalid')).toBe('Sin fecha')
  })
})
