"use client";

import { useState, useEffect } from 'react';
import { Plus, Search, ClipboardList, Trash2, Copy, ExternalLink, BarChart3, FileText, CheckCircle2, PenLine, XCircle, MoreVertical, Eye } from 'lucide-react';
import { api } from '@/lib/api';
import { Survey } from '@/types/survey';
import Link from 'next/link';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: React.ReactNode }> = {
  draft:  { label: 'Borrador', bg: 'bg-slate-100',   text: 'text-slate-600',   icon: <PenLine className="w-3 h-3" /> },
  active: { label: 'Activa',   bg: 'bg-emerald-50',  text: 'text-emerald-700', icon: <CheckCircle2 className="w-3 h-3" /> },
  closed: { label: 'Cerrada',  bg: 'bg-red-50',      text: 'text-red-600',     icon: <XCircle className="w-3 h-3" /> },
};

export default function SurveysPage() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newSurvey, setNewSurvey] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  useEffect(() => {
    fetchSurveys();
  }, []);

  const fetchSurveys = async () => {
    try {
      setLoading(true);
      const response = await api<Survey[]>('/api/surveys');
      if (response.success) {
        setSurveys(response.data || []);
      }
    } catch (error) {
      console.error('Error fetching surveys:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSurvey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSurvey.name.trim()) return;
    setCreating(true);
    try {
      const response = await api<Survey>('/api/surveys', {
        method: 'POST',
        body: JSON.stringify(newSurvey),
      });
      if (response.success && response.data) {
        setIsCreateModalOpen(false);
        setNewSurvey({ name: '', description: '' });
        // Navigate to builder
        window.location.href = `/dashboard/surveys/${response.data.id}`;
      }
    } catch (error) {
      console.error('Error creating survey:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteSurvey = async (id: string) => {
    if (!confirm('¿Estás seguro de eliminar esta encuesta? Se eliminarán todas las preguntas y respuestas.')) return;
    try {
      await api(`/api/surveys/${id}`, { method: 'DELETE' });
      fetchSurveys();
    } catch (error) {
      console.error('Error deleting survey:', error);
    }
    setMenuOpen(null);
  };

  const handleDuplicate = async (id: string) => {
    try {
      const res = await api<Survey>(`/api/surveys/${id}/duplicate`, { method: 'POST' });
      if (res.success) {
        fetchSurveys();
      }
    } catch (error) {
      console.error('Error duplicating survey:', error);
    }
    setMenuOpen(null);
  };

  const handleToggleStatus = async (survey: Survey) => {
    const newStatus = survey.status === 'active' ? 'closed' : 'active';
    try {
      await api(`/api/surveys/${survey.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      fetchSurveys();
    } catch (error) {
      console.error('Error updating status:', error);
    }
    setMenuOpen(null);
  };

  const copyLink = (slug: string) => {
    const url = `${window.location.origin}/f/${slug}`;
    navigator.clipboard.writeText(url);
    setMenuOpen(null);
  };

  const filteredSurveys = surveys.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (searchQuery && !s.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 p-6 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
              <ClipboardList className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Encuestas</h1>
              <p className="text-sm text-slate-500">{surveys.length} encuesta{surveys.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Nueva encuesta
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar encuestas..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
          </div>
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            {['all', 'draft', 'active', 'closed'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  statusFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {s === 'all' ? 'Todas' : STATUS_CONFIG[s]?.label || s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 p-5 animate-pulse">
                <div className="h-5 bg-slate-200 rounded w-3/4 mb-3" />
                <div className="h-3 bg-slate-100 rounded w-1/2 mb-4" />
                <div className="flex gap-4">
                  <div className="h-3 bg-slate-100 rounded w-16" />
                  <div className="h-3 bg-slate-100 rounded w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredSurveys.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
              <ClipboardList className="w-8 h-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-semibold text-slate-700 mb-1">
              {searchQuery || statusFilter !== 'all' ? 'Sin resultados' : 'No hay encuestas'}
            </h3>
            <p className="text-sm text-slate-500 mb-4">
              {searchQuery || statusFilter !== 'all'
                ? 'Intenta con otros filtros'
                : 'Crea tu primera encuesta para empezar a recopilar datos'}
            </p>
            {!searchQuery && statusFilter === 'all' && (
              <button
                onClick={() => setIsCreateModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm"
              >
                <Plus className="w-4 h-4" />
                Crear encuesta
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSurveys.map((survey) => {
              const statusCfg = STATUS_CONFIG[survey.status] || STATUS_CONFIG.draft;
              return (
                <Link key={survey.id} href={`/dashboard/surveys/${survey.id}`}>
                  <div className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md hover:border-emerald-200 transition-all cursor-pointer group relative">
                    {/* Menu */}
                    <div className="absolute top-3 right-3">
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(menuOpen === survey.id ? null : survey.id); }}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {menuOpen === survey.id && (
                        <div className="absolute right-0 top-9 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-48 z-20">
                          {survey.status === 'active' && (
                            <button
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyLink(survey.slug); }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <ExternalLink className="w-4 h-4" /> Copiar enlace
                            </button>
                          )}
                          {survey.status === 'active' && (
                            <a
                              href={`/f/${survey.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            >
                              <Eye className="w-4 h-4" /> Ver formulario
                            </a>
                          )}
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleToggleStatus(survey); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                          >
                            {survey.status === 'active' ? <XCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                            {survey.status === 'active' ? 'Cerrar' : 'Activar'}
                          </button>
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDuplicate(survey.id); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                          >
                            <Copy className="w-4 h-4" /> Duplicar
                          </button>
                          {!survey.is_template && (
                            <>
                              <hr className="my-1 border-slate-100" />
                              <button
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteSurvey(survey.id); }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                              >
                                <Trash2 className="w-4 h-4" /> Eliminar
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Status badge */}
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}>
                        {statusCfg.icon} {statusCfg.label}
                      </span>
                      {survey.is_template && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                          ★ Modelo
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <h3 className="font-semibold text-slate-900 mb-1 line-clamp-1 pr-8">{survey.name}</h3>
                    {survey.description && (
                      <p className="text-sm text-slate-500 line-clamp-2 mb-3">{survey.description}</p>
                    )}

                    {/* Stats */}
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5" />
                        {survey.question_count || 0} preguntas
                      </span>
                      <span className="flex items-center gap-1">
                        <BarChart3 className="w-3.5 h-3.5" />
                        {survey.response_count || 0} respuestas
                      </span>
                    </div>

                    {/* Footer */}
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-xs text-slate-400">
                        {format(new Date(survey.created_at), "d MMM yyyy", { locale: es })}
                      </span>
                      <span className="text-xs text-slate-400 font-mono">/{survey.slug}</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setIsCreateModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Nueva encuesta</h2>
              <form onSubmit={handleCreateSurvey}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
                    <input
                      autoFocus
                      type="text"
                      value={newSurvey.name}
                      onChange={(e) => setNewSurvey({ ...newSurvey, name: e.target.value })}
                      placeholder="Ej: Encuesta de satisfacción"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Descripción (opcional)</label>
                    <textarea
                      value={newSurvey.description}
                      onChange={(e) => setNewSurvey({ ...newSurvey, description: e.target.value })}
                      placeholder="¿De qué trata esta encuesta?"
                      rows={3}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3 mt-6">
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(false)}
                    className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={!newSurvey.name.trim() || creating}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creating ? 'Creando...' : 'Crear encuesta'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Close menu on click outside */}
      {menuOpen && (
        <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
      )}
    </div>
  );
}
