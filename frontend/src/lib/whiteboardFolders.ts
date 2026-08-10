import { flattenWhiteboardFolders, type WhiteboardFolder, type WhiteboardSummary } from './whiteboards'

export interface WhiteboardFolderDestination {
  id: string | null
  name: string | null
}

export type WhiteboardFolderPlacement = 'first' | 'last'

export interface WhiteboardFolderRelocationInput {
  parent_id: string | null
  name: string
  description: string
  sort_order: number
  expected_version: number
}

export interface WhiteboardFolderRelocationPlan {
  input: WhiteboardFolderRelocationInput
  changed: boolean
}

export interface WhiteboardFolderDestinationOption {
  id: string | null
  label: string
  depth: number
  disabled: boolean
  reason?: string
}

const WHITEBOARD_FOLDER_MAX_DEPTH = 20
const WHITEBOARD_FOLDER_SORT_GAP = 1024

function normalizedParentID(folder: WhiteboardFolder) {
  return folder.parent_id || null
}

function sortableFolderOrder(folder: WhiteboardFolder) {
  return typeof folder.sort_order === 'number' && Number.isSafeInteger(folder.sort_order)
    ? folder.sort_order
    : 0
}

function compareFolderOrder(left: WhiteboardFolder, right: WhiteboardFolder) {
  const byOrder = sortableFolderOrder(left) - sortableFolderOrder(right)
  if (byOrder) return byOrder
  return left.id.localeCompare(right.id)
}

function descendantFolderIDs(folders: readonly WhiteboardFolder[], targetID: string) {
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    const parentID = normalizedParentID(folder)
    if (!parentID) continue
    children.set(parentID, [...(children.get(parentID) || []), folder.id])
  }
  const depths = new Map<string, number>([[targetID, 1]])
  const pending = [targetID]
  for (let index = 0; index < pending.length; index += 1) {
    const parentID = pending[index]
    const parentDepth = depths.get(parentID) || 1
    for (const childID of children.get(parentID) || []) {
      if (depths.has(childID)) continue
      depths.set(childID, parentDepth + 1)
      pending.push(childID)
    }
  }
  return depths
}

function destinationAncestry(
  foldersByID: ReadonlyMap<string, WhiteboardFolder>,
  destinationID: string | null,
) {
  const ancestry: WhiteboardFolder[] = []
  const visited = new Set<string>()
  let currentID = destinationID
  while (currentID) {
    if (visited.has(currentID)) return null
    visited.add(currentID)
    const current = foldersByID.get(currentID)
    if (!current) return null
    ancestry.unshift(current)
    currentID = normalizedParentID(current)
    if (ancestry.length > WHITEBOARD_FOLDER_MAX_DEPTH) return null
  }
  return ancestry
}

function folderDestinationError(
  target: WhiteboardFolder,
  folders: readonly WhiteboardFolder[],
  destinationParentID: string | null,
) {
  const active = folders.filter(folder => !folder.archived_at)
  if (!active.some(folder => folder.id === target.id)) return 'La carpeta cambió o ya no está disponible.'
  const byID = new Map(active.map(folder => [folder.id, folder] as const))
  const descendants = descendantFolderIDs(active, target.id)
  if (destinationParentID === target.id) return 'Una carpeta no puede contenerse a sí misma.'
  if (destinationParentID && descendants.has(destinationParentID)) {
    return 'No se puede mover una carpeta dentro de una de sus subcarpetas.'
  }
  const ancestry = destinationAncestry(byID, destinationParentID)
  if (!ancestry) return 'La carpeta de destino ya no está disponible o su jerarquía no es válida.'
  let subtreeDepth = 1
  descendants.forEach(depth => { subtreeDepth = Math.max(subtreeDepth, depth) })
  if (ancestry.length + subtreeDepth > WHITEBOARD_FOLDER_MAX_DEPTH) {
    return `La jerarquía admite como máximo ${WHITEBOARD_FOLDER_MAX_DEPTH} niveles.`
  }
  const duplicateName = active.some(folder => (
    folder.id !== target.id
    && normalizedParentID(folder) === destinationParentID
    && folder.name.trim().localeCompare(target.name.trim(), 'es', { sensitivity: 'accent' }) === 0
  ))
  if (duplicateName) return `Ya existe una carpeta llamada “${target.name}” en ese destino.`
  return null
}

export function whiteboardFolderDestinationOptions(
  folders: readonly WhiteboardFolder[],
  target: WhiteboardFolder,
): WhiteboardFolderDestinationOption[] {
  const active = folders.filter(folder => !folder.archived_at)
  const byID = new Map(active.map(folder => [folder.id, folder] as const))
  const rootError = folderDestinationError(target, active, null)
  return [
    {
      id: null,
      label: 'Raíz de Pizarras',
      depth: 0,
      disabled: Boolean(rootError),
      reason: rootError || undefined,
    },
    ...flattenWhiteboardFolders(active).map(({ folder, depth }) => {
      const ancestry = destinationAncestry(byID, folder.id)
      const error = folderDestinationError(target, active, folder.id)
      return {
        id: folder.id,
        label: ancestry?.map(item => item.name).join(' / ') || folder.name,
        depth,
        disabled: Boolean(error),
        reason: error || undefined,
      }
    }),
  ]
}

export function buildWhiteboardFolderRelocationPlan(
  target: WhiteboardFolder,
  folders: readonly WhiteboardFolder[],
  destinationParentID: string | null,
  placement: WhiteboardFolderPlacement,
): WhiteboardFolderRelocationPlan {
  if (target.archived_at) throw new Error('No se puede organizar una carpeta archivada.')
  if (placement !== 'first' && placement !== 'last') throw new Error('La posición elegida no es válida.')
  const error = folderDestinationError(target, folders, destinationParentID)
  if (error) throw new Error(error)
  const siblings = folders
    .filter(folder => !folder.archived_at && folder.id !== target.id && normalizedParentID(folder) === destinationParentID)
    .sort(compareFolderOrder)
  const currentSiblings = folders
    .filter(folder => !folder.archived_at && normalizedParentID(folder) === normalizedParentID(target))
    .sort(compareFolderOrder)
  const currentIndex = currentSiblings.findIndex(folder => folder.id === target.id)
  const alreadyPlaced = normalizedParentID(target) === destinationParentID && (
    (placement === 'first' && currentIndex === 0)
    || (placement === 'last' && currentIndex === currentSiblings.length - 1)
  )
  const boundary = placement === 'first' ? siblings[0] : siblings[siblings.length - 1]
  const sortOrder = !boundary
    ? WHITEBOARD_FOLDER_SORT_GAP
    : sortableFolderOrder(boundary) + (placement === 'first' ? -WHITEBOARD_FOLDER_SORT_GAP : WHITEBOARD_FOLDER_SORT_GAP)
  if (!Number.isSafeInteger(sortOrder)) throw new Error('El orden de carpetas necesita mantenimiento antes de continuar.')
  return {
    changed: !alreadyPlaced,
    input: {
      parent_id: destinationParentID,
      name: target.name,
      description: target.description || '',
      sort_order: sortOrder,
      expected_version: target.version,
    },
  }
}

export function settleWhiteboardFolderRelocation(
  folders: readonly WhiteboardFolder[],
  canonical: WhiteboardFolder | null,
) {
  if (!canonical) return [...folders]
  return folders.map(folder => folder.id === canonical.id ? canonical : folder)
}

export function activeWhiteboardFolders(folders: readonly WhiteboardFolder[]) {
  return folders.filter(folder => !folder.archived_at)
}

export function archivedWhiteboardFolders(folders: readonly WhiteboardFolder[]) {
  return folders.filter(folder => Boolean(folder.archived_at))
}

export function buildWhiteboardFolderRenameInput(folder: WhiteboardFolder, name: string) {
  return {
    parent_id: folder.parent_id || null,
    name: name.trim(),
    description: folder.description || '',
    ...(typeof folder.sort_order === 'number' ? { sort_order: folder.sort_order } : {}),
    expected_version: folder.version,
  }
}

export function buildWhiteboardMoveInput(whiteboard: WhiteboardSummary, destination: WhiteboardFolderDestination) {
  return {
    name: whiteboard.name,
    description: whiteboard.description || '',
    folder_id: destination.id,
    expected_version: whiteboard.version,
  }
}

export function optimisticWhiteboardMove(
  whiteboard: WhiteboardSummary,
  destination: WhiteboardFolderDestination,
): WhiteboardSummary {
  return {
    ...whiteboard,
    folder_id: destination.id,
    folder_name: destination.name,
  }
}

export function settleWhiteboardMove(
  current: readonly WhiteboardSummary[],
  previous: WhiteboardSummary,
  canonical: WhiteboardSummary | null,
  activeFolderID: string | null,
) {
  const resolved = canonical || previous
  if (canonical && activeFolderID && canonical.folder_id !== activeFolderID) {
    return current.filter(item => item.id !== previous.id)
  }
  return current.map(item => item.id === previous.id ? resolved : item)
}
