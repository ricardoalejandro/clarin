'use client'

import { useEffect } from 'react'

/**
 * Habilita scroll nativo en el documento SOLO para el landing.
 * El dashboard usa un shell fijo con scroll interno; la landing necesita que
 * el viewport vuelva al comportamiento nativo del navegador.
 */
export default function PublicPageScroll() {
  useEffect(() => {
    const html = document.documentElement

    html.classList.add('public-page-scroll')

    return () => {
      html.classList.remove('public-page-scroll')
    }
  }, [])

  return null
}
