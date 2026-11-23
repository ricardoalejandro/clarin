const genericErrors = /^(bad request|internal server error|unauthorized|forbidden|not found|request timeout|too many requests|service unavailable|failed to fetch|fetch failed|network request failed|load failed)$/i

/** Keep actionable API messages; translate generic transport errors without hiding their status. */
export function chatReadError(error: unknown, fallback: string, status?: number): string {
  const message = typeof error === 'string' ? error.trim() : error instanceof Error ? error.message.trim() : ''
  if (message && !genericErrors.test(message)) return message
  if (status === 401) return 'Tu sesión ha caducado. Vuelve a iniciar sesión.'
  if (status === 403) return 'No tienes permiso para consultar estas conversaciones.'
  return status && status >= 400 ? `${fallback.replace(/\.$/, '')} (error ${status}).` : fallback
}
