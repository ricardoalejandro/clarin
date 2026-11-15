export type ImageTextFormat = 'raw' | 'url'
export const IMAGE_TEXT_PREVIEW_CHARACTERS = 12_000

/** The preview is bounded; clipboard and download always receive the complete value. */
export function imageTextOutput(dataUrl: string, format: ImageTextFormat) {
  const value = format === 'url' ? dataUrl : dataUrl.slice(dataUrl.indexOf(',') + 1)
  return { value, preview: value.slice(0, IMAGE_TEXT_PREVIEW_CHARACTERS), truncated: value.length > IMAGE_TEXT_PREVIEW_CHARACTERS }
}
