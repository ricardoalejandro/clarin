'use client'

import { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import EditorPopover from '@/components/documents/EditorPopover'
import type { UtilityDisplayStatus } from './UtilityDocumentContext'

export function DocumentModeIndicator({ status }: { status?: UtilityDisplayStatus }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const visible = Boolean(status && (status.lightPanels.length || status.chunkedPanels.length))
  useEffect(() => { if (!visible) setAnchor(null) }, [visible])
  if (!visible || !status) return null
  const panels = [...new Set([...status.lightPanels, ...status.chunkedPanels])].map(panel => panel.toUpperCase()).join(', ')
  const description = `Modo ligero · Panel ${panels}. Se limita el trabajo automático para mantener el editor ágil. El archivo original y la búsqueda completa se conservan.`
  return <>
    <button type="button" aria-label={`Modo ligero · Panel ${panels}`} title={description} aria-description={description}
      aria-haspopup="dialog" aria-expanded={Boolean(anchor)}
      className="utility-control inline-flex shrink-0 items-center justify-center rounded-lg px-1 text-amber-700 outline-none hover:bg-amber-50 focus-visible:ring-2 focus-visible:ring-emerald-600"
      onClick={event => { const target = event.currentTarget; setAnchor(current => current ? null : target) }}><Gauge size={14} aria-hidden /></button>
    {anchor && <EditorPopover anchor={anchor} label="Modo ligero de este documento" onClose={() => setAnchor(null)} width={300}>
      <div className="space-y-2 p-1 text-xs leading-5">
        <p className="font-semibold">Modo ligero · Panel {panels}</p>
        <p>Solo se aplica a los paneles grandes de esta pestaña: desde 8 MiB, 200.000 líneas o líneas excepcionalmente largas.</p>
        {status.lightPanels.length > 0 && <p>JSON/XML mantiene colores básicos. Se reducen plegado, sugerencias y análisis automático; Formatear, Validar y Buscar siguen disponibles.</p>}
        {status.chunkedPanels.length > 0 && <p>Las líneas gigantes se editan por tramos en texto simple. Buscar sigue recorriendo todo el documento.</p>}
        <p>El contenido y su original se conservan. El modo habitual vuelve cuando el panel queda por debajo de estos límites.</p>
        <button type="button" className="utility-control rounded-lg px-2 text-slate-700 hover:bg-slate-100" onClick={() => setAnchor(null)}>Cerrar explicación</button>
      </div>
    </EditorPopover>}
  </>
}
