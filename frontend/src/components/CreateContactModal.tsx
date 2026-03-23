'use client'

import { useState, useEffect } from 'react'
import { X, UserPlus, Phone, Tag, Loader2, Plus } from 'lucide-react'

interface StructuredTag {
  id: string
  name: string
  color: string
}

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

  // Tag state
  const [allTags, setAllTags] = useState<StructuredTag[]>([])
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [loadingTags, setLoadingTags] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoadingTags(true)
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
    fetch('/api/tags', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json())
      .then(d => { if (d.success) setAllTags(d.tags || []) })
      .catch(() => {})
      .finally(() => setLoadingTags(false))
  }, [open])

  const handleChange = (field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }))
    if (error) setError('')
  }

  const toggleTag = (id: string) => {
    setSelectedTagIds(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    )
  }

  const addCustomTag = () => {
    const name = tagInput.trim()
    if (!name) return
    const existing = allTags.find(t => t.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (!selectedTagIds.includes(existing.id)) {
        setSelectedTagIds(prev => [...prev, existing.id])
      }
    } else {
      const tempId = `__custom__${name}`
      if (!allTags.find(t => t.id === tempId)) {
        setAllTags(prev => [...prev, { id: tempId, name, color: '#6b7280' }])
      }
      if (!selectedTagIds.includes(tempId)) {
        setSelectedTagIds(prev => [...prev, tempId])
      }
    }
    setTagInput('')
  }

  const removeTag = (id: string) => {
    setSelectedTagIds(prev => prev.filter(t => t !== id))
  }

  const handleSubmit = async () => {
    const phone = form.phone.trim()
    if (!phone) {
      setError('El teléfono es obligatorio')
      return
    }

    setLoading(true)
    setError('')
    try {
      const realTagIds = selectedTagIds.filter(id => !id.startsWith('__custom__'))
      const customTagNames = selectedTagIds
        .filter(id => id.startsWith('__custom__'))
        .map(id => id.replace('__custom__', ''))
      const existingTagNames = allTags
        .filter(t => realTagIds.includes(t.id))
        .map(t => t.name)

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
          tags: [...existingTagNames, ...customTagNames],
          tag_ids: realTagIds,
        }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Error al crear el contacto')
        return
      }
      setForm({ phone: '', name: '', last_name: '', email: '', company: '', dni: '', birth_date: '', notes: '' })
      setSelectedTagIds([])
      setTagInput('')
      onSuccess()
      onClose()
    } catch {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const selectedTags = allTags.filter(t => selectedTagIds.includes(t.id))
  const unselectedTags = allTags.filter(t => !selectedTagIds.includes(t.id))
  const filteredUnselected = unselectedTags.filter(t =>
    !tagInput.trim() || t.name.toLowerCase().includes(tagInput.trim().toLowerCase())
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
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
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">

          {/* Phone */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Teléfono <span className="text-emerald-500">*</span>
            </label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="tel"
                placeholder="9XXXXXXXX o 519XXXXXXXX"
                value={form.phone}
                onChange={e => handleChange('phone', e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
                autoFocus
              />
            </div>
            {error && <p className="text-red-500 text-xs mt-1.5">{error}</p>}
          </div>

          {/* Name + Last name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Nombre</label>
              <input
                type="text"
                placeholder="Juan"
                value={form.name}
                onChange={e => handleChange('name', e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">Se guarda como nombre personalizado</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Apellido</label>
              <input
                type="text"
                placeholder="Pérez"
                value={form.last_name}
                onChange={e => handleChange('last_name', e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
              />
            </div>
          </div>

          {/* Email + Company */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Correo</label>
              <input
                type="email"
                placeholder="email@ejemplo.com"
                value={form.email}
                onChange={e => handleChange('email', e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Empresa</label>
              <input
                type="text"
                placeholder="Empresa S.A."
                value={form.company}
                onChange={e => handleChange('company', e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
              />
            </div>
          </div>

          {/* DNI + Fecha de nacimiento */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">DNI</label>
              <input
                type="text"
                placeholder="12345678"
                value={form.dni}
                onChange={e => handleChange('dni', e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Fecha de nacimiento</label>
              <input
                type="date"
                value={form.birth_date}
                onChange={e => handleChange('birth_date', e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all"
              />
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-2">
              <Tag className="w-3.5 h-3.5 text-emerald-500" />
              Etiquetas
            </label>

            {/* Selected tag chips */}
            {selectedTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedTags.map(tag => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: tag.color || '#6b7280' }}
                  >
                    {tag.name}
                    <button
                      onClick={() => removeTag(tag.id)}
                      className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-black/20 transition-colors"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Tag search / add input */}
            <div className="relative">
              <input
                type="text"
                placeholder={loadingTags ? 'Cargando etiquetas...' : 'Buscar o crear etiqueta...'}
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); addCustomTag() }
                }}
                disabled={loadingTags}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all disabled:opacity-50"
              />
              {tagInput.trim() && (
                <button
                  onClick={addCustomTag}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                  title="Añadir etiqueta"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Existing tags */}
            {!loadingTags && filteredUnselected.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {filteredUnselected.slice(0, 20).map(tag => (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border hover:shadow-sm transition-all"
                    style={{ borderColor: tag.color || '#d1d5db', color: tag.color || '#6b7280', backgroundColor: `${tag.color}10` }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: tag.color || '#6b7280' }}
                    />
                    {tag.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Notas</label>
            <textarea
              placeholder="Notas adicionales..."
              value={form.notes}
              onChange={e => handleChange('notes', e.target.value)}
              rows={2}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-sm placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/25 transition-all resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-3 bg-slate-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 transition-colors rounded-lg hover:bg-slate-100"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !form.phone.trim()}
            className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <UserPlus className="w-4 h-4" />
            )}
            {loading ? 'Guardando…' : 'Crear contacto'}
          </button>
        </div>
      </div>
    </div>
  )
}
