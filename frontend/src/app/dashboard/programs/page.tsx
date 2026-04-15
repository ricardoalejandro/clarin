"use client";

import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, BookOpen, Users, Calendar, Trash2, GraduationCap, Clock, CheckCircle2, Archive, BarChart3, X, Edit2, FolderPlus, Home, ChevronRight, MoreHorizontal, LayoutGrid, LayoutTemplate, List, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Program, ProgramFolder } from '@/types/program';
import Link from 'next/link';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: React.ReactNode }> = {
  active: { label: 'Activo', bg: 'bg-emerald-50', text: 'text-emerald-700', icon: <CheckCircle2 className="w-3 h-3" /> },
  completed: { label: 'Completado', bg: 'bg-blue-50', text: 'text-blue-700', icon: <Clock className="w-3 h-3" /> },
  archived: { label: 'Archivado', bg: 'bg-slate-100', text: 'text-slate-600', icon: <Archive className="w-3 h-3" /> },
};

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#6366f1', '#ec4899', '#f43f5e', '#f97316', '#f59e0b'];
const FOLDER_ICONS = ['📁', '📂', '🎓', '🎉', '🏋️', '📊', '📝', '🎯', '📌', '🗂️'];
const FOLDER_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1'];

const token = () => typeof window !== 'undefined' ? localStorage.getItem('token') || '' : '';

export default function ProgramsPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newProgram, setNewProgram] = useState({ name: '', description: '', color: '#10b981' });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingProgram, setEditingProgram] = useState<Program | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', color: '#10b981', status: 'active' });
  const [savingEdit, setSavingEdit] = useState(false);

  // Folder state
  const [folders, setFolders] = useState<ProgramFolder[]>([]);
  const [currentFolderID, setCurrentFolderID] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<ProgramFolder[]>([]);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [editFolder, setEditFolder] = useState<ProgramFolder | null>(null);
  const [folderForm, setFolderForm] = useState({ name: '', color: '#10b981', icon: '📁' });
  const [menuID, setMenuID] = useState<string | null>(null);

  // View mode
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'compact'>('grid');

  // Toast state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  // Confirmation dialog state
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(t);
  }, [toastMessage]);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToastMessage(message);
    setToastType(type);
  };

  useEffect(() => {
    fetchPrograms();
    fetchFolders();
  }, []);

  // Close menus on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (menuID && !target.closest('[data-menu-toggle]') && !target.closest('[data-menu-dropdown]')) {
        setMenuID(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuID]);

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

  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch('/api/programs/folders', {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const data = await res.json();
      if (data.success) setFolders(data.folders || []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const handleCreateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await api('/api/programs', {
        method: 'POST',
        body: JSON.stringify({ ...newProgram, folder_id: currentFolderID || undefined })
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

  const handleDeleteProgram = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuID(null);
    setConfirmAction({
      message: '¿Estás seguro de eliminar este programa? Se eliminarán también todos sus participantes, sesiones y asistencia.',
      onConfirm: async () => {
        setConfirmAction(null);
        setDeleting(id);
        try {
          const res = await api(`/api/programs/${id}`, { method: 'DELETE' });
          if (res.success) {
            showToast('Programa eliminado', 'success');
            fetchPrograms();
          } else {
            showToast('Error al eliminar programa', 'error');
          }
        } catch (error) {
          console.error('Error deleting program:', error);
          showToast('Error al eliminar programa', 'error');
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  const openEditProgram = (program: Program, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditForm({
      name: program.name,
      description: program.description || '',
      color: program.color || '#10b981',
      status: program.status,
    });
    setEditingProgram(program);
  };

  const handleUpdateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProgram) return;
    setSavingEdit(true);
    try {
      const res = await api(`/api/programs/${editingProgram.id}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      });
      if (res.success) {
        setEditingProgram(null);
        showToast('Programa actualizado', 'success');
        fetchPrograms();
      } else {
        showToast('Error al actualizar programa', 'error');
      }
    } catch (error) {
      console.error('Error updating program:', error);
      showToast('Error al actualizar programa', 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  // Folder navigation
  const visibleFolders = folders.filter(f =>
    currentFolderID ? f.parent_id === currentFolderID : !f.parent_id
  );

  const navigateIntoFolder = (folder: ProgramFolder) => {
    setCurrentFolderID(folder.id);
    setFolderPath(prev => [...prev, folder]);
    setSearchQuery('');
  };

  const navigateToBreadcrumb = (index: number) => {
    if (index === -1) {
      setCurrentFolderID(null);
      setFolderPath([]);
    } else {
      setCurrentFolderID(folderPath[index].id);
      setFolderPath(prev => prev.slice(0, index + 1));
    }
    setSearchQuery('');
  };

  // Folder CRUD
  const openCreateFolder = () => {
    setEditFolder(null);
    setFolderForm({ name: '', color: '#10b981', icon: '📁' });
    setShowFolderModal(true);
  };

  const openEditFolder = (folder: ProgramFolder, e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuID(null);
    setEditFolder(folder);
    setFolderForm({ name: folder.name, color: folder.color, icon: folder.icon });
    setShowFolderModal(true);
  };

  const handleSaveFolder = async () => {
    try {
      const endpoint = editFolder ? `/api/programs/folders/${editFolder.id}` : '/api/programs/folders';
      const method = editFolder ? 'PUT' : 'POST';
      const body = editFolder ? folderForm : { ...folderForm, parent_id: currentFolderID || undefined };
      const res = await api(endpoint, { method, body: JSON.stringify(body) });
      if (res.success) {
        showToast(editFolder ? 'Carpeta actualizada' : 'Carpeta creada', 'success');
        setShowFolderModal(false);
        setEditFolder(null);
        fetchFolders();
      } else {
        showToast('Error al guardar carpeta', 'error');
      }
    } catch (error) {
      console.error('Error saving folder:', error);
      showToast('Error al guardar carpeta', 'error');
    }
  };

  const handleDeleteFolder = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuID(null);
    setConfirmAction({
      message: '¿Eliminar carpeta? Los programas se moverán a la carpeta padre.',
      onConfirm: async () => {
        setConfirmAction(null);
        try {
          const res = await api(`/api/programs/folders/${id}`, { method: 'DELETE' });
          if (res.success) {
            showToast('Carpeta eliminada', 'success');
            fetchFolders();
            fetchPrograms();
          } else {
            showToast('Error al eliminar carpeta', 'error');
          }
        } catch (error) {
          console.error('Error deleting folder:', error);
          showToast('Error al eliminar carpeta', 'error');
        }
      },
    });
  };

  const handleMoveToFolder = async (programId: string, folderId: string | null, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuID(null);
    try {
      const res = await api(`/api/programs/${programId}/move-folder`, {
        method: 'PATCH',
        body: JSON.stringify({ folder_id: folderId }),
      });
      if (res.success) {
        showToast('Programa movido', 'success');
        fetchPrograms();
      } else {
        showToast('Error al mover programa', 'error');
      }
    } catch (error) {
      console.error('Error moving program:', error);
      showToast('Error al mover programa', 'error');
    }
  };

  // Filter programs for current folder
  const filteredPrograms = programs.filter(p => {
    const inFolder = currentFolderID
      ? p.folder_id === currentFolderID
      : !p.folder_id;
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return inFolder && matchesSearch && matchesStatus;
  });

  const stats = {
    total: programs.length,
    active: programs.filter(p => p.status === 'active').length,
    totalParticipants: programs.reduce((sum, p) => sum + (p.participant_count || 0), 0),
    totalSessions: programs.reduce((sum, p) => sum + (p.session_count || 0), 0),
  };

  // Render program card for Grid view
  const renderProgramCard = (program: Program) => {
    const status = STATUS_CONFIG[program.status] || STATUS_CONFIG.active;
    return (
      <Link href={`/dashboard/programs/${program.id}`} key={program.id}>
        <div className="group bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md hover:border-slate-300 transition-all duration-200 cursor-pointer h-full flex flex-col relative">
          {/* Action buttons */}
          <div className={`absolute top-3 right-3 flex gap-1 transition-all ${menuID === program.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <div className="relative">
              <button
                data-menu-toggle
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuID(menuID === program.id ? null : program.id); }}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all"
                title="Más opciones"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {menuID === program.id && (
                <div data-menu-dropdown className="absolute top-full right-0 mt-1 z-20 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[160px]" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                  <button onClick={(e) => openEditProgram(program, e)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                    <Edit2 className="w-3.5 h-3.5" /> Editar
                  </button>
                  {folders.length > 0 && (
                    <>
                      <div className="border-t border-slate-100 my-1" />
                      <p className="px-4 py-1 text-xs text-slate-400 font-medium">Mover a...</p>
                      {program.folder_id && (
                        <button onClick={(e) => handleMoveToFolder(program.id, null, e)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                          <Home className="w-3.5 h-3.5" /> Raíz
                        </button>
                      )}
                      {folders.filter(f => f.id !== program.folder_id).map(f => (
                        <button key={f.id} onClick={(e) => handleMoveToFolder(program.id, f.id, e)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                          <span className="text-base">{f.icon}</span> {f.name}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="border-t border-slate-100 my-1" />
                  <button onClick={(e) => handleDeleteProgram(program.id, e)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                    <Trash2 className="w-3.5 h-3.5" /> Eliminar
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Program header */}
          <div className="flex items-start gap-3 mb-2.5">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-base shrink-0 shadow-sm"
              style={{ backgroundColor: program.color || '#10b981' }}
            >
              {program.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1 pr-6">
              <h3 className="font-semibold text-slate-800 truncate group-hover:text-emerald-700 transition-colors text-sm">
                {program.name}
              </h3>
              <div className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${status.bg} ${status.text} mt-0.5`}>
                {status.icon}
                {status.label}
              </div>
            </div>
          </div>

          {/* Description */}
          <p className="text-slate-500 text-xs mb-3 line-clamp-2 flex-grow leading-relaxed">
            {program.description || 'Sin descripción'}
          </p>

          {/* Schedule info */}
          {program.schedule_start_date && (
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-2.5">
              <Clock className="w-3 h-3" />
              <span>
                {format(new Date(program.schedule_start_date), 'dd MMM', { locale: es })}
                {program.schedule_end_date && ` - ${format(new Date(program.schedule_end_date), 'dd MMM yyyy', { locale: es })}`}
              </span>
            </div>
          )}

          {/* Stats footer */}
          <div className="flex items-center gap-3 text-xs pt-2.5 border-t border-slate-100">
            <div className="flex items-center gap-1 text-slate-500">
              <Users className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-slate-700">{program.participant_count || 0}</span>
              <span className="text-slate-400">participantes</span>
            </div>
            <div className="flex items-center gap-1 text-slate-500">
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-slate-700">{program.session_count || 0}</span>
              <span className="text-slate-400">sesiones</span>
            </div>
          </div>
        </div>
      </Link>
    );
  };

  // Render program row for List view
  const renderProgramRow = (program: Program) => {
    const status = STATUS_CONFIG[program.status] || STATUS_CONFIG.active;
    return (
      <Link href={`/dashboard/programs/${program.id}`} key={program.id}>
        <div className="group flex items-center gap-4 bg-white border border-slate-200 rounded-xl px-4 py-3 hover:shadow-sm hover:border-slate-300 transition-all cursor-pointer">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0"
            style={{ backgroundColor: program.color || '#10b981' }}
          >
            {program.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-slate-800 truncate text-sm group-hover:text-emerald-700 transition-colors">{program.name}</h3>
            <p className="text-xs text-slate-500 truncate">{program.description || 'Sin descripción'}</p>
          </div>
          <div className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${status.bg} ${status.text} shrink-0`}>
            {status.icon}
            {status.label}
          </div>
          <div className="hidden md:flex items-center gap-4 text-xs text-slate-500 shrink-0">
            <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{program.participant_count || 0}</span>
            <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{program.session_count || 0}</span>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
            <button onClick={(e) => openEditProgram(program, e)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all" title="Editar">
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={(e) => handleDeleteProgram(program.id, e)} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all" title="Eliminar">
              {deleting === program.id ? <div className="w-3.5 h-3.5 border-2 border-red-300 border-t-red-600 rounded-full animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </Link>
    );
  };

  // Render compact item
  const renderProgramCompact = (program: Program) => {
    const status = STATUS_CONFIG[program.status] || STATUS_CONFIG.active;
    return (
      <Link href={`/dashboard/programs/${program.id}`} key={program.id}>
        <div className="group flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-lg transition-all cursor-pointer border-b border-slate-100 last:border-b-0">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: program.color || '#10b981' }} />
          <span className="font-medium text-slate-800 text-sm truncate flex-1 group-hover:text-emerald-700 transition-colors">{program.name}</span>
          <div className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${status.bg} ${status.text} shrink-0`}>
            {status.label}
          </div>
          <span className="text-xs text-slate-400 shrink-0 hidden sm:inline">{program.participant_count || 0}p · {program.session_count || 0}s</span>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteProgram(program.id, e); }}
            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all shrink-0">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </Link>
    );
  };

  return (
    <div className="h-full flex flex-col min-h-0 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-800 leading-tight">Programas y Clases</h1>
            <p className="text-xs text-slate-500">Cursos, talleres y control de asistencia</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openCreateFolder}
            className="flex items-center gap-2 px-3 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-all text-sm font-medium"
          >
            <FolderPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Carpeta</span>
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium text-sm"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Nuevo Programa</span>
            <span className="sm:hidden">Nuevo</span>
          </button>
        </div>
      </div>

      {/* Stats + Search + View Toggle */}
      <div className="flex flex-col sm:flex-row gap-3 shrink-0">
        {!loading && programs.length > 0 && (
          <div className="flex items-center gap-3 lg:gap-5 bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm flex-wrap shrink-0">
            <span className="flex items-center gap-1.5 text-slate-600">
              <BookOpen className="w-3.5 h-3.5 text-emerald-500" />
              <strong className="text-slate-800 font-semibold">{stats.total}</strong>
              <span className="hidden md:inline text-slate-400">programas</span>
            </span>
            <span className="text-slate-200 hidden sm:inline">|</span>
            <span className="flex items-center gap-1.5 text-slate-600">
              <BarChart3 className="w-3.5 h-3.5 text-blue-500" />
              <strong className="text-slate-800 font-semibold">{stats.active}</strong>
              <span className="hidden md:inline text-slate-400">activos</span>
            </span>
            <span className="text-slate-200 hidden sm:inline">|</span>
            <span className="flex items-center gap-1.5 text-slate-600">
              <Users className="w-3.5 h-3.5 text-purple-500" />
              <strong className="text-slate-800 font-semibold">{stats.totalParticipants}</strong>
              <span className="hidden md:inline text-slate-400">participantes</span>
            </span>
            <span className="text-slate-200 hidden sm:inline">|</span>
            <span className="flex items-center gap-1.5 text-slate-600">
              <Calendar className="w-3.5 h-3.5 text-amber-500" />
              <strong className="text-slate-800 font-semibold">{stats.totalSessions}</strong>
              <span className="hidden md:inline text-slate-400">sesiones</span>
            </span>
          </div>
        )}

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

        {/* Filter */}
        <div className="flex gap-1 bg-white border border-slate-200 rounded-xl p-1 shrink-0">
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

        {/* View mode toggle */}
        <div className="flex bg-slate-100 rounded-xl p-1 shrink-0">
          <button onClick={() => setViewMode('grid')} title="Cuadrícula" className={`p-2 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('list')} title="Lista" className={`p-2 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <List className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('compact')} title="Compacta" className={`p-2 rounded-lg transition-colors ${viewMode === 'compact' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutTemplate className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Breadcrumb */}
      {folderPath.length > 0 && (
        <nav className="flex items-center gap-1 text-sm shrink-0">
          <button onClick={() => navigateToBreadcrumb(-1)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors">
            <Home className="w-3.5 h-3.5" />
            <span>Programas</span>
          </button>
          {folderPath.map((folder, i) => (
            <div key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <button onClick={() => navigateToBreadcrumb(i)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors font-medium ${i === folderPath.length - 1 ? 'text-slate-900 bg-slate-100 cursor-default' : 'text-slate-500 hover:text-emerald-700 hover:bg-emerald-50'}`}>
                <span className="text-base leading-none">{folder.icon}</span>
                {folder.name}
              </button>
            </div>
          ))}
        </nav>
      )}

      {/* Content — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto">
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-5 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-slate-200 rounded-xl" />
                <div className="flex-1">
                  <div className="h-4 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-slate-100 rounded w-1/3" />
                </div>
              </div>
              <div className="h-3 bg-slate-100 rounded w-full mb-2" />
              <div className="h-3 bg-slate-100 rounded w-2/3 mb-5" />
              <div className="h-7 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      ) : filteredPrograms.length === 0 && visibleFolders.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-slate-200">
          <div className="w-20 h-20 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-5">
            <GraduationCap className="w-10 h-10 text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-800 mb-2">
            {searchQuery || statusFilter !== 'all' ? 'Sin resultados' : folderPath.length > 0 ? 'Carpeta vacía' : 'Crea tu primer programa'}
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
        <div className="space-y-4 pb-2">
          {/* Folders section */}
          {visibleFolders.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Carpetas</p>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {visibleFolders.map(folder => (
                  <div key={folder.id}
                    onClick={() => navigateIntoFolder(folder)}
                    className="relative group bg-white border-2 border-slate-200 rounded-xl p-4 cursor-pointer transition-all select-none hover:border-slate-300 hover:shadow-sm">
                    <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: folder.color }} />
                    <div className="flex items-start justify-between mt-1">
                      <span className="text-3xl leading-none">{folder.icon}</span>
                      <button
                        data-menu-toggle
                        onClick={e => { e.stopPropagation(); setMenuID(menuID === `f-${folder.id}` ? null : `f-${folder.id}`); }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-all">
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-slate-800 truncate">{folder.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{folder.program_count} programa{folder.program_count !== 1 ? 's' : ''}</p>
                    {menuID === `f-${folder.id}` && (
                      <div data-menu-dropdown className="absolute top-8 right-2 z-20 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[120px]" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                        <button onClick={e => openEditFolder(folder, e)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                          <Edit2 className="w-3.5 h-3.5" /> Editar
                        </button>
                        <button onClick={e => handleDeleteFolder(folder.id, e)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                          <Trash2 className="w-3.5 h-3.5" /> Eliminar
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Programs section */}
          {filteredPrograms.length > 0 && (
            <div>
              {visibleFolders.length > 0 && (
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 mt-2">Programas</p>
              )}

              {viewMode === 'grid' && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filteredPrograms.map(renderProgramCard)}
                </div>
              )}

              {viewMode === 'list' && (
                <div className="space-y-2">
                  {filteredPrograms.map(renderProgramRow)}
                </div>
              )}

              {viewMode === 'compact' && (
                <div className="bg-white rounded-xl border border-slate-200 divide-y-0">
                  {filteredPrograms.map(renderProgramCompact)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>

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

      {/* Edit Program Modal */}
      {editingProgram && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setEditingProgram(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-xl font-bold text-slate-800">Editar Programa</h2>
              <button onClick={() => setEditingProgram(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleUpdateProgram}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre</label>
                  <input
                    type="text"
                    required
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Descripción</label>
                  <textarea
                    value={editForm.description}
                    onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all resize-none"
                    rows={3}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
                  <div className="flex gap-2.5">
                    {COLORS.map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setEditForm({ ...editForm, color })}
                        className={`w-9 h-9 rounded-full transition-all ${editForm.color === color ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : 'hover:scale-105'}`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Estado</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  >
                    <option value="active">Activo</option>
                    <option value="archived">Archivado</option>
                    <option value="completed">Completado</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
                <button type="button" onClick={() => setEditingProgram(null)} className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium">
                  Cancelar
                </button>
                <button type="submit" disabled={savingEdit || !editForm.name.trim()} className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium disabled:opacity-50">
                  {savingEdit ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Folder Modal */}
      {showFolderModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowFolderModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">
                {editFolder ? 'Editar carpeta' : 'Nueva carpeta'}
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombre *</label>
                  <input value={folderForm.name} onChange={e => setFolderForm({ ...folderForm, name: e.target.value })} autoFocus
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none text-slate-900"
                    placeholder="Ej: Programas 2025" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Ícono</label>
                  <div className="flex flex-wrap gap-2">
                    {FOLDER_ICONS.map(icon => (
                      <button key={icon} type="button" onClick={() => setFolderForm({ ...folderForm, icon })}
                        className={`w-10 h-10 text-xl rounded-lg border-2 transition-all flex items-center justify-center ${folderForm.icon === icon ? 'border-emerald-500 bg-emerald-50 scale-110' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
                  <div className="flex flex-wrap gap-2">
                    {FOLDER_COLORS.map(c => (
                      <button key={c} type="button" onClick={() => setFolderForm({ ...folderForm, color: c })}
                        className={`w-7 h-7 rounded-full border-2 transition-all ${folderForm.color === c ? 'border-slate-900 scale-110' : 'border-transparent hover:scale-105'}`}
                        style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button onClick={() => setShowFolderModal(false)} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancelar</button>
                <button disabled={!folderForm.name} onClick={handleSaveFolder}
                  className="px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                  {editFolder ? 'Guardar' : 'Crear'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMessage && (
        <div className={`fixed bottom-6 right-6 z-[70] flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-white text-sm font-medium transition-all ${
          toastType === 'success' ? 'bg-emerald-600' : 'bg-red-600'
        }`}>
          {toastType === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toastMessage}
          <button onClick={() => setToastMessage(null)} className="ml-1 p-0.5 hover:bg-white/20 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5 text-red-500" />
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">{confirmAction.message}</p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={confirmAction.onConfirm}
                className="px-5 py-2.5 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-all shadow-sm font-medium text-sm"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
