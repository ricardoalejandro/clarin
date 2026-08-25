export type ManualProgressValidation =
  | { valid: true; value: number; error: '' }
  | { valid: false; value: null; error: string }

export function validateManualProgress(value: string): ManualProgressValidation {
  const normalized = value.trim()
  if (!normalized) return { valid: false, value: null, error: 'Ingresa un porcentaje entre 0 y 100.' }
  if (!/^\d+$/.test(normalized)) return { valid: false, value: null, error: 'Usa un número entero entre 0 y 100.' }
  const parsed = Number(normalized)
  if (parsed < 0 || parsed > 100) return { valid: false, value: null, error: 'El porcentaje debe estar entre 0 y 100.' }
  return { valid: true, value: parsed, error: '' }
}
