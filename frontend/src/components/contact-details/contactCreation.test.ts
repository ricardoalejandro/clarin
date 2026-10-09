import { describe, expect, it } from 'vitest'
import { canAddContactCreationTag, contactCreationLimits, validateContactCreation } from './contactCreation'

const empty = { phone: '', name: 'Synthetic', last_name: '', email: '', company: '', dni: '', birth_date: '', notes: '' }

describe('Contact creation contract', () => {
  it.each(Object.entries(contactCreationLimits))('accepts exactly the schema limit for %s and rejects the next character', (field, limit) => {
    expect(validateContactCreation({ ...empty, [field]: 'ñ'.repeat(limit) })).toBeNull()
    expect(validateContactCreation({ ...empty, [field]: 'ñ'.repeat(limit + 1) })).toContain(`${limit} caracteres`)
  })

  it('counts Unicode code points like PostgreSQL VARCHAR', () => {
    expect(validateContactCreation({ ...empty, last_name: '🙂'.repeat(255) })).toBeNull()
    expect(validateContactCreation({ ...empty, last_name: '🙂'.repeat(256) })).toContain('255 caracteres')
  })

  it('requires a phone or name and leaves text notes unrestricted', () => {
    expect(validateContactCreation({ ...empty, name: ' ' })).toContain('teléfono o nombre')
    expect(validateContactCreation({ ...empty, notes: 'n'.repeat(1000) })).toBeNull()
  })

  it('lets a Contacts-only actor select existing tags but never invent a new tag', () => {
    expect(canAddContactCreationTag(' PRIORIDAD ', [{ name: 'Prioridad' }], false)).toBe(true)
    expect(canAddContactCreationTag('Nueva', [{ name: 'Prioridad' }], false)).toBe(false)
    expect(canAddContactCreationTag('Nueva', [], true)).toBe(true)
    expect(canAddContactCreationTag(' ', [], true)).toBe(false)
  })
})
