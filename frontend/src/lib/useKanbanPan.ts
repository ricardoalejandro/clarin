import { useEffect, useRef } from 'react'

/**
 * Hook for Ctrl+drag panning on a kanban container.
 * - Ctrl held: cursor becomes grab (open hand)
 * - Ctrl+mousedown: cursor becomes grabbing (closed hand), drag to pan
 * - All listeners on document so they work regardless of when the kanban
 *   element mounts (the ref is read lazily inside handlers, not at setup time).
 */
export function useKanbanPan(
  kanbanRef: React.RefObject<HTMLDivElement | null>,
  topScrollRef?: React.RefObject<HTMLDivElement | null>,
) {
  const ctrlHeld = useRef(false)
  const isPanning = useRef(false)
  const startX = useRef(0)
  const scrollStart = useRef(0)

  useEffect(() => {
    const root = document.documentElement

    const updateCursor = () => {
      if (isPanning.current) {
        root.classList.remove('kanban-ctrl-held')
        root.classList.add('kanban-panning')
      } else if (ctrlHeld.current) {
        root.classList.remove('kanban-panning')
        root.classList.add('kanban-ctrl-held')
      } else {
        root.classList.remove('kanban-ctrl-held', 'kanban-panning')
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && !ctrlHeld.current) {
        ctrlHeld.current = true
        if (kanbanRef.current) updateCursor()
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        ctrlHeld.current = false
        if (isPanning.current) {
          isPanning.current = false
        }
        updateCursor()
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (!ctrlHeld.current) return
      const el = kanbanRef.current
      if (!el || !el.contains(e.target as Node)) return
      e.stopPropagation()
      e.preventDefault()
      isPanning.current = true
      startX.current = e.clientX
      scrollStart.current = el.scrollLeft
      updateCursor()
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!isPanning.current) return
      const el = kanbanRef.current
      if (!el) return
      e.stopPropagation()
      e.preventDefault()
      const dx = e.clientX - startX.current
      el.scrollLeft = scrollStart.current - dx
      if (topScrollRef?.current) {
        topScrollRef.current.scrollLeft = el.scrollLeft
      }
    }

    const onMouseUp = (e: MouseEvent) => {
      if (isPanning.current) {
        e.stopPropagation()
        e.preventDefault()
        isPanning.current = false
        updateCursor()
        // Suppress the click that follows mouseup so cards don't open detail
        const suppress = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
        document.addEventListener('click', suppress, { capture: true, once: true })
      }
    }

    const onDragStart = (e: DragEvent) => {
      if (ctrlHeld.current && kanbanRef.current?.contains(e.target as Node)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const onBlur = () => {
      ctrlHeld.current = false
      isPanning.current = false
      updateCursor()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousedown', onMouseDown, { capture: true })
    document.addEventListener('mousemove', onMouseMove, { capture: true })
    document.addEventListener('mouseup', onMouseUp, { capture: true })
    document.addEventListener('dragstart', onDragStart, { capture: true })
    window.addEventListener('blur', onBlur)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousedown', onMouseDown, { capture: true })
      document.removeEventListener('mousemove', onMouseMove, { capture: true })
      document.removeEventListener('mouseup', onMouseUp, { capture: true })
      document.removeEventListener('dragstart', onDragStart, { capture: true })
      window.removeEventListener('blur', onBlur)
      root.classList.remove('kanban-ctrl-held', 'kanban-panning')
    }
  }, [kanbanRef, topScrollRef])
}
