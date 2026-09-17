import { describe, expect, it } from 'vitest'
import { controlTargetV4, reconcileSelectionLabelsV4, resourceLabelV4, togglePermissionV4, toggleResourceV4, validateApprovalV4, validateOfflinePasswordV4 } from './uiState'
import type { OnlineGrantV4, ResourceV4 } from './online'

const resource = (id: string): ResourceV4 => ({ module: 'tasks', resource_id: id, resource_type: 'task_list', label: `Lista ${id}` })

describe('browser-only offline selection and authorization', () => {
  it('preserves exact module/type/resource identity while toggling', () => {
    const selected = [resource('same')]
    const other = { ...resource('same'), module: 'contacts' as const, resource_type: 'contact' }
    expect(toggleResourceV4(selected, other, 20)).toEqual([...selected, other])
    expect(toggleResourceV4(selected, resource('same'), 20)).toEqual([])
  })
  it('caps selection at the lower of the grant limit and twenty', () => {
    const full = Array.from({ length: 20 }, (_, index) => resource(String(index)))
    expect(toggleResourceV4(full, resource('extra'), 100)).toBe(full)
    expect(toggleResourceV4(full.slice(0, 2), resource('extra'), 2)).toHaveLength(2)
    expect(toggleResourceV4([], resource('extra'), 0)).toEqual([])
  })
  it('requires a confirmed password with at least twelve characters, without trimming it', () => {
    expect(validateOfflinePasswordV4('12345678901', '12345678901')).toContain('12')
    expect(validateOfflinePasswordV4('123456789012', '123456789013')).toContain('coinciden')
    expect(validateOfflinePasswordV4(' 1234567890 ', ' 1234567890 ')).toBe('')
    expect(validateOfflinePasswordV4('😀'.repeat(6), '😀'.repeat(6))).toContain('12')
    expect(validateOfflinePasswordV4('😀'.repeat(12), '😀'.repeat(12))).toBe('')
    expect(validateOfflinePasswordV4('😀'.repeat(256), '😀'.repeat(256))).toBe('')
    expect(validateOfflinePasswordV4('😀'.repeat(257), '😀'.repeat(257))).toContain('1024')
    expect(validateOfflinePasswordV4('x'.repeat(1024), 'x'.repeat(1024))).toBe('')
    expect(validateOfflinePasswordV4('x'.repeat(1025), 'x'.repeat(1025))).toContain('1024')
  })
  it('task writes imply read and removing read removes writes', () => {
    expect(togglePermissionV4([], 'tasks.create')).toEqual(['tasks.read', 'tasks.create'])
    expect(togglePermissionV4(['tasks.read', 'tasks.create', 'tasks.complete', 'contacts.read'], 'tasks.read')).toEqual(['contacts.read'])
  })
  it('rejects empty, repeated, foreign and write-only account approvals', () => {
    expect(validateApprovalV4([], ['a'])).not.toBe('')
    expect(validateApprovalV4([{ account_id: 'b', actions: ['tasks.read'] }], ['a'])).not.toBe('')
    expect(validateApprovalV4([{ account_id: 'a', actions: ['tasks.create'] }], ['a'])).toContain('leer')
    expect(validateApprovalV4([{ account_id: 'a', actions: ['tasks.read'] }, { account_id: 'a', actions: ['contacts.read'] }], ['a'])).toContain('repitas')
    expect(validateApprovalV4([{ account_id: 'a', actions: ['tasks.read'] }], ['a'])).toBe('')
    expect(validateApprovalV4(Array.from({ length: 6 }, (_, i) => ({ account_id: String(i), actions: ['tasks.read'] })), ['0', '1', '2', '3', '4', '5'])).toContain('5 cuentas')
  })
  it('keeps selected labels by exact identity and renders a usable missing-label fallback', () => {
    const unlabeled = { ...resource('same'), label: undefined }
    expect(reconcileSelectionLabelsV4([unlabeled], [resource('same')])[0].label).toBe('Lista same')
    expect(reconcileSelectionLabelsV4([{ ...unlabeled, module: 'contacts' }], [resource('same')])[0].label).toBeUndefined()
    expect(resourceLabelV4(unlabeled)).toBe('Tareas · same')
  })
  it('never maps browser/account/user control IDs interchangeably', () => {
    const grant = { grant_id: 'grant', browser_profile_id: 'browser', account_id: 'account', user_id: 'user' } as OnlineGrantV4
    expect(controlTargetV4(grant, 'grant')).toBe('grant')
    expect(controlTargetV4(grant, 'browser_profile')).toBe('browser')
    expect(controlTargetV4(grant, 'account')).toBe('account')
    expect(controlTargetV4(grant, 'user')).toBe('user')
    expect(() => controlTargetV4({ ...grant, user_id: '' }, 'user')).toThrow()
  })
})
