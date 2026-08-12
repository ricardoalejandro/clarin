import type { ImgHTMLAttributes } from 'react'

export interface ClarinBrandMarkProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  label?: string
}

/** Canonical product mark. Keep its geometry single-sourced in public/favicon.svg. */
export default function ClarinBrandMark({ label, draggable = false, ...props }: ClarinBrandMarkProps) {
  return (
    <img
      {...props}
      src="/favicon.svg"
      alt={label || ''}
      aria-hidden={label ? undefined : true}
      data-clarin-brand-mark
      draggable={draggable}
    />
  )
}
