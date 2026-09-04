'use client'

import {
  useCallback,
  useId,
  useRef,
  type FormEvent,
  type FormEventHandler,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X, type LucideIcon } from 'lucide-react'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'

export type AdminFormDialogSize = 'role' | 'account' | 'user' | 'password'

export interface AdminFormDialogProps {
  open: boolean
  size: AdminFormDialogSize
  title: string
  description: ReactNode
  icon: LucideIcon
  busy?: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  initialFocusRef?: RefObject<HTMLElement>
  onSubmit?: FormEventHandler<HTMLFormElement>
  formId?: string
  formNoValidate?: boolean
  bodyClassName?: string
  closeLabel?: string
}

const DIALOG_WIDTH_CLASS: Record<AdminFormDialogSize, string> = {
  role: 'sm:max-w-[512px]',
  account: 'sm:max-w-[576px]',
  user: 'sm:max-w-[672px]',
  password: 'sm:max-w-[448px]',
}

export function AdminFormDialog({
  open,
  size,
  title,
  description,
  icon: Icon,
  busy = false,
  onClose,
  children,
  footer,
  initialFocusRef,
  onSubmit,
  formId,
  formNoValidate = false,
  bodyClassName = '',
  closeLabel = `Cerrar ${title}`,
}: AdminFormDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  const generatedId = useId().replace(/:/g, '')
  const titleId = `admin-form-dialog-${generatedId}-title`
  const descriptionId = `admin-form-dialog-${generatedId}-description`
  const portalOpen = open && typeof document !== 'undefined'
  busyRef.current = busy
  onCloseRef.current = onClose

  const requestClose = useCallback(() => {
    if (!busyRef.current) onCloseRef.current()
  }, [])

  useAccessibleDialog(portalOpen, dialogRef, requestClose, initialFocusRef)

  if (!portalOpen) return null

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (busy) {
      event.preventDefault()
      return
    }
    onSubmit?.(event)
  }

  const bodyAndFooter = (
    <>
      <div
        data-admin-dialog-scroll-owner
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 ${bodyClassName}`}
      >
        {children}
      </div>
      <footer className="flex shrink-0 flex-col gap-3 border-t border-slate-200 bg-slate-50/80 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:flex-row sm:justify-end sm:px-6 sm:pb-4">
        {footer}
      </footer>
    </>
  )

  return createPortal(
    <div
      data-admin-dialog-backdrop
      className="app-viewport fixed inset-0 flex items-stretch justify-center bg-slate-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={dialogRef}
        data-admin-form-dialog
        data-admin-dialog-size={size}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={`flex h-[var(--app-height,100dvh)] max-h-[var(--app-height,100dvh)] w-full max-w-none flex-col overflow-hidden rounded-none border-0 bg-white pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-[0_28px_80px_rgba(15,23,42,0.32)] outline-none sm:h-auto sm:max-h-[min(720px,calc(100dvh-32px))] sm:rounded-3xl sm:border sm:border-white/80 sm:pl-0 sm:pr-0 ${DIALOG_WIDTH_CLASS[size]}`}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-slate-200 bg-white px-4 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6 sm:pt-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id={titleId} className="text-xl font-semibold leading-7 text-slate-900">
              {title}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm leading-5 text-slate-500">
              {description}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={closeLabel}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        {onSubmit ? (
          <form
            id={formId}
            noValidate={formNoValidate}
            onSubmit={handleSubmit}
            className="flex min-h-0 flex-1 flex-col"
          >
            {bodyAndFooter}
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {bodyAndFooter}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export default AdminFormDialog
