export interface TaskCreateOperation { operationID: string; payloadKey: string; payload: Record<string, unknown>; uncertain?: boolean }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'operation_id' && key !== 'confirm_grants').sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
  }
  return value
}

/** Retain one operation for retries/permission confirmation of the same draft. */
export function retainTaskCreateOperation(previous: TaskCreateOperation | null, payload: Record<string, unknown>, createID = () => crypto.randomUUID()): TaskCreateOperation {
  if (previous?.uncertain) return previous
  const payloadKey = JSON.stringify(canonical(payload))
  return previous?.payloadKey === payloadKey ? previous : { operationID: createID(), payloadKey, payload: JSON.parse(JSON.stringify(payload)) }
}

export function markTaskCreateUncertain(operation: TaskCreateOperation): TaskCreateOperation {
  return { ...operation, uncertain: true }
}
