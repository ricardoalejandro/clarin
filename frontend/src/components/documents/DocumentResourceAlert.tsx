import { AlertCircle, RefreshCw } from 'lucide-react'
import { type DocumentImageLoadError, documentImageIssueReasonLabel } from '@/lib/documents/resourceErrors'

export default function DocumentResourceAlert({ error, onRetry }: {
  error: DocumentImageLoadError
  onRetry: () => void
}) {
  const count = error.issues.length
  const title = error.incomplete
    ? 'No se pudieron cargar algunas imágenes'
    : `No se ${count === 1 ? 'pudo cargar 1 imagen' : `pudieron cargar ${count} imágenes`}`
  const needsSession = error.issues.some(issue => issue.reason === 'unauthorized')
  return (
    <section role="alert" aria-label="Imágenes de la plantilla sin cargar" className="shrink-0 border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <AlertCircle aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-rose-600" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-xs leading-5 text-rose-800">Tu plantilla guardada sigue intacta. Guardar y exportar están deshabilitados para proteger el diseño.</p>
        </div>
        <button onClick={onRetry} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-rose-300 bg-white px-3 font-medium text-rose-800 hover:bg-rose-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600">
          <RefreshCw aria-hidden="true" className="h-4 w-4" />Reintentar
        </button>
      </div>
      <ul aria-label="Imágenes que no cargaron" tabIndex={0} className="mt-2 grid max-h-[24dvh] gap-2 overflow-y-auto overscroll-contain rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-500 sm:grid-cols-2">
        {error.issues.map((issue, index) => (
          <li key={index} className="min-w-0 rounded-lg border border-rose-200/70 bg-white/70 px-3 py-2">
            <p className="break-words text-xs font-semibold [overflow-wrap:anywhere]">{issue.name}</p>
            <p className="mt-0.5 text-xs leading-5 text-rose-800">{documentImageIssueReasonLabel(issue.reason)}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-5 text-rose-800">
        {needsSession
          ? 'Vuelve a iniciar sesión y abre la plantilla otra vez.'
          : 'Reintenta la carga. Si el aviso continúa, pide a quien administra la cuenta que revise el acceso o recupere los archivos originales y sus vínculos.'}
        {error.incomplete && ' La comprobación se detuvo; puede haber más imágenes afectadas.'}
      </p>
    </section>
  )
}
