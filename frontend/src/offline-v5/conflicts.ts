import { OfflineV5Error, type OfflineV5Conflict, type OfflineV5ConflictResolution, type OfflineV5MutationInput } from './types'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const patchActions = new Set(['tasks.update', 'contacts.update', 'programs.update'])

/** Retrying only known patch contracts avoids turning a rejected command into a blind overwrite. */
export function offlineV5ConflictCanMerge(conflict: OfflineV5Conflict): boolean {
  return conflict.status === 'conflict' && patchActions.has(conflict.action)
    && Boolean(conflict.operation && conflict.optimistic_entity && object(conflict.server) && object(conflict.operation.payload))
    && Number.isSafeInteger(conflict.server_version) && Number(conflict.server_version) > 0
    && Boolean(conflict.fields?.length)
    && conflict.fields!.every(field => Object.prototype.hasOwnProperty.call(object(conflict.operation?.payload) || {}, field)
      && Object.prototype.hasOwnProperty.call(object(conflict.server) || {}, field))
}

/** A resolution creates a new intent; the original id/hash remains immutable for receipt recovery. */
export function offlineV5ConflictRetry(conflict: OfflineV5Conflict, resolution: OfflineV5ConflictResolution): OfflineV5MutationInput | undefined {
  if (resolution.operation_id !== conflict.operation_id) throw new OfflineV5Error('wrong_conflict', 'El conflicto ya no corresponde al cambio seleccionado.')
  if (resolution.choice === 'server') return undefined
  if (!offlineV5ConflictCanMerge(conflict)) throw new OfflineV5Error('conflict_retry_unavailable', 'Este cambio necesita revisión con conexión antes de volver a enviarse. La copia local se conserva.')
  const fields = conflict.fields!
  if (!resolution.fields || !fields.every(field => resolution.fields[field] === 'local' || resolution.fields[field] === 'server')
      || Object.keys(resolution.fields).some(field => !fields.includes(field))) {
    throw new OfflineV5Error('conflict_choice_required', 'Elige la versión que deseas conservar en cada campo en conflicto.')
  }
  const operation = conflict.operation!, entity = conflict.optimistic_entity!, server = object(conflict.server)!
  const payload = { ...object(operation.payload)! }
  // Keep independent local changes. Server-selected fields are omitted rather
  // than resent, so a later server edit cannot be overwritten by this choice.
  for (const field of fields) if (resolution.fields[field] === 'server') delete payload[field]
  if (!Object.keys(payload).length) return undefined
  return {
    action: operation.action, selection_id: operation.selection_id, resource_id: operation.resource_id,
    entity_type: entity.entity_type, entity_id: entity.entity_id, base_version: conflict.server_version!,
    base: server, payload,
    optimistic_value: { ...object(entity.value), ...server, ...payload },
  }
}
