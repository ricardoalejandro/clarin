'use client'

import { Loader2, MonitorUp, Radio, UserRoundCheck, UsersRound, X } from 'lucide-react'
import type { WhiteboardPresentationControlState, WhiteboardPresentationState } from '@/lib/whiteboardPresentation'

export function WhiteboardPresentationButton({
  controlState,
  state,
  canPresent,
  onStart,
  onStop,
}: {
  controlState: WhiteboardPresentationControlState
  state: WhiteboardPresentationState
  canPresent: boolean
  onStart: () => void
  onStop: () => void
  }) {
  if (!canPresent) return null
  const presenterName = state.active?.actor.display_name || ''
  const active = Boolean(state.active && state.active.actor.id === state.selfActorID)
  const busy = controlState === 'starting' || state.stopping
  const disabled = busy || controlState === 'occupied' || controlState === 'disconnected'
  const label = state.stopping
    ? 'Finalizando presentación'
    : controlState === 'starting'
      ? 'Iniciando presentación'
      : active
        ? `Finalizar presentación · ${state.followerActorIDs.length} siguiendo`
        : controlState === 'occupied'
          ? `${presenterName} está presentando`
          : controlState === 'disconnected'
            ? 'Presentación sin conexión'
            : controlState === 'error'
              ? active
                ? `Reintentar finalizar presentación: ${state.error || 'error temporal'}`
                : `Reintentar presentación: ${state.error || 'error temporal'}`
              : 'Invitar a seguirme'

  return <button
    type="button"
    data-whiteboard-action="presentation"
    data-whiteboard-presentation-state={controlState}
    onClick={active ? onStop : onStart}
    disabled={disabled}
    aria-label={label}
    title={label}
    className={`whiteboard-action-bar__control whiteboard-presentation-action${active ? ' whiteboard-presentation-action--active' : ''}`}
  >
    {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : active ? <Radio className="h-[18px] w-[18px]" /> : <MonitorUp className="h-[18px] w-[18px]" />}
    {active && <span className="whiteboard-presentation-action__count" aria-hidden="true">{state.followerActorIDs.length}</span>}
  </button>
}

export function WhiteboardPresentationOverlay({
  state,
  showInvitation,
  onAccept,
  onDecline,
  onLeave,
}: {
  state: WhiteboardPresentationState
  showInvitation: boolean
  onAccept: () => void
  onDecline: () => void
  onLeave: () => void
}) {
  const followingName = state.active?.actor.id === state.followingActorID
    ? state.active.actor.display_name
    : state.followingActorID ? 'colaborador' : null

  return <>
    {showInvitation && state.active && <section
      className="whiteboard-presentation-invitation"
      aria-label="Invitación a presentación"
      aria-live="polite"
    >
      <span className="whiteboard-presentation-invitation__icon"><UsersRound className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-black text-slate-900">{state.active.actor.display_name} te invita a seguir su presentación</p>
        <p className="mt-0.5 text-xs font-semibold text-slate-500">Tu vista cambiará con su recorrido; puedes salir cuando quieras.</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={onDecline} className="min-h-11 rounded-xl px-3 text-xs font-black text-slate-600 hover:bg-slate-100">Ahora no</button>
        <button type="button" onClick={onAccept} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-black text-white shadow-sm hover:bg-emerald-700"><UserRoundCheck className="h-4 w-4" />Seguir</button>
      </div>
    </section>}
    {followingName && <div className="whiteboard-presentation-following" role="status" aria-live="polite">
      <Radio className="h-4 w-4 text-emerald-600" />
      <span className="min-w-0 truncate">Siguiendo a <strong>{followingName}</strong></span>
      <button type="button" onClick={onLeave} aria-label="Dejar de seguir" title="Dejar de seguir" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
    </div>}
  </>
}
