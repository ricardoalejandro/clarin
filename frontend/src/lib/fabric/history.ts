/**
 * Fabric.js Canvas History (Undo/Redo)
 * Listens to canvas events and manages a state stack.
 */

import type { Canvas } from 'fabric'
import { HISTORY_LIMIT, CUSTOM_PROPS } from './constants'

export class CanvasHistory {
  private stack: string[] = []
  private index = -1
  private locked = false
  private canvas: Canvas

  constructor(canvas: Canvas) {
    this.canvas = canvas
  }

  /** Save current canvas state as new history entry */
  save(): void {
    if (this.locked) return
    const json = JSON.stringify(this.canvas.toObject(CUSTOM_PROPS))
    // Trim future states if we undo'd then made a change
    if (this.index < this.stack.length - 1) {
      this.stack = this.stack.slice(0, this.index + 1)
    }
    this.stack.push(json)
    // Enforce limit
    if (this.stack.length > HISTORY_LIMIT) {
      this.stack.shift()
    }
    this.index = this.stack.length - 1
  }

  /** Initialize history with current canvas state */
  init(): void {
    this.stack = []
    this.index = -1
    this.save()
  }

  get canUndo(): boolean {
    return this.index > 0
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1
  }

  async undo(): Promise<void> {
    if (!this.canUndo) return
    this.index--
    await this.restore()
  }

  async redo(): Promise<void> {
    if (!this.canRedo) return
    this.index++
    await this.restore()
  }

  private async restore(): Promise<void> {
    const state = this.stack[this.index]
    if (!state) return
    this.locked = true
    try {
      await this.canvas.loadFromJSON(state)
      // Re-protect the page rect after restore (loadFromJSON creates new objects)
      for (const obj of this.canvas.getObjects()) {
        if ((obj as any).__isPage) {
          obj.set({
            selectable: false,
            evented: false,
            hasControls: false,
            lockMovementX: true,
            lockMovementY: true,
            hoverCursor: 'default',
          })
          this.canvas.__pageRect = obj as any
          this.canvas.sendObjectToBack(obj)
          break
        }
      }
      this.canvas.renderAll()
    } finally {
      this.locked = false
    }
  }

  /** Lock/unlock to prevent saving during programmatic changes */
  lock(): void { this.locked = true }
  unlock(): void { this.locked = false }

  clear(): void {
    this.stack = []
    this.index = -1
  }
}
