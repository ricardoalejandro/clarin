import { describe, expect, it } from 'vitest'

import { TASK_PDF_WORKER_SRC } from './taskPdfRuntime'

describe('task PDF runtime', () => {
  it('uses the locally served module worker instead of a remote or bundled worker', () => {
    expect(TASK_PDF_WORKER_SRC).toBe('/pdf.worker.min.mjs')
    expect(TASK_PDF_WORKER_SRC).not.toMatch(/^https?:/)
  })
})
