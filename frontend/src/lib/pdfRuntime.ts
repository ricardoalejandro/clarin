export const PDF_WORKER_SRC = '/pdf.worker.min.mjs'

let runtimePromise: Promise<typeof import('pdfjs-dist')> | null = null

export async function loadPdfRuntime() {
  if (!runtimePromise) {
    runtimePromise = import('pdfjs-dist').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC
      return pdfjs
    })
  }
  return runtimePromise
}
