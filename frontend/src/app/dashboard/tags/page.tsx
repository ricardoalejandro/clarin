'use client'

import { useEffect, useState, useCallback } from 'react'
import { Plus, Trash2, Edit, Tag, Palette, X, Check } from 'lucide-react'

interface TagItem {
  id: string
  account_id: string
  name: string
  color: string
  created_at: string
  updated_at: string
}

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#64748b',
]

export default function TagsPage() {
  const [tags, setTags] = useState<TagItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingTag, setEditingTag] = useState<TagItem | null>(null)
  const [formName, setFormName] = useState('')
  const [formColor, setFormColor] = useState('#6366f1')

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch('/api/tags', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setTags(data.tags || [])
    } catch (err) {
      console.error('Failed to fetch tags:', err)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { fetchTags() }, [fetchTags])

  const handleCreate = async () => {
    if (!formName.trim()) return
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: formName.trim(), color: formColor }),
      })
      const data = await res.json()
      if (data.success) {
        setShowCreateModal(false)
        setFormName('')
        setFormColor('#6366f1')
        fetchTags()
      } else {
        alert(data.error || 'Error al crear etiqueta')
      }
    } catch {
      alert('Error al crear etiqueta')
    }
  }

  const handleUpdate = async () => {
    if (!editingTag || !formName.trim()) return
    try {
      const res = await fetch(`/api/tags/${editingTag.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: formName.trim(), color: formColor }),
      })
      const data = await res.json()
      if (data.success) {
        setEditingTag(null)
        setFormName('')
        setFormColor('#6366f1')
        fetchTags()
      } else {
        alert(data.error || 'Error al actualizar etiqueta')
      }
    } catch {
      alert('Error al actualizar etiqueta')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar esta etiqueta? Se removerá de todos los contactos, leads y chats.')) return
    try {
      const res = await fetch(`/api/tags/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) fetchTags()
      else alert(data.error || 'Error al eliminar etiqueta')
    } catch {
      alert('Error al eliminar etiqueta')
    }
  }

  const openEdit = (tag: TagItem) => {
    setEditingTag(tag)
    setFormName(tag.name)
    setFormColor(tag.color)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6 overflow-y-auto flex-1 min-h-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Etiquetas</h1>
          <p className="text-gray-600 mt-1">{tags.length} etiquetas globales — se comparten en contactos, leads y chats</p>
        </div>
        <button
          onClick={() => { setFormName(''); setFormColor('#6366f1'); setShowCreateModal(true) }}
          className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
        >
          <Plus className="w-5 h-5" />
          Nueva Etiqueta
        </button>
      </div>

      {/* Tags grid */}
      {tags.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Tag className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900">Sin etiquetas</h3>
          <p className="text-gray-500 mt-1">Crea etiquetas para organizar tus contactos, leads y chats</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {tags.map(tag => (
            <div
              key={tag.id}
              className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition group"
            >
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-8 h-8 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="font-medium text-gray-900 truncate">{tag.name}</span>
              </div>
              <div className="flex items-center justify-end gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => openEdit(tag)}
                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                  title="Editar"
                >
                  <Edit className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(tag.id)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                  title="Eliminar"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {(showCreateModal || editingTag) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <h2 className="text-xl font-bold text-gray-900 mb-4">
              {editingTag ? 'Editar Etiqueta' : 'Nueva Etiqueta'}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 text-gray-900"
                  placeholder="Ej: VIP, Urgente, Nuevo..."
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') editingTag ? handleUpdate() : handleCreate()
                  }}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => setFormColor(color)}
                      className={`w-8 h-8 rounded-full border-2 transition ${
                        formColor === color ? 'border-gray-900 scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                    >
                      {formColor === color && <Check className="w-4 h-4 text-white mx-auto" />}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vista previa</label>
                <span
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-white text-sm font-medium"
                  style={{ backgroundColor: formColor }}
                >
                  {formName || 'Etiqueta'}
                </span>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowCreateModal(false); setEditingTag(null) }}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={editingTag ? handleUpdate : handleCreate}
                disabled={!formName.trim()}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {editingTag ? 'Guardar' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
