import { describe, expect, it } from 'vitest'
import { canonicalTaskIdentityColor, resolveTaskIdentityColor, taskIdentityTint } from './taskIdentityColor'

describe('task identity color', () => {
	it('normalizes safe colors and rejects arbitrary CSS', () => {
		expect(canonicalTaskIdentityColor(' #10b981 ')).toBe('#10B981')
		expect(canonicalTaskIdentityColor('linear-gradient(red, blue)')).toBeNull()
		expect(canonicalTaskIdentityColor('#123456AA')).toBeNull()
	})

	it('resolves item, list and default precedence', () => {
		expect(resolveTaskIdentityColor('#DC2626', '#10B981')).toEqual({ color: '#DC2626', source: 'item' })
		expect(resolveTaskIdentityColor(null, '#10b981')).toEqual({ color: '#10B981', source: 'list' })
		expect(resolveTaskIdentityColor(null, null)).toEqual({ color: '#64748B', source: 'default' })
	})

	it('builds a bounded CSS hex tint from a validated color', () => {
		expect(taskIdentityTint('#10B981', 0.12)).toBe('#10B9811F')
		expect(taskIdentityTint('#10B981', 2)).toBe('#10B981FF')
	})
})
