import { OfflineV5Engine } from './engine'
import { offlineV5WhiteboardAssetDescriptors } from './manifest'
import { OfflineV5Error, type OfflineV5MutationInput, type OfflineV5RouteRequest, type OfflineV5RouteResponse, type OfflineV5Snapshot } from './types'

type JsonObject = Record<string, unknown>
const limaDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' })

function limaDateKey(value: Date): string {
  const parts = Object.fromEntries(limaDayFormatter.formatToParts(value).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function json(status: number, value: unknown): OfflineV5RouteResponse {
  return { status, headers: [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'no-store'], ['X-Clarin-Offline', '5']], body: JSON.stringify(value) }
}

function routeError(code: string, message: string, status = 503): OfflineV5RouteResponse {
  return json(status, { success: false, error: code, message, offline: true })
}

function body(request: OfflineV5RouteRequest): JsonObject {
  if (!request.body) return {}
  try {
    const value = JSON.parse(request.body)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value as JsonObject
  } catch { throw new OfflineV5Error('invalid_request_body', 'La solicitud local no contiene JSON válido.') }
}

function numberParam(url: URL, name: string, fallback: number, maximum = 200): number {
  const value = Number(url.searchParams.get(name) ?? fallback)
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback
}

function item(payload: JsonObject, name: string): JsonObject | undefined {
  const value = payload[name]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function list(payload: JsonObject, name: string): JsonObject[] {
  return Array.isArray(payload[name]) ? (payload[name] as unknown[]).filter(value => value && typeof value === 'object' && !Array.isArray(value)) as JsonObject[] : []
}

function mergedOverlays<T extends JsonObject>(canonical: T[], overlays: Array<{ entity_type: string; entity_id: string; value: unknown }>, entityType: string): T[] {
  const result = new Map(canonical.map(value => [String(value.id || ''), value]))
  for (const overlay of overlays) if (overlay.entity_type === entityType && overlay.value && typeof overlay.value === 'object') result.set(overlay.entity_id, overlay.value as T)
  return [...result.values()]
}

export class OfflineV5RouteAdapter {
  constructor(private readonly engine: OfflineV5Engine) {}

  async request(portID: string, generation: number, request: OfflineV5RouteRequest): Promise<OfflineV5RouteResponse> {
    const method = request.method.toUpperCase()
    let url: URL
    try { url = new URL(request.url, this.engine.origin) } catch { return routeError('invalid_url', 'La ruta solicitada no es válida.', 400) }
    if (url.origin !== this.engine.origin || !url.pathname.startsWith('/api/')) return routeError('online_required', 'Esta función requiere conexión con Clarín.')
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    const session = await this.engine.checkedSession(portID, generation)
    if (url.pathname === '/api/me' && method === 'GET') {
      const permissions = [...new Set(session.manifest.roots.map(root => root.module))]
      return json(200, {
        success: true,
        user: {
          id: session.identity.user_id,
          account_id: session.identity.account_id,
          account_name: session.metadata.actor.account_name,
          username: session.metadata.actor.username,
          display_name: session.metadata.actor.display_name || session.metadata.actor.username,
          is_admin: false,
          is_super_admin: false,
          role: 'offline',
          permissions,
          subscription_active: true,
        },
        account: { id: session.identity.account_id, name: session.metadata.actor.account_name },
        account_count: 1,
      })
    }
    if (url.pathname === '/api/dashboard/summary' && method === 'GET') return this.dashboardSummary(portID, generation, url)
    if (url.pathname === '/api/account/users' && method === 'GET') return this.accountUsers(portID, generation)
    if (url.pathname === '/api/interactions' || url.pathname.startsWith('/api/interactions/')) return this.interactions(portID, generation, url, method, request)
    if (url.pathname.startsWith('/api/contact-profiles/')) return this.contactProfiles(portID, generation, url, method, request)
    if (url.pathname === '/api/contacts' || url.pathname.startsWith('/api/contacts/')) return this.contacts(portID, generation, url, method, request)
    if (url.pathname === '/api/programs' || url.pathname.startsWith('/api/programs/')) return this.programs(portID, generation, url, method, request)
    if (url.pathname === '/api/whiteboards' || url.pathname.startsWith('/api/whiteboards/')) return this.whiteboards(portID, generation, url, method, request)
    if (url.pathname === '/api/tasks' || url.pathname.startsWith('/api/tasks/')) return this.tasks(portID, generation, url, method, request)
    return routeError('online_required', 'Esta función no forma parte de los recursos preparados para trabajar offline.')
  }

  private async dashboardSummary(portID: string, generation: number, url: URL) {
    const session = this.engine.sessions.require(portID, generation)
    const snapshots = await this.engine.aggregates(portID, generation, 'tasks')
    const overlays = await this.engine.overlays(portID, generation, 'task')
    const tasks = mergedOverlays<JsonObject>(snapshots.flatMap(snapshot => list(snapshot.payload, 'tasks')), overlays, 'task')
    const statusCategories = new Map<string, string>()
    for (const snapshot of snapshots) for (const status of list(snapshot.payload, 'statuses')) {
      if (typeof status.id === 'string') statusCategories.set(status.id, String(status.category || ''))
    }
    const mine = tasks.filter(task => task.assigned_to === session.identity.user_id)
    const open = mine.filter(task => {
      const category = String(task.status_category || statusCategories.get(String(task.status_id || '')) || task.status || '')
      return !['done', 'completed', 'cancelled', 'canceled'].includes(category)
    })
    const now = new Date()
    const today = limaDateKey(now)
    const withDue = open.flatMap(task => {
      const due = typeof task.due_at === 'string' && Number.isFinite(Date.parse(task.due_at)) ? new Date(task.due_at) : undefined
      return due ? [{ task, due }] : []
    })
    const overdue = withDue.filter(value => value.due.getTime() < now.getTime() && limaDateKey(value.due) < today)
    const dueToday = withDue.filter(value => limaDateKey(value.due) === today)
    const preset = ['7d', '30d', '90d'].includes(url.searchParams.get('period') || '') ? url.searchParams.get('period')! : '30d'
    const days = Number.parseInt(preset, 10)
    const to = new Date(now), from = new Date(now), previousTo = new Date(now), previousFrom = new Date(now)
    from.setUTCDate(from.getUTCDate() - days)
    previousTo.setUTCDate(previousTo.getUTCDate() - days)
    previousFrom.setUTCDate(previousFrom.getUTCDate() - days * 2)
    return json(200, {
      success: true,
      dashboard: {
        generated_at: now.toISOString(),
        timezone: 'America/Lima',
        period: { preset, from: from.toISOString(), to: to.toISOString(), previous_from: previousFrom.toISOString(), previous_to: previousTo.toISOString() },
        sections: { leads: false, chats: false, tasks: snapshots.length > 0, events: false, devices: false },
        ...(snapshots.length ? {
          tasks: {
            overdue: overdue.length,
            due_today: dueToday.length,
            items: [...overdue, ...dueToday]
              .sort((left, right) => left.due.getTime() - right.due.getTime())
              .slice(0, 5)
              .map(({ task }) => ({ id: task.id, environment_id: task.environment_id || null, title: task.title, due_at: task.due_at, status: task.status || statusCategories.get(String(task.status_id || '')) || '', type: task.type || 'task' })),
          },
        } : {}),
      },
    })
  }

  private async accountUsers(portID: string, generation: number) {
    const snapshots = await this.engine.aggregates(portID, generation, 'tasks')
    const users = new Map<string, JsonObject>()
    for (const snapshot of snapshots) for (const user of list(snapshot.payload, 'users')) if (user.id) users.set(String(user.id), user)
    return json(200, { users: [...users.values()] })
  }

  private async interactions(portID: string, generation: number, url: URL, method: string, request: OfflineV5RouteRequest) {
    if (url.pathname !== '/api/interactions') return routeError('online_required', 'Editar o eliminar observaciones existentes requiere conexión.')
    const snapshots = await this.engine.aggregates(portID, generation, 'programs')
    if (method === 'GET') {
      const participantID = url.searchParams.get('participant_id')
      if (!participantID) return routeError('online_required', 'El historial general requiere conexión.')
      const snapshot = snapshots.find(value => [...list(value.payload, 'active_roster'), ...list(value.payload, 'historical_participations')].some(participant => participant.id === participantID))
      if (!snapshot) return routeError('not_prepared', 'El participante no pertenece a un programa preparado.', 404)
      const overlays = await this.engine.overlays(portID, generation, 'program_observation')
      const interactions = mergedOverlays<JsonObject>(list(snapshot.payload, 'participant_notes'), overlays.filter(value => value.root_selection_id === snapshot.root_selection_id), 'program_observation').filter(value => value.participant_id === participantID)
      return json(200, { success: true, interactions, total: interactions.length })
    }
    if (method !== 'POST') return routeError('online_required', 'Esta operación del historial requiere conexión.')
    const change = body(request), programID = String(change.program_id || ''), participantID = String(change.program_participant_id || change.participant_id || ''), notes = typeof change.notes === 'string' ? change.notes.trim() : ''
    const snapshot = snapshots.find(value => value.root_resource_id === programID)
    const participants = snapshot ? [...list(snapshot.payload, 'active_roster'), ...list(snapshot.payload, 'historical_participations')] : []
    if (!snapshot || !participants.some(value => value.id === participantID) || !notes || [...notes].length > 10_000) return routeError('not_prepared', 'La observación no pertenece a un participante preparado.', 404)
    const payload: JsonObject = { program_id: programID, participant_id: participantID, scope: 'participant', notes }
    for (const name of ['type', 'outcome', 'follow_up_at', 'session_id']) if (change[name] === null || typeof change[name] === 'string') payload[name] = change[name]
    return this.queueProgramObservation(portID, generation, snapshot, payload)
  }

  private async contacts(portID: string, generation: number, url: URL, method: string, request: OfflineV5RouteRequest) {
    const snapshots = await this.engine.aggregates(portID, generation, 'contacts')
    const overlays = await this.engine.overlays(portID, generation, 'contact')
    const contacts: JsonObject[] = mergedOverlays<JsonObject>(snapshots.flatMap(snapshot => {
      const contact = item(snapshot.payload, 'contact')
      return contact ? [{ ...contact, phones: list(snapshot.payload, 'phones'), tags: list(snapshot.payload, 'tags'), direct_observations: list(snapshot.payload, 'direct_observations'), custom_fields: list(snapshot.payload, 'custom_fields') }] : []
    }), overlays, 'contact')
    if (url.pathname === '/api/contacts' && method === 'GET') {
      const query = (url.searchParams.get('search') || url.searchParams.get('q') || '').trim().toLocaleLowerCase()
      const filtered = query ? contacts.filter(contact => [contact.display_name, contact.name, contact.last_name, contact.phone, contact.email].some(value => String(value || '').toLocaleLowerCase().includes(query))) : contacts
      const offset = numberParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER), limit = numberParam(url, 'limit', 50)
      return json(200, { success: true, contacts: filtered.slice(offset, offset + limit), total: filtered.length })
    }
    const interactionMatch = url.pathname.match(/^\/api\/contacts\/([^/]+)\/interactions$/)
    if (interactionMatch && method === 'GET') {
      const contactID = decodeURIComponent(interactionMatch[1])
      const result = new Map<string, JsonObject>()
      const direct = snapshots.find(value => value.root_resource_id === contactID)
      if (direct) for (const value of list(direct.payload, 'direct_observations')) if (value.id) result.set(String(value.id), value)
      const programSnapshots = await this.engine.aggregates(portID, generation, 'programs')
      const programOverlays = await this.engine.overlays(portID, generation, 'program_observation')
      for (const programSnapshot of programSnapshots) {
        const participantIDs = new Set([...list(programSnapshot.payload, 'active_roster'), ...list(programSnapshot.payload, 'historical_participations')].filter(value => value.contact_id === contactID).map(value => value.id))
        if (!participantIDs.size) continue
        for (const value of [...list(programSnapshot.payload, 'participant_notes'), ...list(programSnapshot.payload, 'attendance_observations')]) if (value.id && participantIDs.has(value.participant_id)) result.set(String(value.id), value)
        for (const overlay of programOverlays) if (overlay.root_selection_id === programSnapshot.root_selection_id && overlay.value && typeof overlay.value === 'object' && participantIDs.has((overlay.value as JsonObject).participant_id)) {
          const value = overlay.value as JsonObject
          if (value.id) result.set(String(value.id), value)
        }
      }
      if (!direct && !result.size) return routeError('not_prepared', 'El historial de este contacto no está en la copia offline.', 404)
      const interactions = [...result.values()].sort((left, right) => Date.parse(String(right.created_at || '')) - Date.parse(String(left.created_at || '')))
      return json(200, { success: true, interactions, total: interactions.length })
    }
    const match = url.pathname.match(/^\/api\/contacts\/([^/]+)$/)
    if (!match) return routeError('online_required', 'Esta operación de Contactos requiere conexión.')
    const contactID = decodeURIComponent(match[1]), contact = contacts.find(value => value.id === contactID)
    const snapshot = snapshots.find(value => value.root_resource_id === contactID)
    if (!contact || !snapshot) return routeError('not_prepared', 'Este contacto no está incluido en la copia offline.', 404)
    if (method === 'GET') return json(200, { success: true, contact })
    if (!['PUT', 'PATCH'].includes(method)) return routeError('online_required', 'Esta acción administrativa requiere conexión.')
    const change = body(request), optimistic = { ...contact, ...change, id: contactID, account_id: contact.account_id ?? this.engine.sessions.require(portID, generation).identity.account_id, offline_pending: true }
    const result = await this.engine.queueMutation(portID, generation, {
      operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined,
      action: 'contacts.update', selection_id: snapshot.root_selection_id, resource_id: contactID, entity_type: 'contact', entity_id: contactID,
      base_version: Number(contact.version ?? snapshot.head_version) || 0, payload: change, optimistic_value: optimistic,
    })
    return json(200, { success: true, contact: result.entity.value, operation_id: result.operation_id, offline_pending: true })
  }

  /** Canonical ContactDetailSurface contract; this is a DTO adapter, not a second UI. */
  private async contactProfiles(portID: string, generation: number, url: URL, method: string, request: OfflineV5RouteRequest) {
    const match = url.pathname.match(/^\/api\/contact-profiles\/([^/]+)(?:\/(.*))?$/)
    if (!match) return routeError('online_required', 'Esta operación del contacto requiere conexión.')
    const contactID = decodeURIComponent(match[1]), suffix = match[2] || ''
    const snapshots = await this.engine.aggregates(portID, generation, 'contacts')
    const snapshot = snapshots.find(value => value.root_resource_id === contactID)
    if (!snapshot) return routeError('not_prepared', 'Este contacto no está incluido en la copia offline.', 404)
    const source = item(snapshot.payload, 'contact')
    if (!source) return routeError('invalid_snapshot', 'La copia local del contacto está incompleta.', 500)
    const contactOverlays = await this.engine.overlays(portID, generation, 'contact')
    const contactOverlay = contactOverlays.find(value => value.entity_id === contactID && value.root_selection_id === snapshot.root_selection_id)
    const baseContact = (contactOverlay?.value && typeof contactOverlay.value === 'object' ? contactOverlay.value : source) as JsonObject
    const tags = list(snapshot.payload, 'tags')
    const phones = list(snapshot.payload, 'phones')
    const customFields = list(snapshot.payload, 'custom_fields')
    const contact: JsonObject = {
      ...baseContact,
      id: contactID,
      structured_tags: Array.isArray(baseContact.structured_tags) ? baseContact.structured_tags : tags,
      extra_phones: Array.isArray(baseContact.extra_phones) ? baseContact.extra_phones : phones,
      custom_field_values: Array.isArray(baseContact.custom_field_values) ? baseContact.custom_field_values : customFields,
    }
    const session = this.engine.sessions.require(portID, generation)
    const canEdit = session.manifest.capabilities.some(value => value.action === 'contacts.update' && value.selection_id === snapshot.root_selection_id)
    const canObserve = session.manifest.capabilities.some(value => value.action === 'contacts.observations.create' && value.selection_id === snapshot.root_selection_id)
    const requestedContext = { type: url.searchParams.get('context_type') || 'contact', id: url.searchParams.get('context_id') || contactID }
    // A selected Contact root proves only the canonical Contact context. Other
    // CRM contexts must have their own prepared root/dependency before use.
    if (requestedContext.type !== 'contact' || requestedContext.id !== contactID) return routeError('not_prepared', 'Este contexto del contacto no fue incluido en la copia offline.', 404)
    const observations = await this.contactObservations(portID, generation, snapshot)
    const profile = (nextContact: JsonObject = contact) => ({
      success: true,
      contact: nextContact,
      context: requestedContext,
      capabilities: { can_view: true, can_edit: canEdit, can_manage_avatar: false, can_manage_observations: canObserve, can_create_tags: false },
      available_tags: list(snapshot.payload, 'available_tags'),
      custom_field_definitions: list(snapshot.payload, 'custom_field_definitions'),
      observation_count: Math.max(Number(snapshot.payload.observation_count) || 0, observations.length),
      pinned_observation_count: observations.filter(value => value.type === 'note' && value.is_pinned).length,
    })

    if (!suffix) {
      if (method === 'GET') return json(200, profile())
      if (method !== 'PATCH') return routeError('online_required', 'Esta acción del contacto requiere conexión.')
      if (!canEdit) return routeError('offline_action_denied', 'No tienes permiso para editar este contacto offline.', 403)
      const change = body(request)
      const optimistic = { ...contact, ...change, id: contactID, account_id: contact.account_id ?? session.identity.account_id, offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, {
        operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined,
        action: 'contacts.update', selection_id: snapshot.root_selection_id, resource_id: contactID, entity_type: 'contact', entity_id: contactID,
        base_version: Number(contact.version ?? snapshot.head_version) || 0, payload: change, optimistic_value: optimistic,
      })
      return json(200, { ...profile(result.entity.value as JsonObject), operation_id: result.operation_id, offline_pending: true })
    }

    if (suffix === 'observations') {
      if (method === 'GET') return json(200, { success: true, observations, total: observations.length })
      if (method !== 'POST') return routeError('online_required', 'Editar o eliminar observaciones existentes requiere conexión.')
      if (!canObserve) return routeError('offline_action_denied', 'No tienes permiso para añadir observaciones offline.', 403)
      const change = body(request), notes = typeof change.notes === 'string' ? change.notes.trim() : ''
      if (!notes || [...notes].length > 10_000) return routeError('invalid_request_body', 'La observación debe contener entre 1 y 10.000 caracteres.', 400)
      const observationID = crypto.randomUUID(), now = new Date().toISOString()
      const optimistic: JsonObject = { id: observationID, account_id: session.identity.account_id, contact_id: contactID, source_label: 'Contacto', type: 'note', notes, created_by: session.identity.user_id, author: session.metadata.actor.display_name || session.metadata.actor.username, created_at: now, updated_at: now, is_pinned: false, can_edit: false, can_pin: false, can_delete: false, offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, {
        operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined,
        action: 'contacts.observations.create', selection_id: snapshot.root_selection_id, resource_id: contactID,
        entity_type: 'contact_observation', entity_id: observationID, base_version: 0,
        payload: { observation_id: observationID, notes }, optimistic_value: optimistic,
      })
      return json(201, { success: true, observation: result.entity.value, total: observations.length + 1, operation_id: result.operation_id, offline_pending: true })
    }

    if (suffix === 'tags' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('es')
      const tags = list(snapshot.payload, 'available_tags').filter(value => !query || String(value.name || '').toLocaleLowerCase('es').includes(query))
      const limit = numberParam(url, 'limit', 20)
      return json(200, { success: true, tags: tags.slice(0, limit), total: tags.length })
    }
    if (/^observations\/[^/]+(?:\/pin)?$/.test(suffix)) return routeError('online_required', 'Editar, fijar o eliminar observaciones existentes requiere conexión.')
    return routeError('online_required', 'Esta función del contacto requiere conexión.')
  }

  private async contactObservations(portID: string, generation: number, snapshot: OfflineV5Snapshot): Promise<JsonObject[]> {
    const canonical = list(snapshot.payload, 'direct_observations')
    const overlays = await this.engine.overlays(portID, generation, 'contact_observation')
    return mergedOverlays<JsonObject>(canonical, overlays.filter(value => value.root_selection_id === snapshot.root_selection_id), 'contact_observation')
      .sort((left, right) => Number(Boolean(right.is_pinned)) - Number(Boolean(left.is_pinned)) || Date.parse(String(right.pinned_at || right.created_at || '')) - Date.parse(String(left.pinned_at || left.created_at || '')))
  }

  private async programs(portID: string, generation: number, url: URL, method: string, request: OfflineV5RouteRequest) {
    const snapshots = await this.engine.aggregates(portID, generation, 'programs')
    const allOverlays = await this.engine.overlays(portID, generation)
    const overlays = allOverlays.filter(value => value.entity_type === 'program')
    const session = this.engine.sessions.require(portID, generation)
    const programs: JsonObject[] = mergedOverlays<JsonObject>(snapshots.flatMap(snapshot => {
      const program = item(snapshot.payload, 'program')
      const active = list(snapshot.payload, 'active_roster'), history = list(snapshot.payload, 'historical_participations')
      return program ? [{ ...program, participants: [...active, ...history], active_roster: active, historical_participations: history, sessions: list(snapshot.payload, 'sessions'), eligible_attendance: list(snapshot.payload, 'eligible_attendance'), out_of_window_history: list(snapshot.payload, 'out_of_window_history') }] : []
    }), overlays, 'program')
    if (url.pathname === '/api/programs' && method === 'GET') return json(200, programs)
    if (url.pathname === '/api/programs/folders' && method === 'GET') return json(200, { success: true, folders: [] })
    if (url.pathname === '/api/programs/dashboard' && method === 'GET') return json(200, { success: true, dashboard: programDashboard(snapshots) })
    if (url.pathname === '/api/programs/goals' || url.pathname.startsWith('/api/programs/courses')) return routeError('online_required', 'El catálogo y la configuración global de Programas requieren conexión.')
    const match = url.pathname.match(/^\/api\/programs\/([^/]+)(?:\/(.*))?$/)
    if (!match) return routeError('online_required', 'Esta operación de Programas requiere conexión.')
    const programID = decodeURIComponent(match[1]), suffix = match[2] || '', program = programs.find(value => value.id === programID)
    const snapshot = snapshots.find(value => value.root_resource_id === programID)
    if (!program || !snapshot) return routeError('not_prepared', 'Este programa no está incluido en la copia offline.', 404)

    const participants = mergedOverlays<JsonObject>([
      ...list(snapshot.payload, 'active_roster'),
      ...list(snapshot.payload, 'historical_participations'),
    ], allOverlays, 'program_participant').filter(value => value.program_id === programID)
    const sessionTopics = list(snapshot.payload, 'session_topics')
    const sessions = mergedOverlays<JsonObject>(list(snapshot.payload, 'sessions').map(value => ({
      ...value,
      topics: Array.isArray(value.topics) ? value.topics : sessionTopics.filter(topic => topic.session_id === value.id),
    })), allOverlays, 'program_session').filter(value => value.program_id === programID)
    const attendances = mergeRowsBy(
      list(snapshot.payload, 'eligible_attendance'),
      allOverlays,
      'program_attendance',
      value => `${String(value.session_id || '')}\0${String(value.participant_id || '')}`,
    ).filter(value => value.program_id === undefined || value.program_id === programID)
    const goalsOverlay = allOverlays.find(value => value.entity_type === 'program_goal' && value.root_selection_id === snapshot.root_selection_id)
    const goals = goalsOverlay?.value && typeof goalsOverlay.value === 'object' ? goalsOverlay.value as JsonObject : item(snapshot.payload, 'goals')
    const programObservations = allOverlays.filter(value => value.entity_type === 'program_observation' && value.root_selection_id === snapshot.root_selection_id)
    const sessionObservations = mergedOverlays<JsonObject>(list(snapshot.payload, 'session_observations'), programObservations, 'program_observation')
    const attendanceObservations = mergedOverlays<JsonObject>(list(snapshot.payload, 'attendance_observations'), programObservations, 'program_observation')
    const participantNotes = mergedOverlays<JsonObject>(list(snapshot.payload, 'participant_notes'), programObservations, 'program_observation')

    if (method === 'GET') {
      if (!suffix) return json(200, program)
      if (suffix === 'participants') return json(200, participants)
      if (suffix === 'sessions') return json(200, sessions)
      if (suffix === 'academic-config') return json(200, snapshot.payload.academic_config || {})
      if (suffix === 'health') return snapshot.payload.health ? json(200, { success: true, health: snapshot.payload.health }) : routeError('not_prepared', 'La salud del programa no se incluyó en la copia.', 404)
      if (suffix === 'goals') return goals ? json(200, { success: true, goals }) : routeError('not_prepared', 'Las metas del programa no se incluyeron en la copia.', 404)
      if (suffix === 'attendance-stats') return json(200, programAttendanceStats(sessions, participants, attendances))
      const rosterMatch = suffix.match(/^sessions\/([^/]+)\/roster$/)
      if (rosterMatch) {
        const sessionID = decodeURIComponent(rosterMatch[1]), selectedSession = sessions.find(value => value.id === sessionID)
        if (!selectedSession) return routeError('not_prepared', 'La sesión no pertenece a este programa.', 404)
        const roster = eligibleProgramParticipants(participants, selectedSession).map(participant => {
          const attendance = attendances.find(value => value.session_id === sessionID && value.participant_id === participant.id)
          const observations = attendanceObservations.filter(value => value.session_id === sessionID && value.participant_id === participant.id)
          return {
            participant_id: participant.id, contact_id: participant.contact_id, contact_name: participant.contact_name || 'Contacto', contact_phone: participant.contact_phone || null,
            avatar_url: participant.avatar_url || null, avatar_revision: Number(participant.avatar_revision) || 0, participation_status: participant.status,
            enrolled_at: participant.enrolled_at, dropped_at: participant.dropped_at || null, completed_at: participant.completed_at || null,
            attendance_status: attendance?.status || '', observation_count: observations.length, observation_preview: observations.slice(-1),
          }
        })
        return json(200, { success: true, roster })
      }
      const sessionObservationMatch = suffix.match(/^sessions\/([^/]+)\/observations$/)
      if (sessionObservationMatch) {
        const sessionID = decodeURIComponent(sessionObservationMatch[1])
        if (!sessions.some(value => value.id === sessionID)) return routeError('not_prepared', 'La sesión no pertenece a este programa.', 404)
        return json(200, { success: true, observations: sessionObservations.filter(value => value.session_id === sessionID) })
      }
      const attendanceObservationMatch = suffix.match(/^sessions\/([^/]+)\/participants\/([^/]+)\/attendance-observations$/)
      if (attendanceObservationMatch) {
        const sessionID = decodeURIComponent(attendanceObservationMatch[1]), participantID = decodeURIComponent(attendanceObservationMatch[2])
        if (!sessions.some(value => value.id === sessionID) || !participants.some(value => value.id === participantID)) return routeError('not_prepared', 'La asistencia no pertenece a este programa.', 404)
        return json(200, { success: true, observations: attendanceObservations.filter(value => value.session_id === sessionID && value.participant_id === participantID) })
      }
      const attendanceHistoryMatch = suffix.match(/^participants\/([^/]+)\/attendance-history$/)
      if (attendanceHistoryMatch) {
        const participantID = decodeURIComponent(attendanceHistoryMatch[1]), participant = participants.find(value => value.id === participantID)
        if (!participant) return routeError('not_prepared', 'El participante no pertenece a este programa.', 404)
        return json(200, programAttendanceHistory(participant, sessions, attendances, attendanceObservations, goals))
      }
      const participantNotesMatch = suffix.match(/^participants\/([^/]+)\/observations$/)
      if (participantNotesMatch) return json(200, { success: true, observations: participantNotes.filter(value => value.participant_id === decodeURIComponent(participantNotesMatch[1])) })
      return routeError('online_required', 'Estos datos del programa no se prepararon para uso offline.')
    }

    if (suffix === 'participants/bulk' && method === 'POST') {
      const change = body(request)
      const contactIDs = Array.isArray(change.contact_ids) ? [...new Set(change.contact_ids.filter(value => typeof value === 'string' && value))] as string[] : []
      if (!contactIDs.length || contactIDs.length > 100) return routeError('invalid_request_body', 'Elige entre 1 y 100 contactos.', 400)
      const existing = new Set(participants.map(value => String(value.contact_id || '')))
      const contactSnapshots = await this.engine.aggregates(portID, generation, 'contacts')
      const additions: OfflineV5MutationInput[] = []
      let alreadyPresent = 0, rejected = 0
      for (const contactID of contactIDs) {
        if (existing.has(contactID)) { alreadyPresent++; continue }
        const contactSnapshot = contactSnapshots.find(value => value.root_resource_id === contactID)
        const contact = contactSnapshot && item(contactSnapshot.payload, 'contact')
        if (!contactSnapshot || !contact) { rejected++; continue }
        const participantID = crypto.randomUUID()
        const now = new Date().toISOString()
        const optimistic: JsonObject = { id: participantID, account_id: session.identity.account_id, program_id: programID, contact_id: contactID, status: 'active', enrolled_at: limaDateKey(new Date()), contact_name: contact.display_name || contact.custom_name || contact.name || contact.phone || 'Contacto', contact_phone: contact.phone, avatar_url: contact.avatar_url || null, avatar_revision: contact.avatar_revision || 0, created_at: now, updated_at: now, offline_pending: true }
        additions.push({ action: 'programs.participants.add', selection_id: snapshot.root_selection_id, resource_id: participantID, entity_type: 'program_participant', entity_id: participantID, base_version: 0, payload: { program_id: programID, contact_id: contactID }, optimistic_value: optimistic })
        existing.add(contactID)
      }
      if (additions.length) await this.engine.queueMutations(portID, generation, additions)
      return json(200, { success: true, summary: { requested: contactIDs.length, created: additions.length, already_present: alreadyPresent, rejected } })
    }

    const enrollmentMatch = suffix.match(/^participants\/([^/]+)\/enrollment$/)
    if (enrollmentMatch && method === 'PATCH') {
      const participantID = decodeURIComponent(enrollmentMatch[1]), participant = participants.find(value => value.id === participantID), change = body(request)
      const enrolledAt = typeof change.enrolled_at === 'string' ? change.enrolled_at : ''
      if (!participant || !calendarDate(enrolledAt)) return routeError('invalid_request_body', 'La fecha de incorporación no es válida.', 400)
      const optimistic = { ...participant, enrolled_at: enrolledAt, account_id: session.identity.account_id, program_id: programID, offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, { action: 'programs.participants.lifecycle.update', selection_id: snapshot.root_selection_id, resource_id: participantID, entity_type: 'program_participant', entity_id: participantID, base_version: versionFor(session.manifest, participantID, Number(participant.version) || micros(participant.dropped_at || participant.completed_at || participant.enrolled_at)), payload: { program_id: programID, mode: 'enrollment_date', enrolled_at: enrolledAt }, optimistic_value: optimistic })
      return json(200, { success: true, enrolled_at: enrolledAt, participant: result.entity.value, operation_id: result.operation_id, offline_pending: true })
    }

    const outcomeMatch = suffix.match(/^participants\/([^/]+)\/outcome$/)
    if (outcomeMatch && method === 'PATCH') {
      const participantID = decodeURIComponent(outcomeMatch[1]), participant = participants.find(value => value.id === participantID), change = body(request)
      const status = change.status === 'completed' || change.status === 'dropped' ? change.status : ''
      const endedOn = status === 'completed' ? change.completed_at : change.dropped_at
      if (!participant || participant.status !== 'active' || !status || typeof endedOn !== 'string' || !calendarDate(endedOn)) return routeError('invalid_request_body', 'El cierre de la participación no es válido.', 400)
      const payload: JsonObject = { program_id: programID, mode: 'outcome', status, ended_on: endedOn }
      for (const name of ['drop_reason', 'drop_notes', 'transferred_to_level']) if (typeof change[name] === 'string') payload[name] = change[name]
      const optimistic = { ...participant, status, ...(status === 'completed' ? { completed_at: endedOn, dropped_at: null } : { dropped_at: endedOn, completed_at: null }), ...pick(change, ['drop_reason', 'drop_notes', 'transferred_to_level']), account_id: session.identity.account_id, program_id: programID, offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, { action: 'programs.participants.lifecycle.update', selection_id: snapshot.root_selection_id, resource_id: participantID, entity_type: 'program_participant', entity_id: participantID, base_version: versionFor(session.manifest, participantID, Number(participant.version) || micros(participant.enrolled_at)), payload, optimistic_value: optimistic })
      return json(200, { success: true, participant: result.entity.value, operation_id: result.operation_id, offline_pending: true })
    }
    if (/^participants\/[^/]+\/outcome-date$/.test(suffix)) return routeError('online_required', 'Modificar una fecha de cierre ya sincronizada requiere conexión.')

    const sessionMatch = suffix.match(/^sessions(?:\/([^/]+))?$/)
    if (sessionMatch && (method === 'POST' || method === 'PUT')) {
      const change = body(request), existingSession = sessionMatch[1] ? sessions.find(value => value.id === decodeURIComponent(sessionMatch[1])) : undefined
      if (sessionMatch[1] && !existingSession) return routeError('not_prepared', 'La sesión no pertenece a este programa.', 404)
      const sessionID = existingSession ? String(existingSession.id) : crypto.randomUUID()
      const sessionPayload = normalizeProgramSessionPayload(change, programID)
      if (!sessionPayload) return routeError('invalid_request_body', 'Los datos de la sesión no son válidos.', 400)
      const optimistic = { ...existingSession, ...sessionPayload, id: sessionID, account_id: session.identity.account_id, program_id: programID, created_at: existingSession?.created_at || new Date().toISOString(), updated_at: new Date().toISOString(), offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, { action: 'programs.sessions.upsert', selection_id: snapshot.root_selection_id, resource_id: sessionID, entity_type: 'program_session', entity_id: sessionID, base_version: existingSession ? versionFor(session.manifest, sessionID, Number(existingSession.version) || micros(existingSession.updated_at)) : 0, payload: sessionPayload, optimistic_value: optimistic })
      return json(existingSession ? 200 : 201, { success: true, session: result.entity.value, operation_id: result.operation_id, offline_pending: true })
    }

    const attendanceBatchMatch = suffix.match(/^sessions\/([^/]+)\/attendance\/batch$/)
    if (attendanceBatchMatch && method === 'POST') {
      const sessionID = decodeURIComponent(attendanceBatchMatch[1]), selectedSession = sessions.find(value => value.id === sessionID), change = body(request)
      const records = Array.isArray(change.records) ? change.records.filter(value => value && typeof value === 'object' && !Array.isArray(value)) as JsonObject[] : []
      if (!selectedSession || !records.length || records.length > 200) return routeError('invalid_request_body', 'La asistencia solicitada no es válida.', 400)
      const conflicts: Array<{ participant_id: string; current_status: string }> = []
      const seenParticipants = new Set<string>()
      for (const record of records) {
        const participantID = String(record.participant_id || ''), current = attendances.find(value => value.session_id === sessionID && value.participant_id === participantID)
        if (seenParticipants.has(participantID)) return routeError('invalid_request_body', 'Cada participante debe aparecer una sola vez en el lote.', 400)
        seenParticipants.add(participantID)
        if (!participants.some(value => value.id === participantID) || !attendanceStatus(record.status) || !attendanceStatus(record.expected_status) || String(current?.status || '') !== String(record.expected_status || '')) conflicts.push({ participant_id: participantID, current_status: String(current?.status || '') })
      }
      if (conflicts.length) return json(409, { success: false, code: 'attendance_conflict', error: 'La asistencia cambió desde que abriste la sesión.', conflicts })
      const mutations: OfflineV5MutationInput[] = []
      for (const record of records) {
        const participantID = String(record.participant_id), current = attendances.find(value => value.session_id === sessionID && value.participant_id === participantID)
        const entityID = `attendance:${sessionID}:${participantID}`
        const optimistic: JsonObject = { ...current, id: entityID, account_id: session.identity.account_id, program_id: programID, session_id: sessionID, participant_id: participantID, status: record.status, updated_at: new Date().toISOString(), offline_pending: true }
        mutations.push({ action: 'programs.attendance.set', selection_id: snapshot.root_selection_id, resource_id: participantID, entity_type: 'program_attendance', entity_id: entityID, base_version: current ? versionFor(session.manifest, `${sessionID}:${participantID}`, Number(current.version) || micros(current.updated_at)) : 0, payload: { program_id: programID, session_id: sessionID, status: record.status }, optimistic_value: optimistic })
      }
      await this.engine.queueMutations(portID, generation, mutations)
      return json(200, { success: true, count: records.length, offline_pending: true })
    }

    const createSessionObservationMatch = suffix.match(/^sessions\/([^/]+)\/observations$/)
    if (createSessionObservationMatch && method === 'POST') {
      const sessionID = decodeURIComponent(createSessionObservationMatch[1]), change = body(request), notes = typeof change.notes === 'string' ? change.notes.trim() : ''
      if (!sessions.some(value => value.id === sessionID) || !notes || [...notes].length > 10_000) return routeError('invalid_request_body', 'La observación de sesión no es válida.', 400)
      return this.queueProgramObservation(portID, generation, snapshot, { program_id: programID, session_id: sessionID, scope: 'session', notes })
    }
    const createAttendanceObservationMatch = suffix.match(/^sessions\/([^/]+)\/participants\/([^/]+)\/attendance-observations$/)
    if (createAttendanceObservationMatch && method === 'POST') {
      const sessionID = decodeURIComponent(createAttendanceObservationMatch[1]), participantID = decodeURIComponent(createAttendanceObservationMatch[2]), change = body(request), notes = typeof change.notes === 'string' ? change.notes.trim() : ''
      if (!sessions.some(value => value.id === sessionID) || !participants.some(value => value.id === participantID) || !notes || [...notes].length > 10_000) return routeError('invalid_request_body', 'La observación de asistencia no es válida.', 400)
      return this.queueProgramObservation(portID, generation, snapshot, { program_id: programID, session_id: sessionID, participant_id: participantID, scope: 'attendance', notes })
    }
    const createParticipantObservationMatch = suffix.match(/^participants\/([^/]+)\/observations$/)
    if (createParticipantObservationMatch && method === 'POST') {
      const participantID = decodeURIComponent(createParticipantObservationMatch[1]), change = body(request), notes = typeof change.notes === 'string' ? change.notes.trim() : ''
      if (!participants.some(value => value.id === participantID) || !notes || [...notes].length > 10_000) return routeError('invalid_request_body', 'La observación del participante no es válida.', 400)
      const payload: JsonObject = { program_id: programID, participant_id: participantID, scope: 'participant', notes }
      for (const name of ['type', 'outcome', 'follow_up_at', 'session_id']) if (change[name] === null || typeof change[name] === 'string') payload[name] = change[name]
      return this.queueProgramObservation(portID, generation, snapshot, payload)
    }
    if (/^sessions\/[^/]+\/observations\/|^sessions\/[^/]+\/participants\/[^/]+\/attendance-observations\//.test(suffix)) return routeError('online_required', 'Editar, fijar o eliminar observaciones existentes requiere conexión.')

    if (suffix === 'goals' && method === 'PUT') {
      const change = body(request), current = goals || {}
      const payload = pick(change, ['attendance_goal_percent', 'transfer_goal_percent'])
      if (Object.keys(payload).length !== 2) return routeError('invalid_request_body', 'Las dos metas porcentuales son obligatorias.', 400)
      const optimistic = { ...current, ...payload, id: current.id || programID, program_id: programID, account_id: current.account_id ?? session.identity.account_id, offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, { operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined, action: 'programs.goals.update', selection_id: snapshot.root_selection_id, resource_id: programID, entity_type: 'program_goal', entity_id: String(optimistic.id), base_version: versionFor(session.manifest, String(current.id || ''), 0), payload, optimistic_value: optimistic })
      return json(200, { success: true, goals: result.entity.value, operation_id: result.operation_id, offline_pending: true })
    }
    if (suffix || !['PUT', 'PATCH'].includes(method)) return routeError('online_required', 'Esta acción del programa requiere conexión.')
    const change = body(request), optimistic = { ...program, ...change, id: programID, account_id: program.account_id ?? session.identity.account_id, offline_pending: true }
    const payload = pick(change, ['name', 'description', 'status', 'color', 'schedule_start_date', 'schedule_end_date', 'schedule_days', 'schedule_start_time', 'schedule_end_time', 'health_view_columns'])
    if (!Object.keys(payload).length) return routeError('online_required', 'Los campos solicitados del programa requieren conexión.')
    const result = await this.engine.queueMutation(portID, generation, {
      operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined,
      action: 'programs.update', selection_id: snapshot.root_selection_id, resource_id: programID, entity_type: 'program', entity_id: programID,
      base_version: versionFor(session.manifest, programID, Number(program.version ?? snapshot.head_version) || 0), payload, optimistic_value: optimistic,
    })
    return json(200, result.entity.value)
  }

  private async queueProgramObservation(portID: string, generation: number, snapshot: OfflineV5Snapshot, payload: JsonObject) {
    const session = this.engine.sessions.require(portID, generation)
    const observationID = crypto.randomUUID(), now = new Date().toISOString()
    const optimistic: JsonObject = { id: observationID, account_id: session.identity.account_id, ...payload, created_by: session.identity.user_id, created_by_name: session.metadata.actor.display_name || session.metadata.actor.username, created_at: now, updated_at: now, is_pinned: false, can_edit: false, can_pin: false, can_delete: false, offline_pending: true }
    const result = await this.engine.queueMutation(portID, generation, { action: 'programs.observations.create', selection_id: snapshot.root_selection_id, resource_id: observationID, entity_type: 'program_observation', entity_id: observationID, base_version: 0, payload, optimistic_value: optimistic })
    return json(201, { success: true, observation: result.entity.value, operation_id: result.operation_id, offline_pending: true })
  }


  private async whiteboards(portID: string, generation: number, url: URL, method: string, request: OfflineV5RouteRequest): Promise<OfflineV5RouteResponse> {
    const snapshots = await this.engine.aggregates(portID, generation, 'whiteboards')
    const overlays = await this.engine.overlays(portID, generation, 'whiteboard')
    const boards: JsonObject[] = mergedOverlays<JsonObject>(snapshots.flatMap(snapshot => {
      const board = item(snapshot.payload, 'whiteboard')
      return board ? [{ ...board, scene: snapshot.payload.scene ?? board.scene, referenced_assets: list(snapshot.payload, 'referenced_assets') }] : []
    }), overlays, 'whiteboard')
    if (url.pathname === '/api/whiteboards' && method === 'GET') return json(200, { success: true, whiteboards: boards, permissions: { can_create: false, can_create_folder: false }, counts: { active: boards.length }, work_whiteboard_views_enabled: false })
    const match = url.pathname.match(/^\/api\/whiteboards\/([^/]+)(?:\/(.*))?$/)
    if (!match) return routeError('online_required', 'Esta operación de Pizarras requiere conexión.')
    const boardID = decodeURIComponent(match[1]), suffix = match[2] || '', board = boards.find(value => value.id === boardID)
    const snapshot = snapshots.find(value => value.root_resource_id === boardID)
    if (!board || !snapshot) return routeError('not_prepared', 'Esta pizarra no está incluida en la copia offline.', 404)
    const assets = offlineV5WhiteboardAssetDescriptors(snapshot)
    if (method === 'GET') {
      if (!suffix) return json(200, { success: true, whiteboard: board })
      if (suffix === 'scene') return json(200, { success: true, scene: board.scene || snapshot.payload.scene })
      if (suffix === 'assets') return json(200, {
        success: true,
        assets: assets.map(asset => ({
          id: asset.id,
          board_id: boardID,
          file_id: asset.file_id,
          kind: 'asset',
          filename: asset.file_id,
          content_type: asset.content_type,
          size_bytes: asset.size_bytes,
          created_at: snapshot.generated_at,
        })),
        next_cursor: null,
      })
      const assetMatch = suffix.match(/^assets\/([^/]+)$/)
      if (assetMatch) {
        const assetID = decodeURIComponent(assetMatch[1])
        const descriptor = assets.find(asset => asset.id === assetID)
        if (!descriptor) return routeError('not_prepared', 'Esta imagen no pertenece a la pizarra preparada.', 404)
        const blob = await this.engine.getBlob(portID, generation, assetID)
        if (blob.size !== descriptor.size_bytes || blob.type !== descriptor.content_type) return routeError('blob_integrity', 'La imagen local no superó la verificación de integridad.', 422)
        return { status: 200, headers: [['Content-Type', descriptor.content_type], ['Content-Length', String(blob.size)], ['Cache-Control', 'no-store'], ['X-Clarin-Offline', '5']], binary: blob }
      }
      return routeError('online_required', 'Esta función de la pizarra requiere conexión.')
    }
    if (suffix !== 'scene' || !['PUT', 'PATCH'].includes(method)) return routeError('online_required', 'Compartir y administrar pizarras requiere conexión.')
    const change = body(request), scene = (change.scene || change) as JsonObject
    const optimistic = { ...board, scene, id: boardID, account_id: board.account_id ?? this.engine.sessions.require(portID, generation).identity.account_id, offline_pending: true }
    const result = await this.engine.queueMutation(portID, generation, {
      operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined,
      action: 'whiteboards.scene.update', selection_id: snapshot.root_selection_id, resource_id: boardID, entity_type: 'whiteboard', entity_id: boardID,
      base_version: Number(change.expected_sequence ?? board.sequence ?? snapshot.head_version) || 0, payload: change, optimistic_value: optimistic,
    })
    return json(200, { success: true, rebased: false, result: { scene: result.entity.value.scene, idempotent: result.state === 'duplicate' }, operation_id: result.operation_id, offline_pending: true })
  }

  private async tasks(portID: string, generation: number, url: URL, method: string, request: OfflineV5RouteRequest) {
    const snapshots = await this.engine.aggregates(portID, generation, 'tasks')
    const overlays = await this.engine.overlays(portID, generation, 'task')
    const lists: JsonObject[] = snapshots.flatMap(snapshot => {
      const value = item(snapshot.payload, 'list')
      return value ? [{ ...value, statuses: list(snapshot.payload, 'statuses'), selection_id: snapshot.root_selection_id }] : []
    })
    const tasks: JsonObject[] = mergedOverlays<JsonObject>(snapshots.flatMap(snapshot => list(snapshot.payload, 'tasks')), overlays, 'task')
    if (url.pathname === '/api/tasks/environments' && method === 'GET') {
      const environments = new Map<string, JsonObject>()
      for (const value of lists) if (value.environment_id) environments.set(String(value.environment_id), { id: value.environment_id, name: value.environment_name || 'Entorno preparado', capabilities: { can_view: true, can_edit: true, can_manage: false }, effective_access_level: 'edit' })
      return json(200, { environments: [...environments.values()], can_create: false })
    }
    const environmentMatch = url.pathname.match(/^\/api\/tasks\/environments\/([^/]+)(?:\/(.*))?$/)
    if (environmentMatch && method === 'GET') {
      const environmentID = decodeURIComponent(environmentMatch[1]), suffix = environmentMatch[2] || ''
      const environmentLists = lists.filter(value => value.environment_id === environmentID)
      if (!environmentLists.length) return routeError('not_prepared', 'Este Entorno no forma parte de la copia offline.', 404)
      if (!suffix) return json(200, { environment: { id: environmentID, name: environmentLists[0].environment_name || 'Entorno preparado' } })
      if (suffix === 'folders') return json(200, { folders: [], next_cursor: null })
      if (suffix === 'lists') return json(200, { lists: environmentLists, next_cursor: null })
      if (suffix === 'hierarchy') return json(200, { folders: [], root_lists: environmentLists })
      return routeError('online_required', 'Esta estructura no está preparada offline.')
    }
    if (url.pathname === '/api/tasks/workflows' && method === 'GET') {
      const environmentID = url.searchParams.get('environment_id')
      const workflows = new Map<string, JsonObject>()
      for (const value of lists.filter(item => !environmentID || item.environment_id === environmentID)) if (value.workflow_id) workflows.set(String(value.workflow_id), { id: value.workflow_id, name: value.workflow_name || 'Flujo', environment_id: value.environment_id, statuses: value.statuses || [] })
      return json(200, { workflows: [...workflows.values()] })
    }
    if (url.pathname === '/api/tasks' && method === 'GET') {
      const listID = url.searchParams.get('list_id'), environmentID = url.searchParams.get('environment_id'), query = (url.searchParams.get('search') || '').toLocaleLowerCase()
      let filtered = tasks.filter(task => !listID || task.list_id === listID)
      if (environmentID) { const ids = new Set(lists.filter(value => value.environment_id === environmentID).map(value => value.id)); filtered = filtered.filter(task => ids.has(task.list_id)) }
      if (query) filtered = filtered.filter(task => String(task.title || '').toLocaleLowerCase().includes(query) || String(task.description || '').toLocaleLowerCase().includes(query))
      const cursor = numberParam(url, 'cursor', 0, Number.MAX_SAFE_INTEGER), limit = numberParam(url, 'limit', 50)
      return json(200, { tasks: filtered.slice(cursor, cursor + limit), next_cursor: cursor + limit < filtered.length ? String(cursor + limit) : null, total: filtered.length })
    }
    if (url.pathname === '/api/tasks' && method === 'POST') {
      const change = body(request), listID = String(change.list_id || ''), snapshot = snapshots.find(value => value.root_resource_id === listID)
      if (!snapshot) return routeError('not_prepared', 'La lista elegida no está preparada para uso offline.', 403)
      const taskID = typeof change.id === 'string' && change.id ? change.id : crypto.randomUUID()
      const optimistic = { ...change, id: taskID, account_id: this.engine.sessions.require(portID, generation).identity.account_id, list_id: listID, version: 0, offline_pending: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      const createPayload = pick(change, ['title', 'description', 'parent_task_id', 'start_at', 'due_at', 'due_end_at', 'is_all_day', 'priority'])
      const result = await this.engine.queueMutation(portID, generation, { operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined, action: 'tasks.create', selection_id: snapshot.root_selection_id, resource_id: taskID, entity_type: 'task', entity_id: taskID, base_version: 0, payload: createPayload, optimistic_value: optimistic })
      return json(201, { task: result.entity.value, operation_id: result.operation_id, offline_pending: true })
    }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/)
    if (!match) return routeError('online_required', 'Esta función de Tareas requiere conexión.')
    const taskID = decodeURIComponent(match[1]), suffix = match[2] || '', task = tasks.find(value => value.id === taskID)
    if (!task) return routeError('not_prepared', 'Esta tarea no está incluida en una lista preparada.', 404)
    const snapshot = snapshots.find(value => value.root_resource_id === task.list_id)
    if (!snapshot) return routeError('not_prepared', 'La lista de esta tarea no está preparada.', 404)
    if (method === 'GET') {
      if (!suffix) return json(200, { task })
      if (suffix === 'children') return json(200, { tasks: tasks.filter(value => value.parent_task_id === taskID) })
      if (suffix === 'comments') {
        const commentOverlays = await this.engine.overlays(portID, generation, 'task_comment')
        const comments = mergedOverlays<JsonObject>(list(snapshot.payload, 'comments').filter(value => value.task_id === taskID), commentOverlays.filter(value => value.root_selection_id === snapshot.root_selection_id), 'task_comment').filter(value => value.task_id === taskID)
        const offset = numberParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER), limit = numberParam(url, 'limit', 100)
        return json(200, { comments: comments.slice(offset, offset + limit), has_more: offset + limit < comments.length, next_offset: Math.min(comments.length, offset + limit) })
      }
      if (suffix === 'activity') return json(200, { activity: list(snapshot.payload, 'activity').filter(value => value.task_id === taskID) })
      if (suffix === 'attachments') return json(200, { attachments: list(snapshot.payload, 'attachments').filter(value => value.task_id === taskID) })
      if (suffix === 'dependencies') return json(200, { dependencies: list(snapshot.payload, 'dependencies').filter(value => value.task_id === taskID || value.successor_task_id === taskID) })
      return routeError('online_required', 'Estos datos de la tarea no se prepararon offline.')
    }
    if (suffix === 'comments' && method === 'POST') {
      const change = body(request), text = typeof change.body === 'string' ? change.body.trim() : ''
      const mentions = Array.isArray(change.mentioned_user_ids) ? change.mentioned_user_ids : []
      const attachments = Array.isArray(change.attachment_ids) ? change.attachment_ids : []
      if (mentions.length || attachments.length) return routeError('online_required', 'Los comentarios con menciones o archivos requieren conexión.')
      if (!text || [...text].length > 200_000) return routeError('invalid_request_body', 'El comentario debe contener entre 1 y 200.000 caracteres.', 400)
      const commentID = crypto.randomUUID(), session = this.engine.sessions.require(portID, generation), now = new Date().toISOString()
      const optimistic = { id: commentID, account_id: session.identity.account_id, task_id: taskID, root_resource_id: snapshot.root_resource_id, author_id: session.identity.user_id, author_name: session.metadata.actor.display_name || session.metadata.actor.username, body: text, created_at: now, updated_at: now, mentions: [], attachments: [], can_edit: false, can_delete: false, offline_pending: true }
      const result = await this.engine.queueMutation(portID, generation, { operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined, action: 'tasks.comments.create', selection_id: snapshot.root_selection_id, resource_id: commentID, entity_type: 'task_comment', entity_id: commentID, base_version: 0, payload: { task_id: taskID, body: text }, optimistic_value: optimistic })
      return json(201, { comment: result.entity.value, operation_id: result.operation_id, offline_pending: true })
    }
    if (suffix || !['PUT', 'PATCH'].includes(method)) return routeError('online_required', 'Esta acción de Tareas requiere conexión.')
    const change = body(request), optimistic = { ...task, ...change, id: taskID, account_id: task.account_id ?? this.engine.sessions.require(portID, generation).identity.account_id, list_id: task.list_id, version: Number(task.version || 0), offline_pending: true, updated_at: new Date().toISOString() }
    const statuses = list(snapshot.payload, 'statuses'), targetStatus = typeof change.status_id === 'string' ? statuses.find(value => value.id === change.status_id) : undefined
    const requestedCategory = String(targetStatus?.category || change.status_category || change.status || '')
    const currentCategory = String(task.status_category || '')
    let action: OfflineV5MutationInput['action'] = 'tasks.update'
    let payload: JsonObject = pick(change, ['title', 'description', 'start_at', 'due_at', 'due_end_at', 'is_all_day', 'priority', 'starred', 'progress', 'manual_progress', 'progress_mode', 'is_milestone', 'notes'])
    if (requestedCategory === 'done' || requestedCategory === 'completed') { action = 'tasks.complete'; payload = {} }
    else if ((currentCategory === 'done' || currentCategory === 'completed') && requestedCategory === 'not_started') { action = 'tasks.reopen'; payload = {} }
    else if (change.status_id !== undefined || change.status_category !== undefined || change.status !== undefined) return routeError('online_required', 'Este cambio de estado requiere conexión; offline puedes completar o reabrir la tarea.')
    if (action === 'tasks.update' && !Object.keys(payload).length) return routeError('online_required', 'Los campos solicitados de la tarea requieren conexión.')
    const result = await this.engine.queueMutation(portID, generation, { operation_id: typeof change.operation_id === 'string' ? change.operation_id : undefined, action, selection_id: snapshot.root_selection_id, resource_id: taskID, entity_type: 'task', entity_id: taskID, base_version: Number(change.version ?? task.version) || 0, payload, optimistic_value: optimistic })
    return json(200, { task: result.entity.value, operation_id: result.operation_id, offline_pending: true })
  }
}

export function offlineV5OnlineRequiredResponse() { return routeError('online_required', 'Esta función requiere conexión con Clarín.') }

function mergeRowsBy(
  canonical: JsonObject[],
  overlays: Array<{ entity_type: string; value: unknown }>,
  entityType: string,
  key: (value: JsonObject) => string,
): JsonObject[] {
  const result = new Map(canonical.map(value => [key(value), value]))
  for (const overlay of overlays) {
    if (overlay.entity_type !== entityType || !overlay.value || typeof overlay.value !== 'object' || Array.isArray(overlay.value)) continue
    const value = overlay.value as JsonObject
    result.set(key(value), value)
  }
  return [...result.values()]
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function micros(value: unknown): number {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed * 1000 : 0
}

function attendanceStatus(value: unknown): boolean {
  return typeof value === 'string' && ['', 'confirmed', 'present', 'absent', 'late'].includes(value)
}

function normalizedDate(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 10) : ''
}

function eligibleProgramParticipants(participants: JsonObject[], session: JsonObject): JsonObject[] {
  const date = normalizedDate(session.date)
  return participants.filter(participant => {
    const enrolled = normalizedDate(participant.enrolled_at), dropped = normalizedDate(participant.dropped_at), completed = normalizedDate(participant.completed_at)
    return Boolean(date && enrolled && date >= enrolled && (!dropped || date < dropped) && (!completed || date < completed))
  })
}

function normalizeProgramSessionPayload(change: JsonObject, programID: string): JsonObject | undefined {
  const date = typeof change.date === 'string' ? change.date.slice(0, 10) : ''
  const title = typeof change.title === 'string' ? change.title.trim() : ''
  const sessionType = change.session_type === 'recovery' ? 'recovery' : change.session_type === 'regular' ? 'regular' : ''
  const topics = Array.isArray(change.topics) ? change.topics.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const topic = value as JsonObject, kind = topic.kind, topicTitle = typeof topic.title === 'string' ? topic.title.trim() : ''
    if ((kind !== 'course' && kind !== 'free') || !topicTitle || [...topicTitle].length > 255) return []
    if (kind === 'course' && (typeof topic.course_topic_id !== 'string' || !topic.course_topic_id)) return []
    if (kind === 'free' && topic.course_topic_id != null) return []
    return [{ kind, ...(kind === 'course' ? { course_topic_id: topic.course_topic_id } : {}), title: topicTitle }]
  }) : []
  if (!calendarDate(date) || !title || [...title].length > 255 || !sessionType || !topics.length || topics.length !== (Array.isArray(change.topics) ? change.topics.length : 0) || topics.length > 50) return undefined
  const payload: JsonObject = { program_id: programID, date, title, topics, session_type: sessionType }
  for (const name of ['start_time', 'end_time', 'location']) {
    if (change[name] === null) payload[name] = null
    else if (typeof change[name] === 'string') payload[name] = change[name]
  }
  const start = payload.start_time, end = payload.end_time
  if (typeof start === 'string' && start && !/^\d{2}:\d{2}$/.test(start) || typeof end === 'string' && end && !/^\d{2}:\d{2}$/.test(end) || typeof start === 'string' && typeof end === 'string' && start && end && end <= start) return undefined
  return payload
}

function programDashboard(snapshots: OfflineV5Snapshot[]): JsonObject {
  const groups: JsonObject[] = snapshots.flatMap(snapshot => {
    const program = item(snapshot.payload, 'program'), health = item(snapshot.payload, 'health'), goals = item(snapshot.payload, 'goals')
    if (!program || !health) return []
    const participants = list(health, 'participants')
    return [{
      program_id: program.id,
      name: program.name,
      status: program.status,
      color: program.color,
      participant_count: Number(health.participant_count) || 0,
      active_count: Number(health.active_count) || 0,
      completed_count: Number(health.completed_count) || 0,
      dropped_count: Number(health.dropped_count) || 0,
      transferred_count: Number(health.transferred_count) || 0,
      session_count: Number(health.session_count) || 0,
      attendance_rate: Number(health.attendance_rate) || 0,
      transfer_rate: Number(health.transfer_rate) || 0,
      attendance_goal_percent: Number(health.attendance_goal_percent ?? goals?.attendance_goal_percent) || 80,
      transfer_goal_percent: Number(health.transfer_goal_percent ?? goals?.transfer_goal_percent) || 70,
      at_risk_count: participants.filter(value => value.health === 'critical' || value.health === 'watch').length,
      health: health.health || 'healthy',
    }]
  })
  const total = (name: string) => groups.reduce((sum, value) => sum + Number(value[name] || 0), 0)
  const average = (name: string) => groups.length ? groups.reduce((sum, value) => sum + Number(value[name] || 0), 0) / groups.length : 0
  return {
    attendance_goal_percent: average('attendance_goal_percent') || 80,
    transfer_goal_percent: average('transfer_goal_percent') || 70,
    program_count: groups.length,
    active_program_count: groups.filter(value => value.status === 'active').length,
    participant_count: total('participant_count'),
    completed_count: total('completed_count'),
    dropped_count: total('dropped_count'),
    transferred_count: total('transferred_count'),
    attendance_rate: average('attendance_rate'),
    transfer_rate: average('transfer_rate'),
    groups_below_goal: groups.filter(value => Number(value.attendance_rate) < Number(value.attendance_goal_percent)).length,
    critical_participants: total('at_risk_count'),
    groups,
  }
}

function programAttendanceHistory(participant: JsonObject, sessions: JsonObject[], attendances: JsonObject[], observations: JsonObject[], goals?: JsonObject): JsonObject {
  const eligible = sessions.filter(session => eligibleProgramParticipants([participant], session).length > 0)
  const historical = sessions.filter(session => !eligible.includes(session) && normalizedDate(session.date) < normalizedDate(participant.enrolled_at))
  const row = (session: JsonObject, outside = false) => {
    const attendance = attendances.find(value => value.session_id === session.id && value.participant_id === participant.id)
    const notes = observations.filter(value => value.session_id === session.id && value.participant_id === participant.id)
    return { session_id: session.id, ordinal: 0, title: session.title || session.topic || 'Sesión', date: session.date, start_time: session.start_time || null, end_time: session.end_time || null, session_type: session.session_type || 'regular', topics: Array.isArray(session.topics) ? session.topics : [], status: attendance?.status || null, observation_count: notes.length, observation_preview: notes.at(-1) || null, outside_enrollment_period: outside }
  }
  const rows = eligible.sort((left, right) => String(left.date).localeCompare(String(right.date))).map((value, index) => ({ ...row(value), ordinal: index + 1 }))
  const historicalRows = historical.sort((left, right) => String(left.date).localeCompare(String(right.date))).map((value, index) => ({ ...row(value, true), ordinal: index + 1 }))
  const statuses = rows.map(value => value.status)
  const present = statuses.filter(value => value === 'present').length, late = statuses.filter(value => value === 'late').length, absent = statuses.filter(value => value === 'absent').length
  const marked = present + late + absent, rate = marked ? (present + late) / marked * 100 : null, goal = Number(goals?.attendance_goal_percent) || 80
  return { summary: { goal_percent: goal, eligible_sessions: rows.length, marked_sessions: marked, pending: Math.max(0, rows.length - marked), present, absent, late, attendance_rate: rate, punctuality_rate: present + late ? present / (present + late) * 100 : null, health: rate == null ? 'no_data' : rate >= goal ? 'green' : rate >= Math.max(0, goal - 15) ? 'amber' : 'red' }, sessions: rows, historical_sessions: historicalRows, next_cursor: null }
}

function programAttendanceStats(sessions: JsonObject[], participants: JsonObject[], attendances: JsonObject[]): JsonObject {
  const sessionStats = sessions.map(session => {
    const rows = attendances.filter(value => value.session_id === session.id)
    const count = (status: string) => rows.filter(value => value.status === status).length
    return { session_id: session.id, title: session.title || 'Sesión', topic: session.topic || '', date: session.date, confirmed: count('confirmed'), present: count('present'), absent: count('absent'), late: count('late'), excused: 0 }
  })
  const participantStats = participants.map(participant => {
    const rows = attendances.filter(value => value.participant_id === participant.id), eligible = sessions.filter(session => eligibleProgramParticipants([participant], session).length).length
    const count = (status: string) => rows.filter(value => value.status === status).length
    const present = count('present'), absent = count('absent'), late = count('late'), marked = present + absent + late
    return { participant_id: participant.id, name: participant.contact_name || 'Contacto', present, absent, late, excused: 0, total_sessions: eligible, marked_sessions: marked, pending: Math.max(0, eligible - marked), rate: marked ? (present + late) / marked * 100 : 0 }
  })
  return { success: true, session_stats: sessionStats, participant_stats: participantStats }
}

function pick(value: JsonObject, names: readonly string[]): JsonObject {
  const result: JsonObject = {}
  for (const name of names) if (Object.prototype.hasOwnProperty.call(value, name)) result[name] = value[name]
  return result
}

function versionFor(manifest: { entity_versions: Array<{ entity_id: string; version: number }> }, entityID: string, fallback: number): number {
  return manifest.entity_versions.find(value => value.entity_id === entityID)?.version ?? fallback
}
