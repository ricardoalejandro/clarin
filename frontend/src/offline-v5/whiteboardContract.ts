import { OfflineV5Error, type OfflineV5Snapshot } from './types'

type JsonObject = Record<string, unknown>

/** Keep the REST editor contract independent from the snapshot's storage shape. */
export function offlineWhiteboardSceneRecord(snapshot: OfflineV5Snapshot, board: JsonObject) {
  const scene = board.scene
  const sequence = Number(board.sequence)
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)
      || !Array.isArray((scene as JsonObject).elements)
      || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new OfflineV5Error('invalid_snapshot', 'La escena preparada está incompleta. Vuelve a preparar esta pizarra con conexión.')
  }
  return {
    board_id: snapshot.root_resource_id,
    scene,
    scene_schema_version: board.scene_schema_version,
    editor_version: board.editor_version,
    sequence,
    updated_at: board.updated_at,
  }
}

export function offlineWhiteboardMetadata(snapshot: OfflineV5Snapshot, board: JsonObject, canWrite: boolean) {
  const preparedPermissions = snapshot.payload.permissions as JsonObject | undefined
  const canEdit = canWrite && preparedPermissions?.can_edit === true
  return {
    ...board,
    scene_sequence: board.sequence,
    effective_access: {
      level: canEdit ? 'edit' : 'view',
      inherited_from: 'offline_selection',
      can_view: true,
      can_edit: canEdit,
      can_comment: false,
      can_delete: false,
      can_manage_access: false,
    },
  }
}

/** A new binary cannot enter a scene until it is in the prepared asset manifest. */
export function assertOfflineWhiteboardFilesPrepared(scene: unknown, preparedFileIDs: ReadonlySet<string>) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene) || !Array.isArray((scene as JsonObject).elements)) {
    throw new OfflineV5Error('invalid_request_body', 'La escena no contiene elementos válidos.')
  }
  for (const element of (scene as JsonObject).elements as unknown[]) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue
    const value = element as JsonObject
    if (value.type === 'image' && value.isDeleted !== true && (typeof value.fileId !== 'string' || !preparedFileIDs.has(value.fileId))) {
      throw new OfflineV5Error('online_required', 'Las imágenes nuevas requieren conexión. Solo puedes usar las imágenes preparadas de esta pizarra.')
    }
  }
}
