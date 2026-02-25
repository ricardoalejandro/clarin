"use client";

import { useState, useEffect } from 'react';
import { Plus, Search, BookOpen, Users, Calendar, Trash2, GraduationCap, Clock, CheckCircle2, Archive, BarChart3, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Program } from '@/types/program';
import Link from 'next/link';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: React.ReactNode }> = {
  active: { label: 'Activo', bg: 'bg-emerald-50', text: 'text-emerald-700', icon: <CheckCircle2 className="w-3 h-3" /> },
  completed: { label: 'Completado', bg: 'bg-blue-50', text: 'text-blue-700', icon: <Clock className="w-3 h-3" /> },
  archived: { label: 'Archivado', bg: 'bg-slate-100', text: 'text-slate-600', icon: <Archive className="w-3 h-3" /> },
};

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#6366f1', '#ec4899', '#f43f5e', '#f97316', '#f59e0b'];

export default function ProgramsPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newProgram, setNewProgram] = useState({ name: '', description: '', color: '#10b981' });
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetchPrograms();
  }, []);

  const fetchPrograms = async () => {
    try {
      setLoading(true);
      const response = await api<Program[]>('/api/programs');
      if (response.success) {
        setPrograms(response.data || []);
      }
    } catch (error) {
      console.error('Error fetching programs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await api('/api/programs', {
        method: 'POST',
        body: JSON.stringify(newProgram)
      });
      if (response.success) {
        setIsCreateModalOpen(false);
        setNewProgram({ name: '', description: '', color: '#10b981' });
        fetchPrograms();
      }
    } catch (error) {
      console.error('Error creating program:', error);
    }
  };

  const handleDeleteProgram = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('¿Estás seguro de eliminar este programa? Se eliminarán también todos sus participantes, sesiones y asistencia.')) return;
    setDeleting(id);
    try {
      await api(`/api/programs/${id}`, { method: 'DELETE' });
      fetchPrograms();
    } catch (error) {
      console.error('Error deleting program:', error);
    } finally {
      setDeleting(null);
    }
  };

  const filteredPrograms = programs.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const stats = {
    total: programs.length,
    active: programs.filter(p => p.status === 'active').length,
    totalParticipants: programs.reduce((sum, p) => sum + (p.participant_count || 0), 0),
    totalSessions: programs.reduce((sum, p) => sum + (p.session_count || 0), 0),
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <GraduationCap className="w-7 h-7 text-emerald-600" />
            Programas y Clases
          </h1>
          <p className="text-slate-500 mt-1">Gestiona tus cursos, talleres y asistencia</p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm hover:shadow-md font-medium"
        >
          <Plus className="w-4 h-4" />
          Nuevo Programa
        </button>
      </div>

      {/* Stats Cards */}
      {!loading && programs.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{stats.total}</p>
              <p className="text-xs text-slate-500">Programas totales</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{stats.active}</p>
              <p className="text-xs text-slate-500">Programas activos</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
              <Users className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{stats.totalParticipants}</p>
              <p className="text-xs text-slate-500">Participantes totales</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{stats.totalSessions}</p>
              <p className="text-xs text-slate-500">Sesiones totales</p>
            </div>
          </div>
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar programas..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white text-sm transition-all"
          />
        </div>
        <div className="flex gap-1 bg-white border border-slate-200 rounded-xl p-1">
          {[
            { key: 'all', label: 'Todos' },
            { key: 'active', label: 'Activos' },
            { key: 'completed', label: 'Completados' },
            { key: 'archived', label: 'Archivados' },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                statusFilter === f.key
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-6 animate-pulse">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-11 h-11 bg-slate-200 rounded-xl" />
                <div className="flex-1">
                  <div className="h-4 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-slate-100 rounded w-1/3" />
                </div>
              </div>
              <div className="h-3 bg-slate-100 rounded w-full mb-2" />
              <div className="h-3 bg-slate-100 rounded w-2/3 mb-6" />
              <div className="h-8 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      ) : filteredPrograms.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-slate-200">
          <div className="w-20 h-20 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-5">
            <GraduationCap className="w-10 h-10 text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-800 mb-2">
            {searchQuery || statusFilter !== 'all' ? 'Sin resultados' : 'Crea tu primer programa'}
          </h3>
          <p className="text-slate-500 mb-6 max-w-md mx-auto">
            {searchQuery || statusFilter !== 'all'
              ? 'No se encontraron programas con los filtros seleccionados.'
              : 'Organiza cursos, talleres y clases. Controla la asistencia y envía mensajes masivos a los participantes.'}
          </p>
          {!searchQuery && statusFilter === 'all' && (
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium"
            >
              Crear Programa
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredPrograms.map((program) => {
            const status = STATUS_CONFIG[program.status] || STATUS_CONFIG.active;
            const progress = program.session_count && program.session_count > 0
              ? Math.round(((program.session_count || 0) / Math.max(program.session_count || 1, 1)) * 100)
              : 0;
            return (
              <Link href={`/dashboard/programs/${program.id}`} key={program.id}>
                <div className="group bg-white rounded-xl border border-slate-200 p-5 hover:shadow-lg hover:border-slate-300 transition-all duration-200 cursor-pointer h-full flex flex-col relative">
                  {/* Delete button */}
                  <button
                    onClick={(e) => handleDeleteProgram(program.id, e)}
                    className="absolute top-3 right-3 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50 text-slate-400 hover:text-red-500"
                    title="Eliminar programa"
                  >
                    {deleting === program.id ? (
                      <div className="w-4 h-4 border-2 border-red-300 border-t-red-600 rounded-full animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>

                  {/* Program header */}
                  <div className="flex items-start gap-3 mb-3">
                    <div
                      className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0 shadow-sm"
                      style={{ backgroundColor: program.color || '#10b981' }}
                    >
                      {program.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1 pr-6">
                      <h3 className="font-semibold text-slate-800 truncate group-hover:text-emerald-700 transition-colors">
                        {program.name}
                      </h3>
                      <div className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${status.bg} ${status.text} mt-1`}>
                        {status.icon}
                        {status.label}
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <p className="text-slate-500 text-sm mb-4 line-clamp-2 flex-grow leading-relaxed">
                    {program.description || 'Sin descripción'}
                  </p>

                  {/* Schedule info */}
                  {program.schedule_start_date && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-3">
                      <Clock className="w-3 h-3" />
                      <span>
                        {format(new Date(program.schedule_start_date), 'dd MMM', { locale: es })}
                        {program.schedule_end_date && ` - ${format(new Date(program.schedule_end_date), 'dd MMM yyyy', { locale: es })}`}
                      </span>
                    </div>
                  )}

                  {/* Stats footer */}
                  <div className="flex items-center gap-4 text-sm pt-3 border-t border-slate-100">
                    <div className="flex items-center gap-1.5 text-slate-500">
                      <Users className="w-4 h-4 text-slate-400" />
                      <span className="font-medium">{program.participant_count || 0}</span>
                      <span className="text-slate-400 hidden sm:inline">participantes</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-500">
                      <Calendar className="w-4 h-4 text-slate-400" />
                      <span className="font-medium">{program.session_count || 0}</span>
                      <span className="text-slate-400 hidden sm:inline">sesiones</span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-xl font-bold text-slate-800">Nuevo Programa</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateProgram}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre</label>
                  <input
                    type="text"
                    required
                    value={newProgram.name}
                    onChange={(e) => setNewProgram({ ...newProgram, name: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    placeholder="Ej: Taller de Verano 2024"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Descripción</label>
                  <textarea
                    value={newProgram.description}
                    onChange={(e) => setNewProgram({ ...newProgram, description: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all resize-none"
                    rows={3}
                    placeholder="Descripción del programa..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
                  <div className="flex gap-2.5">
                    {COLORS.map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setNewProgram({ ...newProgram, color })}
                        className={`w-9 h-9 rounded-full transition-all ${
                          newProgram.color === color
                            ? 'ring-2 ring-offset-2 ring-slate-400 scale-110'
                            : 'hover:scale-105'
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium"
                >
                  Crear Programa
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
