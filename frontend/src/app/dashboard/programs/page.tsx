"use client";

import { useState, useEffect } from 'react';
import { Plus, Search, BookOpen, Users, Calendar, MoreVertical, Edit2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Program } from '@/types/program';
import Link from 'next/link';

export default function ProgramsPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newProgram, setNewProgram] = useState({ name: '', description: '', color: '#10b981' });

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

  const filteredPrograms = programs.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Programas y Clases</h1>
          <p className="text-slate-500">Gestiona tus cursos, talleres y asistencia</p>
        </div>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nuevo Programa
        </button>
      </div>

      <div className="mb-6 relative">
        <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Buscar programas..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
        </div>
      ) : filteredPrograms.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
          <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-slate-800 mb-2">No hay programas</h3>
          <p className="text-slate-500 mb-4">Crea tu primer programa para empezar a gestionar clases y asistencia.</p>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
          >
            Crear Programa
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredPrograms.map((program) => (
            <Link href={`/dashboard/programs/${program.id}`} key={program.id}>
              <div className="bg-white rounded-xl border border-slate-200 p-6 hover:shadow-md transition-shadow cursor-pointer h-full flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-lg"
                      style={{ backgroundColor: program.color || '#10b981' }}
                    >
                      {program.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <h3 className="font-semibold text-slate-800 line-clamp-1">{program.name}</h3>
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        program.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                        program.status === 'completed' ? 'bg-blue-100 text-blue-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {program.status === 'active' ? 'Activo' : program.status === 'completed' ? 'Completado' : 'Archivado'}
                      </span>
                    </div>
                  </div>
                </div>
                
                <p className="text-slate-600 text-sm mb-6 line-clamp-2 flex-grow">
                  {program.description || 'Sin descripción'}
                </p>
                
                <div className="flex items-center gap-4 text-sm text-slate-500 pt-4 border-t border-slate-100">
                  <div className="flex items-center gap-1">
                    <Users className="w-4 h-4" />
                    <span>{program.participant_count || 0}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="w-4 h-4" />
                    <span>{program.session_count || 0}</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-800 mb-4">Nuevo Programa</h2>
            <form onSubmit={handleCreateProgram}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
                  <input
                    type="text"
                    required
                    value={newProgram.name}
                    onChange={(e) => setNewProgram({ ...newProgram, name: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="Ej: Taller de Verano 2024"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
                  <textarea
                    value={newProgram.description}
                    onChange={(e) => setNewProgram({ ...newProgram, description: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    rows={3}
                    placeholder="Descripción del programa..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Color</label>
                  <div className="flex gap-2">
                    {['#10b981', '#3b82f6', '#8b5cf6', '#6366f1', '#ec4899', '#f43f5e', '#f97316', '#f59e0b'].map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setNewProgram({ ...newProgram, color })}
                        className={`w-8 h-8 rounded-full ${newProgram.color === color ? 'ring-2 ring-offset-2 ring-slate-400' : ''}`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
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
