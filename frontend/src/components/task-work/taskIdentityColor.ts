export const TASK_DEFAULT_IDENTITY_COLOR = '#64748B'

const COLOR_PATTERN = /^#[0-9A-F]{6}$/

export function canonicalTaskIdentityColor(value?: string | null) {
	const normalized = value?.trim().toUpperCase() || ''
	return COLOR_PATTERN.test(normalized) ? normalized : null
}

export function resolveTaskIdentityColor(itemColor?: string | null, listColor?: string | null, fallback = TASK_DEFAULT_IDENTITY_COLOR) {
	const item = canonicalTaskIdentityColor(itemColor)
	if (item) return { color: item, source: 'item' as const }
	const list = canonicalTaskIdentityColor(listColor)
	if (list) return { color: list, source: 'list' as const }
	return { color: canonicalTaskIdentityColor(fallback) || TASK_DEFAULT_IDENTITY_COLOR, source: 'default' as const }
}

export function taskIdentityTint(value: string, alpha = 0.12) {
	const color = canonicalTaskIdentityColor(value) || TASK_DEFAULT_IDENTITY_COLOR
	const bounded = Math.max(0, Math.min(1, alpha))
	return `${color}${Math.round(bounded * 255).toString(16).padStart(2, '0').toUpperCase()}`
}
