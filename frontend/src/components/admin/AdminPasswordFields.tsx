'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
} from 'react'
import { Check, Copy, Eye, EyeOff, Loader2, WandSparkles } from 'lucide-react'
import PasswordStrengthChecklist from '@/components/PasswordStrengthChecklist'
import { copyAdminPassword, generateAdminPassword } from '@/lib/adminPassword'
import { cn } from '@/lib/utils'

type PasswordFeedback =
  | { kind: 'generated' | 'copying' | 'copied'; message: string }
  | { kind: 'copy_failed' | 'generation_failed'; message: string }

export interface AdminPasswordFieldsProps {
  password: string
  confirmation: string
  onPasswordChange: (password: string) => void
  onConfirmationChange: (confirmation: string) => void
  onGenerated?: (password: string) => void
  passwordId?: string
  confirmationId?: string
  passwordLabel?: string
  confirmationLabel?: string
  passwordInputRef?: Ref<HTMLInputElement>
  confirmationInputRef?: Ref<HTMLInputElement>
  error?: string
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
  showChecklist?: boolean
  layout?: 'responsive' | 'stacked'
  className?: string
  generatePassword?: () => string
  copyText?: (text: string) => Promise<void>
}

export function AdminPasswordFields({
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
  onGenerated,
  passwordId,
  confirmationId,
  passwordLabel = 'Contraseña',
  confirmationLabel = 'Confirmar contraseña',
  passwordInputRef,
  confirmationInputRef,
  error,
  disabled = false,
  required = true,
  autoFocus = false,
  showChecklist = true,
  layout = 'responsive',
  className,
  generatePassword: createPassword = generateAdminPassword,
  copyText = copyAdminPassword,
}: AdminPasswordFieldsProps) {
  const reactId = useId().replace(/:/g, '')
  const resolvedPasswordId = passwordId || `${reactId}-password`
  const resolvedConfirmationId = confirmationId || `${reactId}-password-confirmation`
  const errorId = `${resolvedPasswordId}-error`
  const checklistId = `${resolvedPasswordId}-requirements`
  const fallbackId = `${resolvedPasswordId}-copy-fallback`
  const [revealed, setRevealed] = useState(false)
  const [feedback, setFeedback] = useState<PasswordFeedback | null>(null)
  const fallbackRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef(password)
  const copyOperationRef = useRef(0)
  const preserveFeedbackForGeneratedValueRef = useRef(false)
  passwordRef.current = password

  useEffect(() => {
    copyOperationRef.current += 1
    if (preserveFeedbackForGeneratedValueRef.current) {
      preserveFeedbackForGeneratedValueRef.current = false
    } else {
      setFeedback(null)
    }
    if (!password) setRevealed(false)
  }, [password])

  useEffect(() => () => {
    copyOperationRef.current += 1
  }, [])

  useEffect(() => {
    if (feedback?.kind !== 'copy_failed') return
    fallbackRef.current?.focus()
    fallbackRef.current?.select()
  }, [feedback])

  const describedBy = [error ? errorId : '', showChecklist ? checklistId : '']
    .filter(Boolean)
    .join(' ') || undefined
  const inputClassName = cn(
    'min-h-11 w-full rounded-xl border bg-white px-3 text-sm text-slate-900 outline-none transition',
    'placeholder:text-slate-400 focus:ring-4 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
    error
      ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
      : 'border-slate-200 focus:border-emerald-500 focus:ring-emerald-100',
  )

  const handleGenerate = () => {
    if (disabled) return
    try {
      const generatedPassword = createPassword()
      preserveFeedbackForGeneratedValueRef.current = true
      onPasswordChange(generatedPassword)
      onConfirmationChange(generatedPassword)
      onGenerated?.(generatedPassword)
      setRevealed(true)
      setFeedback({ kind: 'generated', message: 'Clave segura generada. Puedes revisarla y copiarla.' })
    } catch {
      preserveFeedbackForGeneratedValueRef.current = false
      setFeedback({
        kind: 'generation_failed',
        message: 'No se pudo generar una clave segura en este navegador. Escríbela manualmente.',
      })
    }
  }

  const handleCopy = async () => {
    if (disabled || !password) return
    const passwordToCopy = password
    const operation = ++copyOperationRef.current
    setFeedback({ kind: 'copying', message: 'Copiando clave…' })
    try {
      await copyText(passwordToCopy)
      if (operation !== copyOperationRef.current || passwordRef.current !== passwordToCopy) return
      setFeedback({ kind: 'copied', message: 'Clave copiada al portapapeles.' })
    } catch {
      if (operation !== copyOperationRef.current || passwordRef.current !== passwordToCopy) return
      setRevealed(true)
      setFeedback({
        kind: 'copy_failed',
        message: 'No se pudo copiar automáticamente. Selecciona la clave y cópiala manualmente.',
      })
    }
  }

  const handlePasswordChange = (nextPassword: string) => {
    preserveFeedbackForGeneratedValueRef.current = false
    setFeedback(null)
    onPasswordChange(nextPassword)
  }

  const handleConfirmationChange = (nextConfirmation: string) => {
    setFeedback(null)
    onConfirmationChange(nextConfirmation)
  }

  const feedbackFailed = feedback?.kind === 'copy_failed' || feedback?.kind === 'generation_failed'

  return (
    <div className={cn('space-y-3', className)}>
      <div className={cn('grid gap-3', layout === 'responsive' && 'sm:grid-cols-2')}>
        <div>
          <label htmlFor={resolvedPasswordId} className="mb-1.5 block text-sm font-semibold text-slate-700">
            {passwordLabel}
          </label>
          <input
            ref={passwordInputRef}
            id={resolvedPasswordId}
            type={revealed ? 'text' : 'password'}
            value={password}
            onChange={event => handlePasswordChange(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            required={required}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={inputClassName}
          />
        </div>
        <div>
          <label htmlFor={resolvedConfirmationId} className="mb-1.5 block text-sm font-semibold text-slate-700">
            {confirmationLabel}
          </label>
          <input
            ref={confirmationInputRef}
            id={resolvedConfirmationId}
            type={revealed ? 'text' : 'password'}
            value={confirmation}
            onChange={event => handleConfirmationChange(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            required={required}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={inputClassName}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Herramientas de contraseña">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={disabled}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <WandSparkles className="h-4 w-4" aria-hidden="true" />
          Generar clave
        </button>
        <button
          type="button"
          onClick={() => setRevealed(current => !current)}
          disabled={disabled || (!password && !confirmation)}
          aria-pressed={revealed}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {revealed
            ? <EyeOff className="h-4 w-4" aria-hidden="true" />
            : <Eye className="h-4 w-4" aria-hidden="true" />}
          {revealed ? 'Ocultar claves' : 'Mostrar claves'}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={disabled || !password || feedback?.kind === 'copying'}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {feedback?.kind === 'copying'
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            : feedback?.kind === 'copied'
              ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              : <Copy className="h-4 w-4" aria-hidden="true" />}
          {feedback?.kind === 'copying'
            ? 'Copiando…'
            : feedback?.kind === 'copied'
              ? 'Clave copiada'
              : 'Copiar clave'}
        </button>
      </div>

      {error && (
        <p id={errorId} role="alert" className="text-xs font-semibold text-rose-600">
          {error}
        </p>
      )}

      {feedback && (
        <p
          role={feedbackFailed ? 'alert' : 'status'}
          aria-live={feedbackFailed ? 'assertive' : 'polite'}
          className={cn(
            'rounded-xl border px-3 py-2 text-xs font-medium',
            feedbackFailed
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700',
          )}
        >
          {feedback.message}
        </p>
      )}

      {feedback?.kind === 'copy_failed' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <label htmlFor={fallbackId} className="mb-1.5 block text-xs font-semibold text-amber-900">
            Clave para copiar manualmente
          </label>
          <input
            ref={fallbackRef}
            id={fallbackId}
            type="text"
            readOnly
            value={password}
            onFocus={event => event.currentTarget.select()}
            onClick={event => event.currentTarget.select()}
            className="min-h-11 w-full select-all rounded-xl border border-amber-300 bg-white px-3 font-mono text-sm text-slate-900 outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-100"
          />
        </div>
      )}

      {showChecklist && (
        <div id={checklistId}>
          <PasswordStrengthChecklist password={password} confirmPassword={confirmation} compact />
        </div>
      )}
    </div>
  )
}

export default AdminPasswordFields
