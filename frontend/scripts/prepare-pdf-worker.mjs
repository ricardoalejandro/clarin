import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const source = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')
const destination = join(process.cwd(), 'public', 'pdf.worker.min.mjs')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

console.log('PDF.js worker preparado en public/pdf.worker.min.mjs')
