import { describe, expect, it } from 'vitest'
import {
  TASK_DESCRIPTION_DEFAULT_HEIGHT,
  TASK_DESCRIPTION_MAX_HEIGHT,
  clampTaskDescriptionHeight,
  isTaskEditorSubmitShortcut,
  taskAccordionVisualState,
  taskDescriptionHeightFromKey,
  taskDescriptionEditorRemainsOpen,
  taskWindowVisualState,
  taskWorkspaceMenuPosition,
} from './taskInteractionVisuals'

describe('Clarin Work interaction visuals', () => {
  it('keeps floating and docked windows non-blocking while modal modes block', () => {
    expect(taskWindowVisualState('floating')).toMatchObject({ blocksWorkspace: false, backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.18)' } })
    expect(taskWindowVisualState('docked')).toMatchObject({ blocksWorkspace: false, backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.08)' } })
    expect(taskWindowVisualState('maximized')).toMatchObject({ blocksWorkspace: true, backdropStyle: { backgroundColor: 'rgba(2, 6, 23, 0.45)' } })
    expect(taskWindowVisualState('floating', true).blocksWorkspace).toBe(true)
  })

  it('clamps description resizing and supports accessible keyboard steps', () => {
    expect(clampTaskDescriptionHeight(40)).toBe(TASK_DESCRIPTION_DEFAULT_HEIGHT)
    expect(clampTaskDescriptionHeight(900)).toBe(TASK_DESCRIPTION_MAX_HEIGHT)
    expect(taskDescriptionHeightFromKey(160, 'ArrowDown')).toBe(184)
    expect(taskDescriptionHeightFromKey(160, 'ArrowUp')).toBe(136)
    expect(taskDescriptionHeightFromKey(160, 'Home')).toBe(TASK_DESCRIPTION_DEFAULT_HEIGHT)
    expect(taskDescriptionHeightFromKey(160, 'End', 320)).toBe(320)
    expect(taskDescriptionHeightFromKey(160, 'Enter')).toBeNull()
  })

  it('keeps the expanded editor open when persistence fails', () => {
    expect(taskDescriptionEditorRemainsOpen(false)).toBe(true)
    expect(taskDescriptionEditorRemainsOpen(true)).toBe(false)
  })

  it('recognizes Ctrl/Command+Enter but ignores IME composition', () => {
    expect(isTaskEditorSubmitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false })).toBe(true)
    expect(isTaskEditorSubmitShortcut({ key: 'Enter', ctrlKey: false, metaKey: true, isComposing: false })).toBe(true)
    expect(isTaskEditorSubmitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true })).toBe(false)
    expect(isTaskEditorSubmitShortcut({ key: 'Escape', ctrlKey: true, metaKey: false, isComposing: false })).toBe(false)
  })

  it('flips and clamps a portaled workspace menu inside the viewport', () => {
    expect(taskWorkspaceMenuPosition({ left: 260, top: 40, width: 32, height: 32 }, { width: 192, height: 96 }, { width: 320, height: 220 })).toEqual({ left: 100, top: 80 })
    expect(taskWorkspaceMenuPosition({ left: 6, top: 178, width: 32, height: 32 }, { width: 192, height: 96 }, { width: 320, height: 220 })).toEqual({ left: 8, top: 74 })
  })

  it('keeps collapsed content mounted but inaccessible', () => {
    expect(taskAccordionVisualState(true)).toEqual({ ariaHidden: true, contentClass: 'invisible grid-rows-[0fr] opacity-0', chevronClass: '-rotate-90' })
    expect(taskAccordionVisualState(false).contentClass).toContain('grid-rows-[1fr]')
  })
})
