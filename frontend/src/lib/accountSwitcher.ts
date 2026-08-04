const ACCOUNT_ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super administrador',
  admin: 'Administrador',
  agent: 'Agente',
  owner: 'Propietario',
  member: 'Miembro',
}

export function accountRoleLabel(role: string) {
  const normalized = role.trim().toLocaleLowerCase('es-PE')
  if (!normalized) return 'Sin rol asignado'
  if (ACCOUNT_ROLE_LABELS[normalized]) return ACCOUNT_ROLE_LABELS[normalized]
  const words = normalized.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  return words.charAt(0).toLocaleUpperCase('es-PE') + words.slice(1)
}

export function accountOptionsURL(query: string, cursor = '') {
  const params = new URLSearchParams()
  const normalized = query.trim()
  if (normalized) {
    params.set('query', normalized)
    params.set('limit', '50')
  }
  if (cursor) params.set('cursor', cursor)
  const suffix = params.toString()
  return `/api/me/accounts${suffix ? `?${suffix}` : ''}`
}
