export type CrmMessagePhase = 'idle' | 'resolving' | 'choosing_device' | 'opening_chat' | 'chat'

export function crmMessageTemporaryMode(phase: CrmMessagePhase): 'maximized' | undefined {
  return phase === 'idle' ? undefined : 'maximized'
}

export function crmMessageIsPending(phase: CrmMessagePhase): boolean {
  return phase === 'resolving' || phase === 'opening_chat'
}
