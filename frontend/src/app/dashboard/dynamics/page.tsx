"use client";

import { useState, useEffect } from 'react';
import { Plus, Search, Sparkles, Trash2, ExternalLink, MoreVertical, Eye, EyeOff, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { Dynamic, DEFAULT_CONFIG } from '@/types/dynamic';
import Link from 'next/link';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const TYPE_LABELS: Record<string, string> = {
  scratch_card: 'Raspa y Descubre',
};

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export default function DynamicsPage() {
  const [dynamics, setDynamics] = useState<Dynamic[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newDynamic, setNewDynamic] = useState({ name: '', type: 'scratch_card' });
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  useEffect(() => { fetchDynamics(); }, []);

  const fetchDynamics = async () => {
    try {
      setLoading(true);
      const response = await api<Dynamic[]>('/api/dynamics');
      if (response.success) {
        setDynamics(response.data || []);
      }
    } catch (error) {
      console.error('Error fetching dynamics:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDynamic.name.trim()) return;
    setCreating(true);
    try {
      const slug = generateSlug(newDynamic.name);
      const response = await api<Dynamic>('/api/dynamics', {
        method: 'POST',
        body: JSON.stringify({
          name: newDynamic.name,
          type: newDynamic.type,
          slug,
          config: DEFAULT_CONFIG,
        }),
      });
      if (response.success && response.data) {
        setIsCreateModalOpen(false);
        setNewDynamic({ name: '', type: 'scratch_card' });
        window.location.href = `/dashboard/dynamics/${response.data.id}`;
      }
    } catch (error) {
      console.error('Error creating dynamic:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Estás seguro de eliminar esta dinámica? Se eliminarán todos sus items.')) return;
    try {
      await api(`/api/dynamics/${id}`, { method: 'DELETE' });
      fetchDynamics();
    } catch (error) {
      console.error('Error deleting dynamic:', error);
    }
    setMenuOpen(null);
  };

  const handleToggleActive = async (d: Dynamic) => {
    try {
      await api(`/api/dynamics/${d.id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !d.is_active }),
      });
      fetchDynamics();
    } catch (error) {
      console.error('Error toggling status:', error);
    }
    setMenuOpen(null);
  };

  const copyLink = (slug: string) => {
    const url = `${window.location.origin}/d/${slug}`;
    navigator.clipboard.writeText(url);
    setMenuOpen(null);
  };

  const filtered = dynamics.filter(d =>
    !searchQuery || d.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 p-6 border-b border-slate-200 bg-white rounded-t-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800">Dinámicas</h1>
              <p className="text-sm text-slate-500">Actividades interactivas para compartir</p>
            </div>
          </div>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-xl hover:bg-emerald-700 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nueva Dinámica
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar dinámicas..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-200 border-t-emerald-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="font-medium text-slate-500">
              {searchQuery ? 'No se encontraron dinámicas' : 'Aún no hay dinámicas'}
            </p>
            <p className="text-sm mt-1">
              {searchQuery ? 'Intenta con otro término' : 'Crea tu primera dinámica interactiva'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map(d => (
              <div
                key={d.id}
                className="bg-white border border-slate-200 rounded-2xl p-5 hover:shadow-md hover:border-slate-300 transition-all group relative"
              >
                {/* Menu */}
                <div className="absolute top-3 right-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === d.id ? null : d.id); }}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {menuOpen === d.id && (
                    <div className="absolute right-0 top-8 bg-white border border-slate-200 rounded-xl shadow-lg z-10 py-1 min-w-[160px]">
                      <button onClick={() => handleToggleActive(d)} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2 text-slate-600">
                        {d.is_active ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {d.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                      <button onClick={() => copyLink(d.slug)} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2 text-slate-600">
                        <Copy className="w-3.5 h-3.5" /> Copiar enlace
                      </button>
                      <a href={`/d/${d.slug}`} target="_blank" rel="noopener noreferrer" className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2 text-slate-600">
                        <ExternalLink className="w-3.5 h-3.5" /> Vista previa
                      </a>
                      <hr className="my-1 border-slate-100" />
                      <button onClick={() => handleDelete(d.id)} className="w-full text-left px-3 py-2 text-sm hover:bg-red-50 flex items-center gap-2 text-red-600">
                        <Trash2 className="w-3.5 h-3.5" /> Eliminar
                      </button>
                    </div>
                  )}
                </div>

                <Link href={`/dashboard/dynamics/${d.id}`} className="block">
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full ${
                      d.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {d.is_active ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      {d.is_active ? 'Activa' : 'Borrador'}
                    </span>
                    <span className="text-xs text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full">
                      {TYPE_LABELS[d.type] || d.type}
                    </span>
                  </div>

                  <h3 className="font-semibold text-slate-800 mb-1 group-hover:text-emerald-700 transition-colors">
                    {d.name}
                  </h3>
                  {d.description && (
                    <p className="text-sm text-slate-500 line-clamp-2 mb-3">{d.description}</p>
                  )}

                  <div className="flex items-center justify-between text-xs text-slate-400 mt-3 pt-3 border-t border-slate-100">
                    <span>{d.item_count} {d.item_count === 1 ? 'item' : 'items'}</span>
                    <span>{format(new Date(d.created_at), "d MMM yyyy", { locale: es })}</span>
                  </div>
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-800">Nueva Dinámica</h2>
              <p className="text-sm text-slate-500 mt-1">Selecciona el tipo y nombre para tu actividad</p>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Tipo</label>
                <select
                  value={newDynamic.type}
                  onChange={(e) => setNewDynamic({ ...newDynamic, type: e.target.value })}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
                >
                  <option value="scratch_card">🎴 Raspa y Descubre</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre</label>
                <input
                  type="text"
                  value={newDynamic.name}
                  onChange={(e) => setNewDynamic({ ...newDynamic, name: e.target.value })}
                  placeholder="Ej: Frases Motivacionales"
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
                  autoFocus
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setIsCreateModalOpen(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 text-sm font-medium rounded-xl hover:bg-slate-50 transition-colors">
                  Cancelar
                </button>
                <button type="submit" disabled={creating || !newDynamic.name.trim()} className="flex-1 px-4 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {creating ? 'Creando...' : 'Crear'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
