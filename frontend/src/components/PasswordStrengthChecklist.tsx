'use client'

import { CheckCircle2, Circle } from 'lucide-react'
import {
  getAdminPasswordChecks,
  getAdminPasswordIssues,
  isAdminPasswordValid,
  type AdminPasswordCheck,
} from '@/lib/adminPassword'

export type PasswordCheck = AdminPasswordCheck

export function getPasswordChecks(password: string, confirmPassword?: string): PasswordCheck[] {
  return getAdminPasswordChecks(password, confirmPassword)
}

export function getPasswordIssues(password: string, confirmPassword?: string) {
  return getAdminPasswordIssues(password, confirmPassword)
}

export function isStrongPassword(password: string) {
  return isAdminPasswordValid(password)
}

export default function PasswordStrengthChecklist({
  password,
  confirmPassword,
  compact = false,
}: {
  password: string
  confirmPassword?: string
  compact?: boolean
}) {
  const checks = getPasswordChecks(password, confirmPassword)
  const passedCount = checks.filter(check => check.passed).length
  const complete = passedCount === checks.length
  const progress = Math.round((passedCount / checks.length) * 100)

  return (
    <div className={`rounded-xl border ${complete ? 'border-emerald-200 bg-emerald-50/70' : 'border-slate-200 bg-slate-50'} ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Seguridad de contraseña</p>
          <p className={`mt-0.5 text-xs ${complete ? 'text-emerald-700' : 'text-slate-500'}`}>
            {complete ? 'Lista para usar.' : `${passedCount} de ${checks.length} condiciones cumplidas.`}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${complete ? 'bg-emerald-100 text-emerald-700' : 'bg-white text-slate-500 border border-slate-200'}`}>
          {complete ? 'Fuerte' : `${progress}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Requisitos de contraseña cumplidos"
        aria-valuemin={0}
        aria-valuemax={checks.length}
        aria-valuenow={passedCount}
        className="mt-3 h-1.5 overflow-hidden rounded-full border border-slate-100 bg-white"
      >
        <div
          className={`h-full rounded-full transition-all duration-200 motion-reduce:transition-none ${complete ? 'bg-emerald-500' : 'bg-amber-400'}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className={`mt-3 grid ${compact ? 'gap-1.5' : 'sm:grid-cols-2 gap-2'}`}>
        {checks.map(check => (
          <div key={check.key} className={`flex items-center gap-2 text-xs ${check.passed ? 'text-emerald-700' : 'text-slate-500'}`}>
            {check.passed
              ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              : <Circle className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />}
            <span>{check.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
