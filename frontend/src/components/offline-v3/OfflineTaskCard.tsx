import { CalendarDays, Check, Clock3 } from 'lucide-react'
import type { OfflineTask } from '@/offline-v3/types'
import { offlineTaskCanComplete, offlineTaskIsCompleted, offlineTaskPriorityLabels } from '@/offline-v3/taskReadModel'

export default function OfflineTaskCard({ task, completing, canComplete, onComplete }: { task: OfflineTask; completing: boolean; canComplete: boolean; onComplete: () => void }) {
  const completed = offlineTaskIsCompleted(task)
  const allowed = offlineTaskCanComplete(task, canComplete)
  return (
    <article className={`offline-task-card ${completed ? 'offline-task-card--done' : ''}`}>
      <button
        type="button"
        className="offline-task-card__complete"
        onClick={onComplete}
        disabled={!allowed || completing}
        title={completed ? 'Completada' : !allowed && task.local_confirmation === 'pending' ? 'Espera la confirmación del servidor antes de volver a modificarla' : !allowed ? 'Solo lectura para esta tarea' : 'Completar tarea'}
        aria-label={completed ? `Tarea completada: ${task.title}` : `Completar ${task.title}`}
      >
        {completed && <Check />}
      </button>
      <div className="offline-task-card__body">
        <div className="offline-task-card__title-row">
          <h3>{task.title}</h3>
          <span data-priority={task.priority}>{offlineTaskPriorityLabels[task.priority]}</span>
        </div>
        {task.description && <p>{task.description}</p>}
        <div className="offline-task-card__meta">
          {task.status_name && <span><span className="offline-dot" style={{ background: task.status_color || '#94a3b8' }} />{task.status_name}</span>}
          {task.due_at && <span><CalendarDays />{new Date(task.due_at).toLocaleDateString('es-PE')}</span>}
          {task.local_confirmation === 'pending' && <span className="offline-local"><Clock3 />Pendiente de servidor</span>}
        </div>
      </div>
    </article>
  )
}
