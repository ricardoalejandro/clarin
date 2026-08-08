'use client'

import { GripVertical } from 'lucide-react'
import { operationalDragStackLayers } from './operationalDragStack'

type Props = {
  label: string
  count?: number
  singular: string
  plural: string
  destination?: string
  destinationColor?: string
}

export default function OperationalDragOverlay({ label, count = 1, singular, plural, destination, destinationColor }: Props) {
  const layers = operationalDragStackLayers(count)
  return (
    <div data-operational-drag-overlay className="relative h-[92px] w-[284px] motion-reduce:transition-none" aria-label={`${count} ${count === 1 ? singular : plural} seleccionad${count === 1 ? 'o' : 'os'}`}>
      {layers.map(layer => <div key={layer.index} className="absolute inset-0 rounded-xl border bg-white p-3 shadow-2xl shadow-slate-900/20 transition-[transform,background-color,border-color] duration-150 motion-reduce:transform-none" style={{ transform: `translate(${layer.x}px, ${layer.y}px) rotate(${layer.rotation}deg)`, opacity: layer.opacity, zIndex: 10 - layer.index, borderColor: destinationColor || '#6ee7b7', backgroundColor: destinationColor ? `${destinationColor}12` : '#ffffff' }}>
        {layer.index === 0 && <><div className="flex items-start gap-2"><GripVertical className="mt-0.5 h-4 w-4 text-emerald-500" /><p className="line-clamp-2 text-sm font-semibold text-slate-800">{label}</p></div><p className="ml-6 mt-2 truncate text-[10px] font-semibold text-slate-500">{destination ? `Mover a ${destination}` : 'Elige una etapa de destino'}</p></>}
      </div>)}
      {count > 1 && <span className="absolute -right-3 -top-3 z-20 rounded-full bg-slate-900 px-2.5 py-1 text-xs font-black text-white shadow-lg">{count} {plural}</span>}
    </div>
  )
}
