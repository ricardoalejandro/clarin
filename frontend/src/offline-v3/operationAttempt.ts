import { LocalServiceError } from './types'

export function operationOutcomeIsUnknown(error: unknown) {
  return error instanceof LocalServiceError
    && (error.code === 'local_service_timeout' || error.code === 'local_service_unavailable')
}

export function operationErrorMessage(error: unknown) {
  return operationOutcomeIsUnknown(error)
    ? 'El motor local no confirmó el resultado. Reintenta la misma operación; Clarin usará el mismo identificador y no duplicará el cambio.'
    : (error as Error).message
}
