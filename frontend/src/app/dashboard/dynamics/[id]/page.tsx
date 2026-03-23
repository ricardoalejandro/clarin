"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, createWebSocket } from '@/lib/api';
import { Dynamic, DynamicItem, DynamicConfig, DynamicOption, DynamicLink, DynamicLinkRegistration, DEFAULT_CONFIG } from '@/types/dynamic';
import { compressImageStandard } from '@/utils/imageCompression';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft, Save, Images, Settings2, Link2, Plus, Trash2, GripVertical,
  Upload, ExternalLink, Copy, Check, Eye, EyeOff, Palette, Volume2, VolumeX,
  PartyPopper, Sparkles, Image as ImageIcon, LayoutGrid, Grid3X3, Grid2X2, List,
  CheckSquare, Square, XCircle, Tag, MessageCircle, Pencil, X, Film, FileText,
  Calendar, Download, Users, RefreshCw
} from 'lucide-react';

type Tab = 'content' | 'config' | 'links';
type ViewMode = 'large' | 'medium' | 'small' | 'details';

// ─── Toast System ────────────────────────────────────────────────────────────
type ToastType = 'success' | 'error';
interface ToastMessage { id: number; text: string; type: ToastType; }
let toastIdCounter = 0;

function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const show = useCallback((text: string, type: ToastType = 'success') => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev, { id, text, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);
  return { toasts, show };
}

function ToastContainer({ toasts }: { toasts: ToastMessage[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <div key={t.id} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium animate-in slide-in-from-bottom-2 transition-all ${
          t.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {t.type === 'success' ? <Check className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

// Re-decode a string where UTF-8 bytes were incorrectly interpreted as Latin-1
function fixExifEncoding(str: string): string {
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code > 255) return str;
      bytes[i] = code;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return str;
  }
}

// Extract metadata JSON from raw image bytes, bypassing exifr's TextDecoder which corrupts Latin-1 data
async function extractMetadataFromImage(file: File): Promise<{ text: string; author: string; tipo: string }> {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const limit = Math.min(bytes.length, 65536);
    // Search for {"text" or {"author" patterns in raw EXIF bytes
    const needles = [
      [0x7B, 0x22, 0x74, 0x65, 0x78, 0x74],             // {"text
      [0x7B, 0x22, 0x61, 0x75, 0x74, 0x68, 0x6F, 0x72], // {"author
    ];
    for (let i = 0; i < limit - 8; i++) {
      if (bytes[i] !== 0x7B) continue;
      let matched = false;
      for (const needle of needles) {
        if (i + needle.length > limit) continue;
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
          if (bytes[i + j] !== needle[j]) { ok = false; break; }
        }
        if (ok) { matched = true; break; }
      }
      if (!matched) continue;
      // Find the matching closing brace
      let depth = 0, end = -1;
      for (let k = i; k < Math.min(i + 4096, limit); k++) {
        if (bytes[k] === 0x7B) depth++;
        else if (bytes[k] === 0x7D) { depth--; if (depth === 0) { end = k + 1; break; } }
      }
      if (end <= i) continue;
      const jsonBytes = bytes.slice(i, end);
      // Try UTF-8 first (correct if the tool wrote UTF-8)
      try {
        const str = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
        const meta = JSON.parse(str);
        if (meta.text !== undefined || meta.author !== undefined) {
          return { text: String(meta.text || ''), author: String(meta.author || ''), tipo: String(meta.tipo || '') };
        }
      } catch {}
      // Fall back to Latin-1 decode + re-encode values as UTF-8
      try {
        const chars: string[] = [];
        for (let j = 0; j < jsonBytes.length; j++) chars.push(String.fromCharCode(jsonBytes[j]));
        const meta = JSON.parse(chars.join(''));
        return {
          text: fixExifEncoding(String(meta.text || '')),
          author: fixExifEncoding(String(meta.author || '')),
          tipo: fixExifEncoding(String(meta.tipo || '')),
        };
      } catch {}
    }
  } catch {}
  return { text: '', author: '', tipo: '' };
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DynamicEditorPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [dynamic, setDynamic] = useState<Dynamic | null>(null);
  const [items, setItems] = useState<DynamicItem[]>([]);
  const [options, setOptions] = useState<DynamicOption[]>([]);
  const [links, setLinks] = useState<DynamicLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('content');
  const [config, setConfig] = useState<DynamicConfig>(DEFAULT_CONFIG);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null) as React.MutableRefObject<HTMLInputElement | null>;

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [dynRes, itemsRes, optionsRes, linksRes] = await Promise.all([
        api<Dynamic>(`/api/dynamics/${id}`),
        api<DynamicItem[]>(`/api/dynamics/${id}/items`),
        api<DynamicOption[]>(`/api/dynamics/${id}/options`),
        api<DynamicLink[]>(`/api/dynamics/${id}/links`),
      ]);
      if (dynRes.success && dynRes.data) {
        const d = dynRes.data;
        setDynamic(d);
        setName(d.name);
        setSlug(d.slug);
        setDescription(d.description);
        setIsActive(d.is_active);
        setConfig({ ...DEFAULT_CONFIG, ...d.config });
      }
      if (itemsRes.success) {
        setItems(itemsRes.data || []);
      }
      if (optionsRes.success) {
        setOptions(optionsRes.data || []);
      }
      if (linksRes.success) {
        setLinks(linksRes.data || []);
      }
    } catch (error) {
      console.error('Error fetching dynamic:', error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    if (!dynamic) return;
    setSaving(true);
    try {
      await api(`/api/dynamics/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, slug, description, config, is_active: isActive }),
      });
      setDynamic({ ...dynamic, name, slug, description, config, is_active: isActive });
      toast.show('Cambios guardados');
    } catch (error) {
      console.error('Error saving:', error);
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    setUploading(true);
    const token = localStorage.getItem('token');

    for (const file of imageFiles) {
      try {
        // Extract EXIF metadata from raw bytes BEFORE compression (Canvas strips EXIF)
        const { text: thoughtText, author, tipo } = await extractMetadataFromImage(file);

        const compressed = await compressImageStandard(file);
        const formData = new FormData();
        formData.append('image', compressed);
        formData.append('thought_text', thoughtText);
        formData.append('author', author);
        formData.append('tipo', tipo);

        const res = await fetch(`/api/dynamics/${id}/items`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const data = await res.json();
        if (res.ok && data.id) {
          setItems(prev => [...prev, data]);
        }
      } catch (error) {
        console.error('Error uploading file:', error);
      }
    }
    setUploading(false);
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    uploadFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    uploadFiles(files);
    e.target.value = '';
  };

  const handleDeleteItem = async (itemId: string) => {
    try {
      await api(`/api/dynamics/${id}/items/${itemId}`, { method: 'DELETE' });
      setItems(prev => prev.filter(i => i.id !== itemId));
    } catch (error) {
      console.error('Error deleting item:', error);
    }
  };

  const handleBulkDeleteItems = async (itemIds: string[]) => {
    if (itemIds.length === 0) return;
    try {
      await api(`/api/dynamics/${id}/items/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ item_ids: itemIds }),
      });
      setItems(prev => prev.filter(i => !itemIds.includes(i.id)));
    } catch (error) {
      console.error('Error deleting items:', error);
    }
  };

  const handleUpdateItem = async (item: DynamicItem, thoughtText: string, author: string, tipo: string) => {
    try {
      await api(`/api/dynamics/${id}/items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ thought_text: thoughtText, author, tipo, is_active: item.is_active }),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, thought_text: thoughtText, author, tipo } : i));
      toast.show('Item actualizado');
    } catch (error) {
      console.error('Error updating item:', error);
    }
  };

  const handleToggleItemActive = async (item: DynamicItem) => {
    try {
      await api(`/api/dynamics/${id}/items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ thought_text: item.thought_text, author: item.author, tipo: item.tipo, is_active: !item.is_active }),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_active: !i.is_active } : i));
      toast.show(item.is_active ? 'Item desactivado' : 'Item activado');
    } catch (error) {
      console.error('Error toggling item:', error);
    }
  };

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'content', label: 'Contenido', icon: <Images className="w-4 h-4" /> },
    { key: 'config', label: 'Configuración', icon: <Settings2 className="w-4 h-4" /> },
    { key: 'links', label: 'Links', icon: <Link2 className="w-4 h-4" /> },
  ];

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-200 border-t-emerald-600" />
      </div>
    );
  }

  if (!dynamic) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        Dinámica no encontrada
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <ToastContainer toasts={toast.toasts} />
      <div className="flex-shrink-0 px-6 py-4 border-b border-slate-200 flex items-center gap-4">
        <button onClick={() => router.push('/dashboard/dynamics')} className="p-2 hover:bg-slate-100 rounded-xl transition-colors">
          <ArrowLeft className="w-5 h-5 text-slate-500" />
        </button>
        <div className="flex-1 min-w-0">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="text-lg font-bold text-slate-800 bg-transparent border-none outline-none w-full placeholder:text-slate-300"
            placeholder="Nombre de la dinámica"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setIsActive(!isActive); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              isActive ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            {isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {isActive ? 'Activa' : 'Borrador'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 px-6 border-b border-slate-200">
        <div className="flex gap-1">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'content' && (
          <ContentTab
            items={items}
            options={options}
            dynamicId={id}
            uploading={uploading}
            dragOver={dragOver}
            fileInputRef={fileInputRef}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleFileDrop}
            onFileSelect={handleFileSelect}
            onDeleteItem={handleDeleteItem}
            onBulkDeleteItems={handleBulkDeleteItems}
            onUpdateItem={handleUpdateItem}
            onToggleActive={handleToggleItemActive}
            onOptionsChange={setOptions}
            onItemsChange={setItems}
          />
        )}

        {activeTab === 'config' && (
          <ConfigTab config={config} onChange={setConfig} />
        )}

        {activeTab === 'links' && (
          <LinksTab dynamicId={id} links={links} onLinksChange={setLinks} toast={toast} />
        )}
      </div>
    </div>
  );
}

// ─── Content Tab ─────────────────────────────────────────────────────────────

function ContentTab({
  items, options, dynamicId, uploading, dragOver, fileInputRef, onDragOver, onDragLeave, onDrop, onFileSelect,
  onDeleteItem, onBulkDeleteItems, onUpdateItem, onToggleActive, onOptionsChange, onItemsChange,
}: {
  items: DynamicItem[];
  options: DynamicOption[];
  dynamicId: string;
  uploading: boolean;
  dragOver: boolean;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDeleteItem: (id: string) => void;
  onBulkDeleteItems: (ids: string[]) => void;
  onUpdateItem: (item: DynamicItem, thoughtText: string, author: string, tipo: string) => void;
  onToggleActive: (item: DynamicItem) => void;
  onOptionsChange: (opts: DynamicOption[]) => void;
  onItemsChange: (items: DynamicItem[]) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('large');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selecting = selectedIds.size > 0;

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(items.map(i => i.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    onBulkDeleteItems(Array.from(selectedIds));
    setSelectedIds(new Set());
  };

  const viewModes: { key: ViewMode; icon: React.ReactNode; label: string }[] = [
    { key: 'large', icon: <Grid2X2 className="w-4 h-4" />, label: 'Grande' },
    { key: 'medium', icon: <Grid3X3 className="w-4 h-4" />, label: 'Mediano' },
    { key: 'small', icon: <LayoutGrid className="w-4 h-4" />, label: 'Pequeño' },
    { key: 'details', icon: <List className="w-4 h-4" />, label: 'Detalles' },
  ];

  const gridClass = {
    large: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
    medium: 'grid gap-3 grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6',
    small: 'grid gap-2 grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10',
    details: 'flex flex-col gap-1',
  };

  return (
    <div className="p-6 space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
          dragOver
            ? 'border-emerald-400 bg-emerald-50'
            : 'border-slate-300 hover:border-emerald-400 hover:bg-emerald-50/50'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onFileSelect}
          className="hidden"
        />
        {uploading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-200 border-t-emerald-600" />
            <p className="text-sm text-emerald-600 font-medium">Subiendo imágenes...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">
              <Upload className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm font-medium text-slate-600">Arrastra imágenes aquí o haz clic para seleccionar</p>
            <p className="text-xs text-slate-400">JPG, PNG, GIF, WebP — Se comprimen automáticamente</p>
          </div>
        )}
      </div>

      {/* Options Management */}
      <OptionsSection dynamicId={dynamicId} options={options} onOptionsChange={onOptionsChange} items={items} onItemsChange={onItemsChange} />

      {/* View switcher + count */}
      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <p className="text-xs text-slate-400">{items.length} {items.length === 1 ? 'imagen' : 'imágenes'}</p>
              {selecting ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                    {selectedIds.size} seleccionada{selectedIds.size !== 1 ? 's' : ''}
                  </span>
                  <button onClick={selectAll} className="text-xs text-slate-500 hover:text-slate-700 underline">Todas</button>
                  <button onClick={deselectAll} className="text-xs text-slate-500 hover:text-slate-700 underline">Ninguna</button>
                  <button
                    onClick={handleBulkDelete}
                    className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    Eliminar ({selectedIds.size})
                  </button>
                  <button onClick={deselectAll} className="p-1 hover:bg-slate-100 rounded-lg" title="Cancelar selección">
                    <XCircle className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={selectAll}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                >
                  Seleccionar
                </button>
              )}
            </div>
            <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
              {viewModes.map(vm => (
                <button
                  key={vm.key}
                  onClick={() => setViewMode(vm.key)}
                  title={vm.label}
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === vm.key
                      ? 'bg-white text-emerald-600 shadow-sm'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  {vm.icon}
                </button>
              ))}
            </div>
          </div>

          {/* Items grid */}
          <div className={gridClass[viewMode]}>
            {items.map((item, idx) => (
              viewMode === 'details' ? (
                <DetailRow
                  key={item.id}
                  item={item}
                  index={idx}
                  selected={selectedIds.has(item.id)}
                  selecting={selecting}
                  onToggleSelect={toggleSelect}
                  onDelete={onDeleteItem}
                  onUpdateItem={onUpdateItem}
                  onToggleActive={onToggleActive}
                />
              ) : (
                <ItemCard
                  key={item.id}
                  item={item}
                  index={idx}
                  viewMode={viewMode}
                  selected={selectedIds.has(item.id)}
                  selecting={selecting}
                  onToggleSelect={toggleSelect}
                  onDelete={onDeleteItem}
                  onUpdateItem={onUpdateItem}
                  onToggleActive={onToggleActive}
                />
              )
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ItemCard({
  item, index, viewMode, selected, selecting, onToggleSelect, onDelete, onUpdateItem, onToggleActive,
}: {
  item: DynamicItem;
  index: number;
  viewMode: ViewMode;
  selected: boolean;
  selecting: boolean;
  onToggleSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdateItem: (item: DynamicItem, thoughtText: string, author: string, tipo: string) => void;
  onToggleActive: (item: DynamicItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [thoughtText, setThoughtText] = useState(item.thought_text);
  const [author, setAuthor] = useState(item.author);
  const [tipo, setTipo] = useState(item.tipo || '');

  const handleSave = () => {
    onUpdateItem(item, thoughtText, author, tipo);
    setEditing(false);
  };

  const handleClick = () => {
    if (selecting) onToggleSelect(item.id);
  };

  const selectionCheckbox = (size: string) => (
    <button
      onClick={e => { e.stopPropagation(); onToggleSelect(item.id); }}
      className={`p-0.5 rounded transition-all ${selected ? 'opacity-100' : selecting ? 'opacity-70' : 'opacity-0 group-hover:opacity-60'}`}
    >
      {selected
        ? <CheckSquare className={`${size} text-emerald-500`} />
        : <Square className={`${size} text-white drop-shadow`} />
      }
    </button>
  );

  // Small view — compact thumbnail only
  if (viewMode === 'small') {
    return (
      <div
        onClick={handleClick}
        className={`relative rounded-lg overflow-hidden group transition-all ${
          item.is_active ? '' : 'opacity-50'
        } ${selected ? 'ring-2 ring-emerald-500 ring-offset-1' : ''} ${selecting ? 'cursor-pointer' : ''}`}
      >
        <div className="aspect-square bg-slate-100">
          <img src={item.image_url} alt={item.thought_text || `Item ${index + 1}`} className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {!selecting && (
              <>
                <button onClick={e => { e.stopPropagation(); onToggleActive(item); }} className="p-1 bg-white/90 rounded-md">
                  {item.is_active ? <Eye className="w-3 h-3 text-emerald-600" /> : <EyeOff className="w-3 h-3 text-slate-400" />}
                </button>
                <button onClick={e => { e.stopPropagation(); onDelete(item.id); }} className="p-1 bg-white/90 rounded-md hover:bg-red-50">
                  <Trash2 className="w-3 h-3 text-red-500" />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="absolute top-1 left-1">
          {selectionCheckbox('w-3.5 h-3.5')}
        </div>
        <div className="absolute bottom-1 right-1 bg-black/50 text-white text-[10px] px-1 py-0.5 rounded">
          {index + 1}
        </div>
      </div>
    );
  }

  // Medium view — thumbnail + minimal info + file size
  if (viewMode === 'medium') {
    return (
      <div
        onClick={handleClick}
        className={`rounded-xl overflow-hidden group transition-all border ${
          item.is_active ? 'border-slate-200' : 'border-slate-200 opacity-50'
        } ${selected ? 'ring-2 ring-emerald-500 ring-offset-1' : ''} ${selecting ? 'cursor-pointer' : ''}`}
      >
        <div className="relative aspect-square bg-slate-100">
          <img src={item.image_url} alt={item.thought_text || `Item ${index + 1}`} className="w-full h-full object-cover" />
          <div className="absolute top-1 left-1">
            {selectionCheckbox('w-3.5 h-3.5')}
          </div>
          {!selecting && (
            <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={e => { e.stopPropagation(); onToggleActive(item); }} className="p-1 bg-white/90 rounded-md shadow-sm">
                {item.is_active ? <Eye className="w-3 h-3 text-emerald-600" /> : <EyeOff className="w-3 h-3 text-slate-400" />}
              </button>
              <button onClick={e => { e.stopPropagation(); onDelete(item.id); }} className="p-1 bg-white/90 rounded-md shadow-sm hover:bg-red-50">
                <Trash2 className="w-3 h-3 text-red-500" />
              </button>
            </div>
          )}
          <div className="absolute bottom-1 left-1 bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded-full">
            #{index + 1}
          </div>
        </div>
        <div className="p-1.5">
          {item.thought_text && <p className="text-[11px] text-slate-600 truncate">{item.thought_text}</p>}
          <div className="flex items-center justify-between">
            {item.author && <p className="text-[10px] text-slate-400 truncate flex-1">{'\u2014'} {item.author}</p>}
            {item.tipo && <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded shrink-0">{item.tipo}</span>}
            {item.file_size > 0 && <span className="text-[10px] text-slate-300 shrink-0">{formatFileSize(item.file_size)}</span>}
          </div>
        </div>
      </div>
    );
  }

  // Large view — full card with editable fields + file size
  return (
    <div
      onClick={handleClick}
      className={`bg-white border rounded-xl overflow-hidden group transition-all ${
        item.is_active ? 'border-slate-200' : 'border-slate-200 opacity-60'
      } ${selected ? 'ring-2 ring-emerald-500 ring-offset-1' : ''} ${selecting ? 'cursor-pointer' : ''}`}
    >
      <div className="relative aspect-[4/3] bg-slate-100">
        <img
          src={item.image_url}
          alt={item.thought_text || `Item ${index + 1}`}
          className="w-full h-full object-contain"
        />
        <div className="absolute top-2 left-2">
          {selectionCheckbox('w-4 h-4')}
        </div>
        {!selecting && (
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={e => { e.stopPropagation(); onToggleActive(item); }}
              className="p-1.5 bg-white/90 backdrop-blur rounded-lg shadow-sm hover:bg-white transition-colors"
              title={item.is_active ? 'Desactivar' : 'Activar'}
            >
              {item.is_active ? <Eye className="w-3.5 h-3.5 text-emerald-600" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
            </button>
            <button
              onClick={e => { e.stopPropagation(); onDelete(item.id); }}
              className="p-1.5 bg-white/90 backdrop-blur rounded-lg shadow-sm hover:bg-red-50 transition-colors"
              title="Eliminar"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-500" />
            </button>
          </div>
        )}
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
          <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">#{index + 1}</span>
          {item.file_size > 0 && <span className="bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded-full">{formatFileSize(item.file_size)}</span>}
        </div>
      </div>
      <div className="p-3 space-y-2">
        {editing && !selecting ? (
          <>
            <input
              type="text"
              value={thoughtText}
              onChange={e => setThoughtText(e.target.value)}
              placeholder="Pensamiento..."
              className="w-full text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              autoFocus
            />
            <input
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="Autor..."
              className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
            <input
              type="text"
              value={tipo}
              onChange={e => setTipo(e.target.value)}
              onBlur={handleSave}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              placeholder="Tipo..."
              className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
          </>
        ) : (
          <div onClick={e => { if (!selecting) { e.stopPropagation(); setEditing(true); } }} className="cursor-pointer min-h-[40px]">
            <p className="text-sm text-slate-600 hover:text-slate-800 truncate">
              {item.thought_text || <span className="text-slate-400 italic">Agregar pensamiento...</span>}
            </p>
            {item.author && (
              <p className="text-xs text-slate-400 truncate">{'\u2014'} {item.author}</p>
            )}
            {item.tipo && (
              <span className="inline-block text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded mt-0.5">{item.tipo}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Detail Row (list view) ──────────────────────────────────────────────────

function DetailRow({
  item, index, selected, selecting, onToggleSelect, onDelete, onUpdateItem, onToggleActive,
}: {
  item: DynamicItem;
  index: number;
  selected: boolean;
  selecting: boolean;
  onToggleSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdateItem: (item: DynamicItem, thoughtText: string, author: string, tipo: string) => void;
  onToggleActive: (item: DynamicItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [thoughtText, setThoughtText] = useState(item.thought_text);
  const [author, setAuthor] = useState(item.author);
  const [tipo, setTipo] = useState(item.tipo || '');

  const handleSave = () => {
    onUpdateItem(item, thoughtText, author, tipo);
    setEditing(false);
  };

  return (
    <div
      onClick={() => { if (selecting) onToggleSelect(item.id); }}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 group transition-colors ${
        item.is_active ? '' : 'opacity-50'
      } ${selected ? 'bg-emerald-50 hover:bg-emerald-50' : ''} ${selecting ? 'cursor-pointer' : ''}`}
    >
      <button
        onClick={e => { e.stopPropagation(); onToggleSelect(item.id); }}
        className={`shrink-0 transition-all ${selected ? 'opacity-100' : selecting ? 'opacity-70' : 'opacity-0 group-hover:opacity-60'}`}
      >
        {selected
          ? <CheckSquare className="w-4 h-4 text-emerald-500" />
          : <Square className="w-4 h-4 text-slate-300" />
        }
      </button>
      <span className="text-xs text-slate-400 w-6 text-right shrink-0">{index + 1}</span>
      <div className="w-10 h-10 rounded-lg bg-slate-100 overflow-hidden shrink-0">
        <img src={item.image_url} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        {editing && !selecting ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={thoughtText}
              onChange={e => setThoughtText(e.target.value)}
              placeholder="Pensamiento..."
              className="flex-1 text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              autoFocus
            />
            <input
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="Autor..."
              className="w-40 text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
            <input
              type="text"
              value={tipo}
              onChange={e => setTipo(e.target.value)}
              onBlur={handleSave}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              placeholder="Tipo..."
              className="w-28 text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
          </div>
        ) : (
          <div onClick={e => { if (!selecting) { e.stopPropagation(); setEditing(true); } }} className="cursor-pointer">
            <p className="text-sm text-slate-700 truncate">
              {item.thought_text || <span className="text-slate-400 italic">Sin pensamiento</span>}
            </p>
            <div className="flex items-center gap-2">
              {item.author && (
                <p className="text-xs text-slate-400 truncate">{'\u2014'} {item.author}</p>
              )}
              {item.tipo && (
                <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">{item.tipo}</span>
              )}
            </div>
          </div>
        )}
      </div>
      {item.file_size > 0 && (
        <span className="text-[11px] text-slate-300 shrink-0">{formatFileSize(item.file_size)}</span>
      )}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={e => { e.stopPropagation(); onToggleActive(item); }} className="p-1.5 hover:bg-slate-100 rounded-lg" title={item.is_active ? 'Desactivar' : 'Activar'}>
          {item.is_active ? <Eye className="w-3.5 h-3.5 text-emerald-600" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete(item.id); }} className="p-1.5 hover:bg-red-50 rounded-lg" title="Eliminar">
          <Trash2 className="w-3.5 h-3.5 text-red-500" />
        </button>
      </div>
    </div>
  );
}

// ─── Config Tab ──────────────────────────────────────────────────────────────

function ConfigTab({ config, onChange }: { config: DynamicConfig; onChange: (c: DynamicConfig) => void }) {
  const update = (key: keyof DynamicConfig, value: string | number | boolean) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="p-6 max-w-2xl space-y-6">
      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">Título de la página pública</label>
        <input
          type="text"
          value={config.title}
          onChange={e => update('title', e.target.value)}
          className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
          placeholder="✨ Raspa y Descubre ✨"
        />
      </div>

      {/* Colors */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5">
            <Palette className="w-4 h-4" /> Color de fondo
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={config.bg_color}
              onChange={e => update('bg_color', e.target.value)}
              className="w-10 h-10 rounded-lg border border-slate-200 cursor-pointer"
            />
            <input
              type="text"
              value={config.bg_color}
              onChange={e => update('bg_color', e.target.value)}
              className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono"
            />
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5">
            <Palette className="w-4 h-4" /> Color de raspado
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={config.scratch_color}
              onChange={e => update('scratch_color', e.target.value)}
              className="w-10 h-10 rounded-lg border border-slate-200 cursor-pointer"
            />
            <input
              type="text"
              value={config.scratch_color}
              onChange={e => update('scratch_color', e.target.value)}
              className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono"
            />
          </div>
        </div>
      </div>

      {/* Threshold */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          Umbral de raspado: {config.scratch_threshold}%
        </label>
        <input
          type="range"
          min={20}
          max={80}
          value={config.scratch_threshold}
          onChange={e => update('scratch_threshold', parseInt(e.target.value))}
          className="w-full accent-emerald-600"
        />
        <div className="flex justify-between text-xs text-slate-400 mt-1">
          <span>Fácil (20%)</span>
          <span>Difícil (80%)</span>
        </div>
      </div>

      {/* Toggles */}
      <div className="space-y-3">
        <ToggleOption
          icon={<Volume2 className="w-4 h-4" />}
          offIcon={<VolumeX className="w-4 h-4" />}
          label="Sonido de raspado"
          description="Reproduce un sonido realista al raspar"
          checked={config.scratch_sound}
          onChange={v => update('scratch_sound', v)}
        />
        <ToggleOption
          icon={<PartyPopper className="w-4 h-4" />}
          label="Confetti al revelar"
          description="Muestra una lluvia de confetti al descubrir la imagen"
          checked={config.show_confetti}
          onChange={v => update('show_confetti', v)}
        />
        <ToggleOption
          icon={<Volume2 className="w-4 h-4" />}
          offIcon={<VolumeX className="w-4 h-4" />}
          label="Sonido de victoria"
          description="Reproduce un sonido al revelar completamente"
          checked={config.victory_sound}
          onChange={v => update('victory_sound', v)}
        />
      </div>

      {/* Overlay image */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          Imagen de overlay (opcional)
        </label>
        <p className="text-xs text-slate-400 mb-2">URL de imagen que se muestra sobre la capa de raspado</p>
        <input
          type="text"
          value={config.overlay_image_url}
          onChange={e => update('overlay_image_url', e.target.value)}
          className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400"
          placeholder="https://..."
        />
      </div>
    </div>
  );
}

function ToggleOption({
  icon, offIcon, label, description, checked, onChange,
}: {
  icon: React.ReactNode;
  offIcon?: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
      <div className="flex items-center gap-3">
        <div className={`${checked ? 'text-emerald-600' : 'text-slate-400'}`}>
          {checked ? icon : (offIcon || icon)}
        </div>
        <div>
          <p className="text-sm font-medium text-slate-700">{label}</p>
          <p className="text-xs text-slate-400">{description}</p>
        </div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors ${
          checked ? 'bg-emerald-500' : 'bg-slate-300'
        }`}
      >
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`} />
      </button>
    </div>
  );
}

// ─── Share Tab ───────────────────────────────────────────────────────────────

// ─── Options Management Section ──────────────────────────────────────────────

function OptionsSection({
  dynamicId, options, onOptionsChange, items, onItemsChange,
}: {
  dynamicId: string;
  options: DynamicOption[];
  onOptionsChange: (opts: DynamicOption[]) => void;
  items: DynamicItem[];
  onItemsChange: (items: DynamicItem[]) => void;
}) {
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [filterOption, setFilterOption] = useState<string>('all'); // 'all' | 'none' | option_id

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const res = await api<DynamicOption>(`/api/dynamics/${dynamicId}/options`, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), emoji: newEmoji.trim() }),
      });
      if (res.success && res.data) {
        onOptionsChange([...options, res.data]);
        setNewName('');
        setNewEmoji('');
      }
    } catch (e) { console.error(e); }
  };

  const handleUpdate = async (opt: DynamicOption) => {
    try {
      await api(`/api/dynamics/${dynamicId}/options/${opt.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim(), emoji: editEmoji.trim() }),
      });
      onOptionsChange(options.map(o => o.id === opt.id ? { ...o, name: editName.trim(), emoji: editEmoji.trim() } : o));
      setEditingId(null);
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (optId: string) => {
    try {
      await api(`/api/dynamics/${dynamicId}/options/${optId}`, { method: 'DELETE' });
      onOptionsChange(options.filter(o => o.id !== optId));
      // Remove from all items locally
      onItemsChange(items.map(i => ({ ...i, option_ids: i.option_ids.filter(id => id !== optId) })));
    } catch (e) { console.error(e); }
  };

  // Toggle single option on a single item
  const handleToggleItemOption = async (item: DynamicItem, optionId: string) => {
    const has = item.option_ids.includes(optionId);
    const newIds = has ? item.option_ids.filter(id => id !== optionId) : [...item.option_ids, optionId];
    try {
      await api(`/api/dynamics/${dynamicId}/items/${item.id}/options`, {
        method: 'PUT',
        body: JSON.stringify({ option_ids: newIds }),
      });
      onItemsChange(items.map(i => i.id === item.id ? { ...i, option_ids: newIds } : i));
    } catch (e) { console.error(e); }
  };

  // Bulk assign selected items to an option
  const handleBulkAssign = async (optionId: string, action: 'add' | 'remove') => {
    const itemIds = Array.from(selectedItems);
    if (itemIds.length === 0) return;
    try {
      const res = await api(`/api/dynamics/${dynamicId}/items/bulk-assign`, {
        method: 'POST',
        body: JSON.stringify({ item_ids: itemIds, option_id: optionId, action }),
      });
      if (res.success) {
        onItemsChange(items.map(i => {
          if (!selectedItems.has(i.id)) return i;
          if (action === 'add') return { ...i, option_ids: Array.from(new Set([...i.option_ids, optionId])) };
          return { ...i, option_ids: i.option_ids.filter(id => id !== optionId) };
        }));
        // Refresh option counts
        const optsRes = await api<DynamicOption[]>(`/api/dynamics/${dynamicId}/options`);
        if (optsRes.success && optsRes.data) onOptionsChange(optsRes.data);
        setSelectedItems(new Set());
      }
    } catch (e) { console.error(e); }
  };

  // Filter items
  const filteredItems = items.filter(item => {
    if (filterText) {
      const q = filterText.toLowerCase();
      if (!item.thought_text.toLowerCase().includes(q) && !item.author.toLowerCase().includes(q) && !(item.tipo || '').toLowerCase().includes(q)) return false;
    }
    if (filterOption === 'none') return item.option_ids.length === 0;
    if (filterOption !== 'all') return item.option_ids.includes(filterOption);
    return true;
  });

  const toggleSelectAll = () => {
    if (selectedItems.size === filteredItems.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(filteredItems.map(i => i.id)));
    }
  };

  const toggleItem = (id: string) => {
    const next = new Set(selectedItems);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedItems(next);
  };

  return (
    <div className="bg-slate-50 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-emerald-600" />
          <h3 className="text-sm font-semibold text-slate-700">Opciones / Categorías</h3>
        </div>
        <p className="text-xs text-slate-400">
          {options.length === 0 ? 'Sin opciones: todas las imágenes se muestran' :
           options.length === 1 ? '1 opción: no se muestra selector' :
           `${options.length} opciones: se muestra selector en la página pública`}
        </p>
      </div>

      {/* Existing options */}
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map(opt => (
            <div key={opt.id} className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm">
              {editingId === opt.id ? (
                <>
                  <input value={editEmoji} onChange={e => setEditEmoji(e.target.value)} className="w-8 text-center bg-slate-50 border rounded px-1 py-0.5 text-xs" placeholder="😊" />
                  <input value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleUpdate(opt); }} className="w-24 bg-slate-50 border rounded px-1.5 py-0.5 text-xs" autoFocus />
                  <button onClick={() => handleUpdate(opt)} className="text-emerald-600 hover:text-emerald-700"><Check className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setEditingId(null)} className="text-slate-400 hover:text-slate-600"><XCircle className="w-3.5 h-3.5" /></button>
                </>
              ) : (
                <>
                  {opt.emoji && <span>{opt.emoji}</span>}
                  <span className="text-slate-700">{opt.name}</span>
                  <span className="text-xs text-slate-400">({opt.item_count})</span>
                  <button onClick={() => { setEditingId(opt.id); setEditName(opt.name); setEditEmoji(opt.emoji); }} className="text-slate-400 hover:text-slate-600 ml-1"><Pencil className="w-3 h-3" /></button>
                  <button onClick={() => handleDelete(opt.id)} className="text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add new option */}
      <div className="flex items-center gap-2">
        <input value={newEmoji} onChange={e => setNewEmoji(e.target.value)} className="w-10 text-center px-1.5 py-1.5 bg-white border border-slate-200 rounded-lg text-sm" placeholder="😊" />
        <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }} className="flex-1 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm" placeholder="Nombre de la opción..." />
        <button onClick={handleCreate} disabled={!newName.trim()} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Agregar
        </button>
      </div>

      {/* Assign items to options */}
      {options.length > 0 && items.length > 0 && (
        <div className="border-t border-slate-200 pt-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-medium text-slate-500">Asignar imágenes:</p>
            <input
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              className="px-2 py-1 bg-white border border-slate-200 rounded text-xs flex-1 min-w-[120px]"
              placeholder="Filtrar por texto o autor..."
            />
            <select
              value={filterOption}
              onChange={e => { setFilterOption(e.target.value); setSelectedItems(new Set()); }}
              className="px-2 py-1 bg-white border border-slate-200 rounded text-xs"
            >
              <option value="all">Todas</option>
              <option value="none">Sin opción</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.emoji} {o.name}</option>)}
            </select>
          </div>

          {/* Bulk actions bar */}
          {selectedItems.size > 0 && (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <span className="text-xs font-medium text-emerald-700">{selectedItems.size} seleccionados</span>
              <span className="text-emerald-300">|</span>
              {options.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => handleBulkAssign(opt.id, 'add')}
                  className="px-2 py-0.5 bg-emerald-600 text-white text-[11px] font-medium rounded hover:bg-emerald-700 transition-colors"
                >
                  + {opt.emoji} {opt.name}
                </button>
              ))}
              <span className="text-emerald-300">|</span>
              {options.map(opt => (
                <button
                  key={`rm-${opt.id}`}
                  onClick={() => handleBulkAssign(opt.id, 'remove')}
                  className="px-2 py-0.5 bg-red-100 text-red-600 text-[11px] font-medium rounded hover:bg-red-200 transition-colors"
                >
                  − {opt.emoji} {opt.name}
                </button>
              ))}
            </div>
          )}

          {/* Items list */}
          <div className="max-h-64 overflow-y-auto space-y-1">
            <div className="flex items-center gap-2 text-xs text-slate-400 px-1 pb-1">
              <button onClick={toggleSelectAll} className="text-slate-400 hover:text-slate-600">
                {selectedItems.size === filteredItems.length && filteredItems.length > 0
                  ? <CheckSquare className="w-3.5 h-3.5 text-emerald-600" />
                  : <Square className="w-3.5 h-3.5" />}
              </button>
              <span>{filteredItems.length} de {items.length} imágenes</span>
            </div>
            {filteredItems.map((item, idx) => (
              <div key={item.id} className={`flex items-center gap-2 text-xs rounded-lg px-1 py-1 transition-colors ${selectedItems.has(item.id) ? 'bg-emerald-50' : 'hover:bg-slate-100'}`}>
                <button onClick={() => toggleItem(item.id)} className="shrink-0">
                  {selectedItems.has(item.id)
                    ? <CheckSquare className="w-3.5 h-3.5 text-emerald-600" />
                    : <Square className="w-3.5 h-3.5 text-slate-300" />}
                </button>
                <div className="w-7 h-7 rounded bg-slate-100 overflow-hidden shrink-0">
                  <img src={item.image_url} alt="" className="w-full h-full object-cover" />
                </div>
                <span className="flex-1 truncate text-slate-600">{item.thought_text || item.author || item.tipo || 'Sin texto'}</span>
                {item.tipo && <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded shrink-0">{item.tipo}</span>}
                <div className="flex gap-1 shrink-0">
                  {options.map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => handleToggleItemOption(item, opt.id)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border ${
                        item.option_ids.includes(opt.id)
                          ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                          : 'bg-white text-slate-400 border-slate-200 hover:border-emerald-300 hover:text-emerald-600'
                      }`}
                      title={`${item.option_ids.includes(opt.id) ? 'Quitar de' : 'Agregar a'} ${opt.name}`}
                    >
                      {opt.emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WhatsApp Preview Component ──────────────────────────────────────────────

function WAPreview({ msg1Caption, msg2Text, msg2MediaUrl, msg2MediaType }: {
  msg1Caption: string;
  msg2Text: string;
  msg2MediaUrl: string;
  msg2MediaType: string;
}) {
  const hasMsg2 = msg2Text || msg2MediaUrl;
  if (!msg1Caption && !hasMsg2) return null;

  return (
    <div className="mt-3 p-3 bg-[#e5ddd5] rounded-xl space-y-2">
      <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">Vista previa WhatsApp</p>
      {/* Message 1: always the scratch card image + caption */}
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-[#dcf8c6] rounded-lg rounded-tr-none shadow-sm overflow-hidden">
          <div className="w-full h-24 bg-emerald-100 flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-emerald-300" />
          </div>
          {msg1Caption && (
            <p className="px-2.5 py-1.5 text-[11px] text-slate-700 whitespace-pre-wrap">{msg1Caption}</p>
          )}
          <p className="px-2.5 pb-1 text-[9px] text-slate-400 text-right">12:00</p>
        </div>
      </div>
      {/* Message 2: extra message */}
      {hasMsg2 && (
        <div className="flex justify-end">
          <div className="max-w-[75%] bg-[#dcf8c6] rounded-lg rounded-tr-none shadow-sm overflow-hidden">
            {msg2MediaUrl && msg2MediaType === 'image' && (
              <img src={msg2MediaUrl} alt="" className="w-full h-24 object-cover" />
            )}
            {msg2MediaUrl && msg2MediaType === 'video' && (
              <div className="w-full h-24 bg-slate-800 flex items-center justify-center">
                <Film className="w-8 h-8 text-white/50" />
              </div>
            )}
            {msg2Text && (
              <p className="px-2.5 py-1.5 text-[11px] text-slate-700 whitespace-pre-wrap">{msg2Text}</p>
            )}
            <p className="px-2.5 pb-1 text-[9px] text-slate-400 text-right">12:00</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Links Tab ───────────────────────────────────────────────────────────────

function generateSlug() {
  const words = ['sorteo','regalo','promo','evento','oferta','raspa','suerte','premio','bonus','fiesta','juego','loteria','rifa','gana','descubre'];
  const w = words[Math.floor(Math.random() * words.length)];
  const code = Math.random().toString(36).substring(2, 6);
  return `${w}-${code}`;
}

function LinksTab({
  dynamicId, links, onLinksChange, toast,
}: {
  dynamicId: string;
  links: DynamicLink[];
  onLinksChange: (links: DynamicLink[]) => void;
  toast: { show: (text: string, type?: ToastType) => void };
}) {
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newWAEnabled, setNewWAEnabled] = useState(false);
  const [newWAMessage, setNewWAMessage] = useState('¡Aquí tienes tu pensamiento del día! 🌟');
  const [newExtraText, setNewExtraText] = useState('');
  const [newStartsAt, setNewStartsAt] = useState('');
  const [newEndsAt, setNewEndsAt] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState('');
  const [editWAEnabled, setEditWAEnabled] = useState(false);
  const [editWAMessage, setEditWAMessage] = useState('');
  const [editExtraText, setEditExtraText] = useState('');
  const [editExtraMediaUrl, setEditExtraMediaUrl] = useState('');
  const [editExtraMediaType, setEditExtraMediaType] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editStartsAt, setEditStartsAt] = useState('');
  const [editEndsAt, setEditEndsAt] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showQRId, setShowQRId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  // Registrations
  const [regsLinkId, setRegsLinkId] = useState<string | null>(null);
  const [regs, setRegs] = useState<DynamicLinkRegistration[]>([]);
  const [regsTotal, setRegsTotal] = useState(0);
  const [loadingRegs, setLoadingRegs] = useState(false);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Format ISO date to datetime-local input value
  const toLocalInput = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    const offset = d.getTimezoneOffset();
    const local = new Date(d.getTime() - offset * 60000);
    return local.toISOString().slice(0, 16);
  };

  // WebSocket for real-time registration updates
  useEffect(() => {
    const wsProxy = createWebSocket((data: unknown) => {
      const msg = data as { type?: string; data?: { action?: string; link_id?: string; registration?: DynamicLinkRegistration; reg_id?: string } };
      if (msg.type === 'dynamic_registration' && msg.data) {
        if (msg.data.action === 'created' && msg.data.link_id === regsLinkId && msg.data.registration) {
          setRegs(prev => [msg.data!.registration!, ...prev]);
          setRegsTotal(prev => prev + 1);
        }
        if (msg.data.action === 'deleted' && msg.data.link_id === regsLinkId) {
          setRegs(prev => prev.filter(r => r.id !== msg.data!.reg_id));
          setRegsTotal(prev => Math.max(0, prev - 1));
        }
      }
    });
    return () => { if (wsProxy) wsProxy.close(); };
  }, [regsLinkId]);

  const loadRegistrations = async (linkId: string) => {
    if (regsLinkId === linkId) { setRegsLinkId(null); return; }
    setRegsLinkId(linkId);
    setLoadingRegs(true);
    try {
      const res = await api<{ registrations: DynamicLinkRegistration[]; total: number }>(`/api/dynamics/${dynamicId}/links/${linkId}/registrations`);
      if (res.success && res.data) {
        setRegs(res.data.registrations || []);
        setRegsTotal(res.data.total || 0);
      }
    } catch (e) { console.error(e); }
    setLoadingRegs(false);
  };

  const handleDeleteReg = async (regId: string, linkId: string) => {
    try {
      await api(`/api/dynamics/${dynamicId}/links/${linkId}/registrations/${regId}`, { method: 'DELETE' });
      setRegs(prev => prev.filter(r => r.id !== regId));
      setRegsTotal(prev => Math.max(0, prev - 1));
      toast.show('Registro eliminado');
    } catch (e) { console.error(e); }
  };

  const exportRegsCSV = (linkId: string) => {
    const token = localStorage.getItem('token');
    window.open(`/api/dynamics/${dynamicId}/links/${linkId}/registrations/export?token=${token}`, '_blank');
  };

  const handleCreate = async () => {
    if (!newSlug.trim()) return;
    try {
      const res = await api<DynamicLink>(`/api/dynamics/${dynamicId}/links`, {
        method: 'POST',
        body: JSON.stringify({
          slug: newSlug.trim(),
          whatsapp_enabled: newWAEnabled,
          whatsapp_message: newWAMessage,
          extra_message_text: newExtraText,
          starts_at: newStartsAt ? new Date(newStartsAt).toISOString() : null,
          ends_at: newEndsAt ? new Date(newEndsAt).toISOString() : null,
        }),
      });
      if (res.success && res.data) {
        onLinksChange([...links, res.data]);
        setCreating(false);
        setNewSlug('');
        setNewWAEnabled(false);
        setNewWAMessage('¡Aquí tienes tu pensamiento del día! 🌟');
        setNewExtraText('');
        setNewStartsAt('');
        setNewEndsAt('');
        toast.show('Link creado');
      }
    } catch (e) { console.error(e); }
  };

  const handleUpdate = async (link: DynamicLink) => {
    try {
      const res = await api<DynamicLink>(`/api/dynamics/${dynamicId}/links/${link.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          slug: editSlug.trim(),
          whatsapp_enabled: editWAEnabled,
          whatsapp_message: editWAMessage,
          extra_message_text: editExtraText,
          is_active: editActive,
          starts_at: editStartsAt ? new Date(editStartsAt).toISOString() : null,
          ends_at: editEndsAt ? new Date(editEndsAt).toISOString() : null,
        }),
      });
      onLinksChange(links.map(l => l.id === link.id ? {
        ...l,
        slug: editSlug.trim(),
        whatsapp_enabled: editWAEnabled,
        whatsapp_message: editWAMessage,
        extra_message_text: editExtraText,
        extra_message_media_url: editExtraMediaUrl,
        extra_message_media_type: editExtraMediaType,
        is_active: editActive,
        starts_at: editStartsAt ? new Date(editStartsAt).toISOString() : null,
        ends_at: editEndsAt ? new Date(editEndsAt).toISOString() : null,
      } : l));
      setEditingId(null);
      toast.show('Link actualizado');
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (linkId: string) => {
    try {
      await api(`/api/dynamics/${dynamicId}/links/${linkId}`, { method: 'DELETE' });
      onLinksChange(links.filter(l => l.id !== linkId));
      toast.show('Link eliminado');
    } catch (e) { console.error(e); }
  };

  const handleUploadExtraMedia = async (linkId: string, file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const isVideo = ext === 'mp4';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    if (!isImage && !isVideo) {
      toast.show('Solo imágenes (jpg, png, gif, webp) o videos (mp4)', 'error');
      return;
    }
    if (isVideo && file.size > 3 * 1024 * 1024) {
      toast.show('El video no debe superar los 3MB', 'error');
      return;
    }

    setUploadingMedia(true);
    try {
      let uploadFile = file;
      if (isImage) {
        uploadFile = await compressImageStandard(file);
      }
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('media', uploadFile);
      const res = await fetch(`/api/dynamics/${dynamicId}/links/${linkId}/extra-media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      if (res.ok && data.url) {
        onLinksChange(links.map(l => l.id === linkId ? { ...l, extra_message_media_url: data.url, extra_message_media_type: data.media_type } : l));
        setEditExtraMediaUrl(data.url);
        setEditExtraMediaType(data.media_type);
        toast.show('Media subido');
      } else {
        toast.show(data.error || 'Error al subir media', 'error');
      }
    } catch (e) {
      console.error(e);
      toast.show('Error al subir media', 'error');
    } finally {
      setUploadingMedia(false);
    }
  };

  const handleDeleteExtraMedia = async (linkId: string) => {
    try {
      await api(`/api/dynamics/${dynamicId}/links/${linkId}/extra-media`, { method: 'DELETE' });
      onLinksChange(links.map(l => l.id === linkId ? { ...l, extra_message_media_url: '', extra_message_media_type: '' } : l));
      setEditExtraMediaUrl('');
      setEditExtraMediaType('');
      toast.show('Media eliminado');
    } catch (e) { console.error(e); }
  };

  const copyLink = (slug: string, linkId: string) => {
    navigator.clipboard.writeText(`${baseUrl}/d/${slug}`);
    setCopiedId(linkId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const startEdit = (link: DynamicLink) => {
    setEditingId(link.id);
    setEditSlug(link.slug);
    setEditWAEnabled(link.whatsapp_enabled);
    setEditWAMessage(link.whatsapp_message);
    setEditExtraText(link.extra_message_text);
    setEditExtraMediaUrl(link.extra_message_media_url);
    setEditExtraMediaType(link.extra_message_media_type);
    setEditActive(link.is_active);
    setEditStartsAt(toLocalInput(link.starts_at));
    setEditEndsAt(toLocalInput(link.ends_at));
  };

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Links públicos</h3>
          <p className="text-xs text-slate-400 mt-0.5">Cada link tiene su propia URL, registro y configuración de WhatsApp</p>
        </div>
        <button
          onClick={() => { setCreating(true); setNewSlug(generateSlug()); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Nuevo link
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400 whitespace-nowrap">{baseUrl}/d/</span>
            <input
              type="text"
              value={newSlug}
              onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
              placeholder="mi-link"
              autoFocus
            />
            <button
              onClick={() => setNewSlug(generateSlug())}
              className="p-2 hover:bg-emerald-100 rounded-lg text-emerald-600 transition-colors"
              title="Generar slug aleatorio"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          {/* Schedule */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                <Calendar className="w-3 h-3 inline mr-1" />Inicio (opcional)
              </label>
              <input type="datetime-local" value={newStartsAt} onChange={e => setNewStartsAt(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                <Calendar className="w-3 h-3 inline mr-1" />Fin (opcional)
              </label>
              <input type="datetime-local" value={newEndsAt} onChange={e => setNewEndsAt(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400" />
            </div>
          </div>
          <div className="flex items-center justify-between p-3 bg-white rounded-lg">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-emerald-600" />
              <div>
                <p className="text-sm font-medium text-slate-700">Envío por WhatsApp</p>
                <p className="text-xs text-slate-400">Los usuarios reciben su imagen por WhatsApp al registrarse</p>
              </div>
            </div>
            <button
              onClick={() => setNewWAEnabled(!newWAEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${newWAEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
            >
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${newWAEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          {newWAEnabled && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje 1 — Imagen raspada + texto</label>
                <textarea
                  value={newWAMessage}
                  onChange={e => setNewWAMessage(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                  rows={2}
                  placeholder="¡Aquí tienes tu pensamiento del día! 🌟"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje 2 — Adicional (opcional)</label>
                <textarea
                  value={newExtraText}
                  onChange={e => setNewExtraText(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                  rows={2}
                  placeholder="Texto del segundo mensaje (opcional)"
                />
                <p className="text-[10px] text-slate-400 mt-1">Puedes agregar media (imagen/video) después de crear el link.</p>
              </div>
              <WAPreview msg1Caption={newWAMessage} msg2Text={newExtraText} msg2MediaUrl="" msg2MediaType="" />
            </>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700">Cancelar</button>
            <button onClick={handleCreate} disabled={!newSlug.trim()} className="px-4 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors">Crear link</button>
          </div>
        </div>
      )}

      {/* Existing links */}
      <div className="space-y-3">
        {links.map(link => (
          <div key={link.id} className={`border rounded-xl p-4 transition-colors ${link.is_active ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-60'}`}>
            {editingId === link.id ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-400 whitespace-nowrap">{baseUrl}/d/</span>
                  <input
                    type="text"
                    value={editSlug}
                    onChange={e => setEditSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  <button
                    onClick={() => setEditSlug(generateSlug())}
                    className="p-2 hover:bg-emerald-100 rounded-lg text-emerald-600 transition-colors"
                    title="Generar slug aleatorio"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
                {/* Schedule */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      <Calendar className="w-3 h-3 inline mr-1" />Inicio (opcional)
                    </label>
                    <input type="datetime-local" value={editStartsAt} onChange={e => setEditStartsAt(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      <Calendar className="w-3 h-3 inline mr-1" />Fin (opcional)
                    </label>
                    <input type="datetime-local" value={editEndsAt} onChange={e => setEditEndsAt(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400" />
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm text-slate-700">WhatsApp</span>
                  </div>
                  <button
                    onClick={() => setEditWAEnabled(!editWAEnabled)}
                    className={`relative w-11 h-6 rounded-full transition-colors ${editWAEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${editWAEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                {editWAEnabled && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje 1 — Imagen raspada + texto</label>
                      <textarea
                        value={editWAMessage}
                        onChange={e => setEditWAMessage(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                        rows={2}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje 2 — Adicional (opcional)</label>
                      <textarea
                        value={editExtraText}
                        onChange={e => setEditExtraText(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                        rows={2}
                        placeholder="Texto del segundo mensaje (opcional)"
                      />
                    </div>
                    {/* Extra media upload */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Media del mensaje 2 (opcional)</label>
                      {editExtraMediaUrl ? (
                        <div className="flex items-center gap-3 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                          {editExtraMediaType === 'image' ? (
                            <img src={editExtraMediaUrl} alt="" className="w-16 h-16 object-cover rounded-lg" />
                          ) : (
                            <div className="w-16 h-16 bg-slate-800 rounded-lg flex items-center justify-center">
                              <Film className="w-6 h-6 text-white/50" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-slate-600 font-medium capitalize">{editExtraMediaType}</p>
                            <p className="text-[10px] text-slate-400 truncate">{editExtraMediaUrl}</p>
                          </div>
                          <button
                            onClick={() => handleDeleteExtraMedia(link.id)}
                            className="p-1.5 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500 transition-colors"
                            title="Eliminar media"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <label className={`flex items-center justify-center gap-2 p-3 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                          uploadingMedia ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/50'
                        }`}>
                          {uploadingMedia ? (
                            <div className="animate-spin rounded-full h-4 w-4 border-2 border-emerald-200 border-t-emerald-600" />
                          ) : (
                            <Upload className="w-4 h-4 text-slate-400" />
                          )}
                          <span className="text-xs text-slate-500">{uploadingMedia ? 'Subiendo...' : 'Subir imagen o video (mp4 máx 3MB)'}</span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4"
                            className="hidden"
                            disabled={uploadingMedia}
                            onChange={e => {
                              const f = e.target.files?.[0];
                              if (f) handleUploadExtraMedia(link.id, f);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      )}
                    </div>
                    {/* Preview */}
                    <WAPreview
                      msg1Caption={editWAMessage}
                      msg2Text={editExtraText}
                      msg2MediaUrl={editExtraMediaUrl}
                      msg2MediaType={editExtraMediaType}
                    />
                  </>
                )}
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-slate-500">
                    <input type="checkbox" checked={editActive} onChange={e => setEditActive(e.target.checked)} className="accent-emerald-600" />
                    Link activo
                  </label>
                  <div className="flex gap-2">
                    <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700">Cancelar</button>
                    <button onClick={() => handleUpdate(link)} className="px-4 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 transition-colors">Guardar</button>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-sm font-mono text-slate-700">/d/{link.slug}</code>
                      {link.whatsapp_enabled && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-green-50 text-green-700 text-[10px] font-medium rounded-full">
                          <MessageCircle className="w-3 h-3" /> WhatsApp
                        </span>
                      )}
                      {link.whatsapp_enabled && (link.extra_message_text || link.extra_message_media_url) && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 text-[10px] font-medium rounded-full">
                          <FileText className="w-3 h-3" /> 2 msgs
                        </span>
                      )}
                      {(link.starts_at || link.ends_at) && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-50 text-amber-700 text-[10px] font-medium rounded-full">
                          <Calendar className="w-3 h-3" /> Programado
                        </span>
                      )}
                      {!link.is_active && (
                        <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-medium rounded-full">Inactivo</span>
                      )}
                    </div>
                    {link.starts_at && (
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        Inicio: {new Date(link.starts_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}
                        {link.ends_at && <> — Fin: {new Date(link.ends_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</>}
                      </p>
                    )}
                    {!link.starts_at && link.ends_at && (
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        Fin: {new Date(link.ends_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    <button
                      onClick={() => loadRegistrations(link.id)}
                      className={`p-2 rounded-lg transition-colors ${regsLinkId === link.id ? 'bg-emerald-100 text-emerald-700' : 'hover:bg-slate-100 text-slate-400'}`}
                      title="Registros"
                    >
                      <Users className="w-4 h-4" />
                    </button>
                    {link.whatsapp_enabled && (
                      <button
                        onClick={() => setPreviewId(previewId === link.id ? null : link.id)}
                        className={`p-2 rounded-lg transition-colors ${previewId === link.id ? 'bg-emerald-100 text-emerald-700' : 'hover:bg-slate-100 text-slate-400'}`}
                        title="Vista previa"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => copyLink(link.slug, link.id)}
                      className={`p-2 rounded-lg transition-colors ${copiedId === link.id ? 'bg-emerald-100 text-emerald-700' : 'hover:bg-slate-100 text-slate-400'}`}
                      title="Copiar link"
                    >
                      {copiedId === link.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <a href={`${baseUrl}/d/${link.slug}`} target="_blank" rel="noopener noreferrer" className="p-2 hover:bg-slate-100 rounded-lg text-slate-400" title="Abrir">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                    <button
                      onClick={() => setShowQRId(showQRId === link.id ? null : link.id)}
                      className={`p-2 rounded-lg transition-colors ${showQRId === link.id ? 'bg-emerald-100 text-emerald-700' : 'hover:bg-slate-100 text-slate-400'}`}
                      title="Código QR"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM17 14h3v3h-3zM14 17h3v3h-3zM17 20h3v3h-3z" /></svg>
                    </button>
                    <button onClick={() => startEdit(link)} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400" title="Editar">
                      <Pencil className="w-4 h-4" />
                    </button>
                    {links.length > 1 && (
                      <button onClick={() => handleDelete(link.id)} className="p-2 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500" title="Eliminar">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                {/* Preview inline */}
                {previewId === link.id && (
                  <WAPreview
                    msg1Caption={link.whatsapp_message}
                    msg2Text={link.extra_message_text}
                    msg2MediaUrl={link.extra_message_media_url}
                    msg2MediaType={link.extra_message_media_type}
                  />
                )}
                {/* Registrations panel */}
                {regsLinkId === link.id && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-emerald-600" />
                        <span className="text-sm font-medium text-slate-700">Registros</span>
                        <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-bold rounded-full">{regsTotal}</span>
                      </div>
                      {regs.length > 0 && (
                        <button
                          onClick={() => exportRegsCSV(link.id)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors font-medium"
                        >
                          <Download className="w-3 h-3" /> Exportar CSV
                        </button>
                      )}
                    </div>
                    {loadingRegs ? (
                      <div className="flex justify-center py-4">
                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-200 border-t-emerald-600" />
                      </div>
                    ) : regs.length === 0 ? (
                      <p className="text-xs text-slate-400 py-3 text-center">Aún no hay registros</p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto space-y-1">
                        {regs.map(reg => (
                          <div key={reg.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg group">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-slate-700 font-medium truncate">{reg.full_name}</p>
                              <p className="text-[11px] text-slate-400">
                                {reg.phone} · {reg.age} años · {new Date(reg.created_at).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                            <button
                              onClick={() => handleDeleteReg(reg.id, link.id)}
                              className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500 transition-all"
                              title="Eliminar registro"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Per-link QR code */}
            {showQRId === link.id && (
              <div className="flex flex-col items-center gap-3 mt-3 pt-3 border-t border-slate-100">
                <div className="p-3 bg-white rounded-xl shadow-sm border border-slate-100">
                  <QRCodeSVG value={`${baseUrl}/d/${link.slug}`} size={180} level="H" includeMargin />
                </div>
                <p className="text-[11px] text-slate-400 text-center">Escanea para abrir <span className="font-mono font-medium text-slate-500">/d/{link.slug}</span></p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
