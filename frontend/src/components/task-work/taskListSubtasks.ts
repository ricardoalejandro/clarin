import type { Task } from '@/types/task'

export type TaskSubtaskDisplayMode = 'collapsed' | 'expanded'
export type TaskSubtaskLoadPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface TaskSubtaskCacheEntry {
  phase: TaskSubtaskLoadPhase
  items: Task[]
  error?: string
  requestID?: number
}

export interface TaskListSubtaskState {
  displayMode: TaskSubtaskDisplayMode
  expansionOverrides: Record<string, boolean>
  cache: Record<string, TaskSubtaskCacheEntry>
}

export type TaskListSubtaskAction =
  | { type: 'set-mode'; mode: TaskSubtaskDisplayMode }
  | { type: 'toggle-parent'; parentID: string }
  | { type: 'load-started'; parentID: string; requestID: number }
  | { type: 'load-cancelled'; parentID: string; requestID: number }
  | { type: 'load-succeeded'; parentID: string; requestID: number; items: Task[] }
  | { type: 'load-failed'; parentID: string; requestID: number; error: string }
  | { type: 'reconcile-child'; child: Task }
  | { type: 'replace-child'; parentID: string; child: Task }
  | { type: 'remove-child'; parentID: string; childID: string }
  | { type: 'reset-scope'; mode: TaskSubtaskDisplayMode }
  | { type: 'retain-parents'; parentIDs: string[] }

export const TASK_SUBTASK_MAX_CONCURRENT_LOADS = 4

export function createTaskListSubtaskState(displayMode: TaskSubtaskDisplayMode = 'collapsed'): TaskListSubtaskState {
  return { displayMode, expansionOverrides: {}, cache: {} }
}

export function taskSubtaskDisplayStorageKey(scope: string) {
  return `clarin:tasks:${scope}:list-subtasks:v1`
}

export function readTaskSubtaskDisplayMode(scope: string): TaskSubtaskDisplayMode {
  if (typeof window === 'undefined') return 'collapsed'
  return localStorage.getItem(taskSubtaskDisplayStorageKey(scope)) === 'expanded' ? 'expanded' : 'collapsed'
}

export function taskSubtaskParentExpanded(state: TaskListSubtaskState, parentID: string) {
  return state.expansionOverrides[parentID] ?? state.displayMode === 'expanded'
}

function acceptRequest(entry: TaskSubtaskCacheEntry | undefined, requestID: number) {
  return entry?.phase === 'loading' && entry.requestID === requestID
}

export function taskListSubtaskReducer(state: TaskListSubtaskState, action: TaskListSubtaskAction): TaskListSubtaskState {
  switch (action.type) {
    case 'set-mode':
      return { ...state, displayMode: action.mode, expansionOverrides: {} }
    case 'toggle-parent':
      return {
        ...state,
        expansionOverrides: {
          ...state.expansionOverrides,
          [action.parentID]: !taskSubtaskParentExpanded(state, action.parentID),
        },
      }
    case 'load-started':
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.parentID]: {
            phase: 'loading',
            items: state.cache[action.parentID]?.items || [],
            requestID: action.requestID,
          },
        },
      }
    case 'load-cancelled': {
      const entry = state.cache[action.parentID]
      if (!acceptRequest(entry, action.requestID)) return state
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.parentID]: { phase: entry.items.length ? 'ready' : 'idle', items: entry.items },
        },
      }
    }
    case 'load-succeeded': {
      if (!acceptRequest(state.cache[action.parentID], action.requestID)) return state
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.parentID]: { phase: 'ready', items: action.items },
        },
      }
    }
    case 'load-failed': {
      const entry = state.cache[action.parentID]
      if (!acceptRequest(entry, action.requestID)) return state
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.parentID]: { phase: 'error', items: entry.items, error: action.error },
        },
      }
    }
    case 'reconcile-child': {
      const parentID = action.child.parent_task_id
      if (!parentID || !state.cache[parentID]) return state
      const entry = state.cache[parentID]
      const current = entry.items.find(item => item.id === action.child.id)
      if (current && (current.version || 0) > (action.child.version || 0)) return state
      return {
        ...state,
        cache: {
          ...state.cache,
          [parentID]: {
            ...entry,
            items: current
              ? entry.items.map(item => item.id === action.child.id ? action.child : item)
              : [...entry.items, action.child],
          },
        },
      }
    }
    case 'replace-child': {
      const entry = state.cache[action.parentID]
      if (!entry) return state
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.parentID]: {
            ...entry,
            items: entry.items.map(item => item.id === action.child.id ? action.child : item),
          },
        },
      }
    }
    case 'remove-child': {
      const entry = state.cache[action.parentID]
      if (!entry) return state
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.parentID]: { ...entry, items: entry.items.filter(item => item.id !== action.childID) },
        },
      }
    }
    case 'reset-scope':
      return createTaskListSubtaskState(action.mode)
    case 'retain-parents': {
      const allowed = new Set(action.parentIDs)
      return {
        ...state,
        expansionOverrides: Object.fromEntries(Object.entries(state.expansionOverrides).filter(([id]) => allowed.has(id))),
        cache: Object.fromEntries(Object.entries(state.cache).filter(([id]) => allowed.has(id))),
      }
    }
    default:
      return state
  }
}

export function reconcileParentAfterChildStatus(parent: Task, previous: Task, next: Task): Task {
  const previousDone = previous.status_detail?.category === 'done'
  const nextDone = next.status_detail?.category === 'done'
  if (previousDone === nextDone) return parent
  const total = Math.max(0, parent.subtask_count || 0)
  const done = Math.max(0, Math.min(total, (parent.subtask_done || 0) + (nextDone ? 1 : -1)))
  return {
    ...parent,
    subtask_done: done,
    ...(parent.progress_mode === 'automatic' ? { progress: total ? Math.round((done / total) * 100) : 0 } : {}),
  }
}
