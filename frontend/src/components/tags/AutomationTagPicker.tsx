'use client'
import CatalogTagPicker from './CatalogTagPicker'
import { automationTagId } from './tagFormAdapters'
export default function AutomationTagPicker({ data, onChange, sessionKey, onCreatingChange }: { data: Record<string, unknown>; onChange: (id: string) => void; sessionKey: string; onCreatingChange?: (creating: boolean) => void }) {
  const id = automationTagId(data)
  return <div><p className="text-xs font-medium text-slate-600">Etiqueta</p><CatalogTagPicker contextType="automation" sessionKey={sessionKey} mode="single" onCreatingChange={onCreatingChange} selected={id ? [{ id, name: '', color: '#64748B' }] : []} onChange={tags => onChange(tags[0]?.id || '')} /><p className="mt-2 text-xs text-slate-400">Selecciona una etiqueta para configurar la acción. Puedes dejarla vacía mientras el flujo sea un borrador inactivo.</p></div>
}
