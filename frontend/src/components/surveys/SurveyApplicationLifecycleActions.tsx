"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { SurveyDeletionBlockReason, SurveyInstanceSummary } from '@/types/survey-template';

export interface SurveyApplicationLifecycleTarget {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'closed';
  archived_at?: string;
  archived_from_status?: 'draft' | 'active' | 'closed';
  can_delete?: boolean;
  can_archive?: boolean;
  can_restore?: boolean;
  deletion_block_reason?: SurveyDeletionBlockReason;
  response_count?: number;
  recipient_count?: number;
}

type LifecycleAction = 'archive' | 'restore' | 'delete';

const deletionReasonLabel: Record<SurveyDeletionBlockReason, string> = {
  legacy: 'Las aplicaciones heredadas se conservan como historial.',
  has_responses: 'Tiene respuestas y debe conservarse como historial.',
  has_activity: 'Ya fue abierta o distribuida y debe conservarse como historial.',
  has_uploads: 'Tiene archivos activos y no puede eliminarse todavía.',
};

export function surveyDeletionExplanation(target: SurveyApplicationLifecycleTarget): string {
  if (target.can_delete) return 'Eliminar aplicación';
  return target.deletion_block_reason
    ? deletionReasonLabel[target.deletion_block_reason]
    : 'Esta aplicación debe conservarse como historial.';
}

export default function SurveyApplicationLifecycleActions({ target, labeled = false, onUpdated, onDeleted }: {
  target: SurveyApplicationLifecycleTarget;
  labeled?: boolean;
  onUpdated: (instance: SurveyInstanceSummary) => void;
  onDeleted: (id: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setMounted(true), []);

  const open = (next: LifecycleAction) => {
    if (next === 'delete' && !target.can_delete) return;
    if (next === 'archive' && target.can_archive === false) return;
    if (next === 'restore' && target.can_restore === false) return;
    setError('');
    setAction(next);
  };

  const confirm = async () => {
    if (!action || pending) return;
    setPending(true);
    setError('');
    const endpoint = action === 'delete' ? `/api/surveys/${target.id}` : `/api/surveys/${target.id}/${action}`;
    const response = await api<SurveyInstanceSummary>(endpoint, { method: action === 'delete' ? 'DELETE' : 'POST' });
    setPending(false);
    if (!response.success) {
      setError(response.error || 'No se pudo actualizar la aplicación.');
      return;
    }
    if (action === 'delete') onDeleted(target.id);
    else if (response.data) onUpdated(response.data);
    setAction(null);
  };

  const archiveLabel = target.archived_at ? 'Restaurar aplicación' : 'Archivar aplicación';
  const ArchiveIcon = target.archived_at ? RotateCcw : Archive;
  const lifecycleAllowed = target.archived_at ? target.can_restore !== false : target.can_archive !== false;
  const buttonBase = labeled
    ? 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50'
    : 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50';

  return <>
    <div className="flex shrink-0 items-center gap-2">
      <button type="button" disabled={!lifecycleAllowed} onClick={() => open(target.archived_at ? 'restore' : 'archive')} className={`${buttonBase} disabled:cursor-not-allowed disabled:opacity-45`} aria-label={archiveLabel} title={archiveLabel}>
        <ArchiveIcon className="h-4 w-4" />{labeled && <span>{target.archived_at ? 'Restaurar' : 'Archivar'}</span>}
      </button>
      <span title={surveyDeletionExplanation(target)}>
        <button type="button" onClick={() => open('delete')} disabled={!target.can_delete} className={`${buttonBase} text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300 disabled:opacity-70`} aria-label={surveyDeletionExplanation(target)}>
          <Trash2 className="h-4 w-4" />{labeled && <span>Eliminar</span>}
        </button>
      </span>
    </div>
    {mounted && action && createPortal(
      <SurveyApplicationLifecycleDialog target={target} action={action} pending={pending} error={error} onClose={() => !pending && setAction(null)} onConfirm={() => void confirm()} />,
      document.body,
    )}
  </>;
}

function SurveyApplicationLifecycleDialog({ target, action, pending, error, onClose, onConfirm }: {
  target: SurveyApplicationLifecycleTarget;
  action: LifecycleAction;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const deleting = action === 'delete';
  const restoring = action === 'restore';
  const title = deleting ? 'Eliminar aplicación' : restoring ? 'Restaurar aplicación' : 'Archivar aplicación';
  const description = deleting
    ? 'Esta acción es permanente. La plantilla seguirá disponible, pero la aplicación, sus enlaces todavía no utilizados y su copia de preguntas desaparecerán.'
    : restoring
      ? 'Volverá a los listados activos, pero permanecerá cerrada. Podrás reabrirla manualmente cuando confirmes que debe recibir nuevas respuestas.'
      : 'Se moverá al historial y quedará cerrada. Sus respuestas se conservarán y el enlace público informará que la aplicación fue archivada.';
  const ConfirmIcon = deleting ? Trash2 : restoring ? RotateCcw : Archive;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', keydown);
      previous?.focus({ preventScroll: true });
    };
  }, [onClose, pending]);

  return <div className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/50 backdrop-blur-[1px] sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} className="w-full bg-white shadow-2xl outline-none sm:max-w-md sm:rounded-3xl" role="alertdialog" aria-modal="true" aria-labelledby="survey-application-lifecycle-title" aria-describedby="survey-application-lifecycle-description">
      <header className="flex items-start gap-3 border-b border-slate-200 p-4 sm:p-5">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${deleting ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}><ConfirmIcon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><h2 id="survey-application-lifecycle-title" className="font-semibold text-slate-900">{title}</h2><p className="mt-1 truncate text-sm text-slate-500">{target.name}</p></div>
        <button type="button" onClick={onClose} disabled={pending} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
      </header>
      <div className="space-y-4 p-4 sm:p-5">
        <p id="survey-application-lifecycle-description" className="text-sm leading-6 text-slate-600">{description}</p>
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-center"><div><dt className="text-xs text-slate-500">Respuestas</dt><dd className="mt-1 font-semibold text-slate-900">{target.response_count || 0}</dd></div><div><dt className="text-xs text-slate-500">Destinatarios</dt><dd className="mt-1 font-semibold text-slate-900">{target.recipient_count || 0}</dd></div></dl>
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      </div>
      <footer className="flex gap-3 border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" onClick={onClose} disabled={pending} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-50">Cancelar</button><button type="button" onClick={onConfirm} disabled={pending} className={`inline-flex min-h-11 flex-[1.25] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-50 ${deleting ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'}`}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ConfirmIcon className="h-4 w-4" />}{deleting ? 'Eliminar' : restoring ? 'Restaurar' : 'Archivar'}</button></footer>
    </div>
  </div>;
}
