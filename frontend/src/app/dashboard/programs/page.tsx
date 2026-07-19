"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Search, Users, Calendar, Trash2, GraduationCap, Clock, CheckCircle2, Archive, BarChart3, X, Edit2, FolderPlus, Home, ChevronRight, ChevronDown, MoreHorizontal, LayoutGrid, LayoutTemplate, List, AlertCircle, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Program, ProgramDashboardSummary, ProgramFolder, ProgramGoal } from '@/types/program';
import Link from 'next/link';
import { es } from 'date-fns/locale';
import { formatCalendarDate } from '@/utils/calendarDate';
import { useContainerWidth } from '@/components/responsive/useContainerWidth';

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
  const { ref: workspaceRef, width: workspaceWidth } = useContainerWidth<HTMLDivElement>();
  const measuredWorkspaceWidth = workspaceWidth || 320;
  const programGridColumns = Math.max(1, Math.min(4, Math.floor((measuredWorkspaceWidth + 16) / 276)));
  const folderGridColumns = Math.max(1, Math.min(5, Math.floor((measuredWorkspaceWidth + 12) / 192)));
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [programsLoaded, setProgramsLoaded] = useState(false);
  const [programsError, setProgramsError] = useState('');
  const programsRequestRef = useRef<AbortController | null>(null);
  const programsRequestSequence = useRef(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newProgram, setNewProgram] = useState<{
    name: string;
    description: string;
    color: string;
    type: 'course' | 'event';
    pipeline_id?: string;
    event_date?: string;
    event_end?: string;
    location?: string;
  }>({ name: '', description: '', color: '#10b981', type: 'course' });
  const [pipelines, setPipelines] = useState<Array<{ id: string; name: string }>>([]);
  const [dashboard, setDashboard] = useState<ProgramDashboardSummary | null>(null);
  const [loadingDashboard, setLoadingDashboard] = useState(true);
  const [dashboardError, setDashboardError] = useState('');
  const dashboardRequestRef = useRef<AbortController | null>(null);
  const dashboardRequestSequence = useRef(0);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [goalForm, setGoalForm] = useState<ProgramGoal>({ attendance_goal_percent: 80, transfer_goal_percent: 70 });
  const [savingGoals, setSavingGoals] = useState(false);
  const [healthExpanded, setHealthExpanded] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingProgram, setEditingProgram] = useState<Program | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', color: '#10b981', status: 'active' });
  const [savingEdit, setSavingEdit] = useState(false);

  // Folder state
  const [folders, setFolders] = useState<ProgramFolder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [foldersError, setFoldersError] = useState('');
  const foldersRequestRef = useRef<AbortController | null>(null);
  const foldersRequestSequence = useRef(0);
  const [currentFolderID, setCurrentFolderID] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<ProgramFolder[]>([]);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [editFolder, setEditFolder] = useState<ProgramFolder | null>(null);
  const [folderForm, setFolderForm] = useState({ name: '', color: '#10b981', icon: '📁' });
  const [menuID, setMenuID] = useState<string | null>(null);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [visualViewportHeight, setVisualViewportHeight] = useState(900);

  // View mode
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'compact'>('grid');

  // Drag & Drop state
  const [dragOverFolderID, setDragOverFolderID] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const dragProgramIDRef = useRef<string | null>(null);

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

  const compactWorkspace = workspaceWidth === 0 || workspaceWidth < 768;
  const touchWorkspace = compactWorkspace || coarsePointer;
  const mobileWorkspace = workspaceWidth === 0 || workspaceWidth < 700 || (coarsePointer && visualViewportHeight < 600);
  const effectiveViewMode = mobileWorkspace ? 'grid' : viewMode;

  useEffect(() => {
    if (!mobileWorkspace) return;
    setMenuID(null);
    setIsCreateModalOpen(false);
    setEditingProgram(null);
    setShowFolderModal(false);
    setConfirmAction(null);
  }, [mobileWorkspace]);

  useEffect(() => {
    void fetchPrograms();
    void fetchFolders();
    void fetchPipelines();
    return () => {
      programsRequestRef.current?.abort();
      foldersRequestRef.current?.abort();
      dashboardRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    void fetchDashboard();
  }, [dateFrom, dateTo]);

  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)');
    const update = () => {
      setCoarsePointer(media.matches);
      setVisualViewportHeight(window.visualViewport?.height || window.innerHeight);
    };
    update();
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  const fetchPipelines = async () => {
    try {
      const res = await fetch('/api/events/pipelines', { headers: { Authorization: `Bearer ${token()}` } });
      const data = await res.json();
      if (data.success) setPipelines((data.pipelines || []).map((p: any) => ({ id: p.id, name: p.name })));
    } catch (e) { console.error(e); }
  };

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
    programsRequestRef.current?.abort();
    const controller = new AbortController();
    programsRequestRef.current = controller;
    const requestID = ++programsRequestSequence.current;
    if (!programsLoaded) setLoading(true);
    setProgramsError('');

    const response = await api<Program[]>('/api/programs?status=active', { signal: controller.signal });
    if (controller.signal.aborted || requestID !== programsRequestSequence.current) return;

    if (!response.success || !Array.isArray(response.data)) {
      setProgramsError(response.error || 'No se pudo cargar la lista de programas.');
    } else {
      setPrograms(response.data);
      setProgramsLoaded(true);
    }
    setLoading(false);
  };

  const fetchDashboard = async () => {
    dashboardRequestRef.current?.abort();
    const controller = new AbortController();
    dashboardRequestRef.current = controller;
    const requestID = ++dashboardRequestSequence.current;
    if (!dashboard) setLoadingDashboard(true);
    setDashboardError('');

    const params = new URLSearchParams();
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    const response = await api<{ success: boolean; dashboard: ProgramDashboardSummary }>(`/api/programs/dashboard${params.toString() ? `?${params.toString()}` : ''}`, { signal: controller.signal });
    if (controller.signal.aborted || requestID !== dashboardRequestSequence.current) return;

    const data = response.data;
    if (!response.success || !data?.success || !data.dashboard) {
      setDashboardError(response.error || 'No se pudo cargar la salud general.');
    } else {
      setDashboard(data.dashboard);
      setGoalForm({
        attendance_goal_percent: data.dashboard.attendance_goal_percent || 80,
        transfer_goal_percent: data.dashboard.transfer_goal_percent || 70,
      });
    }
    setLoadingDashboard(false);
  };

  const saveGlobalGoals = async () => {
    setSavingGoals(true);
    try {
      const res = await api<{ success: boolean; goals: ProgramGoal }>('/api/programs/goals', {
        method: 'PUT',
        body: JSON.stringify({
          attendance_goal_percent: Number(goalForm.attendance_goal_percent) || 80,
          transfer_goal_percent: Number(goalForm.transfer_goal_percent) || 70,
        }),
      });
      if (res.success) {
        showToast('Metas actualizadas', 'success');
        fetchDashboard();
      } else {
        showToast(res.error || 'Error al guardar metas', 'error');
      }
    } catch (error) {
      console.error('Error saving program goals:', error);
      showToast('Error al guardar metas', 'error');
    } finally {
      setSavingGoals(false);
    }
  };

  const fetchFolders = useCallback(async () => {
    foldersRequestRef.current?.abort();
    const controller = new AbortController();
    foldersRequestRef.current = controller;
    const requestID = ++foldersRequestSequence.current;
    setFoldersLoading(previous => foldersLoaded ? previous : true);
    setFoldersError('');

    const response = await api<{ success: boolean; folders: ProgramFolder[] }>('/api/programs/folders?status=active', { signal: controller.signal });
    if (controller.signal.aborted || requestID !== foldersRequestSequence.current) return;

    const data = response.data;
    if (!response.success || !data?.success || !Array.isArray(data.folders)) {
      setFoldersError(response.error || 'No se pudieron cargar las carpetas.');
    } else {
      setFolders(data.folders);
      setFoldersLoaded(true);
    }
    setFoldersLoading(false);
  }, [foldersLoaded]);

  const handleCreateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newProgram.type === 'event' && !newProgram.pipeline_id) {
      showToast('Selecciona un pipeline para el evento', 'error');
      return;
    }
    try {
      const payload: any = {
        name: newProgram.name,
        description: newProgram.description,
        color: newProgram.color,
        type: newProgram.type,
        folder_id: currentFolderID || undefined,
      };
      if (newProgram.type === 'event') {
        payload.pipeline_id = newProgram.pipeline_id;
        if (newProgram.event_date) payload.event_date = newProgram.event_date;
        if (newProgram.event_end) payload.event_end = newProgram.event_end;
        if (newProgram.location) payload.location = newProgram.location;
      }
      const response = await api('/api/programs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (response.success) {
        setIsCreateModalOpen(false);
        setNewProgram({ name: '', description: '', color: '#10b981', type: 'course' });
        fetchPrograms();
      } else {
        showToast((response as any).error || 'Error al crear programa', 'error');
      }
    } catch (error) {
      console.error('Error creating program:', error);
      showToast('Error al crear programa', 'error');
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
    setMenuID(null);
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

  const moveProgramToFolder = async (programId: string, folderId: string | null) => {
    try {
      const res = await api(`/api/programs/${programId}/move-folder`, {
        method: 'PATCH',
        body: JSON.stringify({ folder_id: folderId }),
      });
      if (res.success) {
        showToast('Programa movido', 'success');
        await Promise.all([fetchPrograms(), fetchFolders()]);
      } else {
        showToast('Error al mover programa', 'error');
      }
    } catch (error) {
      console.error('Error moving program:', error);
      showToast('Error al mover programa', 'error');
    }
  };

  const handleMoveToFolder = async (programId: string, folderId: string | null, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuID(null);
    await moveProgramToFolder(programId, folderId);
  };

  // ─── Drag & Drop ──────────────────────────────────────────────────────────

  const handleProgramDragStart = (e: React.DragEvent, programId: string) => {
    dragProgramIDRef.current = programId;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to start drag
    try { e.dataTransfer.setData('text/plain', programId); } catch { /* noop */ }
  };

  const handleProgramDragEnd = () => {
    dragProgramIDRef.current = null;
    setDragOverFolderID(null);
    setDragOverRoot(false);
  };

  const handleFolderDragOver = (e: React.DragEvent, folderID: string) => {
    if (!dragProgramIDRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverFolderID !== folderID) setDragOverFolderID(folderID);
  };

  const handleFolderDrop = async (e: React.DragEvent, targetFolderID: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderID(null);
    setDragOverRoot(false);
    const programId = dragProgramIDRef.current;
    dragProgramIDRef.current = null;
    if (!programId) return;
    const prog = programs.find(p => p.id === programId);
    if (prog && (prog.folder_id || null) === targetFolderID) return;
    await moveProgramToFolder(programId, targetFolderID);
  };

  const handleRootDragOver = (e: React.DragEvent) => {
    if (!dragProgramIDRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOverRoot) setDragOverRoot(true);
  };

  // Filter programs for current folder
  const filteredPrograms = programs.filter(p => {
    const inFolder = currentFolderID
      ? p.folder_id === currentFolderID
      : !p.folder_id;
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase());
    return inFolder && matchesSearch;
  });

  const formatPct = (value?: number) => `${Math.round(value || 0)}%`;
  const healthClass = (health?: string) => {
    if (health === 'critical') return 'bg-red-50 text-red-700 border-red-100';
    if (health === 'watch') return 'bg-amber-50 text-amber-700 border-amber-100';
    return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  };
  const healthLabel = (health?: string) => {
    if (health === 'critical') return 'Crítico';
    if (health === 'watch') return 'Observar';
    return 'Saludable';
  };

  const renderProgramMenu = (program: Program) => (
    <div className="relative shrink-0">
      <button
        type="button"
        data-menu-toggle
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuID(menuID === program.id ? null : program.id); }}
        className={`flex items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 ${touchWorkspace ? 'h-11 w-11' : 'h-8 w-8'}`}
        title="Más opciones"
        aria-label={`Acciones de ${program.name}`}
        aria-expanded={menuID === program.id}
      >
        <MoreHorizontal className="h-5 w-5 md:h-4 md:w-4" />
      </button>
      {menuID === program.id && (
        <div
          data-menu-dropdown
          className={touchWorkspace
            ? 'fixed inset-x-3 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[70] max-h-[min(70vh,24rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white py-2 shadow-2xl'
            : 'absolute right-0 top-full z-30 mt-1 min-w-[200px] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl'}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={(e) => openEditProgram(program, e)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
            <Edit2 className="h-4 w-4" /> Editar
          </button>
          {folders.length > 0 && (
            <>
              <div className="my-1 border-t border-slate-100" />
              <p className="px-4 py-1 text-xs font-medium text-slate-400">Mover a...</p>
              {program.folder_id && (
                <button onClick={(e) => handleMoveToFolder(program.id, null, e)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                  <Home className="h-4 w-4" /> Raíz
                </button>
              )}
              {folders.filter(f => f.id !== program.folder_id).map(f => (
                <button key={f.id} onClick={(e) => handleMoveToFolder(program.id, f.id, e)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                  <span className="text-base">{f.icon}</span><span className="truncate">{f.name}</span>
                </button>
              ))}
            </>
          )}
          <div className="my-1 border-t border-slate-100" />
          <button disabled={deleting === program.id} onClick={(e) => handleDeleteProgram(program.id, e)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60">
            {deleting === program.id ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-red-200 border-t-red-600" /> : <Trash2 className="h-4 w-4" />} {deleting === program.id ? 'Eliminando…' : 'Eliminar'}
          </button>
        </div>
      )}
    </div>
  );

  // Render program card for Grid view
  const renderProgramCard = (program: Program) => {
    const status = STATUS_CONFIG[program.status] || STATUS_CONFIG.active;
    return (
      <Link href={`/dashboard/programs/${program.id}`} key={program.id}
        draggable={!touchWorkspace}
        onDragStart={e => handleProgramDragStart(e, program.id)}
        onDragEnd={handleProgramDragEnd}>
        <div className="group bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md hover:border-slate-300 transition-all duration-200 cursor-pointer h-full flex flex-col relative">
          {/* Action buttons */}
          {!mobileWorkspace && <div className={`absolute flex gap-1 transition-all ${touchWorkspace ? 'right-2 top-2 opacity-100' : `right-3 top-3 ${menuID === program.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}`}>
            {renderProgramMenu(program)}
          </div>}

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
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <div className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                  {status.icon}
                  {status.label}
                </div>
                {program.type === 'event' && (
                  <div className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700">
                    <Calendar className="w-3 h-3" /> Evento
                  </div>
                )}
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
                {formatCalendarDate(program.schedule_start_date, 'dd MMM', { locale: es })}
                {program.schedule_end_date && ` - ${formatCalendarDate(program.schedule_end_date, 'dd MMM yyyy', { locale: es })}`}
              </span>
            </div>
          )}

          {/* Stats footer */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs pt-2.5 border-t border-slate-100">
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
      <Link href={`/dashboard/programs/${program.id}`} key={program.id}
        draggable={!touchWorkspace}
        onDragStart={e => handleProgramDragStart(e, program.id)}
        onDragEnd={handleProgramDragEnd}>
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
          <div className={`hidden items-center gap-1 rounded-full px-2 py-0.5 text-xs sm:inline-flex ${status.bg} ${status.text} shrink-0`}>
            {status.icon}
            {status.label}
          </div>
          <div className="hidden md:flex items-center gap-4 text-xs text-slate-500 shrink-0">
            <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{program.participant_count || 0}</span>
            <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{program.session_count || 0}</span>
          </div>
          {!touchWorkspace && <div className="flex shrink-0 items-center gap-1 opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100">
            <button onClick={(e) => openEditProgram(program, e)} className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600" title="Editar" aria-label={`Editar ${program.name}`}>
              <Edit2 className="h-3.5 w-3.5" />
            </button>
            <button disabled={deleting === program.id} onClick={(e) => handleDeleteProgram(program.id, e)} className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-red-50 hover:text-red-500 disabled:cursor-wait" title="Eliminar" aria-label={`Eliminar ${program.name}`}>
              {deleting === program.id ? <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-300 border-t-red-600" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </div>}
          {touchWorkspace && renderProgramMenu(program)}
        </div>
      </Link>
    );
  };

  // Render compact item
  const renderProgramCompact = (program: Program) => {
    const status = STATUS_CONFIG[program.status] || STATUS_CONFIG.active;
    return (
      <Link href={`/dashboard/programs/${program.id}`} key={program.id}
        draggable={!touchWorkspace}
        onDragStart={e => handleProgramDragStart(e, program.id)}
        onDragEnd={handleProgramDragEnd}>
        <div className="group flex items-center gap-3 px-3 py-2 hover:bg-slate-50 rounded-lg transition-all cursor-pointer border-b border-slate-100 last:border-b-0">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: program.color || '#10b981' }} />
          <span className="font-medium text-slate-800 text-sm truncate flex-1 group-hover:text-emerald-700 transition-colors">{program.name}</span>
          <div className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${status.bg} ${status.text} shrink-0`}>
            {status.label}
          </div>
          <span className="text-xs text-slate-400 shrink-0 hidden sm:inline">{program.participant_count || 0}p · {program.session_count || 0}s</span>
          {!touchWorkspace && <button disabled={deleting === program.id} onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteProgram(program.id, e); }}
            className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-wait"
            aria-label={`Eliminar ${program.name}`}>
            {deleting === program.id ? <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-300 border-t-red-600" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>}
          {touchWorkspace && renderProgramMenu(program)}
        </div>
      </Link>
    );
  };

  return (
    <div ref={workspaceRef} className="h-full min-h-0 overflow-y-auto flex flex-col gap-4 pr-1">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-800 leading-tight">Programas y Clases</h1>
            <p className="text-xs text-slate-500">Cursos, talleres y control de asistencia</p>
          </div>
        </div>
        {!mobileWorkspace && <div className="flex items-center gap-2 sm:shrink-0">
          <button
            onClick={openCreateFolder}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50 sm:flex-none"
          >
            <FolderPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Carpeta</span>
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700 sm:flex-none"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Nuevo Programa</span>
            <span className="sm:hidden">Nuevo</span>
          </button>
        </div>}
      </div>

      {/* General health dashboard */}
      {!mobileWorkspace && <section className="bg-white border border-slate-200 rounded-xl shrink-0 overflow-hidden">
        <button
          type="button"
          onClick={() => setHealthExpanded(value => !value)}
          className="w-full flex flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
          aria-expanded={healthExpanded}
        >
          <BarChart3 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="text-sm font-semibold text-slate-800">Salud general</span>
          {dashboard && (
            <>
              <span className={`text-xs font-semibold ${dashboard.attendance_rate >= dashboard.attendance_goal_percent ? 'text-emerald-700' : 'text-amber-700'}`}>
                Asistencia {formatPct(dashboard.attendance_rate)} / {dashboard.attendance_goal_percent}%
              </span>
              <span className="hidden sm:inline text-slate-300">·</span>
              <span className={`text-xs font-semibold ${dashboard.transfer_rate >= dashboard.transfer_goal_percent ? 'text-emerald-700' : 'text-amber-700'}`}>
                Traspaso {formatPct(dashboard.transfer_rate)} / {dashboard.transfer_goal_percent}%
              </span>
              <span className="hidden sm:inline text-slate-300">·</span>
              <span className="text-xs text-red-600 font-semibold">{dashboard.critical_participants} alertas</span>
            </>
          )}
          <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            {healthExpanded ? 'Ocultar detalle' : 'Ver detalle'}
            <ChevronDown className={`w-4 h-4 transition-transform ${healthExpanded ? 'rotate-180' : ''}`} />
          </span>
        </button>

        {dashboardError && !healthExpanded && (
          <div role="alert" className="flex flex-col gap-2 border-t border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{dashboardError}</span>
            <button type="button" onClick={() => { void fetchDashboard(); }} className="min-h-11 shrink-0 rounded-lg border border-red-200 bg-white px-3 text-xs font-semibold hover:bg-red-100">Reintentar</button>
          </div>
        )}

        {healthExpanded && (
          <div className="border-t border-slate-100 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-xs text-slate-500">Metas de asistencia y traspaso para probacionistas</p>
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="Desde" className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="Hasta" className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 rounded-lg">Limpiar</button>}
                <button type="button" onClick={(e) => { e.stopPropagation(); setGoalsOpen(true); }} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50">
                  <Settings2 className="w-3.5 h-3.5" /> Metas
                </button>
              </div>
            </div>

            {dashboardError && (
              <div role="alert" className="mb-3 flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{dashboardError}</span>
                <button type="button" onClick={() => { void fetchDashboard(); }} className="min-h-11 shrink-0 rounded-lg border border-red-200 bg-white px-3 text-xs font-semibold hover:bg-red-100">Reintentar</button>
              </div>
            )}

            {loadingDashboard ? (
              <div className="h-20 bg-slate-50 rounded-lg animate-pulse" />
            ) : dashboard && dashboard.groups.length > 0 ? (
              <>
                {compactWorkspace && <div className="space-y-2">
                  {dashboard.groups.slice(0, 6).map(group => (
                    <Link key={group.program_id} href={`/dashboard/programs/${group.program_id}`} className="block rounded-xl border border-slate-100 p-3 transition-colors hover:bg-slate-50">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: group.color || '#10b981' }} /><span className="truncate text-sm font-semibold text-slate-800">{group.name}</span></div>
                        <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${healthClass(group.health)}`}>{healthLabel(group.health)}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        <div><span className="block text-slate-400">Asistencia</span><span className={group.attendance_rate >= group.attendance_goal_percent ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>{formatPct(group.attendance_rate)} / {group.attendance_goal_percent}%</span></div>
                        <div><span className="block text-slate-400">Traspaso</span><span className={group.transfer_rate >= group.transfer_goal_percent ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>{formatPct(group.transfer_rate)} / {group.transfer_goal_percent}%</span></div>
                        <div className="text-right"><span className="block text-slate-400">Riesgo</span><span className="font-semibold text-slate-700">{group.at_risk_count}</span></div>
                      </div>
                    </Link>
                  ))}
                </div>}
                {!compactWorkspace && <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-100"><th className="py-2 font-medium">Grupo</th><th className="py-2 font-medium">Salud</th><th className="py-2 font-medium">Asistencia</th><th className="py-2 font-medium">Traspaso</th><th className="py-2 font-medium text-right">Riesgo</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {dashboard.groups.slice(0, 6).map(group => (
                      <tr key={group.program_id} className="hover:bg-slate-50">
                        <td className="py-2 pr-3"><Link href={`/dashboard/programs/${group.program_id}`} className="flex items-center gap-2 min-w-0"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: group.color || '#10b981' }} /><span className="font-medium text-slate-800 truncate">{group.name}</span></Link></td>
                        <td className="py-2 pr-3"><span className={`inline-flex px-2 py-0.5 rounded-full border text-xs font-medium ${healthClass(group.health)}`}>{healthLabel(group.health)}</span></td>
                        <td className="py-2 pr-3 text-xs"><span className={group.attendance_rate >= group.attendance_goal_percent ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>{formatPct(group.attendance_rate)}</span><span className="text-slate-400 ml-1">/ {group.attendance_goal_percent}%</span></td>
                        <td className="py-2 pr-3 text-xs"><span className={group.transfer_rate >= group.transfer_goal_percent ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>{formatPct(group.transfer_rate)}</span><span className="text-slate-400 ml-1">/ {group.transfer_goal_percent}%</span></td>
                        <td className="py-2 text-right text-xs text-slate-600">{group.at_risk_count}</td>
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>}
              </>
            ) : dashboard ? (
              <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No hay grupos con actividad para este período.</div>
            ) : (
              <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-5 text-center text-sm text-red-700">
                No se pudo cargar la salud general.
                <button type="button" onClick={() => { void fetchDashboard(); }} className="ml-2 min-h-11 font-semibold underline underline-offset-2">Reintentar</button>
              </div>
            )}
          </div>
        )}
      </section>}

      {goalsOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setGoalsOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="program-goals-title" className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100"><h2 id="program-goals-title" className="text-sm font-semibold text-slate-800">Metas globales</h2><button type="button" onClick={() => setGoalsOpen(false)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"><X className="w-4 h-4" /></button></div>
            <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
              <label className="text-xs text-slate-500">Asistencia %<input type="number" min={1} max={100} value={goalForm.attendance_goal_percent} onChange={(e) => setGoalForm(prev => ({ ...prev, attendance_goal_percent: Number(e.target.value) }))} className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></label>
              <label className="text-xs text-slate-500">Traspaso %<input type="number" min={1} max={100} value={goalForm.transfer_goal_percent} onChange={(e) => setGoalForm(prev => ({ ...prev, transfer_goal_percent: Number(e.target.value) }))} className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" /></label>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100"><button type="button" onClick={() => setGoalsOpen(false)} className="px-3 py-2 text-sm text-slate-600 rounded-lg hover:bg-slate-50">Cancelar</button><button type="button" onClick={async () => { await saveGlobalGoals(); setGoalsOpen(false); }} disabled={savingGoals} className="px-3 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50">{savingGoals ? 'Guardando...' : 'Guardar metas'}</button></div>
          </div>
        </div>
      )}

      {/* Stats + Search + View Toggle */}
      <div className="flex flex-col sm:flex-row gap-3 shrink-0">
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

        {/* View mode toggle */}
        {!mobileWorkspace && <div className="flex bg-slate-100 rounded-xl p-1 shrink-0">
          <button onClick={() => setViewMode('grid')} title="Cuadrícula" className={`flex h-11 flex-1 items-center justify-center rounded-lg transition-colors sm:h-8 sm:w-8 sm:flex-none ${viewMode === 'grid' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('list')} title="Lista" className={`flex h-11 flex-1 items-center justify-center rounded-lg transition-colors sm:h-8 sm:w-8 sm:flex-none ${viewMode === 'list' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <List className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode('compact')} title="Compacta" className={`flex h-11 flex-1 items-center justify-center rounded-lg transition-colors sm:h-8 sm:w-8 sm:flex-none ${viewMode === 'compact' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            <LayoutTemplate className="w-4 h-4" />
          </button>
        </div>}
      </div>

      {(programsError || foldersError) && (programsLoaded || foldersLoaded) && (
        <div role="alert" className="flex shrink-0 flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{[programsError, foldersError].filter(Boolean).join(' ')}</span>
          </div>
          <button type="button" onClick={() => { void fetchPrograms(); void fetchFolders(); }} className="min-h-11 shrink-0 rounded-xl border border-red-200 bg-white px-4 font-semibold text-red-700 hover:bg-red-100">
            Reintentar
          </button>
        </div>
      )}

      {/* Breadcrumb */}
      {folderPath.length > 0 && (
        <nav className="flex shrink-0 items-center gap-1 overflow-x-auto pb-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button onClick={() => navigateToBreadcrumb(-1)}
            onDragOver={handleRootDragOver}
            onDragLeave={() => setDragOverRoot(false)}
            onDrop={e => handleFolderDrop(e, null)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 transition-colors ${dragOverRoot ? 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-400' : 'text-slate-500 hover:text-emerald-700 hover:bg-emerald-50'}`}>
            <Home className="w-3.5 h-3.5" />
            <span>Programas</span>
          </button>
          {folderPath.map((folder, i) => {
            const isLast = i === folderPath.length - 1;
            const isDropTarget = !isLast && dragOverFolderID === folder.id;
            return (
            <div key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <button onClick={() => navigateToBreadcrumb(i)}
                onDragOver={isLast ? undefined : e => handleFolderDragOver(e, folder.id)}
                onDragLeave={isLast ? undefined : () => setDragOverFolderID(prev => prev === folder.id ? null : prev)}
                onDrop={isLast ? undefined : e => handleFolderDrop(e, folder.id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 font-medium transition-colors ${isLast ? 'text-slate-900 bg-slate-100 cursor-default' : isDropTarget ? 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-400' : 'text-slate-500 hover:text-emerald-700 hover:bg-emerald-50'}`}>
                <span className="text-base leading-none">{folder.icon}</span>
                {folder.name}
              </button>
            </div>
            );
          })}
        </nav>
      )}

      {/* Content — scrollable */}
      <div className="min-h-0">
      {(loading && !programsLoaded) || (foldersLoading && !foldersLoaded) ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${programGridColumns}, minmax(0, 1fr))` }}>
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
      ) : (!programsLoaded || !foldersLoaded) ? (
        <div role="alert" className="rounded-2xl border border-red-200 bg-white px-5 py-14 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-red-400" />
          <h3 className="mt-4 text-lg font-semibold text-slate-800">No se pudieron cargar los programas</h3>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-500">{[programsError, foldersError].filter(Boolean).join(' ') || 'Ocurrió un problema al consultar la información.'}</p>
          <button type="button" onClick={() => { void fetchPrograms(); void fetchFolders(); }} className="mt-5 min-h-11 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">
            Reintentar
          </button>
        </div>
      ) : filteredPrograms.length === 0 && visibleFolders.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-slate-200">
          <div className="w-20 h-20 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-5">
            <GraduationCap className="w-10 h-10 text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-800 mb-2">
            {searchQuery ? 'Sin resultados' : folderPath.length > 0 ? 'Carpeta vacía' : 'Crea tu primer programa'}
          </h3>
          <p className="text-slate-500 mb-6 max-w-md mx-auto">
            {searchQuery
              ? 'No se encontraron programas activos con esa búsqueda.'
              : 'Organiza cursos, talleres y clases. Controla la asistencia y envía mensajes masivos a los participantes.'}
          </p>
          {!searchQuery && !mobileWorkspace && (
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
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${mobileWorkspace ? 1 : folderGridColumns}, minmax(0, 1fr))` }}>
                {visibleFolders.map(folder => {
                  const isDropTarget = dragOverFolderID === folder.id;
                  return (
                  <div key={folder.id}
                    onClick={() => navigateIntoFolder(folder)}
                    onDragOver={e => handleFolderDragOver(e, folder.id)}
                    onDragLeave={() => setDragOverFolderID(prev => prev === folder.id ? null : prev)}
                    onDrop={e => handleFolderDrop(e, folder.id)}
                    className={`relative group bg-white border-2 rounded-xl p-4 cursor-pointer transition-all select-none hover:shadow-sm ${isDropTarget ? 'border-emerald-500 bg-emerald-50 shadow-md scale-[1.02]' : 'border-slate-200 hover:border-slate-300'}`}>
                    <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: folder.color }} />
                    <div className="flex items-start justify-between mt-1">
                      <span className="text-3xl leading-none">{folder.icon}</span>
                      {!mobileWorkspace && <button
                        data-menu-toggle
                        onClick={e => { e.stopPropagation(); setMenuID(menuID === `f-${folder.id}` ? null : `f-${folder.id}`); }}
                        className={`flex items-center justify-center rounded-xl text-slate-500 transition-all hover:bg-slate-100 hover:text-slate-700 ${touchWorkspace ? 'h-11 w-11 opacity-100' : 'h-8 w-8 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
                        <MoreHorizontal className="w-4 h-4" />
                      </button>}
                    </div>
                    <p className="mt-2 text-sm font-semibold text-slate-800 truncate">{folder.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{folder.program_count} programa{folder.program_count !== 1 ? 's' : ''}</p>
                    {!mobileWorkspace && menuID === `f-${folder.id}` && (
                      <div data-menu-dropdown className={touchWorkspace ? 'fixed inset-x-3 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[70] rounded-2xl border border-slate-200 bg-white py-2 shadow-2xl' : 'absolute right-2 top-8 z-20 min-w-[160px] rounded-xl border border-slate-200 bg-white py-1 shadow-lg'} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                        <button onClick={e => openEditFolder(folder, e)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                          <Edit2 className="w-3.5 h-3.5" /> Editar
                        </button>
                        <button onClick={e => handleDeleteFolder(folder.id, e)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                          <Trash2 className="w-3.5 h-3.5" /> Eliminar
                        </button>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Programs section */}
          {filteredPrograms.length > 0 && (
            <div>
              {visibleFolders.length > 0 && (
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 mt-2">Programas</p>
              )}

              {effectiveViewMode === 'grid' && (
                <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${mobileWorkspace ? 1 : programGridColumns}, minmax(0, 1fr))` }}>
                  {filteredPrograms.map(renderProgramCard)}
                </div>
              )}

              {effectiveViewMode === 'list' && (
                <div className="space-y-2">
                  {filteredPrograms.map(renderProgramRow)}
                </div>
              )}

              {effectiveViewMode === 'compact' && (
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
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="create-program-title" className="h-[var(--app-height)] w-full max-w-md overflow-y-auto rounded-none bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:p-6">
            <div className="flex justify-between items-center mb-5">
              <h2 id="create-program-title" className="text-xl font-bold text-slate-800">Nuevo Programa</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateProgram}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Tipo de programa</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setNewProgram({ ...newProgram, type: 'course' })}
                      className={`p-4 rounded-xl border-2 text-left transition-all ${
                        newProgram.type === 'course'
                          ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <GraduationCap className="w-5 h-5 text-emerald-600 mb-1.5" />
                      <div className="font-semibold text-slate-800 text-sm">Curso</div>
                      <div className="text-xs text-slate-500 mt-0.5">Sesiones y asistencia</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewProgram({ ...newProgram, type: 'event' })}
                      className={`p-4 rounded-xl border-2 text-left transition-all ${
                        newProgram.type === 'event'
                          ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <Calendar className="w-5 h-5 text-emerald-600 mb-1.5" />
                      <div className="font-semibold text-slate-800 text-sm">Evento</div>
                      <div className="text-xs text-slate-500 mt-0.5">Kanban con etapas</div>
                    </button>
                  </div>
                </div>
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
                {newProgram.type === 'event' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Pipeline *</label>
                      <select
                        required
                        value={newProgram.pipeline_id || ''}
                        onChange={(e) => setNewProgram({ ...newProgram, pipeline_id: e.target.value })}
                        className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-white"
                      >
                        <option value="">Selecciona un pipeline...</option>
                        {pipelines.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      {pipelines.length === 0 && (
                        <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                          <AlertCircle className="w-3.5 h-3.5" /> No hay pipelines. Crea uno en Eventos → Pipelines.
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha inicio</label>
                        <input
                          type="datetime-local"
                          value={newProgram.event_date || ''}
                          onChange={(e) => setNewProgram({ ...newProgram, event_date: e.target.value })}
                          className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha fin</label>
                        <input
                          type="datetime-local"
                          value={newProgram.event_end || ''}
                          onChange={(e) => setNewProgram({ ...newProgram, event_end: e.target.value })}
                          className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Ubicación</label>
                      <input
                        type="text"
                        value={newProgram.location || ''}
                        onChange={(e) => setNewProgram({ ...newProgram, location: e.target.value })}
                        className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                        placeholder="Ej: Auditorio principal"
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Color</label>
                  <div className="flex flex-wrap gap-3">
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
              <div className="sticky bottom-0 -mx-4 mt-6 flex gap-3 border-t border-slate-100 bg-white px-4 pb-[env(safe-area-inset-bottom)] pt-4 sm:static sm:mx-0 sm:justify-end sm:px-0 sm:pb-0">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 sm:flex-none"
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
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setEditingProgram(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="edit-program-title" className="h-[var(--app-height)] w-full max-w-md overflow-y-auto rounded-none bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-5">
              <h2 id="edit-program-title" className="text-xl font-bold text-slate-800">Editar Programa</h2>
              <button onClick={() => setEditingProgram(null)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
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
                  <div className="flex flex-wrap gap-3">
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
              <div className="sticky bottom-0 -mx-4 mt-6 flex gap-3 border-t border-slate-100 bg-white px-4 pb-[env(safe-area-inset-bottom)] pt-4 sm:static sm:mx-0 sm:justify-end sm:px-0 sm:pb-0">
                <button type="button" onClick={() => setEditingProgram(null)} className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none">
                  Cancelar
                </button>
                <button type="submit" disabled={savingEdit || !editForm.name.trim()} className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:opacity-50 sm:flex-none">
                  {savingEdit ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Folder Modal */}
      {showFolderModal && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setShowFolderModal(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title" className="h-[var(--app-height)] w-full max-w-sm overflow-y-auto rounded-none bg-white shadow-xl sm:h-auto sm:max-h-[92vh] sm:rounded-xl" onClick={e => e.stopPropagation()}>
            <div className="p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6">
              <h2 id="folder-dialog-title" className="text-lg font-semibold text-slate-900 mb-4">
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
              <div className="sticky bottom-0 -mx-4 mt-6 flex gap-3 bg-white px-4 pb-[env(safe-area-inset-bottom)] pt-3 sm:static sm:mx-0 sm:justify-end sm:px-0 sm:pb-0">
                <button onClick={() => setShowFolderModal(false)} className="min-h-11 flex-1 rounded-lg px-4 py-2 text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none">Cancelar</button>
                <button disabled={!folderForm.name} onClick={handleSaveFolder}
                  className="min-h-11 flex-1 rounded-lg bg-emerald-600 px-6 py-2 text-white transition-colors hover:bg-emerald-700 disabled:opacity-50 sm:flex-none">
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
