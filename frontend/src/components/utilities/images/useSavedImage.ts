import { useEffect, useRef } from 'react'
import { useUtilityDocument } from '../library/UtilityDocumentContext'
import { validateLocalImage, type LocalImage } from './localImages'
import type { useLocalJob } from './useLocalJob'

/** Revalidates stored bytes through exactly the same intake as a new file. */
export function useSavedImage(slot: string, source: ReturnType<typeof useLocalJob<LocalImage>>) {
  const document = useUtilityDocument()
  const choice = useRef(0)
  useEffect(() => {
    if (!document) return
    let alive = true
    const generation = choice.current
    void document.readSlot(slot).then(blob => {
      if (!alive || generation !== choice.current || !blob?.size) return
      void source.run(signal => validateLocalImage(new File([blob], typeof document.initialState[`${slot}_name`] === 'string' ? document.initialState[`${slot}_name`] as string : 'imagen.png', { type: blob.type }), signal))
    }).catch(() => {})
    return () => { alive = false }
  }, [document, slot])
  return {
    select(file: File) {
      choice.current++
      void source.run(async signal => {
        const image = await validateLocalImage(file, signal)
        signal.throwIfAborted()
        document?.setSlot(slot, image.blob)
        document?.setState({ [`${slot}_name`]: image.name })
        return image
      })
    },
    clear() { choice.current++; source.clear(); document?.setSlot(slot, new Blob([], { type: 'application/octet-stream' })) },
  }
}
