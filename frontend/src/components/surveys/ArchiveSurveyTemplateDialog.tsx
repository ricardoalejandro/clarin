"use client";

import { Archive, Loader2, X } from 'lucide-react';
import type { SurveyTemplate } from '@/types/survey-template';

export default function ArchiveSurveyTemplateDialog({ template, archiving, error, onClose, onConfirm }: {
  template: SurveyTemplate;
  archiving: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="archive-survey-template-title">
      <div className="w-full bg-white shadow-2xl sm:max-w-md sm:rounded-2xl">
        <header className="flex items-start gap-3 border-b border-slate-200 p-4 sm:p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><Archive className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h2 id="archive-survey-template-title" className="font-semibold text-slate-900">Archivar plantilla</h2><p className="mt-1 truncate text-sm text-slate-500">{template.name}</p></div>
          <button type="button" onClick={onClose} disabled={archiving} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-sm leading-6 text-slate-600">Se conservarán todos los datos y enlaces existentes. La plantilla dejará de admitir nuevas aplicaciones, pero podrás restaurarla cuando quieras.</p>
          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-center"><div><dt className="text-xs text-slate-500">Aplicaciones</dt><dd className="mt-1 font-semibold text-slate-900">{template.instance_count}</dd></div><div><dt className="text-xs text-slate-500">Respuestas</dt><dd className="mt-1 font-semibold text-slate-900">{template.response_count}</dd></div></dl>
          {error && <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p>}
        </div>
        <footer className="flex gap-3 border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" onClick={onClose} disabled={archiving} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Cancelar</button><button type="button" onClick={onConfirm} disabled={archiving} className="inline-flex min-h-11 flex-[1.25] items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">{archiving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}Archivar</button></footer>
      </div>
    </div>
  );
}
