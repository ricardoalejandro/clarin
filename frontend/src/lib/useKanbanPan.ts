import { useEffect, useRef } from 'react'

/**
 * Hook for Ctrl+drag and middle-mouse-button panning on a kanban container.
 * - Ctrl held: cursor becomes grab (open hand)
 * - Ctrl+mousedown OR middle-click: cursor becomes grabbing (closed hand), drag to pan
 * - All listeners on document so they work regardless of when the kanban
 *   element mounts (the ref is read lazily inside handlers, not at setup time).
 */
export function useKanbanPan(
  kanbanRef: React.RefObject<HTMLDivElement | null>,
  topScrollRef?: React.RefObject<HTMLDivElement | null>,
) {
  const ctrlHeld = useRef(false)
  const isPanning = useRef(false)
  const middlePanning = useRef(false)
  const startX = useRef(0)
  const scrollStart = useRef(0)

  useEffect(() => {
    const root = document.documentElement

    const updateCursor = () => {
      if (isPanning.current) {
        root.classList.remove('kanban-ctrl-held')
        root.classList.add('kanban-panning')
      } else if (ctrlHeld.current || middlePanning.current) {
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
        if (isPanning.current && !middlePanning.current) {
          isPanning.current = false
        }
        updateCursor()
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      const isMiddle = e.button === 1
      if (!ctrlHeld.current && !isMiddle) return
      const el = kanbanRef.current
      if (!el || !el.contains(e.target as Node)) return
      e.stopPropagation()
      e.preventDefault()
      isPanning.current = true
      middlePanning.current = isMiddle
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
        middlePanning.current = false
        updateCursor()
        // Suppress the click that follows mouseup so cards don't open detail
        const suppress = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
        document.addEventListener('click', suppress, { capture: true, once: true })
      }
    }

    // Prevent browser's native middle-click autoscroll on kanban
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1 && kanbanRef.current?.contains(e.target as Node)) {
        e.preventDefault()
      }
    }

    const onDragStart = (e: DragEvent) => {
      if ((ctrlHeld.current || middlePanning.current) && kanbanRef.current?.contains(e.target as Node)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const onBlur = () => {
      ctrlHeld.current = false
      isPanning.current = false
      middlePanning.current = false
      updateCursor()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousedown', onMouseDown, { capture: true })
    document.addEventListener('mousemove', onMouseMove, { capture: true })
    document.addEventListener('mouseup', onMouseUp, { capture: true })
    document.addEventListener('auxclick', onAuxClick, { capture: true })
    document.addEventListener('dragstart', onDragStart, { capture: true })
    window.addEventListener('blur', onBlur)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousedown', onMouseDown, { capture: true })
      document.removeEventListener('mousemove', onMouseMove, { capture: true })
      document.removeEventListener('mouseup', onMouseUp, { capture: true })
      document.removeEventListener('auxclick', onAuxClick, { capture: true })
      document.removeEventListener('dragstart', onDragStart, { capture: true })
      window.removeEventListener('blur', onBlur)
      root.classList.remove('kanban-ctrl-held', 'kanban-panning')
    }
  }, [kanbanRef, topScrollRef])
}
