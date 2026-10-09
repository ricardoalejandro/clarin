export const DEVICE_NAME_MAX_LENGTH = 255

export function deviceNameError(value: string) {
  const name = value.trim()
  if (!name) return 'El nombre del dispositivo es obligatorio'
  if (Array.from(name).length > DEVICE_NAME_MAX_LENGTH) return `El nombre admite hasta ${DEVICE_NAME_MAX_LENGTH} caracteres`
  return ''
}

export function cloudDeviceBadges(device: { api_sending_enabled?: boolean; api_billing_status?: string }) {
  const billing = device.api_billing_status || 'unknown'
  return {
    sending: { enabled: Boolean(device.api_sending_enabled), label: device.api_sending_enabled ? 'Envío activo' : 'Envío inactivo' },
    billing: {
      enabled: ['configured', 'active', 'paid'].includes(billing),
      label: ['configured', 'active', 'paid'].includes(billing) ? 'Facturación configurada' : billing === 'not_configured' ? 'Facturación no configurada' : 'Facturación no verificada',
    },
  }
}

export const CLOUD_DELETION_UNAVAILABLE = 'La baja de canales oficiales todavía no está disponible. El canal se conserva en Clarin y en Meta.'
export const LOCAL_DEVICE_DELETION_MESSAGE = 'Se eliminó el registro local de Clarin y se conservaron sus contactos y chats. No se desvinculó WhatsApp: revisa Dispositivos vinculados en tu teléfono.'
export const DEVICE_DELETION_CONFIRMATION = '¿Eliminar este dispositivo de Clarin? Conservaremos sus contactos y chats. Si existe una sesión disponible, también intentaremos desvincular WhatsApp. Si la sesión local se perdió, retiraremos solo el registro de Clarin; deberás revisar Dispositivos vinculados en WhatsApp.'
