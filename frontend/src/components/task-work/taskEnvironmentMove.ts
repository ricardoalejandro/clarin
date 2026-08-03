export type TaskMoveConflict = {
  code?: string
  affected_user_ids?: string[]
}

export function taskMoveNeedsAccessConfirmation(status: number | undefined, payload?: TaskMoveConflict) {
  return status === 409 && payload?.code === 'access_change_confirmation_required'
}

export function taskMoveConfirmationLabel(affectedUserIDs: string[]) {
  const count = new Set(affectedUserIDs.filter(Boolean)).size
  return count === 0
    ? 'El acceso de la tarea cambiará al moverla.'
    : `${count} participante${count === 1 ? '' : 's'} necesita${count === 1 ? '' : 'n'} una concesión explícita para conservar acceso.`
}

