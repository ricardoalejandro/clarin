'use client'

import { forwardRef, useEffect, useState } from 'react'
import {
  Check,
  Clock3,
  CloudOff,
  LibraryBig,
  Loader2,
  MoreHorizontal,
  Share2,
  ShieldAlert,
  WifiOff,
} from 'lucide-react'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { WhiteboardPresentationControlState, WhiteboardPresentationState } from '@/lib/whiteboardPresentation'
import { WhiteboardPresentationButton } from './WhiteboardPresentationControls'

export type WhiteboardSaveState = 'saved' | 'pending' | 'preparing-assets' | 'uploading-assets' | 'saving' | 'offline' | 'error' | 'conflict'
type WhiteboardOpenSidebar = AppState['openSidebar']

export function whiteboardLibrarySidebarToggle(openSidebar: WhiteboardOpenSidebar) {
  const active = openSidebar?.name === 'default' && openSidebar.tab === 'library'
  return { name: 'default', tab: 'library', force: !active } as const
}

const SAVE_PRESENTATION: Record<WhiteboardSaveState, {
  label: string
  icon: typeof Check
  busy?: boolean
  retryable?: boolean
}> = {
  saved: { label: 'Guardado en Clarin', icon: Check },
  pending: { label: 'Cambios pendientes', icon: Clock3 },
  'preparing-assets': { label: 'Preparando imágenes', icon: Loader2, busy: true },
  'uploading-assets': { label: 'Subiendo imágenes', icon: Loader2, busy: true },
  saving: { label: 'Guardando en Clarin', icon: Loader2, busy: true },
  offline: { label: 'Sin conexión · Reintentar guardado', icon: WifiOff, retryable: true },
  error: { label: 'No guardado · Reintentar', icon: CloudOff, retryable: true },
  conflict: { label: 'Conflicto de guardado · Resolver', icon: ShieldAlert, retryable: true },
}

function WhiteboardSaveStatus({
  state,
  canEdit,
  onRetry,
}: {
  state: WhiteboardSaveState
  canEdit: boolean
  onRetry: () => void
}) {
  const presentation = SAVE_PRESENTATION[state]
  const Icon = presentation.icon
  const content = <Icon className={`h-[18px] w-[18px]${presentation.busy ? ' animate-spin' : ''}`} />
  const className = `whiteboard-action-bar__control whiteboard-save-status whiteboard-save-status--${state}`

  if (presentation.retryable && canEdit) {
    return <button
      type="button"
      data-whiteboard-save-status={state}
      onClick={onRetry}
      className={className}
      aria-label={presentation.label}
      title={presentation.label}
    >{content}</button>
  }

  return <span
    role="status"
    data-whiteboard-save-status={state}
    className={className}
    aria-label={presentation.label}
    title={presentation.label}
  >{content}</span>
}

export interface WhiteboardEditorActionBarProps {
  editorAPI: ExcalidrawImperativeAPI | null
  openSidebar?: WhiteboardOpenSidebar
  showShare: boolean
  canManageAccess: boolean
  canEdit: boolean
  saveState: WhiteboardSaveState
  moreOpen: boolean
  onShare: () => void
  onRetrySave: () => void
  onToggleMore: () => void
  presentation?: {
    controlState: WhiteboardPresentationControlState
    state: WhiteboardPresentationState
    onStart: () => void
    onStop: () => void
  }
}

export const WhiteboardEditorActionBar = forwardRef<HTMLButtonElement, WhiteboardEditorActionBarProps>(
  function WhiteboardEditorActionBar({
    editorAPI,
    openSidebar,
    showShare,
    canManageAccess,
    canEdit,
    saveState,
    moreOpen,
    onShare,
    onRetrySave,
    onToggleMore,
    presentation,
  }, moreButtonRef) {
    const [observedOpenSidebar, setObservedOpenSidebar] = useState<WhiteboardOpenSidebar>(
      () => editorAPI?.getAppState().openSidebar || null,
    )
    const currentOpenSidebar = openSidebar === undefined ? observedOpenSidebar : openSidebar
    const libraryActive = currentOpenSidebar?.name === 'default' && currentOpenSidebar.tab === 'library'

    useEffect(() => {
      if (openSidebar !== undefined || !editorAPI) return
      setObservedOpenSidebar(editorAPI.getAppState().openSidebar)
      return editorAPI.onChange((_elements, appState) => setObservedOpenSidebar(appState.openSidebar))
    }, [editorAPI, openSidebar])

    return <div className="whiteboard-action-bar" role="group" aria-label="Acciones de Pizarras">
      <button
        type="button"
        data-whiteboard-action="library"
        onClick={() => editorAPI?.toggleSidebar(whiteboardLibrarySidebarToggle(editorAPI.getAppState().openSidebar))}
        disabled={!editorAPI}
        aria-label="Biblioteca"
        title="Biblioteca"
        aria-pressed={libraryActive}
        className="whiteboard-action-bar__control whiteboard-library-action"
      ><LibraryBig className="h-5 w-5" /></button>
      {presentation && <WhiteboardPresentationButton
        controlState={presentation.controlState}
        state={presentation.state}
        canPresent={canEdit}
        onStart={presentation.onStart}
        onStop={presentation.onStop}
      />}
      {showShare && canManageAccess && <button
        type="button"
        data-whiteboard-action="share"
        onClick={onShare}
        aria-label="Compartir desde Clarin"
        title="Compartir desde Clarin"
        className="whiteboard-action-bar__control"
      ><Share2 className="h-[18px] w-[18px]" /></button>}
      <WhiteboardSaveStatus state={saveState} canEdit={canEdit} onRetry={onRetrySave} />
      <button
        ref={moreButtonRef}
        type="button"
        data-whiteboard-action="more"
        onClick={onToggleMore}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label="Más acciones de Pizarras"
        title="Más acciones de Pizarras"
        className="whiteboard-action-bar__control"
      ><MoreHorizontal className="h-5 w-5" /></button>
    </div>
  },
)
