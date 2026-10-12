'use client'

import { useState, useEffect } from 'react'
import { X, UserPlus, Phone, Tag, Loader2 } from 'lucide-react'
import CatalogTagPicker from '@/components/tags/CatalogTagPicker'
import { tagSelectionIds } from '@/components/tags/tagFormAdapters'
import type { TagPickerItem } from '@/components/tags/TagPicker'
import { subscribeAuthScope } from '@/lib/authScope'
import { contactCreationLimits, validateContactCreation } from './contact-details/contactCreation'

interface Props {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

export default function CreateContactModal({ open, onClose, onSuccess }: Props) {
  const [form, setForm] = useState({
    phone: '',
    name: '',
    last_name: '',
    email: '',
    company: '',
    dni: '',
    birth_date: '',
    notes: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [creatingTag, setCreatingTag] = useState(false)
  const [selectedTags, setSelectedTags] = useState<TagPickerItem[]>([])
  useEffect(() => { if (!open) setSelectedTags([]) }, [open])
  useEffect(() => subscribeAuthScope(() => { setSelectedTags([]); setError('La sesión cambió. Vuelve a abrir el formulario.') }), [])

  const handleChange = (field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }))
    if (error) setError('')
  }

  const handleSubmit = async () => {
    if (loading || creatingTag) return
    const phone = form.phone.trim()
    const validationError = validateContactCreation(form)
    if (validationError) {
      setError(validationError)
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          name: form.name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim(),
          company: form.company.trim(),
          dni: form.dni.trim(),
          birth_date: form.birth_date || undefined,
          notes: form.notes.trim(),
          tag_ids: tagSelectionIds(selectedTags),
        }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Error al crear el contacto')
        return
      }
      setForm({ phone: '', name: '', last_name: '', email: '', company: '', dni: '', birth_date: '', notes: '' })
      setSelectedTags([])
      onSuccess()
      onClose()
    } catch {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const inputCls = "w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"

  return (
    <div className="responsive-dialog-backdrop fixed inset-0 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div role="dialog" aria-modal="true" aria-label="Nuevo contacto" className="responsive-dialog-panel relative flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:max-h-[90vh]">

        {/* Header */}
        <div className="safe-area-top flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center">
              <UserPlus className="w-4 h-4 text-emerald-600" />
            </div>
            <div>
              <h2 className="text-slate-900 font-semibold text-sm">Nuevo contacto</h2>
              <p className="text-slate-500 text-xs">Crear contacto manualmente</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 sm:h-8 sm:w-8 sm:rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — 2 columns */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {error && <p className="text-red-500 text-xs mb-3 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            {/* ── Left column ── */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Teléfono
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="tel"
                    maxLength={contactCreationLimits.phone * 2}
                    placeholder="9XXXXXXXX o 519XXXXXXXX"
                    value={form.phone}
                    onChange={e => handleChange('phone', e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    className={`${inputCls} pl-9`}
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Nombre</label>
                <input type="text" maxLength={contactCreationLimits.name * 2} placeholder="Juan" value={form.name} onChange={e => handleChange('name', e.target.value)} className={inputCls} />
                <p className="text-[10px] text-slate-400 mt-0.5">Se guarda como nombre personalizado</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Apellido</label>
                <input type="text" maxLength={contactCreationLimits.last_name * 2} placeholder="Pérez" value={form.last_name} onChange={e => handleChange('last_name', e.target.value)} className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Correo</label>
                <input type="email" maxLength={contactCreationLimits.email * 2} placeholder="email@ejemplo.com" value={form.email} onChange={e => handleChange('email', e.target.value)} className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Empresa</label>
                <input type="text" maxLength={contactCreationLimits.company * 2} placeholder="Empresa S.A." value={form.company} onChange={e => handleChange('company', e.target.value)} className={inputCls} />
              </div>
            </div>

            {/* ── Right column ── */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">DNI</label>
                <input type="text" maxLength={contactCreationLimits.dni * 2} placeholder="12345678" value={form.dni} onChange={e => handleChange('dni', e.target.value)} className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Fecha de nacimiento</label>
                <input type="date" value={form.birth_date} onChange={e => handleChange('birth_date', e.target.value)} className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Notas</label>
                <textarea placeholder="Notas adicionales..." value={form.notes} onChange={e => handleChange('notes', e.target.value)} rows={3} className={`${inputCls} resize-none`} />
              </div>

              {/* Tags */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-2">
                  <Tag className="w-3.5 h-3.5 text-emerald-500" />
                  Etiquetas
                </label>
                <CatalogTagPicker contextType="contact_create" selected={selectedTags} onChange={setSelectedTags} onCreatingChange={setCreatingTag} disabled={loading} />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="safe-area-bottom flex shrink-0 items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:px-6 sm:py-4">
          <button onClick={onClose} className="min-h-11 flex-1 rounded-lg px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-800 sm:flex-none">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || creatingTag || (!form.phone.trim() && !form.name.trim())}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            {loading ? 'Guardando…' : 'Crear contacto'}
          </button>
        </div>
      </div>
    </div>
  )
}
