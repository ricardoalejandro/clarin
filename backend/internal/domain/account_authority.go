package domain

// HasAccountAdminAuthority is the canonical account-scoped administrator
// decision. The legacy users.is_admin column mirrors the user's default
// account for old clients and must never be used as authority in another
// account. A global super administrator remains authoritative everywhere;
// otherwise only the role of the membership in the active account applies.
func HasAccountAdminAuthority(accountRole string, globalSuperAdmin bool) bool {
	return globalSuperAdmin || accountRole == RoleAdmin || accountRole == RoleSuperAdmin
}
