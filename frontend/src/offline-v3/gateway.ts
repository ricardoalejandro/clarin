import type {
  OfflineContact,
  OfflineConflict,
  OfflinePage,
  OfflineProgram,
  OfflineResource,
  OfflineTask,
  OfflineTaskList,
  OfflineWhiteboard,
  QueuedTaskResult,
  SyncStatus,
  TaskCompleteInput,
  TaskCreateInput,
} from './types'
import type { OfflineV3Bridge } from './bridge'

export interface OfflineDataGateway {
  conflicts?(cursor?: string): Promise<{ items: OfflineConflict[]; next_cursor?: string }>
  resources(module: 'tasks' | 'contacts' | 'programs' | 'whiteboards', cursor?: string): Promise<{ items: OfflineResource[]; next_cursor?: string; selection_revision: number }>
  taskLists(cursor?: string): Promise<OfflinePage<OfflineTaskList>>
  tasks(selectionId: string, cursor?: string): Promise<OfflinePage<OfflineTask>>
  contacts(cursor?: string): Promise<OfflinePage<OfflineContact>>
  contact(id: string): Promise<{ item: OfflineContact; snapshot: OfflinePage<never>['snapshot'] }>
  programs(cursor?: string): Promise<OfflinePage<OfflineProgram>>
  program(id: string): Promise<{ item: OfflineProgram; snapshot: OfflinePage<never>['snapshot'] }>
  whiteboards(cursor?: string): Promise<OfflinePage<OfflineWhiteboard>>
  whiteboardScene(id: string): Promise<{ item: OfflineWhiteboard; snapshot: OfflinePage<never>['snapshot'] }>
  createTask(input: TaskCreateInput): Promise<QueuedTaskResult>
  completeTask(taskId: string, input: TaskCompleteInput): Promise<QueuedTaskResult>
  syncStatus(): Promise<SyncStatus>
  triggerSync(): Promise<SyncStatus>
}

export function createOfflineBridgeGateway(bridge: OfflineV3Bridge): OfflineDataGateway {
  return {
    conflicts: cursor => bridge.conflicts(cursor),
    resources: (module, cursor) => bridge.resources(module, cursor),
    taskLists: cursor => bridge.taskLists(cursor),
    tasks: (selectionId, cursor) => bridge.tasks(selectionId, cursor),
    contacts: cursor => bridge.contacts(cursor),
    contact: id => bridge.contact(id),
    programs: cursor => bridge.programs(cursor),
    program: id => bridge.program(id),
    whiteboards: cursor => bridge.whiteboards(cursor),
    whiteboardScene: id => bridge.whiteboardScene(id),
    createTask: input => bridge.createTask(input),
    completeTask: (taskId, input) => bridge.completeTask(taskId, input),
    syncStatus: () => bridge.syncStatus(),
    triggerSync: () => bridge.triggerSync(),
  }
}
