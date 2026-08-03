export function taskEnvironmentSaveError(status?: number, code?: string, fallback?: string) {
  if (status === 409 && code === 'environment_name_conflict') {
    return 'Ya existe un Entorno activo con ese nombre. Elige otro nombre.'
  }
  if (status === 409) {
    return 'El Entorno cambió en otra sesión. Revisa los datos actuales y vuelve a guardar.'
  }
  return fallback || 'No se pudo guardar el Entorno.'
}
