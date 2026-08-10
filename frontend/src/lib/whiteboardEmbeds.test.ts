import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderBlockedWhiteboardEmbeddable } from './whiteboardEmbeds'

describe('whiteboard embed isolation', () => {
  it('returns a non-null React node so Excalidraw cannot fall back to an iframe', () => {
    const rendered = renderBlockedWhiteboardEmbeddable()
    expect(rendered).not.toBeNull()
    expect(isValidElement(rendered)).toBe(true)
  })

  it('keeps the upstream embed creation tool hidden in both whiteboard layouts', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/dashboard/whiteboards/whiteboards.css'), 'utf8')
    expect(css).toContain('[data-testid="toolbar-embeddable"]')
    expect(css).toContain('display: none !important')
  })
})
