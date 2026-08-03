import { describe, expect, it } from 'vitest'
import type { TaskAccessGrant } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { eligibleContainerAccessUsers, taskContainerAccessSaveError } from './taskContainerAccess'

const users = [{ id: 'allowed', username: 'allowed' }, { id: 'blocked', username: 'blocked' }, { id: 'already', username: 'already' }] as TaskAccountUser[]
const grants = [{ user_id: 'already', access_level: 'view', can_manage_access: false }] as TaskAccessGrant[]

describe('container access helpers', () => {
  it('offers only Entorno viewers without an existing grant', () => {
    expect(eligibleContainerAccessUsers(users, ['allowed', 'already'], grants).map(user => user.id)).toEqual(['allowed'])
  })

  it('explains the Entorno boundary when a stale or forged recipient is rejected', () => {
    expect(taskContainerAccessSaveError(422)).toContain('acceso Ver al Entorno')
  })

  it('keeps optimistic concurrency conflicts distinct', () => {
    expect(taskContainerAccessSaveError(409)).toContain('otra sesión')
  })
})
