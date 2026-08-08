'use client'

import { ChevronDown, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type CrmDetailSectionKey = 'contact' | 'tags' | 'activity' | 'context' | 'tasks' | 'history' | 'integrations'
export type CrmDetailAccordionState = Record<CrmDetailSectionKey, boolean>

export const defaultCrmDetailAccordionState = (): CrmDetailAccordionState => ({
  contact: true,
  tags: true,
  activity: true,
  context: false,
  tasks: false,
  history: false,
  integrations: false,
})

const tones = {
  emerald: { shell: 'border-emerald-100', icon: 'bg-emerald-50 text-emerald-700', accent: 'bg-emerald-500', open: 'bg-emerald-50/35' },
  cyan: { shell: 'border-cyan-100', icon: 'bg-cyan-50 text-cyan-700', accent: 'bg-cyan-500', open: 'bg-cyan-50/30' },
  amber: { shell: 'border-amber-100', icon: 'bg-amber-50 text-amber-700', accent: 'bg-amber-500', open: 'bg-amber-50/30' },
  violet: { shell: 'border-violet-100', icon: 'bg-violet-50 text-violet-700', accent: 'bg-violet-500', open: 'bg-violet-50/25' },
  blue: { shell: 'border-blue-100', icon: 'bg-blue-50 text-blue-700', accent: 'bg-blue-500', open: 'bg-blue-50/25' },
  slate: { shell: 'border-slate-200', icon: 'bg-slate-100 text-slate-600', accent: 'bg-slate-400', open: 'bg-slate-50/70' },
  sky: { shell: 'border-sky-100', icon: 'bg-sky-50 text-sky-700', accent: 'bg-sky-500', open: 'bg-sky-50/30' },
} as const

type Props = {
  id: string
  title: string
  summary?: ReactNode
  icon: LucideIcon
  tone?: keyof typeof tones
  open: boolean
  onToggle: () => void
  badge?: ReactNode
  action?: ReactNode
  children: ReactNode
  contentClassName?: string
}

export default function CrmDetailAccordion({ id, title, summary, icon: Icon, tone = 'slate', open, onToggle, badge, action, children, contentClassName = 'p-3 sm:p-4' }: Props) {
  const palette = tones[tone]
  return (
    <section data-crm-detail-section={id} className={`relative overflow-hidden rounded-2xl border bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)] ${palette.shell}`}>
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${palette.accent}`} />
      <div className={`flex min-h-[62px] items-stretch ${open ? palette.open : ''}`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-content`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
        >
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${palette.icon}`}><Icon className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-extrabold text-slate-900">{title}</span>{badge}</span>
            {summary && <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-500">{summary}</span>}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
        </button>
        {action && <div className="flex shrink-0 items-center pr-3" onClick={event => event.stopPropagation()}>{action}</div>}
      </div>
      <div id={`${id}-content`} aria-hidden={!open} className={`${open ? '' : 'hidden'} border-t ${palette.shell} ${contentClassName}`}>{children}</div>
    </section>
  )
}
