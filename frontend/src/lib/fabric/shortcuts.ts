/**
 * Keyboard Shortcuts for Fabric.js Editor
 */

import type { Canvas } from 'fabric'
import type { CanvasHistory } from './history'

export interface ShortcutActions {
  onSave: () => void
  onDelete: () => void
  onDuplicate: () => void
  onSelectAll: () => void
  onGroup: () => void
  onUngroup: () => void
  onCopy: () => void
  onPaste: () => void
  onDeselect: () => void
  // Tool shortcuts (single-letter keys)
  onToolSelect?: () => void
  onToolText?: () => void
  onToolRect?: () => void
  onToolCircle?: () => void
  onToolLine?: () => void
  isEditingText?: () => boolean
}

export function setupShortcuts(
  canvas: Canvas,
  history: CanvasHistory,
  actions: ShortcutActions,
): (e: KeyboardEvent) => void {
  const handler = (e: KeyboardEvent) => {
    // Ignore if typing in an input/textarea (not the canvas text editor)
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      // Allow Escape to deselect even from inputs
      if (e.key === 'Escape') {
        actions.onDeselect()
        return
      }
      return
    }

    const ctrl = e.ctrlKey || e.metaKey

    // Ctrl+Z — Undo
    if (ctrl && !e.shiftKey && e.key === 'z') {
      e.preventDefault()
      history.undo()
      return
    }
    // Ctrl+Shift+Z or Ctrl+Y — Redo
    if ((ctrl && e.shiftKey && e.key === 'Z') || (ctrl && e.key === 'y')) {
      e.preventDefault()
      history.redo()
      return
    }
    // Ctrl+S — Save
    if (ctrl && e.key === 's') {
      e.preventDefault()
      actions.onSave()
      return
    }
    // Ctrl+D — Duplicate
    if (ctrl && e.key === 'd') {
      e.preventDefault()
      actions.onDuplicate()
      return
    }
    // Ctrl+G — Group
    if (ctrl && !e.shiftKey && e.key === 'g') {
      e.preventDefault()
      actions.onGroup()
      return
    }
    // Ctrl+Shift+G — Ungroup
    if (ctrl && e.shiftKey && e.key === 'G') {
      e.preventDefault()
      actions.onUngroup()
      return
    }
    // Ctrl+A — Select all
    if (ctrl && e.key === 'a') {
      e.preventDefault()
      actions.onSelectAll()
      return
    }
    // Ctrl+C — Copy
    if (ctrl && e.key === 'c') {
      e.preventDefault()
      actions.onCopy()
      return
    }
    // Ctrl+V — Paste
    if (ctrl && e.key === 'v') {
      e.preventDefault()
      actions.onPaste()
      return
    }
    // Delete / Backspace
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      actions.onDelete()
      return
    }
    // Escape — Deselect
    if (e.key === 'Escape') {
      e.preventDefault()
      actions.onDeselect()
      return
    }
    // Single-letter tool shortcuts (only when not editing text and no modifier)
    if (!ctrl && !e.altKey && !actions.isEditingText?.()) {
      switch (e.key.toLowerCase()) {
        case 'v': actions.onToolSelect?.(); return
        case 't': e.preventDefault(); actions.onToolText?.(); return
        case 'r': actions.onToolRect?.(); return
        case 'c': actions.onToolCircle?.(); return
        case 'l': actions.onToolLine?.(); return
      }
    }

    // Arrow keys — Move selected object
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const active = canvas.getActiveObject()
      if (!active) return
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      switch (e.key) {
        case 'ArrowUp': active.set('top', (active.top ?? 0) - step); break
        case 'ArrowDown': active.set('top', (active.top ?? 0) + step); break
        case 'ArrowLeft': active.set('left', (active.left ?? 0) - step); break
        case 'ArrowRight': active.set('left', (active.left ?? 0) + step); break
      }
      active.setCoords()
      canvas.renderAll()
      history.save()
      return
    }
  }

  document.addEventListener('keydown', handler)
  return handler
}
