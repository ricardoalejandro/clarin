import { describe, expect, it } from 'vitest'
import {
  normalizeOfflineV5Modules,
  offlineModulesV5,
  offlineV5PreparationNotice,
  offlineV5ResourceKey,
  offlineV5ResourceLabel,
  reconcileOfflineV5ResourceLabels,
  toggleOfflineV5Module,
  toggleOfflineV5Resource,
  validateOfflineV5Approval,
  type OfflineV5Resource,
} from './uiState'

const resource = (id: string, module: OfflineV5Resource['module'] = 'tasks'): OfflineV5Resource => ({
  module,
  resource_type: module === 'tasks' ? 'task_list' : module.slice(0, -1),
  resource_id: id,
  label: `Recurso ${id}`,
})

describe('Offline v5 module and root-resource selection', () => {
  it('describes normal work without claiming that modules are read-only', () => {
    expect(offlineModulesV5).toHaveLength(4)
    expect(offlineModulesV5.map(item => item.detail).join(' ')).not.toMatch(/solo lectura/i)
    expect(offlineModulesV5.find(item => item.id === 'whiteboards')?.detail).toContain('editor habitual')
  })

  it('normalizes modules in canonical order and rejects unknown values', () => {
    expect(normalizeOfflineV5Modules(['whiteboards', 'tasks', 'unknown', 'tasks'])).toEqual(['tasks', 'whiteboards'])
    expect(toggleOfflineV5Module(['tasks'], 'contacts')).toEqual(['tasks', 'contacts'])
    expect(toggleOfflineV5Module(['tasks', 'contacts'], 'tasks')).toEqual(['contacts'])
  })

  it('isolates resources by module, type and exact id and caps roots at twenty', () => {
    expect(offlineV5ResourceKey(resource('same'))).not.toBe(offlineV5ResourceKey(resource('same', 'contacts')))
    const twenty = Array.from({ length: 20 }, (_, index) => resource(String(index)))
    expect(toggleOfflineV5Resource(twenty, resource('extra'), 50)).toEqual(twenty)
    expect(toggleOfflineV5Resource([resource('one')], resource('one'), 20)).toEqual([])
  })

  it('reuses labels only for the exact account-scoped resource identity', () => {
    const missing = { ...resource('same'), label: undefined }
    expect(reconcileOfflineV5ResourceLabels([missing], [resource('same')])[0].label).toBe('Recurso same')
    expect(reconcileOfflineV5ResourceLabels([{ ...missing, module: 'contacts' }], [resource('same')])[0].label).toBeUndefined()
    expect(offlineV5ResourceLabel(missing)).toBe('Tareas · same')
  })

  it('requires modules per authorized account without expanding the account set', () => {
    expect(validateOfflineV5Approval([], ['account-a'])).toContain('cuenta')
    expect(validateOfflineV5Approval([{ account_id: 'account-b', modules: ['tasks'] }], ['account-a'])).toContain('pertenece')
    expect(validateOfflineV5Approval([{ account_id: 'account-a', modules: [] }], ['account-a'])).toContain('módulo')
    expect(validateOfflineV5Approval([{ account_id: 'account-a', modules: ['tasks', 'contacts'] }], ['account-a'])).toBe('')
  })

  it('explains when the prepared shell needs one clean browser reopen', () => {
    expect(offlineV5PreparationNotice('next-reopen')).toBe(
      'La copia quedó preparada. Cierra todas las pestañas de Clarin y vuelve a abrirla una vez para activar esta versión offline.',
    )
    expect(offlineV5PreparationNotice('current')).toContain('Copia cifrada y verificada')
  })
})
