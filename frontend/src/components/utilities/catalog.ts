export const UTILITIES_HREF = '/dashboard/utilities'
export const UTILITIES_PERMISSION = 'utilities'

export const utilities = [
  { id: 'json', title: 'Editor JSON y XML', description: 'Edita, valida, formatea y compara documentos JSON y XML.' },
  { id: 'qr', title: 'Códigos QR', description: 'Genera un código o lee uno desde una imagen.' },
  { id: 'imagen-base64', title: 'Imagen ⇄ Base64', description: 'Convierte una imagen en texto Base64 y vuelve a abrirla.' },
  { id: 'criptografia', title: 'Criptografía', description: 'Cifra datos, genera claves y trabaja con hashes o Base64.' },
] as const

export type Utility = typeof utilities[number]

export function utilityById(id: string) {
  return utilities.find(utility => utility.id === id)
}

export function isUtilitiesPath(path: string) {
  return path === UTILITIES_HREF || path.startsWith(`${UTILITIES_HREF}/`)
}

export function canUseUtilities(user: { is_admin?: boolean; is_super_admin?: boolean; permissions?: string[] }) {
  return Boolean(user.is_admin || user.is_super_admin || user.permissions?.includes('*') || user.permissions?.includes(UTILITIES_PERMISSION))
}
