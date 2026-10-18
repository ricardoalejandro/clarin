// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { offlineCanonicalContact, offlineContactOptimisticValue, offlineObservationPage, offlineProgramContactContext } from './contactContract'
import { OfflineV5RouteAdapter } from './routeAdapter'
import type { OfflineV5Engine } from './engine'
import type { OfflineV5MutationInput, OfflineV5Snapshot } from './types'

const root = (module: OfflineV5Snapshot['module'], id: string, payload: Record<string, unknown>): OfflineV5Snapshot => ({
  protocol_version: 5, manifest_id: 'manifest', manifest_revision: 1, selection_id: `selection-${id}`, root_selection_id: `selection-${id}`,
  root_resource_id: id, module, resource_type: module === 'programs' ? 'program' : module === 'whiteboards' ? 'whiteboard' : 'contact', resource_id: id,
  dependency: false, head_version: 7, content_hash: 'hash', payload_json: '{}', tombstone: false, generated_at: '2026-10-16T00:00:00Z', payload,
})
const contact = { id: 'contact', account_id: 'account', name: 'Álvaro', updated_at: '2026-10-15T00:00:00Z' }
const participant = { id: 'participant', program_id: 'program', contact_id: 'contact', status: 'active', enrolled_at: '2026-10-01' }
const program = () => root('programs', 'program', {
  program: { id: 'program', account_id: 'account' }, active_roster: [participant], historical_participations: [],
  contact_profiles: [{ contact, phones: [], tags: [], custom_fields: [], observation_count: 3, history_prepared: false }],
  sessions: [{ id: 'session', program_id: 'program', date: '2026-10-10' }],
})
const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'box', type: 'rectangle', x: 20 }], appState: {}, files: {} }
const board = () => root('whiteboards', 'board', {
  whiteboard: { id: 'board', title: 'Plan', scene, sequence: 41, scene_schema_version: 2, editor_version: '0.18.1-clarin.8', updated_at: '2026-10-15T00:00:00Z' },
  permissions: { can_edit: true }, referenced_assets: [], asset_transport: { embedded: false, local_encrypted: true, blob_sync_enabled: false },
})
function harness(snapshots: OfflineV5Snapshot[], write = true) {
  const overlays: Array<{ entity_type: string; entity_id: string; root_selection_id: string; value: unknown }> = []
  const mutations: OfflineV5MutationInput[] = []
  const session = { identity: { user_id: 'user', account_id: 'account' }, metadata: { actor: { username: 'User' } }, manifest: {
    roots: snapshots, entity_versions: [{ entity_id: 'contact', version: 123456 }],
    capabilities: write ? snapshots.flatMap(snapshot => (snapshot.module === 'whiteboards' ? ['whiteboards.scene.update'] : snapshot.module === 'contacts' ? ['contacts.update', 'contacts.observations.create'] : ['programs.attendance.set']).map(action => ({ action, selection_id: snapshot.root_selection_id }))) : [],
  } }
  const queue = vi.fn(async (_port: string, _generation: number, input: OfflineV5MutationInput) => {
    mutations.push(input)
    const overlay = { entity_type: input.entity_type, entity_id: input.entity_id, root_selection_id: input.selection_id, value: input.optimistic_value }
    const index = overlays.findIndex(value => value.entity_id === overlay.entity_id && value.root_selection_id === overlay.root_selection_id)
    if (index < 0) overlays.push(overlay); else overlays[index] = overlay
    return { operation_id: input.operation_id || 'op', state: 'queued', entity: overlay }
  })
  const engine = { origin: 'https://clarin.test', checkedSession: async () => session, sessions: { require: () => session },
    aggregates: async (_p: string, _g: number, module: string) => snapshots.filter(value => value.module === module),
    overlays: async (_p: string, _g: number, entityType?: string) => overlays.filter(value => !entityType || value.entity_type === entityType),
    queueMutation: queue, queueMutations: async (p: string, g: number, inputs: OfflineV5MutationInput[]) => Promise.all(inputs.map(input => queue(p, g, input))),
  }
  const adapter = new OfflineV5RouteAdapter(engine as unknown as OfflineV5Engine)
  const request = (path: string, method = 'GET', value?: unknown) => adapter.request('port', 1, { url: `https://clarin.test/api/${path}`, method, headers: [], body: value === undefined ? undefined : JSON.stringify(value) })
  return { request, mutations, overlays }
}
const parse = (response: { body?: string }) => JSON.parse(response.body || '{}')

describe('prepared canonical Contact identity', () => {
  it('normalizes historical field names without losing false, zero or Unicode', () => {
    expect(offlineCanonicalContact({ ...contact, district: 'Ñaña', occupation: 'Docente' }, { custom_fields: [{ id: 'field', type: 'checkbox', bool: false, number: 0, text: 'Sí' }] })).toMatchObject({
      distrito: 'Ñaña', ocupacion: 'Docente', custom_field_values: [{ field_id: 'field', contact_id: 'contact', field_type: 'checkbox', value_bool: false, value_number: 0, value_text: 'Sí' }],
    })
  })
  it('reconciles removal of the last tag and retains custom field labels after editing', () => {
    const original = { ...contact, structured_tags: [{ id: 'tag', name: 'Assigned' }], custom_field_values: [{ field_id: 'field', field_name: 'Consent', field_type: 'checkbox', value_bool: true }] }
    expect(offlineContactOptimisticValue(original, {}, { tag_ids: [], custom_field_values: [{ field_id: 'field', value_bool: false }] })).toMatchObject({ structured_tags: [], custom_field_values: [{ field_name: 'Consent', field_type: 'checkbox', value_bool: false }] })
    expect(original.structured_tags).toHaveLength(1)
    expect(() => offlineContactOptimisticValue(original, {}, { tag_ids: ['outside'] })).toThrowError(/no fue preparada/)
  })
  it('opens the same profile for the exact prepared Program participant without granting Contact edits', async () => {
    const { request, mutations } = harness([program()])
    const path = 'contact-profiles/contact?context_type=program_participant&context_id=participant'
    expect(parse(await request(path))).toMatchObject({ contact: { id: 'contact', name: 'Álvaro' }, context: { type: 'program_participant', id: 'participant' }, capabilities: { can_view: true, can_edit: false, can_manage_observations: false }, observation_count: 3 })
    expect((await request(path, 'PATCH', { name: 'Changed' })).status).toBe(403)
    expect((await request('contact-profiles/contact?context_type=program_participant&context_id=another-participation')).status).toBe(404)
    expect((await request('contact-profiles/contact?context_type=contact&context_id=contact')).status).toBe(404)
    expect((await request('contact-profiles/contact/observations?context_type=program_participant&context_id=participant')).status).toBe(404)
    expect(mutations).toHaveLength(0)
  })
  it('rejects a mismatched roster and accepts a locally added participant only in its selected Program', () => {
    const snapshot = program()
    snapshot.payload.active_roster = [{ ...participant, program_id: 'other' }]
    expect(offlineProgramContactContext([snapshot], 'contact', 'participant')).toBeUndefined()
    expect(offlineProgramContactContext([snapshot], 'contact', 'new', [{ root_selection_id: snapshot.root_selection_id, entity_id: 'new', value: { ...participant, id: 'new' } }])?.participant.id).toBe('new')
  })
  it('opens a Program profile from the actual snapshot roster DTO without program_id', async () => {
    const snapshot = program()
    snapshot.payload.active_roster = [{ id: 'participant', contact_id: 'contact', name: 'Álvaro', enrolled_at: '2026-10-01' }]
    const { request } = harness([snapshot])
    expect(parse(await request('contact-profiles/contact?context_type=program_participant&context_id=participant'))).toMatchObject({ contact: { id: 'contact', name: 'Álvaro' }, capabilities: { can_edit: false } })
  })
  it('uses the original Contact fields and exact entity version when editing from its Program', async () => {
    const { request, mutations } = harness([program(), root('contacts', 'contact', { contact, direct_observations: [] })])
    const result = await request('contact-profiles/contact?context_type=program_participant&context_id=participant', 'PATCH', { name: 'New' })
    expect(result.status).toBe(200)
    expect(mutations[0]).toMatchObject({ selection_id: 'selection-contact', base_version: 123456, base: { name: 'Álvaro' }, payload: { name: 'New' }, optimistic_value: { name: 'New' } })
  })
  it('pages observations with a stable cursor instead of silently returning a fixed history', () => {
    const observations = Array.from({ length: 51 }, (_, i) => ({ id: String(i), notes: `Nota ${i}` }))
    const first = offlineObservationPage(observations, new URL('https://clarin.test/?limit=50'))!
    expect(first).toMatchObject({ has_more: true, next_cursor: '49', total: 51 })
    expect(offlineObservationPage(observations, new URL('https://clarin.test/?cursor=49'))).toMatchObject({ has_more: false, observations: [{ id: '50' }] })
    expect(offlineObservationPage(observations, new URL('https://clarin.test/?cursor=unknown'))).toBeUndefined()
  })
})

describe('canonical Whiteboard editor contract', () => {
  it('loads, edits twice and reloads the exact scene record while preserving authoritative sequence', async () => {
    const { request, mutations } = harness([board()])
    expect(parse(await request('whiteboards/board'))).toMatchObject({ whiteboard: { effective_access: { can_edit: true, can_delete: false }, scene_sequence: 41 } })
    expect(parse(await request('whiteboards/board/scene'))).toMatchObject({ scene: { board_id: 'board', sequence: 41, scene } })
    const changed = { ...scene, elements: [{ id: 'box', type: 'rectangle', x: 40 }] }
    const first = parse(await request('whiteboards/board/scene', 'PUT', { operation_id: 'first', expected_sequence: 41, scene: changed, scene_schema_version: 2, editor_version: '0.18.1-clarin.8' }))
    expect(first.result.scene).toMatchObject({ board_id: 'board', sequence: 41, scene: changed })
    const secondScene = { ...changed, elements: [...changed.elements, { id: 'two', type: 'rectangle', x: 50 }] }
    await request('whiteboards/board/scene', 'PUT', { operation_id: 'second', expected_sequence: 41, scene: secondScene })
    expect(mutations[0]).toMatchObject({ base_version: 41, base: { scene }, payload: { expected_sequence: 41 } })
    expect(mutations[1]).toMatchObject({ base_version: 41, base: { scene: changed } })
    expect(parse(await request('whiteboards/board/scene')).scene).toMatchObject({ sequence: 41, scene: secondScene })
  })
  it('intersects prepared permissions and capability, rejects unprepared images and stale saves', async () => {
    const readOnly = harness([board()], false)
    expect(parse(await readOnly.request('whiteboards/board')).whiteboard.effective_access.can_edit).toBe(false)
    expect((await readOnly.request('whiteboards/board/scene', 'PUT', { scene, operation_id: 'one', expected_sequence: 41 })).status).toBe(403)
    const { request, mutations } = harness([board()])
    await expect(request('whiteboards/board/scene', 'PUT', { scene: { ...scene, elements: [{ type: 'image', fileId: 'new-file' }] }, operation_id: 'one', expected_sequence: 41 })).rejects.toMatchObject({ code: 'online_required' })
    expect((await request('whiteboards/board/scene', 'PUT', { scene, operation_id: 'one', expected_sequence: 42 })).status).toBe(409)
    expect(mutations).toHaveLength(0)
  })
})

describe('Program attendance boundary', () => {
  it.each(['2026-10-10', '2026-10-09'])('rejects attendance on/after withdrawal %s before queueing a batch', async droppedAt => {
    const snapshot = program()
    snapshot.payload.active_roster = [{ ...participant, status: 'dropped', dropped_at: droppedAt }]
    const { request, mutations } = harness([snapshot])
    expect((await request('programs/program/sessions/session/attendance/batch', 'POST', { records: [{ participant_id: 'participant', expected_status: '', status: 'present' }] })).status).toBe(409)
    expect(mutations).toHaveLength(0)
  })
  it('includes enrollment day and preserves original pending status for conflict resolution', async () => {
    const snapshot = program()
    snapshot.payload.active_roster = [{ ...participant, enrolled_at: '2026-10-10' }]
    const { request, mutations } = harness([snapshot])
    expect((await request('programs/program/sessions/session/attendance/batch', 'POST', { records: [{ participant_id: 'participant', expected_status: '', status: 'present' }] })).status).toBe(200)
    expect(mutations[0]).toMatchObject({ base: { status: '' }, payload: { status: 'present' } })
  })
})
