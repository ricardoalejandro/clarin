import { describe, expect, it } from 'vitest'
import {
  environmentFolderQuery,
  environmentFolderListQuery,
  environmentListQuery,
  environmentTaskListQuery,
  normalizeTaskAccessGrants,
  taskAccessAtLeast,
  taskAccessLabel,
  validatePrivateAccessManagers,
} from './taskEnvironmentAccess'

describe('task environment access helpers', () => {
  it('maps the fixed access model without treating governance as a fifth level', () => {
    expect(taskAccessLabel('full')).toBe('Administrar')
    expect(taskAccessAtLeast('comment', 'view')).toBe(true)
    expect(taskAccessAtLeast('comment', 'edit')).toBe(false)
  })

  it('canonicalizes duplicate grants and strips invalid governance', () => {
    const result = normalizeTaskAccessGrants([
      { user_id: 'b', display_name: 'Beto', access_level: 'edit', can_manage_access: true },
      { user_id: 'a', display_name: 'Ana', access_level: 'view', can_manage_access: false },
      { user_id: 'b', display_name: 'Beto', access_level: 'full', can_manage_access: true },
    ])
    expect(result.map(item => item.user_id)).toEqual(['a', 'b'])
    expect(result[1]).toMatchObject({ access_level: 'full', can_manage_access: true })
    expect(normalizeTaskAccessGrants([{ user_id: 'a', access_level: 'edit', can_manage_access: true }])[0].can_manage_access).toBe(false)
  })

  it('protects the last explicit manager of a private resource', () => {
    expect(validatePrivateAccessManagers(true, [])).toMatch(/al menos una persona/i)
    expect(validatePrivateAccessManagers(true, [{ user_id: 'a', access_level: 'full', can_manage_access: false }])).toMatch(/gestión de acceso/i)
    expect(validatePrivateAccessManagers(true, [{ user_id: 'a', access_level: 'full', can_manage_access: true }])).toBe('')
    expect(validatePrivateAccessManagers(false, [])).toBe('')
  })

  it('builds bounded cursor queries', () => {
    expect(environmentListQuery('  ventas  ', 'cursor-1')).toBe('limit=50&search=ventas&cursor=cursor-1')
    expect(environmentListQuery('')).toBe('limit=50')
    expect(environmentListQuery('', '', true)).toBe('limit=50&include_archived=true')
    expect(environmentTaskListQuery('  operaciones  ', 'list-cursor')).toBe('scope=all&limit=50&search=operaciones&cursor=list-cursor')
    expect(environmentFolderQuery('  campañas  ', 'folder-cursor', 200)).toBe('limit=200&search=campa%C3%B1as&cursor=folder-cursor')
    expect(environmentFolderListQuery('folder-1', '  agosto  ', 'list-cursor')).toBe('folder_id=folder-1&limit=50&search=agosto&cursor=list-cursor')
  })
})
