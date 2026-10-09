export const contactCreationLimits = {
  phone: 50,
  name: 255,
  last_name: 255,
  email: 255,
  company: 255,
  dni: 50,
  distrito: 255,
  ocupacion: 255,
} as const

export interface ContactCreationForm {
  phone: string
  name: string
  last_name: string
  email: string
  company: string
  dni: string
  birth_date: string
  notes: string
  distrito?: string
  ocupacion?: string
}

const fieldLabels: Record<keyof typeof contactCreationLimits, string> = {
  phone: 'El teléfono', name: 'El nombre', last_name: 'El apellido',
  email: 'El correo', company: 'La empresa', dni: 'El DNI',
  distrito: 'El distrito', ocupacion: 'La ocupación',
}

export function validateContactCreation(form: ContactCreationForm): string | null {
  if (!form.phone.trim() && !form.name.trim()) return 'Se requiere teléfono o nombre'
  for (const field of Object.keys(contactCreationLimits) as (keyof typeof contactCreationLimits)[]) {
    if (Array.from((form[field] ?? '').trim()).length > contactCreationLimits[field]) {
      return `${fieldLabels[field]} admite como máximo ${contactCreationLimits[field]} caracteres.`
    }
  }
  return null
}

export function canAddContactCreationTag(name: string, available: { name: string }[], canCreate: boolean): boolean {
  return Boolean(name.trim()) && (canCreate || findContactCreationTag(name, available) !== undefined)
}

export function findContactCreationTag<T extends { name: string }>(name: string, available: T[]): T | undefined {
  const normalized = name.trim().toLocaleLowerCase('es')
  return available.find(tag => tag.name.trim().toLocaleLowerCase('es') === normalized)
}
