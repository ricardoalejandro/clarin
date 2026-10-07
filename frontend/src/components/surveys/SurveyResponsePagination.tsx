interface SurveyResponsePaginationProps {
  page: number
  total: number
  loading: boolean
  onPageChange: (page: number) => void
}

export default function SurveyResponsePagination({ page, total, loading, onPageChange }: SurveyResponsePaginationProps) {
  if (total <= 50) return null
  const buttonClass = 'min-h-11 min-w-11 rounded-lg bg-slate-100 px-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40'
  return <nav aria-label="Paginación de respuestas" className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
    <p className="min-w-0 text-xs text-slate-400">Mostrando {page * 50 + 1}-{Math.min((page + 1) * 50, total)} de {total}</p>
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:w-auto">
      <button type="button" onClick={() => onPageChange(page - 1)} disabled={loading || page === 0} className={buttonClass}>Anterior</button>
      <span className="whitespace-nowrap text-center text-xs tabular-nums text-slate-500">Página {page + 1} de {Math.ceil(total / 50)}</span>
      <button type="button" onClick={() => onPageChange(page + 1)} disabled={loading || (page + 1) * 50 >= total} className={buttonClass}>Siguiente</button>
    </div>
  </nav>
}
