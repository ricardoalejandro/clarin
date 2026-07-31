let configured = false

export const TASK_PDF_WORKER_SRC = '/pdf.worker.min.mjs'

export async function loadTaskPdfRuntime() {
  const pdfjs = await import('pdfjs-dist')
  if (!configured) {
    pdfjs.GlobalWorkerOptions.workerSrc = TASK_PDF_WORKER_SRC
    configured = true
  }
  return pdfjs
}
