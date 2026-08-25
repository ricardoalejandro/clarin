import { flattenWhiteboardFolders, type WhiteboardFolder, type WhiteboardSummary } from './whiteboards'

export interface WhiteboardFolderDestination {
  id: string | null
  name: string | null
}

export type WhiteboardFolderPlacement = 'first' | 'last'

export interface WhiteboardFolderStructuralPlacement {
  parent_id: string | null
  before_folder_id: string | null
}

export interface WhiteboardFolderRelocationInput {
  name: string
  description: string
  placement: WhiteboardFolderStructuralPlacement
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

export interface WhiteboardFolderPositionOption {
  beforeFolderID: string | null
  label: string
}

export interface WhiteboardMoveDestinationOption extends WhiteboardFolderDestination {
  label: string
  path: string
  depth: number
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

export function whiteboardFolderDestinationError(
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
  const rootError = whiteboardFolderDestinationError(target, active, null)
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
      const error = whiteboardFolderDestinationError(target, active, folder.id)
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
  const siblings = folders
    .filter(folder => !folder.archived_at && folder.id !== target.id && normalizedParentID(folder) === destinationParentID)
    .sort(compareFolderOrder)
  return buildWhiteboardFolderPlacementPlan(
    target,
    folders,
    destinationParentID,
    placement === 'first' ? siblings[0]?.id || null : null,
  )
}

export function buildWhiteboardFolderPlacementPlan(
  target: WhiteboardFolder,
  folders: readonly WhiteboardFolder[],
  destinationParentID: string | null,
  beforeFolderID: string | null,
): WhiteboardFolderRelocationPlan {
  if (target.archived_at) throw new Error('No se puede organizar una carpeta archivada.')
  const error = whiteboardFolderDestinationError(target, folders, destinationParentID)
  if (error) throw new Error(error)
  const siblings = folders
    .filter(folder => !folder.archived_at && folder.id !== target.id && normalizedParentID(folder) === destinationParentID)
    .sort(compareFolderOrder)
  if (beforeFolderID && !siblings.some(folder => folder.id === beforeFolderID)) {
    throw new Error('La posición de destino ya no está disponible.')
  }
  const currentSiblings = folders
    .filter(folder => !folder.archived_at && normalizedParentID(folder) === normalizedParentID(target))
    .sort(compareFolderOrder)
  const currentIndex = currentSiblings.findIndex(folder => folder.id === target.id)
  const currentBeforeFolderID = currentIndex >= 0 ? currentSiblings[currentIndex + 1]?.id || null : null
  const alreadyPlaced = normalizedParentID(target) === destinationParentID && currentBeforeFolderID === beforeFolderID
  return {
    changed: !alreadyPlaced,
    input: {
      name: target.name,
      description: target.description || '',
      placement: { parent_id: destinationParentID, before_folder_id: beforeFolderID },
      expected_version: target.version,
    },
  }
}

export function whiteboardFolderPositionOptions(
  folders: readonly WhiteboardFolder[],
  target: WhiteboardFolder,
  destinationParentID: string | null,
): WhiteboardFolderPositionOption[] {
  const siblings = folders
    .filter(folder => !folder.archived_at && folder.id !== target.id && normalizedParentID(folder) === destinationParentID)
    .sort(compareFolderOrder)
  if (!siblings.length) return [{ beforeFolderID: null, label: 'Única carpeta en este nivel' }]
  return [
    { beforeFolderID: siblings[0].id, label: 'Primera' },
    ...siblings.map((sibling, index) => ({
      beforeFolderID: siblings[index + 1]?.id || null,
      label: `Después de ${sibling.name}`,
    })),
  ]
}

export function currentWhiteboardFolderBeforeID(
  folders: readonly WhiteboardFolder[],
  target: WhiteboardFolder,
) {
  const siblings = folders
    .filter(folder => !folder.archived_at && normalizedParentID(folder) === normalizedParentID(target))
    .sort(compareFolderOrder)
  const index = siblings.findIndex(folder => folder.id === target.id)
  return index < 0 ? null : siblings[index + 1]?.id || null
}

export function optimisticWhiteboardFolderPlacement(
  folders: readonly WhiteboardFolder[],
  targetID: string,
  destinationParentID: string | null,
  beforeFolderID: string | null,
) {
  const target = folders.find(folder => folder.id === targetID)
  if (!target) return [...folders]
  const destinationSiblings = folders
    .filter(folder => !folder.archived_at && folder.id !== targetID && normalizedParentID(folder) === destinationParentID)
    .sort(compareFolderOrder)
  const insertAt = beforeFolderID
    ? destinationSiblings.findIndex(folder => folder.id === beforeFolderID)
    : destinationSiblings.length
  if (insertAt < 0) return [...folders]
  const ordered = [...destinationSiblings]
  ordered.splice(insertAt, 0, { ...target, parent_id: destinationParentID })
  const desired = new Map(ordered.map((folder, index) => [folder.id, (index + 1) * WHITEBOARD_FOLDER_SORT_GAP]))
  return folders.map(folder => {
    const order = desired.get(folder.id)
    if (order === undefined) return folder
    return {
      ...folder,
      ...(folder.id === targetID ? { parent_id: destinationParentID } : {}),
      sort_order: order,
    }
  })
}

export function settleWhiteboardFolderRelocation(
  folders: readonly WhiteboardFolder[],
  canonical: WhiteboardFolder | readonly WhiteboardFolder[] | null,
) {
  if (!canonical) return [...folders]
  const incoming = Array.isArray(canonical) ? canonical : [canonical]
  const byID = new Map(incoming.map(folder => [folder.id, folder] as const))
  return folders.map(folder => byID.get(folder.id) || folder)
}

export function activeWhiteboardFolders(folders: readonly WhiteboardFolder[]) {
  return folders.filter(folder => !folder.archived_at)
}

export function archivedWhiteboardFolders(folders: readonly WhiteboardFolder[]) {
  return folders.filter(folder => Boolean(folder.archived_at))
}

export function whiteboardMoveDestinationOptions(
  folders: readonly WhiteboardFolder[],
  settledSearch = '',
): WhiteboardMoveDestinationOption[] {
  const active = activeWhiteboardFolders(folders)
  const byID = new Map(active.map(folder => [folder.id, folder] as const))
  const options: WhiteboardMoveDestinationOption[] = [
    { id: null, name: null, label: 'Sin carpeta', path: 'Nivel principal de Pizarras', depth: 0 },
    ...flattenWhiteboardFolders(active).map(({ folder, depth }) => {
      const ancestry: string[] = []
      const visited = new Set<string>()
      let current: WhiteboardFolder | undefined = folder
      while (current && !visited.has(current.id) && ancestry.length < WHITEBOARD_FOLDER_MAX_DEPTH) {
        visited.add(current.id)
        ancestry.unshift(current.name)
        current = current.parent_id ? byID.get(current.parent_id) : undefined
      }
      return {
        id: folder.id,
        name: folder.name,
        label: folder.name,
        path: ancestry.join(' / '),
        depth,
      }
    }),
  ]
  const query = settledSearch.trim().toLocaleLowerCase('es')
  if (!query) return options
  return options.filter(option => `${option.label} ${option.path}`.toLocaleLowerCase('es').includes(query))
}

export function optimisticWhiteboardFolderCounts(
  folders: readonly WhiteboardFolder[],
  sourceFolderID: string | null,
  destinationFolderID: string | null,
) {
  if (sourceFolderID === destinationFolderID) return [...folders]
  return folders.map(folder => {
    if (typeof folder.whiteboard_count !== 'number') return folder
    if (folder.id === sourceFolderID) return { ...folder, whiteboard_count: Math.max(0, folder.whiteboard_count - 1) }
    if (folder.id === destinationFolderID) return { ...folder, whiteboard_count: folder.whiteboard_count + 1 }
    return folder
  })
}

export function buildWhiteboardFolderRenameInput(folder: WhiteboardFolder, name: string) {
  return {
    name: name.trim(),
    description: folder.description || '',
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
  destination: WhiteboardFolderDestination,
  activeFolderID: string | null,
) {
  const resolved = canonical
    ? {
        ...previous,
        ...canonical,
        folder_id: destination.id,
        folder_name: destination.name,
        owner_name: canonical.owner_name || previous.owner_name,
        updated_by_name: canonical.updated_by_name || previous.updated_by_name,
        shared: previous.shared,
      }
    : previous
  if (canonical && activeFolderID && destination.id !== activeFolderID) {
    return current.filter(item => item.id !== previous.id)
  }
  return current.map(item => item.id === previous.id ? resolved : item)
}
