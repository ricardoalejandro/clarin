import React from 'react'
import { createRoot } from 'react-dom/client'
import OfflineTasksView from '@/components/offline-v3/OfflineTasksView'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { TaskCreateInput } from '@/offline-v3/types'
import '@/offline-v4/offline-runtime.css'

declare global { interface Window { __offlineDateQA: { writes: TaskCreateInput[] } } }
window.__offlineDateQA = { writes: [] }
const snapshot = { selection_revision: 1, head_version: 1, last_synced_at: '2026-11-15T12:00:00Z' }
const sync = { state: 'waiting_network', server_reachability: 'unreachable', pending_count: 1, conflict_count: 0, outcome_unknown_count: 0, lease_expires_at: '2026-11-20T12:00:00Z', selection_revision: 1 }
const gateway = {
  async taskLists() { return { items: [{ selection_id: 'qa-selection', id: 'qa-list', name: 'General', environment_id: 'qa-environment', environment_name: 'QA sin conexión', statuses: [], can_create: true }], snapshot } },
  async tasks() { return { items: [], snapshot } },
  async createTask(input: TaskCreateInput) {
    window.__offlineDateQA.writes.push(input)
    return { operation_id: input.operation_id, state: 'queued', pending_count: 1, sync, local_task: { id: input.task_id, list_id: 'qa-list', version: 1, status: 'pending', local_confirmation: 'pending', can_complete: false, created_at: '2026-11-15T12:00:00Z', updated_at: '2026-11-15T12:00:00Z', ...input.patch } }
  },
} as unknown as OfflineDataGateway

createRoot(document.getElementById('root')!).render(<main className="offline-main"><OfflineTasksView gateway={gateway} canCreate canComplete={false} onSync={() => {}} /></main>)
