import { expect, it } from 'vitest'
import { IMAGE_TEXT_PREVIEW_CHARACTERS, imageTextOutput } from './imageTextOutput'

it('bounds only the preview while preserving the entire clipboard and download payload', () => {
  const original = 'a'.repeat(IMAGE_TEXT_PREVIEW_CHARACTERS + 128) + '=='
  const dataUrl = `data:image/png;base64,${original}`
  const raw = imageTextOutput(dataUrl, 'raw')
  expect(raw.value).toBe(original)
  expect(raw.preview).toBe(original.slice(0, IMAGE_TEXT_PREVIEW_CHARACTERS))
  expect(raw.truncated).toBe(true)
  const url = imageTextOutput(dataUrl, 'url')
  expect(url.value).toBe(dataUrl)
  expect(url.preview).toHaveLength(IMAGE_TEXT_PREVIEW_CHARACTERS)
  expect(url.truncated).toBe(true)
})

it('switches result formats without changing the original encoded image bytes', () => {
  const original = 'AAAB+/=='
  const dataUrl = `data:image/webp;base64,${original}`
  expect(imageTextOutput(dataUrl, 'raw')).toEqual({ value: original, preview: original, truncated: false })
  expect(imageTextOutput(dataUrl, 'url')).toEqual({ value: dataUrl, preview: dataUrl, truncated: false })
})
