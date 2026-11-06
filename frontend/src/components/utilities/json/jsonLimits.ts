export const JSON_INPUT_LIMIT = 2 * 1024 * 1024

export function fitsJsonInput(source: string) {
  return source.length <= JSON_INPUT_LIMIT && (source.length * 3 <= JSON_INPUT_LIMIT || new TextEncoder().encode(source).byteLength <= JSON_INPUT_LIMIT)
}
