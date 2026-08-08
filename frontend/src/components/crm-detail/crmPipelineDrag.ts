export type CrmPipelineBucket<T> = {
  id: string
  totalCount: number
  items: T[]
}

export const CRM_PIPELINE_UNASSIGNED_STAGE_ID = '__unassigned__'

export type CrmPipelineSnapshot<T> = {
  columns: CrmPipelineBucket<T>[]
  unassigned: CrmPipelineBucket<T>
}

export type CrmPipelineMoveResult<T> = {
  snapshot: CrmPipelineSnapshot<T>
  movedIds: string[]
}

export function reconcileCrmPipelineCanonicalItem<T>(
  snapshot: CrmPipelineSnapshot<T>,
  canonical: T,
  targetStageId: string,
  getId: (item: T) => string,
  mergeItem: (current: T, canonical: T) => T,
): CrmPipelineSnapshot<T> {
  const canonicalId = getId(canonical)
  const sourceColumn = snapshot.columns.find(column => column.items.some(item => getId(item) === canonicalId))
  const sourceBucket = sourceColumn || (snapshot.unassigned.items.some(item => getId(item) === canonicalId) ? snapshot.unassigned : undefined)
  const targetBucket = targetStageId === snapshot.unassigned.id
    ? snapshot.unassigned
    : snapshot.columns.find(column => column.id === targetStageId)
  if (!sourceBucket || !targetBucket) return snapshot

  if (sourceBucket.id === targetBucket.id) {
    const update = (bucket: CrmPipelineBucket<T>): CrmPipelineBucket<T> => bucket.id === targetBucket.id ? {
      ...bucket,
      items: bucket.items.map(item => getId(item) === canonicalId ? mergeItem(item, canonical) : item),
    } : bucket
    return {
      columns: snapshot.columns.map(update),
      unassigned: update(snapshot.unassigned),
    }
  }

  return moveCrmPipelineItems(
    snapshot,
    [canonicalId],
    targetStageId,
    getId,
    current => mergeItem(current, canonical),
  ).snapshot
}

/**
 * Deterministic optimistic reducer used by Leads and Eventos. It moves only
 * loaded entities, preserves untouched bucket order and updates each derived
 * count in the same state transition. The caller keeps the original snapshot
 * for exact rollback if the one server mutation fails.
 */
export function moveCrmPipelineItems<T>(
  snapshot: CrmPipelineSnapshot<T>,
  entityIds: Iterable<string>,
  targetStageId: string,
  getId: (item: T) => string,
  updateItem: (item: T) => T,
): CrmPipelineMoveResult<T> {
  const requested = new Set(entityIds)
  const targetBucket = targetStageId === snapshot.unassigned.id
    ? snapshot.unassigned
    : snapshot.columns.find(column => column.id === targetStageId)
  if (!targetBucket) return { snapshot, movedIds: [] }
  const targetAlreadyContains = new Set(targetBucket.items.map(getId))
  const movable = new Set(Array.from(requested).filter(id => !targetAlreadyContains.has(id)))
  if (!movable.size) return { snapshot, movedIds: [] }

  const moved: T[] = []
  const columns = snapshot.columns.map(column => {
    const removed = column.items.filter(item => movable.has(getId(item)))
    if (!removed.length) return column
    moved.push(...removed)
    return {
      ...column,
      items: column.items.filter(item => !movable.has(getId(item))),
      totalCount: Math.max(0, column.totalCount - removed.length),
    }
  })
  const removedUnassigned = snapshot.unassigned.items.filter(item => movable.has(getId(item)))
  moved.push(...removedUnassigned)
  const unassigned = removedUnassigned.length ? {
    ...snapshot.unassigned,
    items: snapshot.unassigned.items.filter(item => !movable.has(getId(item))),
    totalCount: Math.max(0, snapshot.unassigned.totalCount - removedUnassigned.length),
  } : snapshot.unassigned

  if (!moved.length) return { snapshot, movedIds: [] }
  const movedIds = moved.map(getId)
  const movedIdSet = new Set(movedIds)
  if (targetStageId === unassigned.id) {
    return {
      snapshot: {
        columns,
        unassigned: {
          ...unassigned,
          items: [...moved.map(updateItem), ...unassigned.items.filter(item => !movedIdSet.has(getId(item)))],
          totalCount: unassigned.totalCount + moved.length,
        },
      },
      movedIds,
    }
  }

  const nextColumns = columns.map(column => column.id === targetStageId ? {
    ...column,
    items: [...moved.map(updateItem), ...column.items.filter(item => !movedIdSet.has(getId(item)))],
    totalCount: column.totalCount + moved.length,
  } : column)
  return { snapshot: { columns: nextColumns, unassigned }, movedIds }
}
