import type { TaskAccessGrant } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'

export function eligibleContainerAccessUsers(users: TaskAccountUser[], eligibleUserIDs: string[], grants: TaskAccessGrant[]) {
  const eligible = new Set(eligibleUserIDs)
  const granted = new Set(grants.map(grant => grant.user_id))
  return users.filter(user => eligible.has(user.id) && !granted.has(user.id))
}

export function taskContainerAccessSaveError(status?: number, fallback?: string) {
  if (status === 409) return 'El acceso cambió en otra sesión. Recarga y vuelve a aplicar tus cambios.'
  if (status === 422) return 'Solo puedes compartir con personas que ya tengan al menos acceso Ver al Entorno.'
  return fallback || 'No se pudo guardar el acceso.'
}
