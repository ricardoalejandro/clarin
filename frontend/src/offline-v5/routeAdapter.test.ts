// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { OfflineV5RouteAdapter } from './routeAdapter'
import type { OfflineV5Engine } from './engine'
import { OfflineV5Error, type OfflineV5MutationInput, type OfflineV5Snapshot } from './types'

const snapshot: OfflineV5Snapshot = {
  protocol_version: 5,
  manifest_id: 'manifest',
  manifest_revision: 1,
  selection_id: 'selection-contact',
  root_selection_id: 'selection-contact',
  root_resource_id: 'contact-a',
  module: 'contacts',
  resource_type: 'contact',
  resource_id: 'contact-a',
  dependency: false,
  head_version: 7,
  content_hash: 'hash',
  payload_json: '{}',
  tombstone: false,
  generated_at: '2026-09-15T00:00:00.000Z',
  payload: {
    contact: { id: 'contact-a', account_id: 'account-a', name: 'Ada', version: 7 },
    phones: [{ id: 'phone-a', contact_id: 'contact-a', phone: '999' }],
    tags: [{ id: 'tag-a', name: 'Cliente', color: '#008000' }],
    direct_observations: [{ id: 'observation-a', contact_id: 'contact-a', type: 'note', notes: 'Antes', created_at: '2026-09-14T00:00:00.000Z' }],
    custom_fields: [],
    available_tags: [],
    custom_field_definitions: [],
    observation_count: 1,
  },
}

function harness() {
  const mutations: OfflineV5MutationInput[] = []
  const session = {
    identity: { user_id: 'user-a', account_id: 'account-a' },
    metadata: { actor: { username: 'ada', display_name: 'Ada' } },
    manifest: { capabilities: [
      { action: 'contacts.update', selection_id: 'selection-contact' },
      { action: 'contacts.observations.create', selection_id: 'selection-contact' },
    ] },
  }
  const fake = {
    origin: 'https://clarin.test',
    sessions: { require: () => session }, checkedSession: async () => session,
    aggregates: async (_port: string, _generation: number, module?: string) => module === 'contacts' ? [snapshot] : [],
    overlays: async () => [],
    queueMutation: vi.fn(async (_port: string, _generation: number, input: OfflineV5MutationInput) => {
      mutations.push(input)
      return { operation_id: input.operation_id || 'operation-local', state: 'queued', pending_count: 1, entity: { entity_type: input.entity_type, entity_id: input.entity_id, root_selection_id: input.selection_id, root_resource_id: 'contact-a', version: input.base_version, dependency: false, value: input.optimistic_value } }
    }),
  }
  return { adapter: new OfflineV5RouteAdapter(fake as unknown as OfflineV5Engine), fake, mutations }
}

function parse(response: { body?: string }) { return JSON.parse(response.body || '{}') as Record<string, unknown> }

describe('Offline v5 canonical Contact profile adapter', () => {
  it('checks the durable identity epoch before exposing even /api/me metadata', async () => {
    const unchecked = vi.fn(() => ({ identity: { user_id: 'stale', account_id: 'stale' }, metadata: { actor: {} }, manifest: { roots: [] } }))
    const checked = vi.fn(async () => { throw new OfflineV5Error('identity_changed', 'La identidad cambió.') })
    const adapter = new OfflineV5RouteAdapter({ origin: 'https://clarin.test', sessions: { require: unchecked }, checkedSession: checked } as unknown as OfflineV5Engine)
    await expect(adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/me' })).rejects.toMatchObject({ code: 'identity_changed' })
    expect(checked).toHaveBeenCalledWith('port', 1)
    expect(unchecked).not.toHaveBeenCalled()
  })

  it('serves the existing ContactDetailSurface DTO only for the selected contact', async () => {
    const { adapter } = harness()
    const response = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/contact-profiles/contact-a?context_type=contact&context_id=contact-a' })
    expect(response.status).toBe(200)
    expect(parse(response)).toMatchObject({ success: true, contact: { id: 'contact-a', structured_tags: [{ id: 'tag-a' }], extra_phones: [{ id: 'phone-a' }] }, capabilities: { can_edit: true, can_manage_observations: true, can_manage_avatar: false, can_create_tags: false }, observation_count: 1 })
    const outside = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/contact-profiles/contact-b?context_type=contact&context_id=contact-b' })
    expect(outside.status).toBe(404)
    expect(parse(outside)).toMatchObject({ error: 'not_prepared' })
  })

  it('queues observation creation against the selected root and blocks unsupported edits', async () => {
    const { adapter, mutations, fake } = harness()
    const created = await adapter.request('port', 1, { method: 'POST', headers: [['content-type', 'application/json']], url: 'https://clarin.test/api/contact-profiles/contact-a/observations?context_type=contact&context_id=contact-a', body: JSON.stringify({ notes: '  Seguimiento local  ' }) })
    expect(created.status).toBe(201)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ action: 'contacts.observations.create', selection_id: 'selection-contact', resource_id: 'contact-a', entity_type: 'contact_observation', base_version: 0, payload: { notes: 'Seguimiento local' } })
    expect((mutations[0].payload as Record<string, unknown>).observation_id).toBe(mutations[0].entity_id)

    const unsupported = await adapter.request('port', 1, { method: 'PATCH', headers: [['content-type', 'application/json']], url: 'https://clarin.test/api/contact-profiles/contact-a/observations/observation-a?context_type=contact&context_id=contact-a', body: JSON.stringify({ notes: 'No' }) })
    expect(unsupported.status).toBe(503)
    expect(parse(unsupported)).toMatchObject({ error: 'online_required' })
    expect(fake.queueMutation).toHaveBeenCalledTimes(1)
  })
})

describe('Offline v5 canonical Task detail adapter', () => {
  it('queues plain comments with the strict backend envelope and rejects attachments', async () => {
    const taskSnapshot: OfflineV5Snapshot = {
      ...snapshot,
      selection_id: 'selection-list', root_selection_id: 'selection-list', root_resource_id: 'list-a', resource_id: 'list-a', module: 'tasks', resource_type: 'task_list',
      payload: { list: { id: 'list-a' }, statuses: [], tasks: [{ id: 'task-a', account_id: 'account-a', list_id: 'list-a', version: 3, title: 'Tarea' }], comments: [] },
    }
    const mutations: OfflineV5MutationInput[] = []
    const session = { identity: { user_id: 'user-a', account_id: 'account-a' }, metadata: { actor: { username: 'ada', display_name: 'Ada' } }, manifest: { capabilities: [{ action: 'tasks.comments.create', selection_id: 'selection-list' }] } }
    const fake = {
      origin: 'https://clarin.test', sessions: { require: () => session }, checkedSession: async () => session,
      aggregates: async (_port: string, _generation: number, module?: string) => module === 'tasks' ? [taskSnapshot] : [], overlays: async () => [],
      queueMutation: vi.fn(async (_port: string, _generation: number, input: OfflineV5MutationInput) => { mutations.push(input); return { operation_id: 'comment-op', state: 'queued', pending_count: 1, entity: { value: input.optimistic_value } } }),
    }
    const adapter = new OfflineV5RouteAdapter(fake as unknown as OfflineV5Engine)
    const created = await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/tasks/task-a/comments', body: JSON.stringify({ body: ' Comentario local ', mentioned_user_ids: [], attachment_ids: [] }) })
    expect(created.status).toBe(201)
    expect(mutations[0]).toMatchObject({ action: 'tasks.comments.create', selection_id: 'selection-list', entity_type: 'task_comment', base_version: 0, payload: { task_id: 'task-a', body: 'Comentario local' } })
    expect(mutations[0].resource_id).toBe(mutations[0].entity_id)
    const blocked = await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/tasks/task-a/comments', body: JSON.stringify({ body: 'Con archivo', mentioned_user_ids: [], attachment_ids: ['attachment-a'] }) })
    expect(blocked.status).toBe(503)
    expect(parse(blocked)).toMatchObject({ error: 'online_required' })
    expect(fake.queueMutation).toHaveBeenCalledTimes(1)
  })
})

function programHarness() {
  const programSnapshot: OfflineV5Snapshot = {
    ...snapshot,
    selection_id: 'selection-program', root_selection_id: 'selection-program', root_resource_id: 'program-a', resource_id: 'program-a', module: 'programs', resource_type: 'program', head_version: 12,
    payload: {
      program: { id: 'program-a', account_id: 'account-a', name: 'Grupo A', status: 'active', color: '#10b981', updated_at: '2026-09-14T10:00:00.000Z' },
      active_roster: [{ id: 'participant-a', program_id: 'program-a', contact_id: 'contact-a', contact_name: 'Ada', status: 'active', enrolled_at: '2026-09-01', version: 1_700_000_000_000_000 }],
      historical_participations: [],
      sessions: [{ id: 'session-a', program_id: 'program-a', date: '2026-09-15', title: 'Clase 1', session_type: 'regular', start_time: '10:00', end_time: '11:00', updated_at: '2026-09-14T10:00:00.000Z', version: 1_700_000_000_000_001 }],
      session_topics: [{ id: 'topic-a', session_id: 'session-a', kind: 'free', title: 'Tema A', position: 0 }],
      eligible_attendance: [{ id: 'attendance-a', session_id: 'session-a', participant_id: 'participant-a', status: 'present', updated_at: '2026-09-14T10:00:00.000Z', version: 1_700_000_000_000_002 }],
      out_of_window_history: [], session_observations: [], attendance_observations: [], participant_notes: [],
      goals: { id: 'goal-a', program_id: 'program-a', account_id: 'account-a', attendance_goal_percent: 80, transfer_goal_percent: 70, updated_at: '2026-09-14T10:00:00.000Z' },
      health: { program_id: 'program-a', participant_count: 1, active_count: 1, completed_count: 0, dropped_count: 0, transferred_count: 0, session_count: 1, recovery_session_count: 0, attendance_rate: 100, transfer_rate: 0, attendance_goal_percent: 80, transfer_goal_percent: 70, health: 'healthy', participants: [] },
      academic_config: { program_id: 'program-a', courses: [], topics: [], instructors: [] },
    },
  }
  const contactSnapshot: OfflineV5Snapshot = {
    ...snapshot,
    root_resource_id: 'contact-b', resource_id: 'contact-b',
    payload: { ...snapshot.payload, contact: { id: 'contact-b', account_id: 'account-a', name: 'Grace', version: 3 } },
  }
  const mutations: OfflineV5MutationInput[] = []
  const session = {
    identity: { user_id: 'user-a', account_id: 'account-a' }, metadata: { actor: { username: 'ada', display_name: 'Ada', account_name: 'Cuenta A' } },
    manifest: {
      roots: [{ selection_id: 'selection-program', module: 'programs' }, { selection_id: 'selection-contact', module: 'contacts', resource_id: 'contact-b' }],
      capabilities: ['update', 'participants.add', 'participants.lifecycle.update', 'sessions.upsert', 'attendance.set', 'observations.create', 'goals.update'].map(action => ({ action: `programs.${action}`, selection_id: 'selection-program' })),
      entity_versions: [
        { entity_type: 'program_participant', entity_id: 'participant-a', version: 1_700_000_000_000_000 },
        { entity_type: 'program_session', entity_id: 'session-a', version: 1_700_000_000_000_001 },
        { entity_type: 'program_attendance', entity_id: 'session-a:participant-a', version: 1_700_000_000_000_002 },
      ],
    },
  }
  const fake = {
    origin: 'https://clarin.test', sessions: { require: () => session }, checkedSession: async () => session,
    aggregates: async (_port: string, _generation: number, module?: string) => module === 'programs' ? [programSnapshot] : module === 'contacts' ? [contactSnapshot] : [],
    overlays: async () => [],
    queueMutation: vi.fn(async (_port: string, _generation: number, input: OfflineV5MutationInput) => { mutations.push(input); return { operation_id: `op-${mutations.length}`, state: 'queued', pending_count: mutations.length, entity: { value: input.optimistic_value } } }),
    queueMutations: vi.fn(async (_port: string, _generation: number, inputs: readonly OfflineV5MutationInput[]) => inputs.map(input => {
      mutations.push(input)
      return { operation_id: `op-${mutations.length}`, state: 'queued', pending_count: mutations.length, entity: { value: input.optimistic_value } }
    })),
  }
  return { adapter: new OfflineV5RouteAdapter(fake as unknown as OfflineV5Engine), fake, mutations }
}

describe('Offline v5 canonical Program adapters', () => {
  it('loads the canonical Program detail contracts and derives a selected-only roster', async () => {
    const { adapter } = programHarness()
    const detail = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/programs/program-a' })
    const roster = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/programs/program-a/sessions/session-a/roster' })
    const dashboard = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/programs/dashboard' })
    expect(parse(detail)).toMatchObject({ id: 'program-a', name: 'Grupo A' })
    expect(parse(roster)).toMatchObject({ success: true, roster: [{ participant_id: 'participant-a', attendance_status: 'present' }] })
    expect(parse(dashboard)).toMatchObject({ success: true, dashboard: { program_count: 1, groups: [{ program_id: 'program-a' }] } })
  })

  it('translates lifecycle and session writes to exact v5 action payloads', async () => {
    const { adapter, mutations } = programHarness()
    await adapter.request('port', 1, { method: 'PATCH', headers: [], url: 'https://clarin.test/api/programs/program-a/participants/participant-a/enrollment', body: JSON.stringify({ enrolled_at: '2026-09-02' }) })
    await adapter.request('port', 1, { method: 'PATCH', headers: [], url: 'https://clarin.test/api/programs/program-a/participants/participant-a/outcome', body: JSON.stringify({ status: 'completed', completed_at: '2026-09-15', transferred_to_level: 'Nivel 2', transferred_at: 'ignored' }) })
    await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/programs/program-a/sessions', body: JSON.stringify({ date: '2026-09-16', title: ' Clase 2 ', topics: [{ kind: 'free', title: ' Tema 2 ' }], session_type: 'regular', start_time: '10:00', end_time: '11:00', location: '' }) })
    expect(mutations[0]).toMatchObject({ action: 'programs.participants.lifecycle.update', resource_id: 'participant-a', base_version: 1_700_000_000_000_000, payload: { program_id: 'program-a', mode: 'enrollment_date', enrolled_at: '2026-09-02' } })
    expect(mutations[1]).toMatchObject({ action: 'programs.participants.lifecycle.update', resource_id: 'participant-a', payload: { program_id: 'program-a', mode: 'outcome', status: 'completed', ended_on: '2026-09-15', transferred_to_level: 'Nivel 2' } })
    expect(mutations[1].payload).not.toHaveProperty('transferred_at')
    expect(mutations[2]).toMatchObject({ action: 'programs.sessions.upsert', base_version: 0, payload: { program_id: 'program-a', date: '2026-09-16', title: 'Clase 2', topics: [{ kind: 'free', title: 'Tema 2' }], session_type: 'regular' } })
  })

  it('adds only separately selected Contacts in one atomic local batch', async () => {
    const { adapter, mutations, fake } = programHarness()
    const response = await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/programs/program-a/participants/bulk', body: JSON.stringify({ contact_ids: ['contact-b', 'contact-not-selected'] }) })
    expect(response.status).toBe(200)
    expect(parse(response)).toMatchObject({ success: true, summary: { requested: 2, created: 1, rejected: 1 } })
    expect(fake.queueMutations).toHaveBeenCalledTimes(1)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ action: 'programs.participants.add', payload: { program_id: 'program-a', contact_id: 'contact-b' } })
  })

  it('queues attendance and each supported observation scope without replaying generic HTTP', async () => {
    const { adapter, mutations, fake } = programHarness()
    const attendance = await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/programs/program-a/sessions/session-a/attendance/batch', body: JSON.stringify({ records: [{ participant_id: 'participant-a', expected_status: 'present', status: 'late' }] }) })
    await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/programs/program-a/sessions/session-a/observations', body: JSON.stringify({ notes: 'Sesión local' }) })
    await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/programs/program-a/sessions/session-a/participants/participant-a/attendance-observations', body: JSON.stringify({ notes: 'Asistencia local' }) })
    await adapter.request('port', 1, { method: 'POST', headers: [], url: 'https://clarin.test/api/programs/program-a/participants/participant-a/observations', body: JSON.stringify({ notes: 'Participante local', type: 'call' }) })
    expect(attendance.status).toBe(200)
    expect(fake.queueMutations).toHaveBeenCalledTimes(1)
    expect(mutations[0]).toMatchObject({ action: 'programs.attendance.set', resource_id: 'participant-a', entity_type: 'program_attendance', base_version: 1_700_000_000_000_002, payload: { program_id: 'program-a', session_id: 'session-a', status: 'late' } })
    expect(mutations.slice(1).map(value => value.payload)).toEqual([
      { program_id: 'program-a', session_id: 'session-a', scope: 'session', notes: 'Sesión local' },
      { program_id: 'program-a', session_id: 'session-a', participant_id: 'participant-a', scope: 'attendance', notes: 'Asistencia local' },
      { program_id: 'program-a', participant_id: 'participant-a', scope: 'participant', notes: 'Participante local', type: 'call' },
    ])
  })
})

describe('Offline v5 canonical identity and dashboard adapters', () => {
  it('returns only manifest-authorized module permissions and a task-only summary', async () => {
    const taskSnapshot: OfflineV5Snapshot = {
      ...snapshot, selection_id: 'selection-list', root_selection_id: 'selection-list', root_resource_id: 'list-a', resource_id: 'list-a', module: 'tasks', resource_type: 'task_list',
      payload: { list: { id: 'list-a' }, statuses: [{ id: 'status-open', category: 'not_started' }], tasks: [{ id: 'task-a', list_id: 'list-a', assigned_to: 'user-a', title: 'Urgente', due_at: '2020-01-01T10:00:00.000Z', status_id: 'status-open' }] },
    }
    const session = { identity: { user_id: 'user-a', account_id: 'account-a' }, metadata: { actor: { username: 'ada', display_name: 'Ada Lovelace', account_name: 'Cuenta A' } }, manifest: { roots: [{ module: 'tasks' }, { module: 'contacts' }], capabilities: [], entity_versions: [] } }
    const fake = { origin: 'https://clarin.test', sessions: { require: () => session }, checkedSession: async () => session, aggregates: async (_p: string, _g: number, module?: string) => module === 'tasks' ? [taskSnapshot] : [], overlays: async () => [] }
    const adapter = new OfflineV5RouteAdapter(fake as unknown as OfflineV5Engine)
    const me = parse(await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/me' }))
    const dashboard = parse(await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/dashboard/summary?period=7d' }))
    expect(me).toMatchObject({ success: true, account_count: 1, user: { display_name: 'Ada Lovelace', account_name: 'Cuenta A', role: 'offline', permissions: ['tasks', 'contacts'], is_admin: false, is_super_admin: false, subscription_active: true } })
    expect(dashboard).toMatchObject({ success: true, dashboard: { period: { preset: '7d' }, sections: { leads: false, chats: false, tasks: true, events: false, devices: false }, tasks: { overdue: 1, items: [{ id: 'task-a' }] } } })
  })
})

describe('Offline v5 canonical whiteboard asset routes', () => {
  function whiteboardAdapter(rootResourceID = 'board-a') {
    const boardSnapshot: OfflineV5Snapshot = {
      ...snapshot,
      selection_id: 'selection-board', root_selection_id: 'selection-board', root_resource_id: 'board-a', resource_id: 'board-a', module: 'whiteboards', resource_type: 'whiteboard',
      payload: {
        whiteboard: { id: 'board-a', account_id: 'account-a', name: 'Ideas', scene: { elements: [{ type: 'image', fileId: 'file-a' }] } },
        permissions: { can_view: true, can_edit: true, can_upload_assets: false },
        asset_transport: { embedded: false, local_encrypted: true, blob_sync_enabled: false },
        referenced_assets: [{ id: 'asset-a', root_resource_id: rootResourceID, file_id: 'file-a', content_hash: 'a'.repeat(64), content_type: 'image/png', size_bytes: 4 }],
      },
    }
    const session = { identity: { user_id: 'user-a', account_id: 'account-a' }, metadata: { actor: { username: 'ada' } }, manifest: { capabilities: [], roots: [{ module: 'whiteboards' }] } }
    const fake = {
      origin: 'https://clarin.test', sessions: { require: () => session }, checkedSession: async () => session,
      aggregates: async (_p: string, _g: number, module?: string) => module === 'whiteboards' ? [boardSnapshot] : [], overlays: async () => [],
      getBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })),
    }
    return { adapter: new OfflineV5RouteAdapter(fake as unknown as OfflineV5Engine), fake }
  }

  it('serves the signed descriptor and encrypted local bytes through the normal editor routes', async () => {
    const { adapter, fake } = whiteboardAdapter()
    const listed = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/whiteboards/board-a/assets?limit=200&referenced_only=1' })
    expect(parse(listed)).toMatchObject({ success: true, assets: [{ id: 'asset-a', board_id: 'board-a', file_id: 'file-a', content_type: 'image/png', size_bytes: 4 }] })
    const downloaded = await adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/whiteboards/board-a/assets/asset-a' })
    expect(downloaded.status).toBe(200)
    expect(await downloaded.binary?.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer)
    expect(fake.getBlob).toHaveBeenCalledWith('port', 1, 'asset-a')
  })

  it('rejects an asset descriptor bound to another whiteboard', async () => {
    const { adapter } = whiteboardAdapter('board-b')
    await expect(adapter.request('port', 1, { method: 'GET', headers: [], url: 'https://clarin.test/api/whiteboards/board-a/assets' })).rejects.toMatchObject({ code: 'invalid_asset_manifest' })
  })
})
