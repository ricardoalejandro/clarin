'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Loader2, LockKeyhole, RotateCcw, Settings2, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Program, ProgramHealthViewColumn } from '@/types/program';
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog';
import {
  normalizeProgramHealthViewColumns,
  PROGRAM_HEALTH_VIEW_COLUMN_CATALOG,
} from './programHealthView';

const PROGRAM_COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#6366f1', '#ec4899', '#f43f5e', '#f97316', '#f59e0b'];

interface ProgramDraft {
  name: string;
  description: string;
  color: string;
  status: Program['status'];
  healthViewColumns: ProgramHealthViewColumn[];
}

interface ProgramConflictPayload {
  code?: string;
  error?: string;
  program?: Program;
}

interface ProgramSettingsDialogProps {
  open: boolean;
  program: Program | null;
  onClose: () => void;
  onSaved: (program: Program) => void;
  onCanonicalReload?: (program: Program) => void;
}

function draftFromProgram(program: Program): ProgramDraft {
  return {
    name: program.name,
    description: program.description || '',
    color: program.color || '#10b981',
    status: program.status,
    healthViewColumns: normalizeProgramHealthViewColumns(program.health_view_columns),
  };
}

function draftSignature(draft: ProgramDraft): string {
  return JSON.stringify({
    name: draft.name,
    description: draft.description,
    color: draft.color,
    status: draft.status,
    health_view_columns: draft.healthViewColumns,
  });
}

export function ProgramSettingsDialog({
  open,
  program,
  onClose,
  onSaved,
  onCanonicalReload,
}: ProgramSettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const discardCancelRef = useRef<HTMLButtonElement>(null);
  const [canonicalProgram, setCanonicalProgram] = useState<Program | null>(program);
  const [draft, setDraft] = useState<ProgramDraft | null>(program ? draftFromProgram(program) : null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    if (!open || !program) return;
    setCanonicalProgram(program);
    setDraft(draftFromProgram(program));
    setSaving(false);
    setReloading(false);
    setError('');
    setConflict(false);
    setDiscardOpen(false);
  }, [open, program?.id, program?.updated_at]);

  const dirty = useMemo(() => {
    if (!draft || !canonicalProgram) return false;
    return draftSignature(draft) !== draftSignature(draftFromProgram(canonicalProgram));
  }, [canonicalProgram, draft]);

  const requestClose = () => {
    if (saving || reloading) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  useAccessibleDialog(open, dialogRef, () => {
    if (discardOpen) setDiscardOpen(false);
    else requestClose();
  }, nameRef);
  useAccessibleDialog(discardOpen, discardDialogRef, () => setDiscardOpen(false), discardCancelRef);

  if (!open || !program || !draft || !canonicalProgram || typeof document === 'undefined') return null;

  const toggleColumn = (column: ProgramHealthViewColumn) => {
    setError('');
    setConflict(false);
    setDraft(current => {
      if (!current) return current;
      const selected = current.healthViewColumns.includes(column)
        ? current.healthViewColumns.filter(value => value !== column)
        : [...current.healthViewColumns, column];
      return { ...current, healthViewColumns: normalizeProgramHealthViewColumns(selected) };
    });
  };

  const applyCanonicalProgram = (nextProgram: Program) => {
    setCanonicalProgram(nextProgram);
    setDraft(draftFromProgram(nextProgram));
    setError('');
    setConflict(false);
    onCanonicalReload?.(nextProgram);
  };

  const reloadCanonical = async () => {
    setReloading(true);
    setError('');
    const response = await api<Program>(`/api/programs/${canonicalProgram.id}`);
    setReloading(false);
    if (!response.success || !response.data) {
      setError(response.error || 'No se pudo recargar la versión actual del programa.');
      return;
    }
    applyCanonicalProgram(response.data);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    setError('');
    setConflict(false);
    const response = await api<Program | ProgramConflictPayload>(`/api/programs/${canonicalProgram.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: draft.name.trim(),
        description: draft.description,
        color: draft.color,
        status: draft.status,
        health_view_columns: draft.healthViewColumns,
        expected_updated_at: canonicalProgram.updated_at,
      }),
    });
    setSaving(false);

    if (response.success && response.data && 'id' in response.data) {
      onSaved(response.data);
      return;
    }

    const payload = response.data as ProgramConflictPayload | undefined;
    if (response.status === 409) {
      setConflict(true);
      setError(payload?.error || response.error || 'El programa cambió mientras lo editabas.');
      if (payload?.program) setCanonicalProgram(payload.program);
      return;
    }
    setError(response.error || 'No se pudieron guardar los cambios. Puedes reintentar.');
  };

  return createPortal(
    <div
      className="app-viewport fixed inset-0 z-[90] flex items-stretch justify-center bg-slate-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="program-settings-title"
        aria-describedby="program-settings-description"
        tabIndex={-1}
        className="flex h-[var(--app-height)] w-full max-w-2xl flex-col overflow-hidden rounded-none bg-white shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-emerald-700">
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-[0.12em]">Configuración</span>
            </div>
            <h2 id="program-settings-title" className="mt-1 text-xl font-semibold text-slate-900">Editar programa</h2>
            <p id="program-settings-description" className="mt-1 text-sm text-slate-500">Actualiza los datos y define qué columnas muestra la vista Salud.</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving || reloading}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            aria-label="Cerrar edición del programa"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <div className="space-y-6">
              <section aria-labelledby="program-general-title">
                <h3 id="program-general-title" className="text-sm font-semibold text-slate-900">Información general</h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre</span>
                    <input
                      ref={nameRef}
                      type="text"
                      required
                      value={draft.name}
                      onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : current)}
                      className="min-h-11 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-1.5 block text-sm font-medium text-slate-700">Descripción</span>
                    <textarea
                      value={draft.description}
                      onChange={event => setDraft(current => current ? { ...current, description: event.target.value } : current)}
                      rows={3}
                      className="w-full resize-y rounded-xl border border-slate-300 px-3.5 py-2.5 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </label>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium text-slate-700">Color</legend>
                    <div className="flex flex-wrap gap-2.5">
                      {PROGRAM_COLORS.map(color => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => setDraft(current => current ? { ...current, color } : current)}
                          className={`flex h-9 w-9 items-center justify-center rounded-full transition ${draft.color === color ? 'ring-2 ring-slate-500 ring-offset-2' : 'hover:scale-105'}`}
                          style={{ backgroundColor: color }}
                          aria-label={`Usar color ${color}`}
                          aria-pressed={draft.color === color}
                        >
                          {draft.color === color && <Check className="h-4 w-4 text-white drop-shadow" aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-slate-700">Estado</span>
                    <select
                      value={draft.status}
                      onChange={event => setDraft(current => current ? { ...current, status: event.target.value as Program['status'] } : current)}
                      className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    >
                      <option value="active">Activo</option>
                      <option value="archived">Archivado</option>
                      <option value="completed">Completado</option>
                    </select>
                  </label>
                </div>
              </section>

              <section aria-labelledby="program-view-title" className="border-t border-slate-200 pt-5">
                <div>
                  <h3 id="program-view-title" className="text-sm font-semibold text-slate-900">Vista de participantes</h3>
                  <p className="mt-1 text-sm text-slate-500">Selecciona las columnas de la tabla Salud. El orden visual se mantiene estable.</p>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="flex min-h-[68px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 opacity-80" aria-disabled="true">
                    <input type="checkbox" checked disabled readOnly aria-label="Participante siempre visible" className="h-4 w-4 shrink-0 rounded border-slate-300 text-slate-500" />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm"><LockKeyhole className="h-4 w-4" aria-hidden="true" /></span>
                    <span className="min-w-0"><span className="block text-sm font-medium text-slate-800">Participante</span><span className="block text-xs text-slate-500">Siempre visible; identifica la fila.</span></span>
                  </div>
                  {PROGRAM_HEALTH_VIEW_COLUMN_CATALOG.map(column => {
                    const checked = draft.healthViewColumns.includes(column.key);
                    return (
                      <label key={column.key} className="flex min-h-[68px] cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 transition hover:border-emerald-300 hover:bg-emerald-50/40">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleColumn(column.key)}
                          aria-label={column.label}
                          className="h-4 w-4 shrink-0 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        />
                        <span className="min-w-0"><span className="block text-sm font-medium text-slate-800">{column.label}</span><span className="block text-xs text-slate-500">{column.description}</span></span>
                      </label>
                    );
                  })}
                  <div className="flex min-h-[68px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 opacity-80" aria-disabled="true">
                    <input type="checkbox" checked disabled readOnly aria-label="Acciones siempre visible" className="h-4 w-4 shrink-0 rounded border-slate-300 text-slate-500" />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm"><LockKeyhole className="h-4 w-4" aria-hidden="true" /></span>
                    <span className="min-w-0"><span className="block text-sm font-medium text-slate-800">Acciones</span><span className="block text-xs text-slate-500">Siempre visible; abre el detalle.</span></span>
                  </div>
                </div>
              </section>

              {error && (
                <div role="alert" className={`rounded-xl border px-3.5 py-3 text-sm ${conflict ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{conflict ? 'Hay una versión más reciente' : 'No pudimos guardar los cambios'}</p>
                      <p className="mt-0.5">{error}</p>
                      <button type="button" onClick={() => void reloadCanonical()} disabled={reloading} className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg border border-current/20 bg-white/70 px-3 font-medium disabled:opacity-50">
                        {reloading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}
                        Recargar versión actual
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <footer className="flex shrink-0 gap-3 border-t border-slate-200 bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:justify-end sm:px-6 sm:pb-4">
            <button type="button" onClick={requestClose} disabled={saving || reloading} className="min-h-11 flex-1 rounded-xl px-4 font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 sm:flex-none">Cancelar</button>
            <button type="submit" disabled={saving || reloading || !draft.name.trim() || !dirty} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </footer>
        </form>
      </div>

      {discardOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4" onMouseDown={event => event.stopPropagation()}>
          <div ref={discardDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="discard-program-title" aria-describedby="discard-program-description" tabIndex={-1} className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700"><AlertTriangle className="h-5 w-5" aria-hidden="true" /></div>
            <h3 id="discard-program-title" className="mt-3 text-lg font-semibold text-slate-900">¿Descartar los cambios?</h3>
            <p id="discard-program-description" className="mt-1.5 text-sm text-slate-600">La configuración todavía no se guardó.</p>
            <div className="mt-5 flex gap-3 justify-end">
              <button ref={discardCancelRef} type="button" onClick={() => setDiscardOpen(false)} className="min-h-11 rounded-xl px-4 font-medium text-slate-700 hover:bg-slate-100">Seguir editando</button>
              <button type="button" onClick={onClose} className="min-h-11 rounded-xl bg-rose-600 px-4 font-medium text-white hover:bg-rose-700">Descartar</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
