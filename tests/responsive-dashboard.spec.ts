import { expect, test, type Locator, type Page } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3001'
const username = process.env.CLARIN_E2E_USERNAME
const password = process.env.CLARIN_E2E_PASSWORD
const accountName = process.env.CLARIN_E2E_ACCOUNT
const useMockSession = process.env.CLARIN_E2E_MOCK_AUTH === '1'
const captureVisuals = process.env.CLARIN_E2E_CAPTURE === '1'

const priorityRoutes = [
  '/dashboard',
  '/dashboard/chats',
  '/dashboard/programs',
]

const secondaryRoutes = [
  '/dashboard/contacts',
  '/dashboard/settings?tab=devices',
  '/dashboard/broadcasts',
  '/dashboard/leads',
  '/dashboard/events',
]

const priorityMatrix = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'phone-375-short', width: 375, height: 667 },
  { name: 'phone-375-tall', width: 375, height: 812 },
  { name: 'phone-landscape', width: 568, height: 320 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

const mockNow = '2026-07-17T12:00:00.000Z'
const mockCanonicalContact = {
  id: 'contact-1',
  account_id: 'account-responsive',
  jid: '51999999999@s.whatsapp.net',
  phone: '51999999999',
  name: 'Contacto móvil',
  custom_name: 'Contacto móvil',
  last_name: 'Responsive',
  short_name: 'Contacto QA',
  email: 'movil@example.test',
  company: 'Clarin QA',
  age: 31,
  dni: '70000001',
  birth_date: '1995-04-03',
  address: 'Jr. Pruebas 123',
  distrito: 'Iquitos',
  ocupacion: 'Facilitador',
  notes: 'Ficha canónica compartida',
  tags: ['Comunidad'],
  structured_tags: [{ id: 'tag-community', name: 'Comunidad', color: '#10b981' }],
  extra_phones: [{ id: 'phone-extra-1', contact_id: 'contact-1', phone: '51911111111', label: 'Trabajo' }],
  custom_field_values: [{ id: 'custom-value-1', contact_id: 'contact-1', field_id: 'custom-field-1', field_name: 'Nivel', field_slug: 'nivel', field_type: 'select', value_text: 'intermedio', value_number: null, value_date: null, value_bool: null, value_json: null }],
  avatar_url: null,
  created_at: mockNow,
  updated_at: mockNow,
}

const mockLeadSnapshot = {
  id: 'lead-1',
  jid: '51999999999@s.whatsapp.net',
  contact_id: 'contact-1',
  title: 'Matrícula del programa QA',
  name: 'Snapshot de lead desactualizado',
  last_name: null,
  short_name: null,
  phone: '51900000001',
  email: 'snapshot-lead@example.test',
  company: 'Snapshot comercial',
  age: null,
  dni: null,
  birth_date: null,
  address: null,
  distrito: null,
  ocupacion: null,
  status: 'open',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Ventas QA',
  stage_id: 'stage-1',
  stage_name: 'Interesado',
  stage_color: '#10b981',
  stage_position: 0,
  notes: 'Contexto comercial independiente',
  tags: [],
  structured_tags: [],
  kommo_id: null,
  is_archived: false,
  archived_at: null,
  is_blocked: false,
  blocked_at: null,
  block_reason: '',
  kommo_deleted_at: null,
  assigned_to: '',
  created_at: mockNow,
  updated_at: mockNow,
}

const mockEventParticipant = {
  id: 'event-participant-1',
  event_id: 'event-1',
  contact_id: 'contact-1',
  name: 'Snapshot de evento desactualizado',
  phone: '51900000002',
  email: 'snapshot-evento@example.test',
  status: 'confirmed',
  notes: 'Datos exclusivos de la inscripción',
  tags: [],
  membership_state: 'active',
  membership_source: 'manual',
  membership_reason: '',
  membership_changed_at: mockNow,
  auto_tag_sync: false,
  related_leads: [{
    id: 'lead-1',
    title: 'Matrícula del programa QA',
    status: 'open',
    pipeline_id: 'pipeline-1',
    pipeline_name: 'Ventas QA',
    stage_id: 'stage-1',
    stage_name: 'Interesado',
    stage_color: '#10b981',
    is_archived: false,
    updated_at: mockNow,
  }],
}
const mockProgramParticipants = Array.from({ length: 6 }, (_, index) => ({
  id: `program-participant-${index + 1}`,
  program_id: 'program-1',
  contact_id: `program-contact-${index + 1}`,
  status: 'active',
  enrolled_at: mockNow,
  contact_name: index === 0 ? 'Álexis Tarillo Mejio' : `Participante Móvil ${index + 1}`,
  contact_phone: `5192300${String(100 + index)}`,
  avatar_url: null,
}))

const mockCoursePlan = {
  id: 'course-1',
  account_id: 'account-responsive',
  name: 'Formación inicial',
  description: 'Plan de clases para nuevos participantes',
  status: 'active',
  position: 0,
  usage_count: 1,
  topic_count: 2,
  active_topic_count: 2,
  topic_preview: ['Bienvenida', 'Principios básicos'],
  created_at: mockNow,
  updated_at: mockNow,
  topics: [
    { id: 'topic-1', account_id: 'account-responsive', course_id: 'course-1', title: 'Bienvenida', description: 'Presentación del grupo', status: 'active', position: 0, usage_count: 1, created_at: mockNow, updated_at: mockNow },
    { id: 'topic-2', account_id: 'account-responsive', course_id: 'course-1', title: 'Principios básicos', description: 'Conceptos fundamentales', status: 'active', position: 1, usage_count: 0, created_at: mockNow, updated_at: mockNow },
  ],
}

const mockSecondCoursePlan = {
  ...mockCoursePlan,
  id: 'course-2',
  name: 'Habilidades prácticas',
  position: 1,
  topics: [
    { ...mockCoursePlan.topics[0], id: 'topic-3', course_id: 'course-2', title: 'Preparación', usage_count: 1 },
    { ...mockCoursePlan.topics[1], id: 'topic-4', course_id: 'course-2', title: 'Práctica guiada' },
  ],
  topic_preview: ['Preparación', 'Práctica guiada'],
}

const mockThirdCoursePlan = {
  ...mockCoursePlan,
  id: 'course-3',
  name: 'Comunicación efectiva',
  description: 'Plan de clases para conversaciones claras y respetuosas',
  position: 2,
  usage_count: 0,
  topics: [
    { ...mockCoursePlan.topics[0], id: 'topic-5', course_id: 'course-3', title: 'Escucha activa', usage_count: 0 },
    { ...mockCoursePlan.topics[1], id: 'topic-6', course_id: 'course-3', title: 'Acuerdos claros' },
  ],
  topic_preview: ['Escucha activa', 'Acuerdos claros'],
}

const mockPreviousSession = {
  id: 'session-previous',
  program_id: 'program-1',
  title: 'Sesión de apertura',
  date: '2026-07-20',
  topic: 'Bienvenida',
  course_topic_id: 'topic-1',
  session_type: 'regular',
  start_time: '09:00',
  end_time: '10:00',
  location: 'Aula QA',
  created_at: '2026-07-20T09:00:00.000Z',
  updated_at: '2026-07-20T09:00:00.000Z',
  topics: [
    { id: 'session-topic-1', session_id: 'session-previous', kind: 'course', course_id: 'course-1', course_topic_id: 'topic-1', course_name: 'Formación inicial', title: 'Bienvenida', position: 0, created_at: mockNow },
    { id: 'session-topic-2', session_id: 'session-previous', kind: 'course', course_id: 'course-2', course_topic_id: 'topic-3', course_name: 'Habilidades prácticas', title: 'Preparación', position: 1, created_at: mockNow },
  ],
  attendance_stats: { absent: 1 },
}

function mockAcademicConfig() {
  return {
    program_id: 'program-1',
    updated_at: mockNow,
    courses: [mockCoursePlan],
    instructors: [{ contact_id: 'instructor-contact-1', contact_name: 'Instructora Responsive', contact_phone: '51988888888', avatar_url: null, avatar_revision: 0, position: 0 }],
  }
}

function mockApiPayload(url: URL, method = 'GET', requestBody?: any) {
  const path = url.pathname
  if (path === '/api/me') {
    return {
      success: true,
      user: {
        id: 'user-responsive', username: 'responsive_qa', display_name: 'Responsive QA',
        is_admin: true, is_super_admin: false, role: 'admin', account_id: 'account-responsive',
        account_name: 'Cuenta Responsive', plan: 'pro', subscription_status: 'active',
        subscription_active: true, permissions: ['chats', 'contacts', 'programs', 'surveys', 'devices', 'broadcasts', 'leads', 'events', 'tasks', 'tags'],
        kommo_enabled: false,
      },
      accounts: [{ account_id: 'account-responsive', account_name: 'Cuenta Responsive', account_slug: 'responsive', role: 'admin', is_default: true }],
    }
  }
  if (path === '/api/dashboard/summary') {
    return {
      success: true,
      dashboard: {
        generated_at: mockNow,
        timezone: 'America/Lima',
        period: { preset: '30d', from: '2026-06-18', to: '2026-07-17', previous_from: '2026-05-19', previous_to: '2026-06-17' },
        sections: { leads: true, chats: true, tasks: true, events: true, devices: true },
        leads: {
          open: 12,
          new: { current: 8, previous: 6, change_percent: 33.3 },
          won: { current: 3, previous: 2, change_percent: 50 },
          conversion: { current_percent: 25, previous_percent: 20, change_points: 5 },
          trend: [
            { date: '2026-06-18', new: 1, won: 0, lost: 0 },
            { date: '2026-07-02', new: 4, won: 1, lost: 1 },
            { date: '2026-07-17', new: 3, won: 2, lost: 0 },
          ],
          pipeline: { id: 'pipeline-1', name: 'Ventas', unassigned_count: 1, stages: [{ id: 'stage-1', name: 'Nuevo', color: '#10b981', count: 5 }] },
        },
        chats: { total: 7, unread_total: 2, awaiting_reply: 1, items: [{ id: 'chat-1', display_name: 'Contacto móvil', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, last_inbound_at: mockNow, unread_count: 2 }] },
        tasks: { overdue: 1, due_today: 2, items: [{ id: 'task-1', title: 'Seguimiento desde móvil', due_at: mockNow, status: 'pending', type: 'follow_up' }] },
        events: { overdue_followups: 1, due_next_7_days: 2, items: [{ participant_id: 'participant-1', event_id: 'event-1', event_name: 'Evento QA', participant_name: 'Persona QA', next_action: 'Llamar', next_action_date: mockNow }] },
        devices: { total: 1, connected: 0, connecting: 0, disconnected: 1, issues: [{ id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'disconnected' }] },
      },
    }
  }
  if (path === '/api/programs/dashboard') {
    return { success: true, dashboard: { attendance_goal_percent: 80, transfer_goal_percent: 70, program_count: 1, active_program_count: 1, participant_count: 8, completed_count: 2, dropped_count: 1, transferred_count: 1, attendance_rate: 88, transfer_rate: 75, groups_below_goal: 0, critical_participants: 0, groups: [] } }
  }
  if (path === '/api/programs/folders') return { success: true, folders: [] }
  if (path === '/api/programs/courses/course-1') {
    if (method === 'DELETE') return { deleted: false, archived: true, course: { ...mockCoursePlan, status: 'archived' } }
    if (method === 'PUT') return { course: { ...mockCoursePlan, ...requestBody, topics: (requestBody?.topics || mockCoursePlan.topics).map((topic: any, index: number) => ({ ...mockCoursePlan.topics[index], ...topic, id: topic.id || `topic-saved-${index + 1}`, account_id: 'account-responsive', course_id: 'course-1', position: index, usage_count: mockCoursePlan.topics[index]?.usage_count || 0, created_at: mockNow, updated_at: mockNow })) } }
    return { course: mockCoursePlan }
  }
  if (path === '/api/programs/courses') {
    if (method === 'POST') return { course: { ...mockCoursePlan, ...requestBody, id: 'course-created', usage_count: 0, topics: (requestBody?.topics || []).map((topic: any, index: number) => ({ ...topic, id: `topic-created-${index + 1}`, account_id: 'account-responsive', course_id: 'course-created', position: index, usage_count: 0, created_at: mockNow, updated_at: mockNow })) } }
    return { courses: [mockCoursePlan], total: 1, page: 1, page_size: 10 }
  }
  if (path === '/api/programs/program-1/academic-config') {
    return mockAcademicConfig()
  }
  if (path === '/api/programs/program-1/courses' || path === '/api/programs/program-1/instructors') return mockAcademicConfig()
  if (path === '/api/survey-templates') {
    return [{
      id: 'survey-template-1', account_id: 'account-responsive', name: 'Satisfacción del programa',
      description: 'Plantilla reutilizable', status: 'active', welcome_title: '', welcome_description: '',
      thank_you_title: '', thank_you_message: '', thank_you_redirect_url: '', branding: {}, revision: 3,
      created_at: mockNow, updated_at: mockNow, question_count: 4, instance_count: 2, response_count: 5,
    }]
  }
  if (path === '/api/programs/program-1/surveys') {
    if (method === 'POST') return {
      id: 'survey-instance-created', account_id: 'account-responsive', template_id: requestBody?.template_id,
      template_revision: 3, program_id: 'program-1', origin_type: 'program', origin_label: 'Programa sin sesiones',
      name: requestBody?.name || 'Satisfacción del programa · Programa sin sesiones', slug: 'satisfaccion-programa-qa',
      status: requestBody?.status || 'active', audience_mode: 'program_participants', legacy_instance: false,
      question_count: 4, recipient_count: 6, response_count: 0, created_at: mockNow, updated_at: mockNow,
    }
    return [{
      id: 'survey-instance-1', account_id: 'account-responsive', template_id: 'survey-template-1',
      template_revision: 2, program_id: 'program-1', origin_type: 'program', origin_label: 'Programa sin sesiones',
      name: 'Encuesta inicial', slug: 'encuesta-inicial-qa', status: 'active', audience_mode: 'program_participants',
      legacy_instance: false, question_count: 4, recipient_count: 6, response_count: 2,
      created_at: mockNow, updated_at: mockNow,
    }]
  }
  if (/^\/api\/programs\/program-1\/surveys\/[^/]+\/recipients$/.test(path)) {
    return {
      recipients: mockProgramParticipants.map((participant, index) => ({
        id: `survey-recipient-${index + 1}`, contact_id: participant.contact_id,
        program_participant_id: participant.id, contact_name: participant.contact_name,
        status: index === 0 ? 'completed' : 'pending', recipient_token: `recipient-token-${index + 1}`,
      })),
      total: mockProgramParticipants.length,
    }
  }
  if (path === '/api/programs/program-1/participants') return mockProgramParticipants
  if (/^\/api\/programs\/program-1\/participants\/program-participant-\d+\/enrollment$/.test(path) && method === 'PATCH') {
    return { success: true, enrolled_at: requestBody?.enrolled_at }
  }
  if (/^\/api\/programs\/program-1\/participants\/program-participant-\d+\/attendance-history$/.test(path)) {
    const participantNumber = Number(path.match(/program-participant-(\d+)/)?.[1] || '1')
    return {
      summary: {
        goal_percent: 80,
        eligible_sessions: participantNumber === 1 ? 4 : 0,
        marked_sessions: participantNumber === 1 ? 3 : 0,
        pending: participantNumber === 1 ? 1 : 0,
        present: participantNumber === 1 ? 1 : 0,
        absent: participantNumber === 1 ? 1 : 0,
        late: participantNumber === 1 ? 1 : 0,
        attendance_rate: participantNumber === 1 ? 66.67 : null,
        punctuality_rate: participantNumber === 1 ? 33.33 : null,
        health: participantNumber === 1 ? 'red' : 'no_data',
      },
      sessions: participantNumber === 1 ? [
        {
          session_id: 'session-history-4', ordinal: 4, title: 'Ética aplicada', date: '2026-07-17', start_time: '18:00', end_time: '19:30', session_type: 'regular', status: null,
          topics: [{ id: 'history-topic-4', kind: 'course', course_name: 'Ética', title: 'Ética aplicada', position: 0 }], observation_count: 0, observation_preview: null,
        },
        {
          session_id: 'session-history-3', ordinal: 3, title: 'Debate y ciudadanía', date: '2026-07-15', start_time: '18:00', end_time: '19:30', session_type: 'regular', status: 'late',
          topics: [{ id: 'history-topic-3', kind: 'course', course_name: 'Sociopolítica', title: 'Ciudadanía', position: 0 }], observation_count: 2,
          observation_preview: { id: 'attendance-history-observation-2', notes: 'Llegó quince minutos tarde por movilidad.', created_by_name: 'Responsive QA', created_at: mockNow, source_label: 'Asistencia' },
        },
        {
          session_id: 'session-history-2', ordinal: 2, title: 'Dharma y Karma', date: '2026-07-12', start_time: '18:00', end_time: '19:30', session_type: 'regular', status: 'absent',
          topics: [{ id: 'history-topic-2', kind: 'course', course_name: 'Ética', title: 'Dharma y Karma', position: 0 }], observation_count: 0, observation_preview: null,
        },
        {
          session_id: 'session-history-1', ordinal: 1, title: 'Ética y Moral', date: '2026-07-10', start_time: '18:00', end_time: '19:30', session_type: 'regular', status: 'present',
          topics: [{ id: 'history-topic-1', kind: 'course', course_name: 'Ética', title: 'Ética y Moral', position: 0 }], observation_count: 1,
          observation_preview: { id: 'attendance-history-observation-1', notes: 'Participó activamente en la sesión.', created_by_name: 'Responsive QA', created_at: mockNow, source_label: 'Asistencia' },
        },
      ] : [],
      historical_sessions: participantNumber === 2 ? [{
        session_id: 'session-history-before-enrollment', ordinal: 1, title: 'Sesión anterior a la incorporación', date: '2026-07-15', start_time: '18:00', end_time: '19:30', session_type: 'regular', status: 'present',
        topics: [{ id: 'history-topic-before', kind: 'free', title: 'Introducción', position: 0 }], observation_count: 0, observation_preview: null, outside_enrollment_period: true,
      }] : [],
      next_cursor: null,
    }
  }
  if (/^\/api\/programs\/program-1\/sessions\/session-history-\d+\/participants\/program-participant-\d+\/attendance-observations$/.test(path)) {
    if (method === 'POST') {
      return {
        success: true,
        observation: {
          id: 'attendance-history-observation-created',
          notes: requestBody?.notes || 'Nueva observación de asistencia',
          created_by_name: 'Responsive QA',
          created_at: mockNow,
          source_label: 'Asistencia',
        },
      }
    }
    return {
      success: true,
      observations: [
        { id: 'attendance-history-observation-2', notes: 'Llegó quince minutos tarde por movilidad.', created_by_name: 'Responsive QA', created_at: mockNow, source_label: 'Asistencia' },
        { id: 'attendance-history-observation-older', notes: 'Avisó previamente que tendría una demora.', created_by_name: 'Responsive QA', created_at: '2026-07-17T12:00:00.000Z', source_label: 'Asistencia' },
      ],
    }
  }
  if (path === '/api/programs/program-1/sessions') {
    if (method === 'POST') return { id: 'session-created', program_id: 'program-1', ...requestBody, created_at: mockNow, updated_at: mockNow }
    return null
  }
  if (path === '/api/programs/program-1/sessions/generate') return { success: true, sessions: [], count: 0, assigned_topic_count: 0, fallback_count: 0 }
  if (path === '/api/programs/program-1/health') {
    return { success: true, health: { program_id: 'program-1', attendance_goal_percent: 80, transfer_goal_percent: 70, participant_count: 6, active_count: 6, completed_count: 0, dropped_count: 0, transferred_count: 0, session_count: 0, recovery_session_count: 0, attendance_rate: 72, transfer_rate: 0, health: 'watch', reasons: ['asistencia bajo meta'], participants: mockProgramParticipants.map((participant, index) => ({ participant_id: participant.id, contact_id: participant.contact_id, name: participant.contact_name, phone: participant.contact_phone, avatar_url: null, status: participant.status, health: index === 0 ? 'watch' : 'healthy', attendance_rate: 70 + index, present: 2, late: 0, absent: 1, excused: 0, recovery_sessions: 0, notes_count: index === 0 ? 1 : 0, reasons: index === 0 ? ['asistencia bajo meta'] : [] })) } }
  }
  if (path === '/api/programs/program-1/goals') return { success: true, goals: { attendance_goal_percent: 80, transfer_goal_percent: 70 } }
  if (path === '/api/programs/program-1') {
    return { id: 'program-1', account_id: 'account-responsive', name: 'Programa sin sesiones', description: '', status: 'active', color: '#10b981', created_by: 'user-responsive', created_at: mockNow, updated_at: mockNow, participant_count: 6, session_count: 0, type: 'course' }
  }
  if (path === '/api/programs') {
    return [{ id: 'program-1', account_id: 'account-responsive', name: 'Programa móvil QA', description: 'Programa visible en tarjetas responsivas', status: 'active', color: '#10b981', created_by: 'user-responsive', created_at: mockNow, updated_at: mockNow, participant_count: 8, session_count: 3, type: 'course' }]
  }
  if (path === '/api/events/pipelines') return { success: true, pipelines: [] }
  if (path === '/api/chats/chat-1') {
    return {
      success: true,
      chat: { id: 'chat-1', jid: '51999999999@s.whatsapp.net', name: 'Contacto móvil', device_id: 'device-1', device_name: 'Canal QA', contact_phone: '51999999999', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, unread_count: 2 },
      contact: { ...mockCanonicalContact, is_group: false },
      device: { id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'connected', provider: 'whatsapp_web' },
      opportunities: [mockLeadSnapshot],
      lead: mockLeadSnapshot,
      active_opportunity_id: mockLeadSnapshot.id,
    }
  }
  if (path === '/api/chats/chat-1/messages') return { success: true, messages: [
    { id: 'message-in-1', account_id: 'account-responsive', device_id: 'device-1', chat_id: 'chat-1', message_id: 'wa-in-1', from_jid: '51999999999@s.whatsapp.net', from_name: 'Contacto móvil', body: 'Mensaje recibido para seleccionar', message_type: 'text', is_from_me: false, is_read: true, status: 'read', timestamp: new Date(Date.now() - 120_000).toISOString(), created_at: new Date(Date.now() - 120_000).toISOString() },
    { id: 'message-out-1', account_id: 'account-responsive', device_id: 'device-1', chat_id: 'chat-1', message_id: 'wa-out-1', from_jid: '51911111111@s.whatsapp.net', from_name: 'Me', body: 'Mensaje enviado para acciones', message_type: 'text', is_from_me: true, is_read: true, status: 'read', delivered_at: new Date(Date.now() - 45_000).toISOString(), read_at: new Date(Date.now() - 20_000).toISOString(), timestamp: new Date(Date.now() - 60_000).toISOString(), created_at: new Date(Date.now() - 60_000).toISOString() },
    { id: 'message-image-1', account_id: 'account-responsive', device_id: 'device-1', chat_id: 'chat-1', message_id: 'wa-image-1', from_jid: '51999999999@s.whatsapp.net', from_name: 'Contacto móvil', body: '', message_type: 'image', media_url: '/api/media/test-image', media_mimetype: 'image/png', is_from_me: false, is_read: true, status: 'read', timestamp: new Date(Date.now() - 30_000).toISOString(), created_at: new Date(Date.now() - 30_000).toISOString() },
  ] }
  if (path.startsWith('/api/chats/resolve-whatsapp/')) {
    const phone = path.split('/').pop() || '5192300100'
    return { success: true, phone, jid: `${phone}@s.whatsapp.net`, chat: null, historical_phone: '', devices: [{ id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'connected', provider: 'whatsapp_web', historical_relation: 'new_chat' }], mode: 'open_direct' }
  }
  if (path === '/api/chats/new') {
    return { success: true, chat: { id: 'chat-1', jid: '51999999999@s.whatsapp.net', name: 'Contacto móvil', device_id: 'device-1', device_name: 'Canal QA', contact_phone: '51999999999', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, unread_count: 0 } }
  }
  if (path === '/api/chats') {
    return { success: true, total: 1, chats: [{ id: 'chat-1', jid: '51999999999@s.whatsapp.net', name: 'Contacto móvil', device_id: 'device-1', device_name: 'Canal QA', contact_phone: '51999999999', last_message: 'Mensaje de prueba responsiva', last_message_at: mockNow, unread_count: 2 }] }
  }
  if (path === '/api/devices') {
    return { success: true, devices: [{ id: 'device-1', name: 'Canal QA', phone: '51999999999', status: 'connected', provider: 'whatsapp_web', receive_messages: true, runtime_capabilities: { can_start_chat: true, can_check_whatsapp: true, can_send_sticker: true, can_send_animated_sticker: true, can_publish_status: true, can_sync_own_status: true } }] }
  }
  if (path === '/api/contacts') {
    return { success: true, total: 1, contacts: [{ id: 'contact-1', jid: '51999999999@s.whatsapp.net', phone: '51999999999', name: 'Contacto móvil', custom_name: 'Contacto móvil', email: 'movil@example.test', tags: [], structured_tags: [], created_at: mockNow, updated_at: mockNow }] }
  }
  if (path === '/api/contact-profiles/contact-1/observations') {
    return {
      success: true,
      total: 1,
      observations: [{ id: 'contact-note-1', contact_id: 'contact-1', lead_id: null, type: 'note', direction: null, outcome: null, notes: 'Observación canónica visible', created_by_name: 'Responsive QA', created_at: mockNow }],
    }
  }
  if (path === '/api/contact-profiles/contact-1/tags') {
    return { success: true, total: 1, tags: [{ id: 'tag-priority', name: 'Prioridad', color: '#f59e0b' }] }
  }
  if (path === '/api/contact-profiles/contact-1') {
    const patch = requestBody && typeof requestBody === 'object' ? requestBody as Record<string, any> : {}
    const contextType = url.searchParams.get('context_type') || 'contact'
    const contextId = url.searchParams.get('context_id') || 'contact-1'
    const selectedTags = Array.isArray(patch.tag_ids)
      ? patch.tag_ids.map((id: string) => id === 'tag-priority'
        ? { id, name: 'Prioridad', color: '#f59e0b' }
        : id === 'tag-created'
          ? { id, name: 'Etiqueta móvil QA', color: '#6366f1' }
          : { id, name: 'Comunidad', color: '#10b981' })
      : mockCanonicalContact.structured_tags
    return {
      success: true,
      contact: {
        ...mockCanonicalContact,
        ...patch,
        structured_tags: selectedTags,
        tags: selectedTags.map((tag: { name: string }) => tag.name),
        extra_phones: Array.isArray(patch.extra_phones)
          ? patch.extra_phones.map((phone: any, index: number) => ({ ...phone, id: phone.id || `phone-extra-${index + 2}`, contact_id: 'contact-1' }))
          : mockCanonicalContact.extra_phones,
        custom_field_values: Array.isArray(patch.custom_field_values)
          ? patch.custom_field_values.map((value: any, index: number) => ({ ...value, id: `custom-value-${index + 1}`, contact_id: 'contact-1', field_name: 'Nivel', field_slug: 'nivel', field_type: 'select' }))
          : mockCanonicalContact.custom_field_values,
        updated_at: mockNow,
      },
      context: { type: contextType, id: contextId },
      capabilities: { can_view: true, can_edit: true, can_manage_avatar: true, can_manage_observations: true, can_create_tags: true },
      observation_count: 1,
      available_tags: [],
      custom_field_definitions: [{
        id: 'custom-field-1', name: 'Nivel', slug: 'nivel', field_type: 'select', is_required: false, position: 0,
        options: [{ label: 'Inicial', value: 'inicial' }, { label: 'Intermedio', value: 'intermedio' }, { label: 'Avanzado', value: 'avanzado' }],
      }],
    }
  }
  if (/^\/api\/contact-profiles\/program-contact-\d+\/observations$/.test(path)) {
    const contactId = path.split('/')[3]
    return { success: true, total: 1, observations: [{ id: 'observation-1', contact_id: contactId, lead_id: null, type: 'note', direction: null, outcome: null, notes: 'Observación móvil existente', created_by_name: 'Responsive QA', created_at: mockNow, program_id: 'program-1', program_participant_id: 'program-participant-1' }] }
  }
  if (/^\/api\/contact-profiles\/program-contact-\d+\/tags$/.test(path)) {
    return { success: true, total: 1, tags: [{ id: 'tag-priority', name: 'Prioridad', color: '#f59e0b' }] }
  }
  if (/^\/api\/contact-profiles\/program-contact-\d+$/.test(path)) {
    const contactNumber = Number(path.split('-').pop() || '1')
    const participant = mockProgramParticipants[contactNumber - 1] || mockProgramParticipants[0]
    return {
      success: true,
      contact: { id: participant.contact_id, account_id: 'account-responsive', jid: `${participant.contact_phone}@s.whatsapp.net`, phone: participant.contact_phone, name: participant.contact_name, custom_name: participant.contact_name, email: `participante${contactNumber}@example.test`, company: 'Clarin QA', distrito: 'Lima', ocupacion: 'Estudiante', notes: 'Nota general del contacto', tags: ['Comunidad'], structured_tags: [{ id: 'tag-program-1', name: 'Comunidad', color: '#6366f1' }], avatar_url: null, created_at: mockNow, updated_at: mockNow, custom_field_values: [], extra_phones: [] },
      capabilities: { can_view: true, can_edit: true, can_manage_avatar: true, can_manage_observations: true, can_create_tags: true },
      observation_count: 1,
    }
  }
  if (/^\/api\/contacts\/program-contact-\d+\/interactions$/.test(path)) {
    return { success: true, interactions: [{ id: 'observation-1', contact_id: path.split('/')[3], lead_id: null, type: 'note', direction: null, outcome: null, notes: 'Observación móvil existente', created_by_name: 'Responsive QA', created_at: mockNow, program_id: 'program-1', program_participant_id: 'program-participant-1' }] }
  }
  if (/^\/api\/contacts\/program-contact-\d+$/.test(path)) {
    const contactNumber = Number(path.split('-').pop() || '1')
    const participant = mockProgramParticipants[contactNumber - 1] || mockProgramParticipants[0]
    return { success: true, contact: { id: participant.contact_id, account_id: 'account-responsive', jid: `${participant.contact_phone}@s.whatsapp.net`, phone: participant.contact_phone, name: participant.contact_name, custom_name: participant.contact_name, email: `participante${contactNumber}@example.test`, company: 'Clarin QA', distrito: 'Lima', ocupacion: 'Estudiante', notes: 'Nota general del contacto', tags: ['Comunidad'], structured_tags: [{ id: 'tag-program-1', name: 'Comunidad', color: '#6366f1' }], avatar_url: null, created_at: mockNow, updated_at: mockNow } }
  }
  if (path === '/api/campaigns') {
    return { success: true, campaigns: [{ id: 'campaign-1', account_id: 'account-responsive', device_id: 'device-1', name: 'Difusión móvil QA', message_template: 'Mensaje responsivo', media_url: null, media_type: null, status: 'draft', scheduled_at: null, started_at: null, completed_at: null, total_recipients: 1, sent_count: 0, failed_count: 0, settings: {}, created_at: mockNow, updated_at: mockNow, device_name: 'Canal QA' }] }
  }
  if (path === '/api/events/folders') return { success: true, folders: [] }
  if (path === '/api/events/event-1/participants/event-participant-1') {
    return { success: true, participant: mockEventParticipant }
  }
  if (path === '/api/events/event-1/participants/paginated') {
    return {
      success: true,
      stages: [],
      unassigned: { total_count: 1, participants: [mockEventParticipant], has_more: false },
      all_tags: [],
    }
  }
  if (path === '/api/events/event-1/participants') {
    return { success: true, participants: [mockEventParticipant], total: 1 }
  }
  if (path === '/api/events/event-1/participants/observations/batch') {
    return { success: true, observations: { 'event-participant-1': [] } }
  }
  if (path === '/api/events/event-1') {
    return {
      success: true,
      event: {
        id: 'event-1', name: 'Evento móvil QA', description: 'Contexto propio del evento',
        event_date: mockNow, location: 'Lima', status: 'active', color: '#10b981',
        total_participants: 1, participant_counts: { confirmed: 1 },
      },
    }
  }
  if (path === '/api/events') {
    return {
      success: true,
      events: [{
        id: 'event-1',
        name: 'Evento móvil QA',
        description: 'Evento visible después del estado de carga',
        event_date: mockNow,
        location: 'Lima',
        status: 'active',
        color: '#10b981',
        folder_id: null,
        created_at: mockNow,
        total_participants: 3,
        participant_counts: { confirmed: 2, invited: 1 },
        stage_counts: {},
        tags: [],
      }],
      total: 1,
      has_more: false,
    }
  }
  if (path === '/api/leads/counts') return { success: true, open: 1, won: 0, lost: 0, archived: 0, blocked: 0, trash: 0 }
  if (path === '/api/leads/paginated') {
    return {
      success: true,
      stages: [{ id: 'stage-1', pipeline_id: 'pipeline-1', name: 'Interesado', color: '#10b981', position: 0, total_count: 1, leads: [mockLeadSnapshot], has_more: false }],
      unassigned: { total_count: 0, leads: [], has_more: false },
      all_tags: [],
      hidden_by_status: 0,
    }
  }
  if (path === '/api/leads/list-paginated') return { success: true, leads: [mockLeadSnapshot], total: 1, has_more: false }
  if (path === '/api/leads/observations/batch') return { success: true, observations: { 'lead-1': [] } }
  if (path === '/api/leads/lead-1') return { success: true, lead: mockLeadSnapshot }
  if (path.startsWith('/api/leads/')) return { success: true, leads: [], total: 0, counts: {} }
  if (path === '/api/leads') return method === 'POST' ? { success: true, lead: mockLeadSnapshot } : { success: true, leads: [mockLeadSnapshot], total: 1, counts: {} }
  if (path === '/api/pipelines') {
    return {
      success: true,
      pipelines: [{
        id: 'pipeline-1', account_id: 'account-responsive', name: 'Ventas QA', is_default: true,
        stages: [{ id: 'stage-1', pipeline_id: 'pipeline-1', name: 'Interesado', color: '#10b981', position: 0, stage_type: 'active', lead_count: 1 }],
      }],
    }
  }
  if (path === '/api/tags') return method === 'POST'
    ? { success: true, tag: { id: 'tag-created', name: requestBody?.name || 'Nueva etiqueta', color: requestBody?.color || '#6366f1' } }
    : { success: true, tags: [] }
  if (path === '/api/custom-fields') return { success: true, definitions: [] }
  if (path === '/api/google/status') return { success: true, connected: false }
  if (path === '/api/eros/status') return { success: true, available: false }
  if (path === '/api/public/security-config') return { success: true, login_enabled: true, login_turnstile_required: false, turnstile_site_key: '' }
  if (path.startsWith('/api/programs')) {
    throw new Error(`Mock faltante para Programas: ${method} ${path}`)
  }
  return { success: true }
}

async function installMockSession(page: Page) {
  await page.routeWebSocket('**/ws**', socket => {
    socket.onMessage(() => undefined)
  })
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/media/test-image') {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAC0lEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNiBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4M3Am4E3A28G3gy8GXgz8GbgzcCbgTcDbwbeDLwZeDPwZuDNwJuBNwNvBt4MvBl4M/Bm4G3gB4x8BfU3pFQAAAABJRU5ErkJggg==', 'base64'),
      })
      return
    }
    let requestBody: unknown
    try { requestBody = route.request().postDataJSON() } catch { requestBody = undefined }
    try {
      const payload = mockApiPayload(new URL(route.request().url()), route.request().method(), requestBody)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
    } catch (error) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: error instanceof Error ? error.message : 'Mock faltante para Programas' }),
      })
    }
  })
  await page.context().addCookies([{ name: 'auth-token', value: 'responsive-ui-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  await page.addInitScript(() => {
    localStorage.setItem('token', 'responsive-ui-session')
    localStorage.setItem('clarin:last_activity_at', String(Date.now()))
  })
}

type GoogleStatusMockMode = 'connected' | 'disconnected' | 'forbidden' | 'error'

async function installGoogleContactSyncMock(page: Page) {
  let statusMode: GoogleStatusMockMode = 'connected'
  let nextMutationFailure: { status: number; error: string } | null = null
  const queuedStatuses: Array<{ mode: GoogleStatusMockMode; delayMs: number }> = []
  const mutations: Array<{ method: string; contactId: string }> = []

  await page.route('**/api/google/status', async route => {
    const queued = queuedStatuses.shift()
    const mode = queued?.mode || statusMode
    if (queued?.delayMs) await new Promise(resolve => setTimeout(resolve, queued.delayMs))
    if (mode === 'forbidden') {
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Sin permiso de integraciones' }) }).catch(() => undefined)
      return
    }
    if (mode === 'error') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Google Contacts no está disponible temporalmente' }) }).catch(() => undefined)
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, connected: mode === 'connected', configured: true, token_valid: true }),
    }).catch(() => undefined)
  })

  await page.route(/\/api\/google\/contacts\/[^/]+\/sync$/, async route => {
    const request = route.request()
    const match = new URL(request.url()).pathname.match(/^\/api\/google\/contacts\/([^/]+)\/sync$/)
    mutations.push({ method: request.method(), contactId: match?.[1] || '' })
    if (nextMutationFailure) {
      const failure = nextMutationFailure
      nextMutationFailure = null
      await route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify({ success: false, error: failure.error }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })

  return {
    mutations,
    setStatusMode(mode: GoogleStatusMockMode) { statusMode = mode },
    queueStatus(mode: GoogleStatusMockMode, delayMs = 0) { queuedStatuses.push({ mode, delayMs }) },
    failNextMutation(status: number, error: string) { nextMutationFailure = { status, error } },
  }
}

async function authenticate(page: Page) {
  if (useMockSession) {
    await installMockSession(page)
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
    // Wait until DashboardLayout finishes /api/me. Navigating away while that
    // request is still pending can make its unmount/abort path race with the
    // next page.goto and spuriously redirect the test to /login.
    await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 })
    return
  }
  await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('input[name="username"], input[type="text"]').first().fill(username || '')
  await page.locator('input[type="password"]').first().fill(password || '')
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })

  if (accountName) {
    const account = page.getByText(accountName, { exact: true }).first()
    if (await account.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await account.click()
      await page.waitForURL(/\/dashboard/, { timeout: 10_000 })
    }
  }
}

async function expectRouteToFit(page: Page, route: string) {
  await page.goto(`${baseURL}${route}`, { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(new RegExp(route.split('?')[0].replaceAll('/', '\\/')))
  await expect(page.locator('body')).toBeVisible()

  await expect.poll(async () => page.evaluate(() => {
    const root = document.documentElement
    return root.scrollWidth - root.clientWidth
  }), {
    message: `${route} no debe desbordar horizontalmente el documento`,
    timeout: 10_000,
  }).toBeLessThanOrEqual(1)

  const appViewport = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      height: Number.parseFloat(styles.getPropertyValue('--app-height')),
      width: Number.parseFloat(styles.getPropertyValue('--app-width')),
      visualHeight: window.visualViewport?.height || window.innerHeight,
      visualWidth: window.visualViewport?.width || window.innerWidth,
    }
  })
  expect(appViewport.height).toBeGreaterThan(0)
  expect(appViewport.width).toBeGreaterThan(0)
  expect(appViewport.height).toBeLessThanOrEqual(appViewport.visualHeight + 1)
  expect(appViewport.width).toBeLessThanOrEqual(appViewport.visualWidth + 1)
}

async function expectInsideVisualViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const viewport = await page.evaluate(() => ({
    left: window.visualViewport?.offsetLeft || 0,
    top: window.visualViewport?.offsetTop || 0,
    width: window.visualViewport?.width || window.innerWidth,
    height: window.visualViewport?.height || window.innerHeight,
  }))
  expect(box!.x).toBeGreaterThanOrEqual(viewport.left - 1)
  expect(box!.y).toBeGreaterThanOrEqual(viewport.top - 1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.left + viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.top + viewport.height + 1)
}

function waitForCanonicalProfileRequest(page: Page, contextType: string, contextId: string) {
  return page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/contact-profiles/contact-1'
      && request.method() === 'GET'
      && url.searchParams.get('context_type') === contextType
      && url.searchParams.get('context_id') === contextId
  })
}

async function expectCanonicalContactDetails(page: Page) {
  await expect(page.getByText('Contacto móvil', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('movil@example.test', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Iquitos', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Ficha canónica compartida', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Observación canónica visible', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Ver historial' }).last().click()
  await expect(page.getByText('Observación canónica visible', { exact: true }).last()).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
}

async function setMockKeyboardInset(page: Page, inset: number) {
  await page.evaluate((nextInset) => {
    const viewport = window.visualViewport
    if (!viewport) throw new Error('visualViewport no está disponible para simular el teclado')
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      value: Math.max(160, window.innerHeight - nextInset),
    })
    viewport.dispatchEvent(new Event('resize'))
  }, inset)
}

async function selectAllEditableText(locator: Locator, text: string) {
  await locator.fill(text)
  await expect(locator).toHaveText(text)
  await locator.evaluate(element => {
    const selection = window.getSelection()
    if (!selection) throw new Error('No se pudo crear una selección de texto')
    const range = document.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

async function expectToolbarOutsideEditor(page: Page, toolbar: Locator, editor: Locator) {
  await expectInsideVisualViewport(page, toolbar)
  const toolbarBox = await toolbar.boundingBox()
  const editorBox = await editor.boundingBox()
  expect(toolbarBox).not.toBeNull()
  expect(editorBox).not.toBeNull()
  const horizontalOverlap = toolbarBox!.x < editorBox!.x + editorBox!.width
    && toolbarBox!.x + toolbarBox!.width > editorBox!.x
  const verticalOverlap = toolbarBox!.y < editorBox!.y + editorBox!.height
    && toolbarBox!.y + toolbarBox!.height > editorBox!.y
  expect(horizontalOverlap && verticalOverlap).toBe(false)
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(editorBox!.y - 4)
}

test.describe('Clarin responsive authenticated matrix', () => {
  test.skip(!useMockSession && (!username || !password), 'Define credenciales E2E o CLARIN_E2E_MOCK_AUTH=1 para ejecutar la matriz')
  test.describe.configure({ mode: 'serial' })

  for (const viewport of priorityMatrix) {
    test(`${viewport.name}: Inicio, Chats y Programas caben en el viewport`, async ({ page }, testInfo) => {
      test.setTimeout(90_000)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await authenticate(page)
      for (const route of priorityRoutes) {
        await expectRouteToFit(page, route)
        if (captureVisuals && (viewport.name === 'phone-375-tall' || viewport.name === 'desktop')) {
          const routeName = route === '/dashboard' ? 'inicio' : route.split('/').pop() || 'page'
          await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${routeName}.png`), fullPage: false })
        }
      }
    })
  }

  test('módulos secundarios caben en un teléfono de 375 px', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    for (const route of secondaryRoutes) await expectRouteToFit(page, route)
  })

  test('Eventos mide el contenedor que aparece después de cargar y activa sus tarjetas móviles', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/events`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByText('Evento móvil QA')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Acciones de Evento móvil QA' })).toBeVisible()
    await expect(page.locator('table')).toHaveCount(0)
  })

  test('Dispositivos conserva la vinculación por QR en una laptop táctil amplia', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1024, height: 768 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/settings?tab=devices`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Agregar', exact: true }).click()

    const nameInput = page.getByPlaceholder('Nombre del canal')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('Canal laptop táctil')
    await expect(page.getByRole('button', { name: 'Crear y Conectar' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Requiere computadora' })).toHaveCount(0)
  })

  test('login y navegación móvil mantienen controles alcanzables', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await expectRouteToFit(page, '/dashboard')

    const openMenu = page.getByRole('button', { name: 'Abrir menú' })
    await expect(openMenu).toBeVisible()
    await openMenu.click()
    await expect(page.getByRole('button', { name: 'Cerrar menú' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Chats mantiene Nueva conversación dentro del viewport en horizontal', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 568, height: 320 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Nuevo chat' }).click()
    const dialog = page.getByRole('dialog', { name: 'Nueva conversación' })
    await expectInsideVisualViewport(page, dialog)
    const close = page.getByRole('button', { name: /Cerrar nueva conversación|Espera a que termine/ })
    const closeBox = await close.boundingBox()
    expect(closeBox?.width).toBeGreaterThanOrEqual(40)
    expect(closeBox?.height).toBeGreaterThanOrEqual(40)
  })

  test('Chats reemplaza el popup por una bandeja móvil dentro del viewport', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 213, height: 378 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    await page.getByRole('button', { name: 'Adjuntar archivo' }).click()
    await page.getByRole('menuitem', { name: 'Emoji' }).click()
    const accessory = page.getByTestId('mobile-composer-accessory')
    await expectInsideVisualViewport(page, accessory)
    await expect(page.getByRole('region', { name: 'Selector de emojis' })).toBeVisible()
    await expect(page.getByTestId('dashboard-mobile-header')).toBeHidden()
    await page.goBack()
    await expect(accessory).toHaveCount(0)
  })

  test('Chats intercambia teclado, emojis y stickers sin recuperar el foco indebidamente', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await composer.click()
    await setMockKeyboardInset(page, 280)
    await page.getByRole('button', { name: 'Abrir selector de emojis' }).click()

    const accessory = page.getByTestId('mobile-composer-accessory')
    await expect(accessory).toBeVisible()
    await expect(page.getByTestId('dashboard-mobile-header')).toBeHidden()
    await expect.poll(() => composer.evaluate(element => document.activeElement === element)).toBe(false)

    await setMockKeyboardInset(page, 0)
    await expect(page.getByRole('region', { name: 'Selector de emojis' })).toBeVisible()
    await page.getByRole('tab', { name: 'Stickers' }).click()
    await expect(page.getByRole('region', { name: 'Selector de stickers' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Recientes' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Favoritos' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Crear' })).toBeVisible()

    await page.getByRole('button', { name: 'Mostrar teclado' }).click()
    await expect(accessory).toHaveCount(0)
    await expect.poll(() => composer.evaluate(element => document.activeElement === element)).toBe(true)
  })

  test('El visor móvil captura pinch sobre la foto sin deshabilitar el zoom del documento', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const chatImage = page.getByRole('img', { name: 'Imagen' })
    await expect(chatImage).toBeVisible()
    await expect(chatImage).toHaveAttribute('loading', 'lazy')
    await expect(chatImage).toHaveAttribute('decoding', 'async')
    await chatImage.click()

    const viewer = page.getByRole('dialog', { name: 'Visor de imagen' })
    const surface = page.getByTestId('image-viewer-surface')
    await expectInsideVisualViewport(page, viewer)
    await expect(surface).toHaveCSS('touch-action', 'none')
    const initialDocumentScale = await page.evaluate(() => window.visualViewport?.scale || 1)
    const box = await surface.boundingBox()
    expect(box).not.toBeNull()
    const centerX = box!.x + box!.width / 2
    const centerY = box!.y + box!.height / 2

    await surface.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: centerX - 30, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: centerX + 30, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: centerX - 70, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: centerX + 70, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: centerX - 70, clientY: centerY, button: 0 })
    await surface.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch', clientX: centerX + 70, clientY: centerY, button: 0 })

    await expect.poll(async () => Number.parseInt((await page.getByTestId('image-viewer-scale').textContent()) || '0', 10)).toBeGreaterThan(100)
    expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBe(initialDocumentScale)
    await page.getByRole('button', { name: 'Cerrar visor' }).click()
    await expect(viewer).toHaveCount(0)
  })

  test('Chats cede la cabecera global al teclado solo en teléfono y conserva la conversación', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const dashboardHeader = page.getByTestId('dashboard-mobile-header')
    const conversationHeader = page.getByRole('button', { name: 'Ver detalles de la conversación' })
    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await expect(dashboardHeader).toBeVisible()
    await expect(conversationHeader).toBeVisible()

    await composer.click()
    await setMockKeyboardInset(page, 280)
    await expect(dashboardHeader).toBeHidden()
    await expect(conversationHeader).toBeVisible()

    await setMockKeyboardInset(page, 0)
    await expect(dashboardHeader).toBeVisible()
    await expect(conversationHeader).toBeVisible()

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    await page.getByRole('textbox', { name: 'Escribe un mensaje…' }).click()
    await setMockKeyboardInset(page, 320)
    await expect(page.getByTestId('dashboard-mobile-header')).toBeVisible()
  })

  test('Chats móvil selecciona por pulsación larga y adapta las acciones y el compositor', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    await expect(page.getByText('Mensaje enviado para acciones', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Más acciones del mensaje' })).toHaveCount(0)

    const selectedMessage = page.locator('[data-whatsapp-message-id="wa-out-1"] [role="group"]')
    await selectedMessage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await page.waitForTimeout(550)
    await selectedMessage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })

    await expect(page.getByTestId('message-selection-header')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Responder mensaje' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reenviar mensaje' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Eliminar mensaje para todos' })).toBeVisible()

    await page.getByRole('button', { name: 'Reenviar mensaje' }).click()
    const forwardDialog = page.getByRole('dialog', { name: 'Reenviar mensaje' })
    await expectInsideVisualViewport(page, forwardDialog)
    await expect(forwardDialog.getByPlaceholder('Buscar por nombre, teléfono...')).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar reenvío' }).click()

    await selectedMessage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await page.waitForTimeout(550)
    await selectedMessage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await expect(page.getByTestId('message-selection-header')).toBeVisible()

    await page.getByRole('button', { name: 'Más acciones del mensaje' }).click()
    await page.getByRole('menuitem', { name: 'Información del mensaje' }).click()
    const infoDialog = page.getByRole('dialog', { name: 'Información del mensaje' })
    await expectInsideVisualViewport(page, infoDialog)
    await expect(infoDialog.getByText('Entregado')).toBeVisible()
    await expect(infoDialog.getByText('Leído')).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar información del mensaje' }).click()

    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await expect(page.getByRole('button', { name: 'Abrir selector de emojis' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Adjuntar archivo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Tomar una foto' })).toBeVisible()
    await composer.fill('Hola desde móvil')
    await expect(page.getByRole('button', { name: 'Tomar una foto' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Enviar mensaje' })).toBeVisible()

    await composer.fill('')
    await selectedMessage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await page.waitForTimeout(550)
    await selectedMessage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 180, clientY: 420, button: 0 })
    await expect(page.getByTestId('message-selection-header')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('message-selection-header')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ver detalles de la conversación' })).toBeVisible()
  })

  test('Chats escritorio conserva sus acciones por mensaje y el compositor amplio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    await expect(page.getByText('Mensaje enviado para acciones', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Más acciones del mensaje' })).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Adjuntar archivo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir selector de emojis' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Tomar una foto' })).toHaveCount(0)
    await expect(page.getByTestId('message-selection-header')).toHaveCount(0)
  })

  test('Chats muestra el formato fuera del texto en mensaje y pie de adjunto', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()

    const composer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await composer.click()
    await setMockKeyboardInset(page, 220)
    await selectAllEditableText(composer, 'Mensaje para dar formato')

    const toolbar = page.getByRole('toolbar', { name: 'Formato de texto' })
    await expectToolbarOutsideEditor(page, toolbar, composer)
    await page.getByRole('button', { name: 'Negrita, Ctrl+B' }).click()
    await expect(toolbar).toBeHidden()
    await expect.poll(() => composer.evaluate(element => element.innerHTML)).toContain('<strong>Mensaje para dar formato</strong>')

    await page.locator('input[type="file"]').nth(1).setInputFiles({
      name: 'prueba.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('archivo de prueba'),
    })
    const caption = page.getByRole('textbox', { name: 'Agregar descripción...' })
    await expect(caption).toBeVisible()
    await selectAllEditableText(caption, 'Descripción del archivo')
    await expectToolbarOutsideEditor(page, toolbar, caption)
    await page.keyboard.press('Escape')
    await expect(toolbar).toBeHidden()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    const desktopComposer = page.getByRole('textbox', { name: 'Escribe un mensaje…' })
    await selectAllEditableText(desktopComposer, 'Formato en escritorio')
    await expectToolbarOutsideEditor(page, toolbar, desktopComposer)
  })

  test('Programas móvil permite crear grupos y conserva la operación ampliada en escritorio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs`, { waitUntil: 'domcontentloaded' })
    const mobileCreateButton = page.getByRole('button', { name: 'Nuevo', exact: true })
    await expect(mobileCreateButton).toBeVisible()
    await expect(page.getByText('Salud general', { exact: true })).toHaveCount(0)
    await expect(page.getByTitle('Cuadrícula')).toHaveCount(0)
    await expect(page.getByText('Programa móvil QA', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Administrar cursos' })).toBeVisible()
    await mobileCreateButton.click()
    const createProgramDialog = page.getByRole('dialog', { name: 'Nuevo grupo de clases' })
    await expectInsideVisualViewport(page, createProgramDialog)
    await expect(createProgramDialog.getByText('Programa educativo', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await createProgramDialog.getByRole('button', { name: 'Cerrar nuevo programa' }).click()
    await expect(createProgramDialog).toBeHidden()

    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByRole('button', { name: 'Nuevo grupo' })).toBeVisible()
    await expect(page.getByText('Salud general', { exact: true })).toBeVisible()
    await expect(page.getByTitle('Cuadrícula')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Administrar cursos' })).toBeVisible()
  })

  test('Chats móvil mueve los filtros secundarios a una superficie completa', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Nuevo chat' })).toBeVisible()
    await expect(page.getByText('No leídos', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /Abrir filtros de chats/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Filtros de chats' })
    await expectInsideVisualViewport(page, dialog)
    await expect(page.getByRole('button', { name: 'Solo no leídos' })).toBeVisible()
  })

  test('Contactos móvil integra el orden en filtros y usa acciones a pantalla completa', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/contacts`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#contacts-mobile-sort')).toHaveCount(0)

    await page.getByRole('button', { name: /Abrir filtros y orden/ }).click()
    await expect(page.locator('#contacts-mobile-sort')).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar filtros y orden' }).click()

    await page.getByTitle('Más acciones').click()
    const actions = page.getByRole('dialog', { name: 'Más acciones de contactos' })
    await expectInsideVisualViewport(page, actions)
    const box = await actions.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(790)
    await expect(page.getByText('Herramientas', { exact: true })).toBeVisible()
  })

  test('La ficha canónica permite editar todos los datos del contacto sin desbordar un teléfono de 320 px', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/contacts`, { waitUntil: 'domcontentloaded' })

    await page.getByText('Contacto móvil', { exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Detalles' })).toBeVisible()
    await expect(page.getByText('movil@example.test', { exact: true })).toBeVisible()
    await expect(page.getByText('Iquitos', { exact: true })).toBeVisible()
    await expect(page.getByText('Ficha canónica compartida', { exact: true })).toBeVisible()
    await expect(page.getByText('Observación canónica visible', { exact: true })).toHaveCount(0)
    await expect(page.getByText('1 registro', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Ver historial' }).click()
    await expect(page.getByText('Observación canónica visible', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Editar contacto' }).first().click()
    await expect(page.getByRole('heading', { name: 'Editar contacto' }).first()).toBeVisible()
    await page.getByLabel('Correo').fill('canonica@example.test')
    await page.getByRole('button', { name: 'Añadir teléfono' }).click()
    await page.getByRole('textbox', { name: 'Teléfono adicional 2', exact: true }).fill('51922222222')
    await page.getByRole('textbox', { name: 'Etiqueta del teléfono 2', exact: true }).fill('Emergencia')
    const tagSearch = page.getByRole('combobox', { name: 'Buscar o crear etiqueta' })
    await tagSearch.fill('Prioridad')
    await page.waitForTimeout(550)
    await page.getByRole('option', { name: 'Prioridad' }).click()
    const createTagRequest = page.waitForRequest(request => request.url().endsWith('/api/tags') && request.method() === 'POST')
    await tagSearch.fill('Etiqueta móvil QA')
    await page.waitForTimeout(550)
    await page.getByRole('button', { name: 'Crear “Etiqueta móvil QA”' }).click()
    expect((await createTagRequest).postDataJSON()).toMatchObject({ name: 'Etiqueta móvil QA' })
    await page.getByLabel('Nivel').selectOption('avanzado')

    const save = page.getByRole('button', { name: 'Guardar contacto' })
    await expect(save).toBeVisible()
    await expect(save).toBeEnabled()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const patchRequest = page.waitForRequest(request => request.url().includes('/api/contact-profiles/contact-1?') && request.method() === 'PATCH')
    await save.click()
    const body = (await patchRequest).postDataJSON()
    expect(body.email).toBe('canonica@example.test')
    expect(body.tag_ids).toEqual(['tag-community', 'tag-priority', 'tag-created'])
    expect(body.extra_phones).toEqual([
      { id: 'phone-extra-1', phone: '51911111111', label: 'Trabajo' },
      { phone: '51922222222', label: 'Emergencia' },
    ])
    expect(body.custom_field_values).toContainEqual({ field_id: 'custom-field-1', value_text: 'avanzado' })
    await expect(page.getByText('canonica@example.test', { exact: true })).toBeVisible()
    await expect(page.getByText('Prioridad', { exact: true }).last()).toBeVisible()

    await page.getByRole('button', { name: 'Editar contacto' }).first().click()
    await page.getByLabel('Nombre visible').fill('Cambio sin guardar')
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('cambios del contacto sin guardar')
      await dialog.accept()
    })
    await page.getByRole('button', { name: 'Cerrar detalles' }).click()
    await expect(page.getByRole('heading', { name: 'Detalles' })).toHaveCount(0)
  })

  test('Leads móvil abre la ficha canónica y mantiene separado el contexto comercial', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/leads`, { waitUntil: 'domcontentloaded' })

    const snapshotLead = page.getByText('Snapshot de lead desactualizado', { exact: true }).first()
    await expect(snapshotLead).toBeVisible({ timeout: 30_000 })
    const profileRequest = waitForCanonicalProfileRequest(page, 'lead', 'lead-1')
    await snapshotLead.click()
    await profileRequest

    await expect(page.getByRole('heading', { name: 'Detalles' })).toBeVisible()
    await expectCanonicalContactDetails(page)
    await expect(page.getByText('Concepto del lead', { exact: true })).toBeVisible()
    await expect(page.getByText('Matrícula del programa QA', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('snapshot-lead@example.test', { exact: true })).toHaveCount(0)
  })

  test('Chats móvil usa la ficha canónica sin perder dispositivo ni oportunidad', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 465, height: 818 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    const profileRequest = waitForCanonicalProfileRequest(page, 'chat', 'chat-1')
    await page.getByRole('button', { name: 'Ver detalles de la conversación' }).click()
    await profileRequest

    await expect(page.getByRole('heading', { name: 'Detalles' })).toBeVisible()
    await expectCanonicalContactDetails(page)
    await expect(page.getByText('Contexto comercial', { exact: true })).toBeVisible()
    await expect(page.getByText('Canal QA', { exact: true }).last()).toBeVisible()
    await expect(page.getByText('Matrícula del programa QA', { exact: true }).first()).toBeVisible()
  })

  test('Eventos móvil muestra el Contact canónico y conserva la participación contextual', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 465, height: 818 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/events/event-1`, { waitUntil: 'domcontentloaded' })

    const snapshotParticipant = page.getByText('Snapshot de evento desactualizado', { exact: true }).first()
    await expect(snapshotParticipant).toBeVisible({ timeout: 30_000 })
    const profileRequest = waitForCanonicalProfileRequest(page, 'event_participant', 'event-participant-1')
    await snapshotParticipant.click()
    await profileRequest

    const detail = page.getByRole('dialog', { name: 'Detalle del participante' })
    await expectInsideVisualViewport(page, detail)
    await expectCanonicalContactDetails(page)
    await expect(detail.getByText('Participación en el evento', { exact: true })).toBeVisible()
    await expect(detail.getByText('Participante activo', { exact: true })).toBeVisible()
    await expect(detail.getByText('Oportunidades del contacto', { exact: true })).toBeVisible()
    await expect(detail.getByText('snapshot-evento@example.test', { exact: true })).toHaveCount(0)
    await expect.poll(() => detail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Google Sync permanece visible en la ficha canónica de los cinco módulos, móvil y escritorio', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await installGoogleContactSyncMock(page)

    const expectSyncAction = async () => {
      await expect(page.getByRole('region', { name: 'Google Contacts' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' })).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    }

    await page.goto(`${baseURL}/dashboard/contacts`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Contacto móvil', { exact: true }).first().click()
    await expectSyncAction()

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`${baseURL}/dashboard/leads`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Snapshot de lead desactualizado', { exact: true }).first().click()
    await expectSyncAction()

    await page.setViewportSize({ width: 465, height: 818 })
    await page.goto(`${baseURL}/dashboard/chats`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Conversación con Contacto móvil' }).click()
    await page.getByRole('button', { name: 'Ver detalles de la conversación' }).click()
    await expectSyncAction()

    await page.goto(`${baseURL}/dashboard/events/event-1`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Snapshot de evento desactualizado', { exact: true }).first().click()
    await expectSyncAction()

    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /Álexis Tarillo Mejio.*5192300100.*Activo/ }).click()
    await expectSyncAction()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/contacts`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Contacto móvil', { exact: true }).first().click()
    await expectSyncAction()
  })

  test('Google Sync ejecuta POST y DELETE, recupera errores y respeta un 403 sin alertas', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    const google = await installGoogleContactSyncMock(page)
    await page.goto(`${baseURL}/dashboard/contacts`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Contacto móvil', { exact: true }).first().click()

    const postRequest = page.waitForRequest(request => request.url().endsWith('/api/google/contacts/contact-1/sync') && request.method() === 'POST')
    await page.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' }).click()
    await postRequest
    await expect(page.getByText('Sincronización iniciada. Google Contacts se actualizará en segundo plano.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Actualizar contacto en Google Contacts' })).toBeVisible()

    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Quitar este contacto de Google Contacts')
      await dialog.accept()
    })
    const deleteRequest = page.waitForRequest(request => request.url().endsWith('/api/google/contacts/contact-1/sync') && request.method() === 'DELETE')
    await page.getByRole('button', { name: 'Quitar contacto de Google Contacts' }).click()
    await deleteRequest
    await expect(page.getByText('El contacto se quitó de Google Contacts.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' })).toBeVisible()

    google.failNextMutation(500, 'Fallo controlado al sincronizar')
    await page.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' }).click()
    await expect(page.getByText('Fallo controlado al sincronizar', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' }).click()
    await expect(page.getByRole('button', { name: 'Actualizar contacto en Google Contacts' })).toBeVisible()

    await page.getByRole('button', { name: 'Cerrar detalles' }).click()
    google.setStatusMode('error')
    await page.getByText('Contacto móvil', { exact: true }).first().click()
    await expect(page.getByText('Google Contacts no está disponible temporalmente', { exact: true })).toBeVisible()
    google.setStatusMode('connected')
    await page.getByRole('button', { name: 'Reintentar Google Contacts' }).click()
    await expect(page.getByRole('region', { name: 'Google Contacts' })).toBeVisible()

    await page.getByRole('button', { name: 'Cerrar detalles' }).click()
    google.setStatusMode('forbidden')
    const forbiddenResponse = page.waitForResponse(response => response.url().endsWith('/api/google/status') && response.status() === 403)
    await page.getByText('Contacto móvil', { exact: true }).first().click()
    await forbiddenResponse
    await expect(page.getByRole('region', { name: 'Google Contacts' })).toHaveCount(0)
    await expect(page.getByText('Sin permiso de integraciones', { exact: true })).toHaveCount(0)
    expect(google.mutations).toEqual([
      { method: 'POST', contactId: 'contact-1' },
      { method: 'DELETE', contactId: 'contact-1' },
      { method: 'POST', contactId: 'contact-1' },
      { method: 'POST', contactId: 'contact-1' },
    ])
  })

  test('Google Sync descarta una respuesta tardía al cambiar rápidamente de participante', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    const google = await installGoogleContactSyncMock(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    google.queueStatus('error', 350)
    google.queueStatus('connected')
    await page.getByRole('button', { name: /Álexis Tarillo Mejio.*5192300100.*Activo/ }).click()
    await expect(page.getByRole('status', { name: 'Consultando Google Contacts' })).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar detalles' }).click()
    await page.getByRole('button', { name: /Participante Móvil 2.*Activo/ }).click()
    await expect(page.locator('#canonical-contact-name')).toHaveText('Participante Móvil 2')
    await expect(page.getByRole('region', { name: 'Google Contacts' })).toBeVisible()
    await page.waitForTimeout(450)
    await expect(page.getByText('Google Contacts no está disponible temporalmente', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sincronizar contacto con Google Contacts' })).toBeVisible()
  })

  test('Programas interpreta una respuesta null de sesiones como lista vacía', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTitle('Editar programa')).toHaveCount(0)
    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Sesiones 0 registradas/ }).click()
    await expect(page.getByRole('button', { name: /Cambiar sección\. Actual: Sesiones/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Sin sesiones programadas' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Nueva Sesión' })).toBeVisible()
    await expect(page.getByText('No se pudieron cargar las sesiones.', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Nueva Sesión' }).click()
    const createDialog = page.getByRole('dialog', { name: 'Nueva Sesión' })
    await expectInsideVisualViewport(page, createDialog)
    await expect(createDialog.getByText('Continuación sugerida', { exact: true })).toBeVisible()
    await expect(createDialog.getByText('Bienvenida', { exact: true }).first()).toBeVisible()
    await expect(createDialog.getByRole('button', { name: 'Tema libre' })).toBeVisible()
    await createDialog.getByRole('button', { name: /Bienvenida.*Formación inicial/ }).click()
    const sessionRequest = page.waitForRequest(request => request.url().endsWith('/api/programs/program-1/sessions') && request.method() === 'POST')
    await createDialog.getByRole('button', { name: 'Crear Sesión' }).click()
    const submitted = await sessionRequest
    expect(submitted.postDataJSON()).toMatchObject({
      topics: [{ kind: 'course', course_topic_id: 'topic-1', title: 'Bienvenida' }],
    })
  })

  test('Programas interpreta participantes null como una lista vacía', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.route('**/api/programs/program-1/participants', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: 'null',
    }))
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('No se pudieron cargar los participantes.', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('0 participantes')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Agregar participantes' }).first()).toBeVisible()
  })

  test('Sesiones permite un tema por cada plan y sugiere la continuidad anterior', async ({ page }) => {
    await page.setViewportSize({ width: 465, height: 818 })
    await authenticate(page)
    await page.route('**/api/programs/program-1/academic-config', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...mockAcademicConfig(), courses: [mockCoursePlan, mockSecondCoursePlan] }),
    }))
    await page.route('**/api/programs/program-1/sessions', async route => {
      const request = route.request()
      let body = [mockPreviousSession]
      if (request.method() === 'POST') body = [{ ...mockPreviousSession, id: 'session-created', ...request.postDataJSON() }]
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Sesiones 1 registradas/ }).click()
    await expect(page.getByRole('heading', { name: 'Sesión de apertura' })).toBeVisible()
    await expect(page.getByText('Formación inicial · Bienvenida', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Nueva Sesión' }).click()
    const dialog = page.getByRole('dialog', { name: 'Nueva Sesión' })
    const sessionName = dialog.getByRole('textbox', { name: 'Nombre de la sesión' })
    await expect(sessionName).toHaveValue('Sesión 2')
    await expect(dialog.getByText('Continuación sugerida', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Principios básicos.*Formación inicial/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Práctica guiada.*Habilidades prácticas/ })).toBeVisible()
    await expect(dialog.getByLabel('Temas seleccionados')).toHaveCount(0)

    await dialog.getByRole('button', { name: /Principios básicos.*Formación inicial/ }).click()
    await expect(sessionName).toHaveValue('Principios básicos')
    await sessionName.fill('Sesión estratégica del grupo')
    await dialog.getByRole('button', { name: /Práctica guiada.*Habilidades prácticas/ }).click()
    await expect(dialog.getByLabel('Temas seleccionados')).toContainText('Formación inicial · Principios básicos')
    await expect(dialog.getByLabel('Temas seleccionados')).toContainText('Habilidades prácticas · Práctica guiada')

    await dialog.getByRole('button', { name: /Bienvenida/ }).last().click()
    await expect(sessionName).toHaveValue('Sesión estratégica del grupo')
    await expect(dialog.getByLabel('Temas seleccionados')).toContainText('Formación inicial · Bienvenida')
    await expect(dialog.getByLabel('Temas seleccionados')).not.toContainText('Principios básicos')
    const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/programs/program-1/sessions') && request.method() === 'POST')
    await dialog.getByRole('button', { name: 'Crear Sesión' }).click()
    const requestBody = (await requestPromise).postDataJSON()
    expect(requestBody.title).toBe('Sesión estratégica del grupo')
    expect(requestBody.topics).toEqual([
      { kind: 'course', course_topic_id: 'topic-4', title: 'Práctica guiada' },
      { kind: 'course', course_topic_id: 'topic-1', title: 'Bienvenida' },
    ])
  })

  test('Asistencia móvil usa P F T, conserva observaciones y guarda desde la barra inferior', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    const attendanceObservations = [
      { id: 'attendance-observation-2', notes: 'Llegó con una incidencia informada', created_by_name: 'Responsive QA', created_at: mockNow, source_label: 'Programa sin sesiones · Sesión de apertura · 20/07/2026' },
      { id: 'attendance-observation-1', notes: 'Primera observación', created_by_name: 'Responsive QA', created_at: '2026-07-16T12:00:00.000Z', source_label: 'Programa sin sesiones · Sesión de apertura · 20/07/2026' },
    ]
    const addedAttendanceObservationBodies: Array<Record<string, unknown>> = []
    await page.route('**/api/programs/program-1/sessions', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([mockPreviousSession]),
    }))
    await page.route('**/api/programs/program-1/sessions/session-previous/attendance', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'attendance-1',
        session_id: 'session-previous',
        participant_id: 'program-participant-1',
        status: 'absent',
        notes: 'Primera observación',
        observation_count: 2,
        observation_preview: [{ id: 'attendance-observation-2', notes: 'Llegó con una incidencia informada', created_by_name: 'Responsive QA', created_at: mockNow, source_label: 'Programa sin sesiones · Sesión de apertura · 20/07/2026' }],
        created_at: mockNow,
        updated_at: mockNow,
      }]),
    }))
    await page.route('**/api/programs/program-1/sessions/session-previous/participants/program-participant-1/attendance-observations', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>
        addedAttendanceObservationBodies.push(body)
        const observation = { id: `attendance-observation-created-${addedAttendanceObservationBodies.length}`, notes: body.notes, created_by_name: 'Responsive QA', created_at: mockNow, source_label: 'Programa sin sesiones · Sesión de apertura · 20/07/2026' }
        attendanceObservations.unshift(observation as typeof attendanceObservations[number])
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, observation }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, observations: attendanceObservations }) })
    })
    await page.route('**/api/programs/program-1/sessions/session-previous/attendance/batch', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, count: 1 }),
    }))
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Sesiones 1 registradas/ }).click()
    await page.getByRole('button', { name: 'Asistencia', exact: true }).click()
    const attendanceDialog = page.getByRole('dialog', { name: 'Tomar asistencia' })
    await expectInsideVisualViewport(page, attendanceDialog)
    await expect(attendanceDialog.getByRole('button', { name: 'Presente: Álexis Tarillo Mejio' })).toBeVisible()
    await expect(attendanceDialog.getByRole('button', { name: 'Falta: Álexis Tarillo Mejio' })).toBeVisible()
    await expect(attendanceDialog.getByRole('button', { name: 'Tarde: Álexis Tarillo Mejio' })).toBeVisible()
    await expect(attendanceDialog.getByRole('button', { name: /Justificada/ })).toHaveCount(0)
    await expect(attendanceDialog.getByText('Llegó con una incidencia informada').first()).toBeVisible()
    await expect(attendanceDialog.getByRole('button', { name: 'Añadir observación' })).toHaveCount(0)
    await expect(attendanceDialog.getByRole('button', { name: /Ver todas/ })).toHaveCount(0)
    const observationsAccess = attendanceDialog.getByRole('button', { name: 'Abrir observaciones de asistencia de Álexis Tarillo Mejio' })
    await expect(observationsAccess).toBeVisible()

    await observationsAccess.click()
    await expect(page.getByRole('heading', { name: 'Observaciones de asistencia' })).toBeVisible()
    await expect(page.getByText('Primera observación', { exact: true })).toBeVisible()
    await expect(page.getByText('Programa sin sesiones · Sesión de apertura · 20/07/2026').first()).toBeVisible()
    await expect(page.getByPlaceholder(/Escribir observación de asistencia/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Nueva observación' }).click()
    const attendanceObservationInput = page.getByPlaceholder(/Escribir observación de asistencia/)
    await expect(attendanceObservationInput).toBeVisible()
    await attendanceObservationInput.fill('Primera alta consecutiva')
    await page.getByRole('button', { name: 'Agregar', exact: true }).click()
    await expect(attendanceObservationInput).toBeVisible()
    await expect(attendanceObservationInput).toHaveValue('')
    await attendanceObservationInput.fill('Segunda alta consecutiva')
    await page.getByRole('button', { name: 'Agregar', exact: true }).click()
    await expect(attendanceObservationInput).toBeVisible()
    await expect(attendanceObservationInput).toHaveValue('')
    await expect.poll(() => addedAttendanceObservationBodies.length).toBe(2)
    expect(addedAttendanceObservationBodies.map(body => body.notes)).toEqual(['Primera alta consecutiva', 'Segunda alta consecutiva'])
    await page.getByRole('button', { name: 'Cerrar observaciones' }).click()

    await attendanceDialog.getByRole('button', { name: 'Presente: Álexis Tarillo Mejio' }).click()
    await page.setViewportSize({ width: 465, height: 818 })
    await expect(attendanceDialog.getByRole('button', { name: 'Guardar Asistencia' })).toBeVisible()
    const saveRequest = page.waitForRequest(request => request.url().endsWith('/api/programs/program-1/sessions/session-previous/attendance/batch') && request.method() === 'POST')
    await attendanceDialog.getByRole('button', { name: 'Guardar Asistencia' }).click()
    expect((await saveRequest).postDataJSON()).toEqual({ records: [{ participant_id: 'program-participant-1', status: 'present' }] })
  })

  test('Asistencia permite reintentar una carga 500 y no cierra ni pierde cambios si falla el guardado', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    let attendanceLoadAttempts = 0
    const failedAttendanceBodies: Array<{ records: Array<{ participant_id: string; status: string }> }> = []
    await page.route('**/api/programs/program-1/sessions', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([mockPreviousSession]),
    }))
    await page.route('**/api/programs/program-1/sessions/session-previous/attendance', async route => {
      attendanceLoadAttempts += 1
      await route.fulfill(attendanceLoadAttempts === 1
        ? { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'No se pudo consultar la asistencia' }) }
        : { status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.route('**/api/programs/program-1/sessions/session-previous/attendance/batch', async route => {
      failedAttendanceBodies.push(route.request().postDataJSON())
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No se pudo guardar la asistencia' }),
      })
    })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Sesiones 1 registradas/ }).click()
    const openAttendanceButton = page.getByRole('button', { name: 'Asistencia', exact: true })
    await openAttendanceButton.click()
    const dialog = page.getByRole('dialog', { name: 'Tomar asistencia' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('No se pudo consultar la asistencia', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Reintentar' }).click()
    await expect(dialog.getByText('Sin observaciones').first()).toBeVisible()
    const saveButton = dialog.getByRole('button', { name: 'Guardar Asistencia' })
    await expect(saveButton).toBeDisabled()

    const presentButton = dialog.getByRole('button', { name: 'Presente: Álexis Tarillo Mejio' })
    await presentButton.click()
    await expect(saveButton).toBeEnabled()
    await presentButton.click()
    await expect(presentButton).not.toHaveClass(/ring-2/)
    await saveButton.click()
    await expect(page.getByText('No se pudo guardar la asistencia. No se aplicaron cambios parciales.', { exact: true })).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(failedAttendanceBodies[0]).toEqual({ records: [{ participant_id: 'program-participant-1', status: '' }] })

    await presentButton.click()
    await expect(presentButton).toHaveClass(/ring-2/)
    await saveButton.click()
    await expect.poll(() => failedAttendanceBodies.length).toBe(2)
    expect(failedAttendanceBodies[1]).toEqual({ records: [{ participant_id: 'program-participant-1', status: 'present' }] })
    await expect(dialog).toBeVisible()
    await expect(saveButton).toBeEnabled()
  })

  test('Programas móvil separa el padrón activo del historial sin perder las participaciones', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    const historicalParticipants = [
      { ...mockProgramParticipants[0], id: 'program-participant-7', contact_id: 'program-contact-7', contact_name: 'Participante retirado', contact_phone: '5192300107', status: 'dropped', dropped_at: '2026-07-16T12:00:00.000Z', drop_reason: 'Cambio de horario' },
      { ...mockProgramParticipants[1], id: 'program-participant-8', contact_id: 'program-contact-8', contact_name: 'Participante completado', contact_phone: '5192300108', status: 'completed', completed_at: '2026-07-17T12:00:00.000Z' },
    ]
    await page.route('**/api/programs/program-1/participants', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([...mockProgramParticipants, ...historicalParticipants]),
    }))
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('tab', { name: /Activos 6/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('mobile-program-participant-row')).toHaveCount(6)
    await expect(page.getByText('Participante retirado', { exact: true })).toHaveCount(0)

    await page.getByRole('tab', { name: /Historial 2/ }).click()
    await expect(page.getByRole('tab', { name: /Historial 2/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('mobile-program-participant-history-row')).toHaveCount(2)
    await expect(page.getByText('Participante retirado', { exact: true })).toBeVisible()
    await expect(page.getByText('Cambio de horario', { exact: true })).toBeVisible()
    await expect(page.getByText('Participante completado', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Programas móvil prioriza búsqueda, filas densas y detalle enfocado sin alterar escritorio', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel('6 participantes')).toBeVisible()
    await expect(page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ })).toBeVisible()
    const search = page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })
    await expect(search).toBeVisible()
    await search.focus()
    await expect(search).toBeFocused()
    const addParticipantsButton = page.getByRole('button', { name: 'Agregar participantes' })
    await expect(addParticipantsButton).toBeVisible()
    await addParticipantsButton.click()
    const participantSelector = page.getByRole('dialog', { name: 'Agregar participantes' })
    await expectInsideVisualViewport(page, participantSelector)
    await expect(participantSelector.getByPlaceholder('Buscar por nombre, teléfono, email...')).toBeFocused()
    await participantSelector.getByRole('button', { name: 'Cerrar selector de contactos' }).click()
    await expect(participantSelector).toBeHidden()
    await expect(page.getByText('Salud', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Asistencia', { exact: true })).toHaveCount(0)

    const rows = page.getByTestId('mobile-program-participant-row')
    await expect(rows).toHaveCount(6)
    const firstRowBox = await rows.first().boundingBox()
    expect(firstRowBox?.height).toBeLessThanOrEqual(90)

    await search.fill('alexis')
    await expect(page.getByRole('button', { name: 'Exportar participantes filtrados a Excel' })).toHaveCount(0)
    await page.waitForTimeout(250)
    await expect(rows).toHaveCount(6)
    await expect(rows).toHaveCount(1)
    await expect(page.getByText('Álexis Tarillo Mejio', { exact: true })).toBeVisible()
    await search.press('Enter')
    await search.blur()
    await expect(page.getByRole('button', { name: 'Exportar participantes filtrados a Excel' })).toBeEnabled()
    const [participantsDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar participantes filtrados a Excel' }).click(),
    ])
    expect(participantsDownload.suggestedFilename()).toBe('Programa_sin_sesiones_participantes.xlsx')
    await page.getByRole('button', { name: /Álexis Tarillo Mejio.*5192300100.*Activo/ }).click()

    await expect(page.getByRole('heading', { name: 'Detalle del participante' })).toBeVisible()
    await expect(page.getByText('participante1@example.test')).toBeVisible()
    await expect(page.getByText('Observación móvil existente')).toHaveCount(0)
    await page.getByRole('button', { name: 'Ver historial' }).click()
    await expect(page.getByText('Observación móvil existente')).toBeVisible()
    await expect(page.getByText('Participación en el programa')).toBeVisible()
    const enrollmentRequest = page.waitForRequest(request => request.url().includes('/api/programs/program-1/participants/program-participant-1/enrollment') && request.method() === 'PATCH')
    await page.getByRole('button', { name: 'Modificar fecha de incorporación' }).click()
    const enrollmentInput = page.getByLabel('Nueva fecha de incorporación')
    await enrollmentInput.fill('2026-07-10')
    const healthRefreshRequest = page.waitForRequest(request => request.url().endsWith('/api/programs/program-1/health') && request.method() === 'GET')
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    expect((await enrollmentRequest).postDataJSON()).toEqual({ enrolled_at: '2026-07-10' })
    await healthRefreshRequest
    await expect(page.getByText(/10 jul.*2026/i).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Asistencia y progreso' })).toBeVisible()
    await expect(page.getByText('67%', { exact: true })).toBeVisible()
    await expect(page.getByText('Ética aplicada', { exact: true })).toBeVisible()
    await expect(page.getByLabel('—: Sin registrar')).toBeVisible()
    await expect(page.getByLabel('P: Estuvo presente')).toBeVisible()
    await expect(page.getByLabel('F: Faltó')).toBeVisible()
    await expect(page.getByLabel('T: Asistió, llegó tarde')).toBeVisible()
    await page.getByRole('button', { name: 'Observaciones (2)' }).click()
    const attendanceObservations = page.getByRole('heading', { name: 'Observaciones de asistencia' })
    await expect(attendanceObservations).toBeVisible()
    await expect(page.getByPlaceholder(/Escribir observación de asistencia/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Nueva observación' }).click()
    const attendanceComposer = page.getByPlaceholder(/Escribir observación de asistencia/)
    await attendanceComposer.fill('Seguimiento añadido desde la ficha individual')
    await page.getByRole('button', { name: 'Agregar', exact: true }).click()
    await expect(attendanceComposer).toBeVisible()
    await expect(attendanceComposer).toHaveValue('')
    await page.getByRole('button', { name: 'Cerrar observaciones' }).click()
    await expect(page.getByText('Generar Documento')).toHaveCount(0)
    await expect(page.getByText('Nueva tarea')).toHaveCount(0)
    await expect(page.getByText('Eliminar', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Enviar mensaje a Álexis Tarillo Mejio' }).click()
    await expect(page.getByRole('button', { name: 'Ver detalles de la conversación' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Escribe un mensaje…' })).toBeVisible()
    await page.getByRole('button', { name: 'Volver a la lista de chats' }).click()
    await expect(page.getByRole('heading', { name: 'Detalle del participante' })).toBeVisible()
    await page.getByRole('button', { name: 'Cerrar detalles' }).click()
    await expect(search).toHaveValue('alexis')

    await page.getByRole('button', { name: 'Abrir observaciones de Álexis Tarillo Mejio' }).click()
    await expect(page.getByRole('heading', { name: 'Historial de Observaciones' })).toBeVisible()
    const observationAuthor = page.getByTestId('observation-author')
    await expect(observationAuthor).toBeVisible()
    await expect(observationAuthor).toContainText('Responsive QA')
    await expect(page.getByPlaceholder(/Escribir observación/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Nueva observación' }).click()
    await expect(page.getByPlaceholder(/Escribir observación/)).toBeVisible()

    await page.setViewportSize({ width: 320, height: 568 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })).toBeVisible()
    await page.getByRole('button', { name: /Álexis Tarillo Mejio.*5192300100.*Activo/ }).click()
    const narrowDetail = page.getByRole('dialog', { name: 'Detalle del participante' })
    await expectInsideVisualViewport(page, narrowDetail)
    await expect(narrowDetail.getByRole('heading', { name: 'Asistencia y progreso' })).toBeVisible()
    await expect.poll(() => narrowDetail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await narrowDetail.getByRole('button', { name: 'Cerrar detalles' }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 465, height: 818 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /Álexis Tarillo Mejio.*5192300100.*Activo/ }).click()
    const phoneDetail = page.getByRole('dialog', { name: 'Detalle del participante' })
    await expectInsideVisualViewport(page, phoneDetail)
    await expect(phoneDetail.getByText('participante1@example.test')).toBeVisible()
    await expect(phoneDetail.getByRole('heading', { name: 'Asistencia y progreso' })).toBeVisible()
    await phoneDetail.getByRole('button', { name: 'Cerrar detalles' }).click()

    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    const tabletParticipantsTab = page.getByRole('button', { name: /Participantes \(6\)/ })
    await expect(tabletParticipantsTab).toBeAttached({ timeout: 15_000 })
    await tabletParticipantsTab.scrollIntoViewIfNeeded()
    await expect(tabletParticipantsTab).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Exportar participantes filtrados a Excel' })).toBeVisible()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /Participantes \(6\)/ })).toBeVisible()
    await expect(page.getByText('Salud', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Asistencia', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Buscar participante por nombre o teléfono' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Exportar participantes filtrados a Excel' })).toBeVisible()
  })

  test('Programas móvil explica con precisión los registros anteriores a la incorporación', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /Participante Móvil 2.*Activo/ }).click()
    const detail = page.getByRole('dialog', { name: 'Detalle del participante' })
    await expectInsideVisualViewport(page, detail)
    await expect(detail.getByText('Solo historial', { exact: true })).toBeVisible()
    await expect(detail.getByText('No hay sesiones dentro de su periodo', { exact: true })).toBeVisible()
    await expect(detail.getByText(/1 registro de asistencia anterior a la incorporación/)).toBeVisible()
    await detail.getByRole('button', { name: /Registros fuera del periodo de participación/ }).click()
    await expect(detail.getByText('Sesión anterior a la incorporación', { exact: true })).toBeVisible()
    await expect.poll(() => detail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Cursos permite editar el plan de clases en móvil y mantiene el editor paralelo en escritorio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.route(/\/api\/programs\/courses(?:\?.*)?$/, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ courses: [mockCoursePlan, mockSecondCoursePlan, mockThirdCoursePlan], total: 3, page: 1, page_size: 10 }),
    }))
    await page.goto(`${baseURL}/dashboard/programs/courses`, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'Cursos', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('textbox', { name: 'Buscar cursos' })).toBeVisible()
    await expect(page.getByText('Formación inicial', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Editar', exact: true })).toHaveCount(0)
    const firstTrigger = page.getByRole('button', { name: 'Ver detalles de Formación inicial' })
    const secondTrigger = page.getByRole('button', { name: 'Ver detalles de Habilidades prácticas' })
    const thirdTrigger = page.getByRole('button', { name: 'Ver detalles de Comunicación efectiva' })
    await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(secondTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(thirdTrigger).toHaveAttribute('aria-expanded', 'false')

    const firstPanelID = await firstTrigger.getAttribute('aria-controls')
    const secondPanelID = await secondTrigger.getAttribute('aria-controls')
    expect(firstPanelID).toBeTruthy()
    expect(secondPanelID).toBeTruthy()
    const firstPanel = page.locator(`#${firstPanelID}`)
    const secondPanel = page.locator(`#${secondPanelID}`)
    await expect(firstPanel).toHaveCount(1)
    await expect(firstPanel).toHaveAttribute('role', 'region')
    await expect(firstPanel).toHaveAttribute('aria-labelledby', await firstTrigger.getAttribute('id') || '')
    await expect(firstPanel).toHaveAttribute('aria-hidden', 'true')
    await expect(firstPanel).toHaveAttribute('inert', '')
    await expect(firstPanel).toHaveClass(/grid-rows-\[0fr\]/)

    await firstTrigger.focus()
    await page.keyboard.press('Tab')
    await expect(secondTrigger).toBeFocused()

    await firstTrigger.click()
    await expect(page.getByRole('button', { name: 'Contraer Formación inicial' })).toHaveAttribute('aria-expanded', 'true')
    await expect(firstPanel).toHaveAttribute('aria-hidden', 'false')
    await expect(firstPanel).not.toHaveAttribute('inert', '')
    await expect(firstPanel).toHaveClass(/grid-rows-\[1fr\]/)
    await expect(page.getByRole('region', { name: /Formación inicial/ })).toBeVisible()

    await secondTrigger.click()
    await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(firstPanel).toHaveAttribute('inert', '')
    await expect(secondPanel).toHaveAttribute('aria-hidden', 'false')
    await expect(secondPanel).not.toHaveAttribute('inert', '')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => secondPanel.evaluate(element => getComputedStyle(element).transitionProperty)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await firstTrigger.click()
    await expect(page.getByRole('button', { name: 'Contraer Formación inicial' })).toBeVisible()
    await firstPanel.getByRole('button', { name: 'Editar', exact: true }).click()
    const mobileEditor = page.getByRole('dialog', { name: 'Editar curso' })
    await expectInsideVisualViewport(page, mobileEditor)
    await expect(mobileEditor.locator('#course-name')).toHaveValue('Formación inicial')
    const topicTitles = mobileEditor.locator('input[id^="topic-title-"]')
    await expect(topicTitles.nth(0)).toHaveValue('Bienvenida')
    await expect(topicTitles.nth(1)).toHaveValue('Principios básicos')
    await mobileEditor.getByRole('button', { name: 'Agregar tema' }).click()
    await expect(mobileEditor.getByPlaceholder('Tema 3 *')).toBeVisible()
    await expect(mobileEditor.getByPlaceholder('Tema 3 *')).toBeFocused()
    await mobileEditor.getByPlaceholder('Tema 3 *').fill('Aplicación práctica')
    await page.setViewportSize({ width: 320, height: 568 })
    await mobileEditor.getByRole('button', { name: 'Agregar otro tema al final del plan' }).click()
    await expect(mobileEditor.getByPlaceholder('Tema 4 *')).toBeVisible()
    await expect(mobileEditor.getByPlaceholder('Tema 4 *')).toBeFocused()
    await mobileEditor.getByPlaceholder('Tema 4 *').fill('Cierre y acuerdos')
    await expect(topicTitles.nth(2)).toHaveValue('Aplicación práctica')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const courseSaveRequest = page.waitForRequest(request => request.url().endsWith('/api/programs/courses/course-1') && request.method() === 'PUT')
    await mobileEditor.getByRole('button', { name: 'Guardar curso' }).click()
    expect((await courseSaveRequest).postDataJSON().topics.map((topic: { title: string }) => topic.title)).toEqual([
      'Bienvenida',
      'Principios básicos',
      'Aplicación práctica',
      'Cierre y acuerdos',
    ])
    await expect(page.getByText('Curso actualizado', { exact: true })).toBeVisible()
    await mobileEditor.getByRole('button', { name: 'Volver al listado de cursos' }).click()
    await expect(mobileEditor).toBeHidden()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard/programs/courses`, { waitUntil: 'domcontentloaded' })
    const desktopCourseTrigger = page.getByRole('button', { name: 'Editar Formación inicial', exact: true })
    await expect(desktopCourseTrigger).not.toHaveAttribute('aria-expanded', /.+/)
    await expect(page.getByText('Principios básicos', { exact: true }).first()).toBeVisible()
    await desktopCourseTrigger.click()
    await expect(page.getByRole('heading', { name: 'Editar curso' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Editar curso' })).toHaveCount(0)
    await page.locator('#course-name').fill('Formación inicial ajustada')
    await page.locator('a[href="/dashboard/programs"]:visible').first().click()
    const navigationConfirm = page.getByRole('alertdialog', { name: 'Salir sin guardar' })
    await expect(navigationConfirm).toContainText('Si navegas a otra sección')
    await navigationConfirm.getByRole('button', { name: 'Cancelar' }).click()
    await expect(page).toHaveURL(/\/dashboard\/programs\/courses/)
  })

  test('Cursos muestra carga, vacío, error recuperable y conserva el borrador si falla el guardado', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    let listMode: 'empty' | 'error' | 'data' = 'empty'
    let releaseInitialList!: () => void
    const initialListGate = new Promise<void>(resolve => { releaseInitialList = resolve })
    let initialListPending = true

    await page.route(/\/api\/programs\/courses(?:\?.*)?$/, async route => {
      if (listMode === 'error') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Catálogo temporalmente no disponible' }) })
        return
      }
      if (listMode === 'empty' && initialListPending) {
        await initialListGate
        initialListPending = false
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(listMode === 'empty'
          ? { courses: [], total: 0, page: 1, page_size: 10 }
          : { courses: [mockCoursePlan], total: 1, page: 1, page_size: 10 }),
      })
    })
    await page.route('**/api/programs/courses/course-1', async route => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'No fue posible guardar este curso de prueba.' }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ course: mockCoursePlan }) })
    })

    await page.goto(`${baseURL}/dashboard/programs/courses`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByLabel('Cargando cursos')).toBeVisible()
    releaseInitialList()
    await expect(page.getByText('Crea tu primer curso', { exact: true })).toBeVisible()

    listMode = 'error'
    await page.getByRole('tab', { name: 'Archivados' }).click()
    await expect(page.getByText('No pudimos cargar los cursos', { exact: true })).toBeVisible()
    await expect(page.getByText('Catálogo temporalmente no disponible', { exact: true })).toBeVisible()

    listMode = 'data'
    await page.getByRole('button', { name: 'Reintentar' }).click()
    await expect(page.getByText('Formación inicial', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Ver detalles de Formación inicial' }).click()
    await page.getByRole('button', { name: 'Editar', exact: true }).click()

    const editor = page.getByRole('dialog', { name: 'Editar curso' })
    await editor.locator('#course-name').fill('Borrador que debe conservarse')
    await editor.getByRole('button', { name: 'Guardar curso' }).click()
    await expect(editor.getByText('No fue posible guardar este curso de prueba.', { exact: true })).toBeVisible()
    await expect(editor.locator('#course-name')).toHaveValue('Borrador que debe conservarse')
    await expect(editor).toBeVisible()
  })

  test('Programa administra plan e instructores también en móvil', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Plan e instructores 1 cursos · 1 instructores/ }).click()

    await expect(page.getByRole('heading', { name: 'Plan de clases' })).toBeVisible()
    await expect(page.getByText('Formación inicial', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Instructores' })).toBeVisible()
    await expect(page.getByText('Instructora Responsive', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Agregar curso' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Agregar instructor' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Desasociar Formación inicial' }).click()
    await expect(page.getByText('Tienes cambios sin guardar', { exact: false })).toBeVisible()
    const academicSaveRequest = page.waitForRequest(request => request.url().endsWith('/api/programs/program-1/academic-config') && request.method() === 'PUT')
    await page.getByRole('button', { name: 'Guardar plan' }).click()
    expect((await academicSaveRequest).postDataJSON()).toMatchObject({
      course_ids: [],
      contact_ids: ['instructor-contact-1'],
      expected_updated_at: mockNow,
    })
    await expect(page.getByText('Tienes cambios sin guardar', { exact: false })).toBeHidden()

    await page.getByRole('button', { name: 'Desasociar Formación inicial' }).click()
    await expect(page.getByText('Tienes cambios sin guardar', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: /Cambiar sección\. Actual: Plan e instructores/ }).click()
    await page.getByRole('button', { name: /Sesiones 0 registradas/ }).click()
    const sectionConfirm = page.getByRole('alertdialog', { name: 'Confirmar acción' })
    await expect(sectionConfirm).toContainText('Si cambias de sección')
    await sectionConfirm.getByRole('button', { name: 'Cancelar' }).click()
    await expect(page.getByRole('heading', { name: 'Plan de clases' })).toBeVisible()

    await page.getByRole('button', { name: 'Administrar cursos' }).click()
    const catalogConfirm = page.getByRole('alertdialog', { name: 'Confirmar acción' })
    await expect(catalogConfirm).toContainText('Si sales de esta página')
    await catalogConfirm.getByRole('button', { name: 'Confirmar' }).click()
    await expect(page).toHaveURL(/\/dashboard\/programs\/courses/)
  })

  test('Programa móvil instancia una plantilla de encuesta y conserva resultados por programa', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)
    await page.goto(`${baseURL}/dashboard/programs/program-1`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Programa sin sesiones' })).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: /Cambiar sección\. Actual: Participantes/ }).click()
    await page.getByRole('button', { name: /Encuestas Aplicaciones y resultados/ }).click()
    await expect(page.getByRole('heading', { name: 'Encuestas del programa' })).toBeVisible()
    await expect(page.getByText('Encuesta inicial', { exact: true })).toBeVisible()
    await expect(page.getByText('2', { exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Crear', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Crear encuesta' })
    await expectInsideVisualViewport(page, createDialog)
    await expect(createDialog.getByText('Satisfacción del programa', { exact: true })).toBeVisible()
    const createRequest = page.waitForRequest(request => request.url().endsWith('/api/programs/program-1/surveys') && request.method() === 'POST')
    await createDialog.getByRole('button', { name: 'Crear y obtener enlaces' }).click()
    expect((await createRequest).postDataJSON()).toMatchObject({
      template_id: 'survey-template-1',
      status: 'active',
      audience_mode: 'program_participants',
    })

    const linksDialog = page.getByRole('dialog', { name: 'Enlaces por participante' })
    await expectInsideVisualViewport(page, linksDialog)
    await expect(linksDialog.getByText('Álexis Tarillo Mejio', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Aplicación de encuesta del programa no ofrece enlace ni QR sin destinatario', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await authenticate(page)

    const surveyId = 'survey-program-restricted'
    await page.route(url => url.pathname === `/api/surveys/${surveyId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: surveyId,
          account_id: 'account-responsive',
          name: 'Encuesta privada del programa',
          description: '',
          slug: 'encuesta-privada-programa',
          status: 'active',
          welcome_title: '',
          welcome_description: '',
          thank_you_title: '',
          thank_you_message: '',
          thank_you_redirect_url: '',
          branding: {},
          template_id: 'survey-template-1',
          template_revision: 3,
          origin_type: 'program',
          origin_label: 'Programa sin sesiones',
          program_id: 'program-1',
          audience_mode: 'program_participants',
          legacy_instance: false,
          created_at: mockNow,
          updated_at: mockNow,
        }),
      })
    })
    await page.route(url => url.pathname === `/api/surveys/${surveyId}/questions`, async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })

    await page.goto(`${baseURL}/dashboard/surveys/${surveyId}?mode=instance&tab=share`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Enlaces individuales por participante' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copiar enlace' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Abrir', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Código QR' })).toHaveCount(0)
    await expect(page.locator('a[href^="/f/"]')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Ir al programa' })).toHaveAttribute('href', '/dashboard/programs/program-1')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })

  test('Editor de encuesta bloquea un snapshot parcial y conserva todas las preguntas al reintentar', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await authenticate(page)

    const surveyId = 'survey-legacy-load-guard'
    const questions = [
      { id: 'legacy-question-1', survey_id: surveyId, order_index: 0, type: 'short_text', title: 'Primera pregunta', description: '', required: true, config: {}, logic_rules: [], created_at: mockNow, updated_at: mockNow },
      { id: 'legacy-question-2', survey_id: surveyId, order_index: 1, type: 'long_text', title: 'Segunda pregunta', description: '', required: false, config: {}, logic_rules: [], created_at: mockNow, updated_at: mockNow },
    ]
    let questionLoads = 0
    let savedQuestions: Array<{ id: string; title: string }> | null = null

    await page.route(url => url.pathname === `/api/surveys/${surveyId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: surveyId,
          account_id: 'account-responsive',
          name: 'Encuesta legado protegida',
          description: '',
          slug: 'encuesta-legado-protegida',
          status: 'draft',
          welcome_title: '',
          welcome_description: '',
          thank_you_title: '',
          thank_you_message: '',
          thank_you_redirect_url: '',
          branding: {},
          audience_mode: 'public',
          legacy_instance: true,
          created_at: mockNow,
          updated_at: mockNow,
        }),
      })
    })
    await page.route(url => url.pathname === `/api/surveys/${surveyId}/questions`, async route => {
      if (route.request().method() === 'PUT') {
        savedQuestions = route.request().postDataJSON()
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedQuestions) })
        return
      }
      questionLoads += 1
      if (questionLoads === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fallo controlado al cargar preguntas' }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(questions) })
    })

    await page.goto(`${baseURL}/dashboard/surveys/${surveyId}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'No pudimos cargar la encuesta completa' })).toBeVisible()
    await expect(page.getByText('Fallo controlado al cargar preguntas', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toHaveCount(0)
    await expect(page.getByText('Sin preguntas aún', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Reintentar' }).click()
    await expect(page.getByText('Preguntas (2)', { exact: true })).toBeVisible()
    await page.locator('input[placeholder="Escribe tu pregunta aquí..."]').fill('Primera pregunta editada')
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()

    await expect.poll(() => savedQuestions?.length || 0).toBe(2)
    expect(savedQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy-question-1', title: 'Primera pregunta editada' }),
      expect.objectContaining({ id: 'legacy-question-2', title: 'Segunda pregunta' }),
    ]))
  })

  test('Eros permanece dentro del viewport móvil y conserva el modo acoplado de escritorio', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await authenticate(page)

    const openVisibleEros = async () => {
      const triggers = page.getByRole('button', { name: 'Abrir Eros' })
      await triggers.first().waitFor({ state: 'attached', timeout: 10_000 })
      for (let index = 0; index < await triggers.count(); index += 1) {
        const trigger = triggers.nth(index)
        const box = await trigger.boundingBox()
        const viewport = page.viewportSize()
        const intersectsViewport = Boolean(box && viewport
          && box.x + box.width > 0
          && box.y + box.height > 0
          && box.x < viewport.width
          && box.y < viewport.height)
        if (await trigger.isVisible() && intersectsViewport) {
          await trigger.click()
          return
        }
      }
      throw new Error('No se encontró un botón visible para abrir Eros')
    }

    await openVisibleEros()
    const mobileEros = page.getByLabel('Asistente Eros')
    await expectInsideVisualViewport(page, mobileEros)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
    await openVisibleEros()
    const desktopEros = page.getByLabel('Asistente Eros')
    await expectInsideVisualViewport(page, desktopEros)
    const dock = page.getByTitle('Acoplar a la derecha')
    await expect(dock).toBeVisible()
    await dock.click()
    await expectInsideVisualViewport(page, desktopEros)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    const collapseSidebar = page.getByTitle('Colapsar menú')
    await expect(collapseSidebar).toBeVisible()
    await collapseSidebar.click()
    await expectInsideVisualViewport(page, desktopEros)
  })
})
