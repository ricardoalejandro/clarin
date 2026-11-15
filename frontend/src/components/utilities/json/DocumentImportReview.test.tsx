import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DOCUMENT_IMPORT_PREVIEW_LIMIT, DocumentImportReview, documentImportPreview } from './DocumentImportReview'

const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
})
afterEach(cleanup)
afterAll(() => {
  if (showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

it('bounds a preview around the replacement character rather than an unrelated earlier accent', () => {
  const preview = documentImportPreview('á' + 'x'.repeat(100_000) + 'valor-\uFFFD-prueba' + 'y'.repeat(100_000))
  expect(preview.length).toBeLessThanOrEqual(DOCUMENT_IMPORT_PREVIEW_LIMIT)
  expect(preview).toContain('valor-\uFFFD-prueba')
  expect(preview.startsWith('…')).toBe(true)
  expect(preview.endsWith('…')).toBe(true)
})

it('limits lines while retaining the interesting character and complete surrogate pairs', () => {
  const preview = documentImportPreview('x\n'.repeat(200) + '😀ñ\n' + 'y\n'.repeat(200))
  expect(preview.split('\n').length).toBeLessThanOrEqual(8)
  expect(preview).toContain('😀ñ')
  expect(preview).not.toMatch(/(?:^|…)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?:…|$)/u)
  const bounded = documentImportPreview('ñ' + 'a'.repeat(1196) + '😀tail')
  expect(bounded.length).toBeLessThanOrEqual(DOCUMENT_IMPORT_PREVIEW_LIMIT)
  expect(bounded).not.toMatch(/[\uD800-\uDBFF]…$/u)
  const boundary = documentImportPreview('x'.repeat(1000) + '😀' + 'a'.repeat(199) + '\uFFFD')
  expect(boundary).toContain('😀')
  expect(boundary).toContain('\uFFFD')
  expect(documentImportPreview('')).toBe('')
})

it('requires an explicit action and never accepts a changed preview automatically', () => {
  const onApply = vi.fn(), onCancel = vi.fn(), onChooseEncoding = vi.fn()
  const props = { fileName: 'documento.xml', source: '<dato>Español</dato>', encoding: 'windows-1252', onApply, onCancel, onChooseEncoding }
  const view = render(<DocumentImportReview {...props} />)
  expect(screen.getByRole('dialog', { name: 'Revisar codificación' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Vista previa de la codificación' })).toHaveValue(props.source)
  expect(onApply).not.toHaveBeenCalled()
  view.rerender(<DocumentImportReview {...props} source="<dato>Otra vista</dato>" />)
  expect(onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Elegir otra codificación' }))
  expect(onChooseEncoding).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(onCancel).toHaveBeenCalledOnce()
  expect(onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Usar esta codificación y abrir' }))
  expect(onApply).toHaveBeenCalledOnce()
})

it('keeps all actions disabled while the accepted import is being processed', () => {
  const onApply = vi.fn(), onCancel = vi.fn()
  render(<DocumentImportReview fileName="documento.xml" source="<a/>" busy onApply={onApply} onCancel={onCancel} onChooseEncoding={vi.fn()} />)
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }))
  expect(onApply).not.toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
})
