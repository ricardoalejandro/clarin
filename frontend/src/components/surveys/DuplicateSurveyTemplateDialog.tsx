"use client";

import { useEffect, useState } from 'react';
import { Copy, Loader2, X } from 'lucide-react';
import { buildDuplicateTemplateName } from './duplicateSurveyTemplate';

interface DuplicateSurveyTemplateDialogProps {
  sourceName: string;
  questionCount: number;
  measurementDimensionCount: number;
  onClose: () => void;
  onDuplicate: (name: string) => Promise<void>;
}

export default function DuplicateSurveyTemplateDialog({
  sourceName, questionCount, measurementDimensionCount, onClose, onDuplicate,
}: DuplicateSurveyTemplateDialogProps) {
  const [name, setName] = useState(() => buildDuplicateTemplateName(sourceName));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, saving]);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      await onDuplicate(name.trim());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo duplicar la plantilla.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="duplicate-survey-template-title">
      <form onSubmit={event => { event.preventDefault(); void submit(); }} className="flex max-h-[100dvh] w-full flex-col bg-white shadow-2xl sm:max-w-md sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5">
          <div className="min-w-0">
            <h2 id="duplicate-survey-template-title" className="font-semibold text-slate-900">Duplicar plantilla</h2>
            <p className="truncate text-xs text-slate-500">La copia será activa, editable e independiente.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500 disabled:opacity-50" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="space-y-4 overflow-y-auto p-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre de la copia</span>
            <input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={180} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-700">Se copiarán {questionCount} preguntas, diseño y configuración{measurementDimensionCount > 0 ? `, incluidas ${measurementDimensionCount} dimensiones de medición` : ''}.</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">No se copiarán aplicaciones, enlaces, destinatarios, respuestas ni resultados.</p>
          </div>
          {error && <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p>}
        </div>
        <footer className="flex gap-3 border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={onClose} disabled={saving} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-50">Cancelar</button>
          <button type="submit" disabled={!name.trim() || saving} className="inline-flex min-h-11 flex-[1.3] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />} Duplicar y editar
          </button>
        </footer>
      </form>
    </div>
  );
}
