import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import OperationalDatePicker from '@/components/operational-date/OperationalDatePicker'
import { useOperationalDateFields } from '@/components/operational-date/useOperationalDateFields'
import TaskDateRangePicker, { type TaskDateRangeValue } from '@/components/task-work/TaskDateRangePicker'
import ContactDetailSurface from '@/components/contact-details/ContactDetailSurface'

declare global { interface Window { __dateQA: { writes: unknown[]; ranges: TaskDateRangeValue[]; commits: string[]; contactWrites: unknown[] } } }
window.__dateQA = { writes: [], ranges: [], commits: [], contactWrites: [] }

function Fixture() {
  const [birth, setBirth] = useState('1990-05-15')
  const [meeting, setMeeting] = useState('2026-11-15T14:35')
  const [range, setRange] = useState<TaskDateRangeValue>({ startAt: '2026-11-15T09:00', endAt: '2026-11-16T10:00', isAllDay: false })
  const dateFields = useOperationalDateFields(), meetingFields = useOperationalDateFields(), rangeFields = useOperationalDateFields()
  const params = new URLSearchParams(location.search)
  const narrow = innerWidth < 768
  const sidebar = narrow ? 0 : params.get('sidebar') === 'open' ? 240 : 68
  const eros = !narrow && params.get('eros') === 'open' ? 280 : 0
  const button = 'mt-3 min-h-11 rounded-xl border border-emerald-700 bg-emerald-700 px-3 text-sm font-semibold text-white'
  return <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-slate-800">
    {sidebar > 0 && <aside aria-label="Navegación simulada" className="shrink-0 overflow-hidden border-r border-slate-200 bg-slate-100 p-3 text-sm" style={{ width: sidebar }}>Clarin</aside>}
    <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
      <h1 className="mb-2 text-lg font-semibold">Fechas · datos sintéticos</h1><p className="mb-4 text-xs text-slate-500">Componentes reales compilados; sin conexión a cuentas ni servicios.</p>
      {params.get('surface') === 'contact' ? <ContactDetailSurface contactId="qa-contact" context={{ type: 'contact', id: 'qa-contact' }} onClose={() => {}} /> :
      <div className="mx-auto grid max-w-4xl gap-4">
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3" aria-label="Formulario fecha sin hora">
          <h2 className="mb-2 text-sm font-semibold">Fecha sin hora</h2>
          <OperationalDatePicker mode="date" label="Nacimiento" value={birth} onChange={value => { window.__dateQA.commits.push(value); setBirth(value) }} showQuickValues={false} onDraftStateChange={dateFields.track('birth')} />
          <button type="button" className={button} onClick={() => { if (dateFields.validate()) window.__dateQA.writes.push({ birth: dateFields.value('birth', birth) }) }}>Guardar fecha</button>
        </section>
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3" aria-label="Formulario fecha con hora">
          <h2 className="mb-2 text-sm font-semibold">Fecha y hora</h2>
          <OperationalDatePicker mode="datetime" label="Reunión" value={meeting} onChange={setMeeting} showQuickValues={false} onDraftStateChange={meetingFields.track('meeting')} />
          <button type="button" className={button} onClick={() => { if (meetingFields.validate()) window.__dateQA.writes.push({ meeting: meetingFields.value('meeting', meeting) }) }}>Guardar reunión</button>
        </section>
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3" aria-label="Formulario rango de tarea">
          <h2 className="mb-2 text-sm font-semibold">Rango de tarea</h2>
          <TaskDateRangePicker label="Entrega" startValue={range.startAt} endValue={range.endAt} allDay={range.isAllDay} onStartDraftStateChange={rangeFields.track('start')} onEndDraftStateChange={rangeFields.track('end')}
            onApply={value => { window.__dateQA.ranges.push(value); setRange(value) }} />
          <button type="button" className={button} onClick={() => { if (rangeFields.validate()) window.__dateQA.writes.push({ range: { startAt: rangeFields.value('start', range.startAt), endAt: rangeFields.value('end', range.endAt), isAllDay: range.isAllDay } }) }}>Guardar rango</button>
        </section>
      </div>}
    </main>
    {eros > 0 && <aside aria-label="Eros simulado" className="shrink-0 border-l border-slate-200 bg-white p-3 text-sm" style={{ width: eros }}>Eros</aside>}
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
