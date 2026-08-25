import type { WhiteboardAccessLevel, WhiteboardEffectiveAccess } from './whiteboards'

export type WhiteboardRealtimeIssueKind =
  | 'session_expired'
  | 'access_revoked'
  | 'authorization_unavailable'

export interface WhiteboardRealtimeIssue {
  kind: WhiteboardRealtimeIssueKind
  message: string
  retryable: boolean
}

export type WhiteboardCollabTicketAudience = 'member' | 'guest'

interface WhiteboardTicketFailureInput {
  audience: WhiteboardCollabTicketAudience
  status?: number
  code?: string
  message?: string
}

interface WhiteboardRealtimeErrorEventLike {
  event: string
  code?: string
  error?: string
  data?: unknown
}

export interface WhiteboardRealtimeConnectionNotice {
  message: string
  busy: boolean
  warning: boolean
}

export interface WhiteboardPermissionChangeFeedback {
  notice: string | null
  saveState: 'pending' | 'error' | null
}

function normalizedCode(value?: string) {
  return value?.trim().toLocaleLowerCase('en') || ''
}

function issueMessage(kind: WhiteboardRealtimeIssueKind, fallback?: string) {
  if (fallback?.trim()) return fallback.trim()
  if (kind === 'session_expired') return 'Tu sesión expiró. Inicia sesión nuevamente para continuar.'
  if (kind === 'access_revoked') return 'Tu acceso a esta pizarra fue revocado.'
  return 'No se pudo comprobar temporalmente el acceso. La pizarra sigue abierta y Clarin volverá a intentarlo.'
}

export function classifyWhiteboardCollabTicketFailure({
  audience,
  status,
  code,
  message,
}: WhiteboardTicketFailureInput): WhiteboardRealtimeIssue {
  const normalized = normalizedCode(code)
  if (audience === 'member' && (status === 401 || normalized === 'session_expired')) {
    return { kind: 'session_expired', message: issueMessage('session_expired', message), retryable: false }
  }
  if (
    normalized === 'access_revoked'
    || normalized === 'permission_denied'
    || normalized === 'whiteboard_not_found'
    || (audience === 'member' && (status === 403 || status === 404))
    || (audience === 'guest' && (status === 401 || status === 403 || status === 404 || status === 410))
  ) {
    return {
      kind: 'access_revoked',
      message: issueMessage(
        'access_revoked',
        message || (audience === 'guest' ? 'Esta sesión compartida dejó de estar disponible.' : undefined),
      ),
      retryable: false,
    }
  }
  return {
    kind: 'authorization_unavailable',
    message: issueMessage('authorization_unavailable', message),
    retryable: true,
  }
}

export class WhiteboardCollabTicketError extends Error {
  readonly issue: WhiteboardRealtimeIssue
  readonly status?: number
  readonly code?: string

  constructor(issue: WhiteboardRealtimeIssue, input: { status?: number; code?: string } = {}) {
    super(issue.message)
    this.name = 'WhiteboardCollabTicketError'
    this.issue = issue
    this.status = input.status
    this.code = input.code
  }
}

export function whiteboardCollabTicketError(
  input: WhiteboardTicketFailureInput,
): WhiteboardCollabTicketError {
  return new WhiteboardCollabTicketError(classifyWhiteboardCollabTicketFailure(input), {
    status: input.status,
    code: input.code,
  })
}

export function whiteboardRealtimeIssueFromUnknown(error: unknown): WhiteboardRealtimeIssue {
  if (error instanceof WhiteboardCollabTicketError) return error.issue
  return {
    kind: 'authorization_unavailable',
    message: issueMessage('authorization_unavailable', error instanceof Error ? error.message : undefined),
    retryable: true,
  }
}

export function whiteboardRealtimeIssueFromEvent(
  event: WhiteboardRealtimeErrorEventLike,
  audience: WhiteboardCollabTicketAudience,
): WhiteboardRealtimeIssue | null {
  if (event.event === 'access.revoked') {
    return {
      kind: 'access_revoked',
      message: audience === 'guest'
        ? 'Esta sesión compartida fue revocada.'
        : 'Tu acceso a esta pizarra fue revocado.',
      retryable: false,
    }
  }
  if (event.event !== 'error') return null
  const code = normalizedCode(event.code)
  if (code === 'session_expired') {
    return audience === 'guest'
      ? { kind: 'access_revoked', message: 'Esta sesión compartida expiró.', retryable: false }
      : { kind: 'session_expired', message: issueMessage('session_expired', event.error), retryable: false }
  }
  if (code === 'authorization_unavailable' || code === 'presence_unavailable') {
    return {
      kind: 'authorization_unavailable',
      message: issueMessage('authorization_unavailable', event.error),
      retryable: true,
    }
  }
  return null
}

export function whiteboardRealtimeConnectionNotice(input: {
  connection: 'connecting' | 'open' | 'closed'
  hasOpened: boolean
  issue: WhiteboardRealtimeIssue | null
}): WhiteboardRealtimeConnectionNotice | null {
  if (input.issue?.kind === 'authorization_unavailable') {
    return {
      message: `${input.issue.message} Tus cambios permanecen en pantalla.`,
      busy: true,
      warning: true,
    }
  }
  if (!input.hasOpened || input.connection === 'open') return null
  if (input.connection === 'connecting') {
    return { message: 'Reconectando la colaboración en tiempo real…', busy: true, warning: false }
  }
  return {
    message: 'La colaboración está desconectada. Tus cambios permanecen en pantalla y Clarin reintentará automáticamente.',
    busy: false,
    warning: true,
  }
}

export function whiteboardPermissionChangeFeedback(input: {
  canEdit: boolean
  hasPendingChanges: boolean
  online: boolean
}): WhiteboardPermissionChangeFeedback {
  if (input.canEdit) {
    return {
      notice: null,
      saveState: input.hasPendingChanges && input.online ? 'pending' : null,
    }
  }
  return input.hasPendingChanges
    ? {
      notice: 'Tu permiso cambió a solo lectura. Tus cambios locales permanecen en pantalla, pero no pueden guardarse mientras no recuperes edición.',
      saveState: 'error',
    }
    : {
      notice: 'Tu permiso cambió y la pizarra está ahora en modo de solo lectura.',
      saveState: null,
    }
}

export function whiteboardRealtimeAccessLevel(data: unknown): WhiteboardAccessLevel | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const access = String((data as Record<string, unknown>).access || '').trim().toLocaleLowerCase('en')
  return access === 'view' || access === 'comment' || access === 'edit' || access === 'manage'
    ? access
    : null
}

export function whiteboardEffectiveAccessAtLevel(
  current: WhiteboardEffectiveAccess | null | undefined,
  level: WhiteboardAccessLevel,
): WhiteboardEffectiveAccess {
  const rank: Record<WhiteboardAccessLevel, number> = { view: 0, comment: 1, edit: 2, manage: 3 }
  return {
    ...current,
    level,
    can_view: true,
    can_comment: rank[level] >= rank.comment,
    can_edit: rank[level] >= rank.edit,
    can_manage_access: rank[level] >= rank.manage,
    can_delete: rank[level] >= rank.manage ? current?.can_delete : false,
  }
}

export function whiteboardGuestAccessAtLevel(level: WhiteboardAccessLevel): 'view' | 'edit' {
  return level === 'edit' || level === 'manage' ? 'edit' : 'view'
}
