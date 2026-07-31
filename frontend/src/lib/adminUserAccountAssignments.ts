export interface AdminUserAccountAssignment {
  id?: string
  account_id: string
  account_name: string
  account_slug?: string
  role: string
  role_id?: string | null
  role_name?: string
  permissions?: string[]
  is_default: boolean
}

export interface AdminUserAccountsResponse {
  success: boolean
  accounts?: AdminUserAccountAssignment[]
  session_refresh_required?: boolean
  persisted?: boolean
  error?: string
  code?: string
}

export interface AdminApiResult {
  success: boolean
  data?: AdminUserAccountsResponse
  error?: string
  status?: number
}

export interface AdminUserAccountMutationOutcome {
  success: boolean
  accounts: AdminUserAccountAssignment[]
  persisted: boolean
  error?: string
  code?: string
}

export async function finalizeAdminUserAccountMutation(
  result: AdminApiResult,
  refreshSession: () => Promise<boolean>,
): Promise<AdminUserAccountMutationOutcome> {
  const payload = result.data
  if (!result.success || !payload?.success) {
    return {
      success: false,
      accounts: payload?.accounts ?? [],
      persisted: Boolean(payload?.persisted),
      error: result.error || payload?.error || 'No se pudo actualizar la asignación.',
      code: payload?.code,
    }
  }

  const accounts = payload.accounts ?? []
  if (payload.session_refresh_required) {
    const refreshed = await refreshSession()
    if (!refreshed) {
      return {
        success: false,
        accounts,
        persisted: true,
        error: 'El cambio se guardó, pero tu sesión no pudo renovarse. Vuelve a iniciar sesión.',
        code: 'session_refresh_failed',
      }
    }
  }

  return { success: true, accounts, persisted: true }
}
