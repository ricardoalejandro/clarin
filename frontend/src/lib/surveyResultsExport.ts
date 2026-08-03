export type SurveyResultsChartType = 'bar' | 'pie' | 'radar'

export function buildSurveyResultsExportPayload(
  questionIds: string[],
  chartTypes: Record<string, SurveyResultsChartType>,
  baselineId = '',
  followupId = '',
) {
  return {
    chart_types: Object.fromEntries(questionIds.map(questionId => [questionId, chartTypes[questionId] || 'bar'])),
    ...(baselineId ? { baseline_id: baselineId } : {}),
    ...(followupId ? { followup_id: followupId } : {}),
  }
}

export function saveSurveyResultsBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function createSurveyResultsExportSingleFlight() {
  let active = false
  return {
    run: async (task: () => Promise<void>) => {
      if (active) return false
      active = true
      try {
        await task()
        return true
      } finally {
        active = false
      }
    },
    isActive: () => active,
  }
}
