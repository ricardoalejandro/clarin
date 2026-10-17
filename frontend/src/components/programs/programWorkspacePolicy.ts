export type ProgramDetailTab = 'health' | 'participants' | 'sessions' | 'stats' | 'kanban' | 'academic' | 'surveys'
export type ProgramMobileTab = 'health' | 'sessions'

export function programWorkspacePolicy(width: number, coarsePointer: boolean, layoutHeight: number) {
  const compact = width <= 0 || width < 820
  const mobile = width <= 0 || width < 700 || (coarsePointer && layoutHeight < 600)
  return { compact, mobile, touch: compact || coarsePointer, desktopActions: !mobile }
}

export function mobileProgramTab(desktopTab: ProgramDetailTab): ProgramMobileTab {
  return desktopTab === 'sessions' ? 'sessions' : 'health'
}

export function programSections(mobile: boolean, canUseSurveys: boolean): ProgramDetailTab[] {
  if (mobile) return ['health', 'sessions']
  return ['health', 'academic', 'sessions', 'stats', ...(canUseSurveys ? ['surveys' as const] : [])]
}
