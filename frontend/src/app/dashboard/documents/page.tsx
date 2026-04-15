"use client";

import { useState, useEffect, useRef } from 'react';
import { Plus, Search, FileText, Trash2, Copy, MoreVertical, Download, Upload, Pencil, LayoutGrid, Grid3X3, List, Grid2X2 } from 'lucide-react';
import { api } from '@/lib/api';
import { DocumentTemplate } from '@/types/document';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { useRouter } from 'next/navigation';

const PAGE_SIZES: Record<string, { label: string; w: number; h: number }> = {
  a4: { label: 'A4', w: 210, h: 297 },
  letter: { label: 'Carta', w: 216, h: 279 },
  custom: { label: 'Personalizado', w: 210, h: 297 },
};

export default function DocumentsPage() {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'large' | 'thumbnails' | 'compact' | 'list'>('compact');
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    description: '',
    page_width: 210,
    page_height: 297,
    page_orientation: 'portrait' as 'portrait' | 'landscape',
  });
  const [pageSize, setPageSize] = useState('a4');
  const importInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    fetchTemplates();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-menu-dropdown]')) {
        setMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const response = await api<{ templates: DocumentTemplate[] }>('/api/document-templates');
      if (response.success) {
        setTemplates(response.data?.templates || []);
      }
    } catch (error) {
      console.error('Error fetching templates:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTemplate.name.trim()) return;
    setCreating(true);
    try {
      const response = await api<{ template: DocumentTemplate }>('/api/document-templates', {
        method: 'POST',
        body: JSON.stringify(newTemplate),
      });
      if (response.success && response.data?.template) {
        setIsCreateModalOpen(false);
        setNewTemplate({ name: '', description: '', page_width: 210, page_height: 297, page_orientation: 'portrait' });
        setPageSize('a4');
        window.location.href = `/dashboard/documents/${response.data.template.id}`;
      }
    } catch (error) {
      console.error('Error creating template:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('¿Estás seguro de eliminar esta plantilla?')) return;
    try {
      await api(`/api/document-templates/${id}`, { method: 'DELETE' });
      fetchTemplates();
    } catch (error) {
      console.error('Error deleting template:', error);
    }
    setMenuOpen(null);
  };

  const handleDuplicate = async (id: string) => {
    try {
      const res = await api<{ template: DocumentTemplate }>(`/api/document-templates/${id}/duplicate`, { method: 'POST' });
      if (res.success) {
        fetchTemplates();
      }
    } catch (error) {
      console.error('Error duplicating template:', error);
    }
    setMenuOpen(null);
  };

  const handleExportJSON = async (id: string, name: string) => {
    try {
      const res = await api<{ template: DocumentTemplate }>(`/api/document-templates/${id}`);
      if (res.success && res.data?.template) {
        const t = res.data.template;
        const exportData = {
          name: t.name,
          description: t.description,
          canvas_json: t.canvas_json,
          page_width: t.page_width,
          page_height: t.page_height,
          page_orientation: t.page_orientation,
          fields_used: t.fields_used,
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('Error exporting template:', error);
    }
    setMenuOpen(null);
  };

  const handleImportJSON = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await api<{ template: DocumentTemplate }>('/api/document-templates/import', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      if (res.success) {
        fetchTemplates();
      }
    } catch (error) {
      console.error('Error importing template:', error);
    }
    if (importInputRef.current) importInputRef.current.value = '';
  };

  const handlePageSizeChange = (size: string) => {
    setPageSize(size);
    const cfg = PAGE_SIZES[size];
    if (cfg && size !== 'custom') {
      if (newTemplate.page_orientation === 'landscape') {
        setNewTemplate(prev => ({ ...prev, page_width: cfg.h, page_height: cfg.w }));
      } else {
        setNewTemplate(prev => ({ ...prev, page_width: cfg.w, page_height: cfg.h }));
      }
    }
  };

  const handleOrientationChange = (orientation: 'portrait' | 'landscape') => {
    setNewTemplate(prev => ({
      ...prev,
      page_orientation: orientation,
      page_width: prev.page_height,
      page_height: prev.page_width,
    }));
  };

  const filteredTemplates = templates.filter(t => {
    if (searchQuery && !t.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
              <FileText className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Plantillas</h1>
              <p className="text-sm text-slate-500">{templates.length} plantilla{templates.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => importInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors text-sm"
            >
              <Upload className="w-4 h-4" />
              Importar
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImportJSON}
            />
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              Nueva plantilla
            </button>
          </div>
        </div>

        {/* Search + View Modes */}
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar plantillas..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
          </div>
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            {[
              { mode: 'large' as const, icon: Grid2X2, title: 'Grande' },
              { mode: 'thumbnails' as const, icon: LayoutGrid, title: 'Miniaturas' },
              { mode: 'compact' as const, icon: Grid3X3, title: 'Compacta' },
              { mode: 'list' as const, icon: List, title: 'Lista' },
            ].map(({ mode, icon: Icon, title }) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={title}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === mode
                    ? 'bg-white text-emerald-600 shadow-sm'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                <Icon className="w-4 h-4" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className={viewMode === 'list' ? 'space-y-2' : `grid gap-4 ${
            viewMode === 'large' ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' :
            viewMode === 'thumbnails' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6' :
            'grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10'
          }`}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              viewMode === 'list' ? (
                <div key={i} className="bg-white rounded-lg border border-slate-200 animate-pulse flex items-center gap-4 px-4 py-3">
                  <div className="w-10 h-14 bg-slate-100 rounded" />
                  <div className="flex-1"><div className="h-4 bg-slate-200 rounded w-1/3 mb-1" /><div className="h-3 bg-slate-100 rounded w-1/5" /></div>
                </div>
              ) : (
                <div key={i} className="bg-white rounded-xl border border-slate-200 overflow-hidden animate-pulse">
                  <div className={`${viewMode === 'compact' ? 'aspect-square' : 'aspect-[210/297]'} bg-slate-100`} />
                  <div className="p-3">
                    <div className="h-3 bg-slate-200 rounded w-3/4 mb-1" />
                    <div className="h-2.5 bg-slate-100 rounded w-1/2" />
                  </div>
                </div>
              )
            ))}
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
              <FileText className="w-8 h-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-semibold text-slate-700 mb-1">
              {searchQuery ? 'Sin resultados' : 'No hay plantillas'}
            </h3>
            <p className="text-sm text-slate-500 mb-4">
              {searchQuery
                ? 'Intenta con otra búsqueda'
                : 'Crea tu primera plantilla de documento para generar certificados, credenciales y más'}
            </p>
            {!searchQuery && (
              <button
                onClick={() => setIsCreateModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm"
              >
                <Plus className="w-4 h-4" />
                Crear plantilla
              </button>
            )}
          </div>
        ) : (
          <>
            {/* List view */}
            {viewMode === 'list' ? (
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {filteredTemplates.map((template) => (
                  <div
                    key={template.id}
                    onClick={() => router.push(`/dashboard/documents/${template.id}`)}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50 cursor-pointer group relative"
                  >
                    {/* Mini thumbnail */}
                    <div className="w-10 h-14 bg-slate-50 border border-slate-100 rounded flex-shrink-0 flex items-center justify-center overflow-hidden">
                      {template.thumbnail_url ? (
                        <img src={template.thumbnail_url} alt={template.name} className="w-full h-full object-contain" />
                      ) : (
                        <FileText className="w-5 h-5 text-slate-300" />
                      )}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 truncate">{template.name}</h3>
                      {template.description && (
                        <p className="text-xs text-slate-500 truncate">{template.description}</p>
                      )}
                    </div>
                    <span className="text-xs text-slate-400 hidden sm:block">{template.page_width}×{template.page_height}mm</span>
                    <span className="text-xs text-slate-400 hidden md:block">{format(new Date(template.updated_at), "d MMM yyyy", { locale: es })}</span>
                    {/* Menu */}
                    <div data-menu-dropdown>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(menuOpen === template.id ? null : template.id); }}
                        className={`p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all ${menuOpen === template.id ? 'opacity-100' : 'opacity-50 group-hover:opacity-100'}`}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {menuOpen === template.id && (
                        <div className="absolute right-4 top-12 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-44 z-20">
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDuplicate(template.id); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Copy className="w-4 h-4" /> Duplicar</button>
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleExportJSON(template.id, template.name); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Download className="w-4 h-4" /> Exportar JSON</button>
                          <hr className="my-1 border-slate-100" />
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteTemplate(template.id); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /> Eliminar</button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* Grid views: large / thumbnails / compact */
              <div className={`grid gap-4 ${
                viewMode === 'large' ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' :
                viewMode === 'thumbnails' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3' :
                'grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10 gap-2'
              }`}>
                {filteredTemplates.map((template) => (
                  <div
                    key={template.id}
                    onClick={() => router.push(`/dashboard/documents/${template.id}`)}
                    className={`bg-white rounded-xl border border-slate-200 hover:shadow-md hover:border-emerald-200 transition-all cursor-pointer group relative ${
                      viewMode === 'compact' ? 'rounded-lg' : ''
                    }`}
                  >
                    {/* Thumbnail */}
                    <div className={`bg-slate-50 border-b border-slate-100 flex items-center justify-center relative overflow-hidden ${
                      viewMode === 'large' ? 'aspect-[210/297] rounded-t-xl' :
                      viewMode === 'thumbnails' ? 'aspect-[3/4] rounded-t-xl' :
                      'aspect-square rounded-t-lg'
                    }`}>
                      {template.thumbnail_url ? (
                        <img src={template.thumbnail_url} alt={template.name} className="w-full h-full object-contain" />
                      ) : (
                        <div className="flex flex-col items-center gap-1 text-slate-300">
                          <FileText className={viewMode === 'compact' ? 'w-6 h-6' : 'w-10 h-10'} />
                          {viewMode !== 'compact' && <span className="text-xs font-medium">Sin vista previa</span>}
                        </div>
                      )}
                      {/* Hover overlay */}
                      {viewMode !== 'compact' && (
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className={`bg-white/90 backdrop-blur-sm rounded-lg shadow font-medium text-slate-700 flex items-center gap-1.5 ${
                              viewMode === 'large' ? 'px-3 py-1.5 text-sm' : 'px-2 py-1 text-xs'
                            }`}>
                              <Pencil className="w-3 h-3" />
                              Editar
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Menu */}
                    <div className={`absolute ${viewMode === 'compact' ? 'top-1 right-1' : 'top-2 right-2'} z-10`} data-menu-dropdown>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(menuOpen === template.id ? null : template.id); }}
                        className={`p-1 rounded-lg bg-white/80 backdrop-blur-sm hover:bg-white text-slate-400 hover:text-slate-600 transition-all shadow-sm ${menuOpen === template.id ? 'opacity-100' : 'opacity-50 group-hover:opacity-100'}`}
                      >
                        <MoreVertical className={viewMode === 'compact' ? 'w-3 h-3' : 'w-4 h-4'} />
                      </button>
                      {menuOpen === template.id && (
                        <div className="absolute right-0 top-8 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-44 z-20">
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDuplicate(template.id); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Copy className="w-4 h-4" /> Duplicar</button>
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleExportJSON(template.id, template.name); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Download className="w-4 h-4" /> Exportar JSON</button>
                          <hr className="my-1 border-slate-100" />
                          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteTemplate(template.id); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /> Eliminar</button>
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className={viewMode === 'compact' ? 'p-2' : viewMode === 'thumbnails' ? 'p-3' : 'p-4'}>
                      <h3 className={`font-semibold text-slate-900 truncate ${
                        viewMode === 'compact' ? 'text-xs' : viewMode === 'thumbnails' ? 'text-sm' : 'text-base'
                      }`}>{template.name}</h3>
                      {viewMode !== 'compact' && template.description && (
                        <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">{template.description}</p>
                      )}
                      {viewMode === 'large' && (
                        <div className="flex items-center justify-between mt-2 text-xs text-slate-400">
                          <span>{template.page_width}×{template.page_height}mm</span>
                          <span>{format(new Date(template.updated_at), "d MMM yyyy", { locale: es })}</span>
                        </div>
                      )}
                      {viewMode === 'thumbnails' && (
                        <div className="text-xs text-slate-400 mt-1">{template.page_width}×{template.page_height}mm</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Create Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setIsCreateModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Nueva plantilla</h2>
              <form onSubmit={handleCreateTemplate}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
                    <input
                      autoFocus
                      type="text"
                      value={newTemplate.name}
                      onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                      placeholder="Ej: Certificado de asistencia"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Descripción (opcional)</label>
                    <textarea
                      value={newTemplate.description}
                      onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                      placeholder="¿Para qué se usará esta plantilla?"
                      rows={2}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
                    />
                  </div>

                  {/* Page size */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Tamaño de página</label>
                    <div className="flex items-center gap-2">
                      {Object.entries(PAGE_SIZES).map(([key, cfg]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => handlePageSizeChange(key)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                            pageSize === key
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          {cfg.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Orientation */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Orientación</label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleOrientationChange('portrait')}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                          newTemplate.page_orientation === 'portrait'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="w-3 h-4 border border-current rounded-[2px]" />
                        Vertical
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOrientationChange('landscape')}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                          newTemplate.page_orientation === 'landscape'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="w-4 h-3 border border-current rounded-[2px]" />
                        Horizontal
                      </button>
                    </div>
                  </div>

                  {/* Custom dimensions */}
                  {pageSize === 'custom' && (
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-slate-600 mb-1">Ancho (mm)</label>
                        <input
                          type="number"
                          value={newTemplate.page_width}
                          onChange={(e) => setNewTemplate({ ...newTemplate, page_width: Number(e.target.value) })}
                          min={50}
                          max={2000}
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-slate-600 mb-1">Alto (mm)</label>
                        <input
                          type="number"
                          value={newTemplate.page_height}
                          onChange={(e) => setNewTemplate({ ...newTemplate, page_height: Number(e.target.value) })}
                          min={50}
                          max={2000}
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>
                    </div>
                  )}
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
                    disabled={!newTemplate.name.trim() || creating}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creating ? 'Creando...' : 'Crear plantilla'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Close menu handled by mousedown listener */}
    </div>
  );
}
