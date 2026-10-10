import { describe, expect, it } from 'vitest'
import { canSelectStorageFile, EMPTY_FILTERS, formatStorageBytes, nextStorageTab, reconcileStorageSelection, resultStorageMessage, safeStorageOriginHref, STORAGE_SELECTION_LIMIT, storageContentPath, storageDate, storageAdvancedFilterCount, storageFileIdentity, storagePreviewRequest, storageRecommendationFilters, storageRealtimeChange, reconcileStorageUses, storageUsesPath, storageFilesQuery, storagePreviewExpired, storageTrashStatus, toggleStorageSelection, type StorageFile, type StorageResult } from './storageModel'

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
    expect(canSelectStorageFile(file('a', { status: 'trash', recovery_id: 'recovery-a', can_restore: true }), 'trash', true)).toBe(true)
    expect(canSelectStorageFile(file('a', { status: 'trash', can_remove: true }), 'trash', true)).toBe(false)
  })
  it('does not treat an elapsed retention date as permission to purge', () => {
    const status = storageTrashStatus({ can_purge: false, purge_after: '2000-01-01T12:00:00Z', blocked_reason: 'El archivo volvió a utilizarse y se conservará.' })
    expect(status).toContain('El archivo volvió a utilizarse y se conservará.')
    expect(status).toContain('Retención mínima hasta')
    expect(status).not.toContain('Borrado disponible')
    expect(storageTrashStatus({ can_purge: true })).toBe('Disponible para borrado definitivo')
  })
  it('keeps the server blocking reason authoritative even with an inconsistent capability', () => {
    const reason = 'La eliminación está pendiente. Puedes reintentarla desde Actividad.'
    expect(storageTrashStatus({ can_purge: true, blocked_reason: reason })).toBe(reason)
  })
  it.each([undefined, 'invalid'])('does not invent a purge date when retention is %s', purge_after => {
    expect(storageTrashStatus({ can_purge: false, purge_after })).toBe('El borrado definitivo todavía no está disponible.')
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
  it('keeps independent recoveries of one object distinct through selection and partial results', () => {
    const first = file('shared', { recovery_id: 'r1' }), second = file('shared', { recovery_id: 'r2' })
    const selected = toggleStorageSelection(toggleStorageSelection(new Map(), first), second)
    expect([...selected.keys()]).toEqual(['recovery:r1', 'recovery:r2'])
    expect(storagePreviewRequest('restore', selected.values())).toEqual({ action: 'restore', recovery_ids: ['r1', 'r2'] })
    expect(storagePreviewRequest('purge', [second])).toEqual({ action: 'purge', recovery_ids: ['r2'] })
    const result: StorageResult = { success: true, action: 'restore', operation_id: 'op', status: 'partial', freed_bytes: 0, retained_bytes: 4096, items: [{ object_key: 'shared', recovery_id: 'r1', filename: 'shared', status: 'completed' }] }
    expect([...reconcileStorageSelection(selected, result).keys()]).toEqual(['recovery:r2'])
    expect(storageFileIdentity(file('legacy'))).toBe('legacy')
    expect(canSelectStorageFile(file('legacy', { status: 'trash', can_restore: true }), 'trash', true)).toBe(false)
  })
  it('sends explicit whole-file or individual-use scope without expanding another selection', () => {
    expect(storagePreviewRequest('trash', [file('a')])).toEqual({ action: 'trash', targets: [{ object_key: 'a', mode: 'file' }] })
    expect(storagePreviewRequest('trash', [file('a')], [{ object_key: 'b', mode: 'uses', use_ids: ['one'] }])).toEqual({ action: 'trash', targets: [{ object_key: 'b', mode: 'uses', use_ids: ['one'] }] })
    expect(storageUsesPath('account/a b.pdf', 'opaque/cursor')).toBe('/api/storage/uses?object_key=account%2Fa+b.pdf&limit=40&cursor=opaque%2Fcursor')
  })
  it('reconciles use permissions without losing selections on other pages', () => {
    const selected = new Map([['one', { use_id: 'one', type: 'chats', label: 'Old', can_remove: true }], ['other-page', { use_id: 'other-page', type: 'chats', label: 'Other', can_remove: true }]])
    expect([...reconcileStorageUses(selected, [{ use_id: 'one', type: 'chats', label: 'Revoked', can_remove: false }], true).keys()]).toEqual(['other-page'])
    expect(reconcileStorageUses(selected, [], false).size).toBe(0)
    expect(selected.size).toBe(2)
  })
  it('turns exact recommendation filters into bounded file and trash queries', () => {
    const rec = storageRecommendationFilters({ id: 'trash_ready', count: 3, bytes: 4096, filters: { status: 'trash_ready', min_size: 10485760, older_than_days: 180 } })
    expect(rec.tab).toBe('trash')
    const params = new URLSearchParams(storageFilesQuery(rec.filters, rec.tab, 0))
    expect(params.get('status')).toBe('trash_ready'); expect(params.get('min_size')).toBe('10485760'); expect(params.get('older_than_days')).toBe('180')
  })
  it('only accepts account-scoped storage invalidations and always honors a restrictive access signal', () => {
    const event = (account_id: string, revision: number, reason = 'changed') => ({ event: 'storage_changed', data: { account_id, revision, reason } })
    expect(storageRealtimeChange(event('b', 20), 'a', 5)).toBeNull()
    expect(storageRealtimeChange(event('a', 4), 'a', 5)).toBeNull()
    expect(storageRealtimeChange(event('a', 5), 'a', 5)).toEqual({ action: 'refresh', revision: 5 })
    expect(storageRealtimeChange(event('a', 6), 'a', 5)).toEqual({ action: 'refresh', revision: 6 })
    expect(storageRealtimeChange(event('a', 4, 'access_changed'), 'a', 5)).toEqual({ action: 'reset', revision: 5 })
    expect(storageRealtimeChange(event('a', 6), undefined)).toBeNull()
    expect(storageRealtimeChange({ event: 'task_update', data: { action: 'access_revoked' } }, 'a', 5)).toEqual({ action: 'reset', revision: 5 })
    expect(storageRealtimeChange({ event: 'task_update', account_id: 'b', data: { action: 'access_revoked' } }, 'a')).toBeNull()
  })

  it('counts only the advanced filter and ordering controls with a non-default value', () => {
    expect(storageAdvancedFilterCount({ ...EMPTY_FILTERS, query: 'foto', type: 'image' })).toBe(0)
    expect(storageAdvancedFilterCount({ ...EMPTY_FILTERS, origin: 'chats', minSize: '10485760', age: '180', status: 'removable', sort: 'name' })).toBe(5)
  })

})
