export type SurveySlugAvailabilityController = ReturnType<typeof createSurveySlugAvailabilityController>

export function createSurveySlugAvailabilityController({
  request,
  onPending,
  onResult,
  onError,
  delayMs = 500,
}: {
  request: (slug: string, signal: AbortSignal) => Promise<boolean>
  onPending: () => void
  onResult: (available: boolean | null) => void
  onError: (message: string) => void
  delayMs?: number
}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let active: AbortController | null = null
  let sequence = 0

  const cancel = () => {
    sequence += 1
    if (timer) clearTimeout(timer)
    timer = null
    active?.abort()
    active = null
  }

  const check = (rawSlug: string) => {
    cancel()
    const currentSequence = sequence
    const slug = rawSlug.trim()
    if (slug.length < 2) {
      onResult(null)
      return
    }
    onPending()
    timer = setTimeout(async () => {
      const controller = new AbortController()
      active = controller
      try {
        const available = await request(slug, controller.signal)
        if (!controller.signal.aborted && currentSequence === sequence) onResult(available)
      } catch (error) {
        if (!controller.signal.aborted && currentSequence === sequence) {
          onError(error instanceof Error ? error.message : 'No se pudo comprobar el enlace.')
        }
      }
    }, delayMs)
  }

  return { check, cancel }
}
