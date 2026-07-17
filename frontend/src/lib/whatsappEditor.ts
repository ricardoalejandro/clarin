export type WhatsAppFormatCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inline_code'
  | 'monospace'
  | 'bullet_list'
  | 'numbered_list'
  | 'quote'

export type TextSelection = {
  start: number
  end: number
}

export type TextEditResult = {
  value: string
  selection: TextSelection
}

const INLINE_MARKERS: Partial<Record<WhatsAppFormatCommand, [string, string]>> = {
  bold: ['*', '*'],
  italic: ['_', '_'],
  strike: ['~', '~'],
  inline_code: ['`', '`'],
  monospace: ['```', '```'],
}

function clampSelection(value: string, selection: TextSelection): TextSelection {
  const start = Math.max(0, Math.min(value.length, Math.min(selection.start, selection.end)))
  const end = Math.max(start, Math.min(value.length, Math.max(selection.start, selection.end)))
  return { start, end }
}

export function insertTextAtSelection(value: string, selection: TextSelection, text: string): TextEditResult {
  const range = clampSelection(value, selection)
  const nextCaret = range.start + text.length
  return {
    value: value.slice(0, range.start) + text + value.slice(range.end),
    selection: { start: nextCaret, end: nextCaret },
  }
}

function applyInlineFormat(value: string, selection: TextSelection, prefix: string, suffix: string): TextEditResult {
  const range = clampSelection(value, selection)
  if (range.start === range.end) {
    const next = value.slice(0, range.start) + prefix + suffix + value.slice(range.end)
    const caret = range.start + prefix.length
    return { value: next, selection: { start: caret, end: caret } }
  }

  const selected = value.slice(range.start, range.end)
  const leadingWhitespace = selected.match(/^\s*/)?.[0] || ''
  const trailingWhitespace = selected.match(/\s*$/)?.[0] || ''
  const contentStart = range.start + leadingWhitespace.length
  const contentEnd = range.end - trailingWhitespace.length
  const content = value.slice(contentStart, contentEnd)
  if (!content) return { value, selection: range }

  const hasOuterMarkers =
    value.slice(Math.max(0, contentStart - prefix.length), contentStart) === prefix &&
    value.slice(contentEnd, contentEnd + suffix.length) === suffix
  if (hasOuterMarkers) {
    const next =
      value.slice(0, contentStart - prefix.length) +
      content +
      value.slice(contentEnd + suffix.length)
    const start = contentStart - prefix.length
    return { value: next, selection: { start, end: start + content.length } }
  }

  if (content.startsWith(prefix) && content.endsWith(suffix) && content.length >= prefix.length + suffix.length) {
    const unwrapped = content.slice(prefix.length, content.length - suffix.length)
    const next = value.slice(0, contentStart) + unwrapped + value.slice(contentEnd)
    return {
      value: next,
      selection: { start: contentStart, end: contentStart + unwrapped.length },
    }
  }

  const next =
    value.slice(0, contentStart) +
    prefix + content + suffix +
    value.slice(contentEnd)
  const start = contentStart + prefix.length
  return { value: next, selection: { start, end: start + content.length } }
}

function linePrefix(command: WhatsAppFormatCommand, index: number): string {
  if (command === 'bullet_list') return '- '
  if (command === 'numbered_list') return `${index + 1}. `
  return '> '
}

function stripLinePrefix(command: WhatsAppFormatCommand, line: string): string {
  if (command === 'bullet_list') return line.replace(/^[-*] /, '')
  if (command === 'numbered_list') return line.replace(/^\d{1,2}\. /, '')
  return line.replace(/^> /, '')
}

function hasLinePrefix(command: WhatsAppFormatCommand, line: string): boolean {
  if (command === 'bullet_list') return /^[-*] /.test(line)
  if (command === 'numbered_list') return /^\d{1,2}\. /.test(line)
  return /^> /.test(line)
}

function applyLineFormat(value: string, selection: TextSelection, command: WhatsAppFormatCommand): TextEditResult {
  const range = clampSelection(value, selection)
  const blockStart = value.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
  let blockEnd = value.indexOf('\n', range.end)
  if (blockEnd === -1) blockEnd = value.length
  if (range.end > range.start && range.end > blockStart && value[range.end - 1] === '\n') {
    blockEnd = range.end - 1
  }

  const block = value.slice(blockStart, blockEnd)
  const lines = block.split('\n')
  const nonEmpty = lines.filter(line => line.trim() !== '')
  const remove = nonEmpty.length > 0 && nonEmpty.every(line => hasLinePrefix(command, line))
  const transformed = lines.map((line, index) => {
    if (line.trim() === '') return line
    return remove ? stripLinePrefix(command, line) : linePrefix(command, index) + line
  }).join('\n')
  const next = value.slice(0, blockStart) + transformed + value.slice(blockEnd)

  if (range.start !== range.end) {
    return {
      value: next,
      selection: { start: blockStart, end: blockStart + transformed.length },
    }
  }

  const originalLine = lines[0] || ''
  const transformedLine = transformed.split('\n')[0] || ''
  const delta = transformedLine.length - originalLine.length
  const caret = Math.max(blockStart, range.start + delta)
  return { value: next, selection: { start: caret, end: caret } }
}

export function applyWhatsAppFormat(value: string, selection: TextSelection, command: WhatsAppFormatCommand): TextEditResult {
  const markers = INLINE_MARKERS[command]
  if (markers) return applyInlineFormat(value, selection, markers[0], markers[1])
  return applyLineFormat(value, selection, command)
}
