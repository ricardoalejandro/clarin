export function formatSurveyDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatObservedRate(rate: number | undefined): string {
  return rate === undefined ? 'Sin base suficiente' : `${rate.toFixed(1)}%`;
}

