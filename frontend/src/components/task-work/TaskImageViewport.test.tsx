import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TaskImageViewport from './TaskImageViewport'
import type { TaskAttachmentAnchor } from '@/types/task'
const rect = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON() {} })
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) { return parseFloat(this.style.width) || 400 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return parseFloat(this.style.height) || 200 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(500, 400) as DOMRect)
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; pointerType: string; constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'touch' } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Fixture({ source = 'one', active = true, onAnchor = vi.fn() }: { source?: string; active?: boolean; onAnchor?: (anchor: TaskAttachmentAnchor) => void }) {
  const [scale, setScale] = useState(1)
  return <><output aria-label="Zoom actual">{scale}</output><button onClick={() => setScale(3)}>Zoom por botón</button><TaskImageViewport key={source} src={`/${source}.png`} alt="Imagen QA" sourceKey={source} active={active} scale={scale} onScaleChange={setScale} anchor={{ kind: 'image', x: .5, y: .25 }} onAnchor={onAnchor} onError={vi.fn()} /></>
}
function load() {
  const image = screen.getByRole('img', { hidden: true })
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: 400 }, naturalHeight: { configurable: true, value: 200 } })
  fireEvent.load(image)
  return { image, viewport: screen.getByRole('region'), content: document.querySelector<HTMLElement>('[data-task-image-content]')! }
}
it('fits the image and transforms its marker with native modifier wheel and existing scale controls', () => {
  render(<Fixture />)
  const { image, viewport, content } = load()
  expect(content).toHaveStyle({ width: '400px', height: '200px' })
  expect(content).toContainElement(image)
  expect(content.querySelector('[data-task-image-anchor]')).toHaveStyle({ left: '50%', top: '25%' })
  const wheel = new WheelEvent('wheel', { deltaY: -150, ctrlKey: true, clientX: 250, clientY: 200, bubbles: true, cancelable: true })
  fireEvent(viewport, wheel)
  expect(wheel.defaultPrevented).toBe(true)
  expect(Number(screen.getByLabelText('Zoom actual').textContent)).toBeGreaterThan(1)
  expect(content.style.transform).toContain('scale(')
  expect(image.style.transform).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom por botón' }))
  expect(viewport).toHaveAttribute('data-image-scale', '3')
})
it('never creates an anchor from a pinch or pan and retains a deliberate click', () => {
  const onAnchor = vi.fn()
  render(<Fixture onAnchor={onAnchor} />)
  const { viewport, content } = load()
  fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200, bubbles: true })
  fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 200, bubbles: true })
  fireEvent.pointerMove(viewport, { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 200, bubbles: true })
  expect(Number(viewport.getAttribute('data-image-scale'))).toBeGreaterThan(1)
  fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: 'touch' })
  fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: 'touch' })
  fireEvent.click(content, { clientX: 250, clientY: 100 })
  expect(onAnchor).not.toHaveBeenCalled()
  fireEvent.pointerDown(viewport, { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 })
  fireEvent.pointerUp(viewport, { pointerId: 3, pointerType: 'mouse', clientX: 100, clientY: 100 })
  fireEvent.click(viewport, { clientX: 250, clientY: 100 })
  expect(onAnchor).toHaveBeenCalledWith({ kind: 'image', page: undefined, x: .5, y: .25 })
})
it('leaves ordinary scrolling and suspended or outside gestures untouched', () => {
  const view = render(<Fixture />)
  const { viewport } = load()
  const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
  fireEvent(viewport, wheel)
  expect(wheel.defaultPrevented).toBe(false)
  view.rerender(<Fixture active={false} />)
  const suspended = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
  fireEvent(viewport, suspended)
  expect(suspended.defaultPrevented).toBe(false)
  expect(viewport.style.touchAction).not.toBe('none')
  const outside = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
  fireEvent(document.body, outside)
  expect(outside.defaultPrevented).toBe(false)
})
