/**
 * Apple Emoji Renderer
 *
 * Converts native emoji characters to Apple-style emoji images
 * using the same CDN as emoji-picker-react (cdn.jsdelivr.net/npm/emoji-datasource-apple).
 * This makes emojis look identical to WhatsApp Web.
 */

const APPLE_EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64'

/**
 * Convert a single emoji character (or emoji sequence) to its unified hex code.
 * Example: '😀' → '1f600', '👨‍💻' → '1f468-200d-1f4bb'
 */
function emojiToUnified(emoji: string): string {
  const codepoints: string[] = []
  for (const char of emoji) {
    const cp = char.codePointAt(0)
    if (cp !== undefined) {
      codepoints.push(cp.toString(16))
    }
  }
  return codepoints.join('-')
}

/**
 * Get the Apple emoji image URL for a given emoji character.
 */
export function getAppleEmojiUrl(emoji: string): string {
  const unified = emojiToUnified(emoji)
  return `${APPLE_EMOJI_CDN}/${unified}.png`
}

/**
 * Check if a grapheme is an emoji using a simple heuristic.
 * A grapheme is likely an emoji if its first codepoint is in known emoji ranges.
 */
function isEmojiGrapheme(grapheme: string): boolean {
  const cp = grapheme.codePointAt(0)
  if (!cp) return false
  return (
    (cp >= 0x1F600 && cp <= 0x1F64F) || // Emoticons
    (cp >= 0x1F300 && cp <= 0x1F5FF) || // Misc Symbols & Pictographs
    (cp >= 0x1F680 && cp <= 0x1F6FF) || // Transport & Map
    (cp >= 0x1F900 && cp <= 0x1F9FF) || // Supplemental Symbols
    (cp >= 0x1FA00 && cp <= 0x1FA6F) || // Chess Symbols
    (cp >= 0x1FA70 && cp <= 0x1FAFF) || // Symbols Extended-A
    (cp >= 0x1F1E0 && cp <= 0x1F1FF) || // Regional Indicator (flags)
    (cp >= 0x2600 && cp <= 0x26FF) ||   // Misc Symbols
    (cp >= 0x2700 && cp <= 0x27BF) ||   // Dingbats
    (cp >= 0xFE00 && cp <= 0xFE0F) ||   // Variation Selectors
    (cp >= 0x200D && cp <= 0x200D) ||   // ZWJ
    (cp >= 0x20E3 && cp <= 0x20E3) ||   // Combining Enclosing Keycap
    (cp >= 0xE0020 && cp <= 0xE007F) || // Tags
    (cp >= 0x2300 && cp <= 0x23FF) ||   // Misc Technical
    (cp >= 0x2B50 && cp <= 0x2B55) ||   // Stars, circles
    (cp >= 0x3030 && cp <= 0x303D) ||   // CJK symbols
    (cp >= 0xA9 && cp <= 0xAE) ||       // ©®
    cp === 0x200D ||                     // ZWJ
    cp === 0xFE0F                        // VS16
  )
}

/**
 * Split text into segments of emoji and non-emoji text.
 * Uses Intl.Segmenter for correct grapheme cluster detection (handles ZWJ sequences, flags, etc.)
 * Falls back to codepoint-based splitting if Segmenter is unavailable.
 */
export function splitEmojiSegments(text: string): Array<{ type: 'emoji' | 'text'; value: string }> {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return splitWithSegmenter(text)
  }
  return splitFallback(text)
}

function splitWithSegmenter(text: string): Array<{ type: 'emoji' | 'text'; value: string }> {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  const segments: Array<{ type: 'emoji' | 'text'; value: string }> = []
  let currentText = ''

  for (const seg of Array.from(segmenter.segment(text))) {
    const grapheme = seg.segment
    if (isEmojiGrapheme(grapheme)) {
      if (currentText) {
        segments.push({ type: 'text', value: currentText })
        currentText = ''
      }
      segments.push({ type: 'emoji', value: grapheme })
    } else {
      currentText += grapheme
    }
  }

  if (currentText) {
    segments.push({ type: 'text', value: currentText })
  }

  return segments
}

function splitFallback(text: string): Array<{ type: 'emoji' | 'text'; value: string }> {
  // Simple fallback: iterate codepoints and group
  const segments: Array<{ type: 'emoji' | 'text'; value: string }> = []
  let currentText = ''
  let currentEmoji = ''

  for (const char of text) {
    const cp = char.codePointAt(0) || 0
    const isEmoji = cp > 0xFF && isEmojiGrapheme(char)

    if (isEmoji) {
      if (currentText) {
        segments.push({ type: 'text', value: currentText })
        currentText = ''
      }
      currentEmoji += char
    } else {
      // Check if this is a ZWJ or VS16 continuing an emoji sequence
      if (currentEmoji && (cp === 0x200D || cp === 0xFE0F)) {
        currentEmoji += char
      } else {
        if (currentEmoji) {
          segments.push({ type: 'emoji', value: currentEmoji })
          currentEmoji = ''
        }
        currentText += char
      }
    }
  }

  if (currentEmoji) segments.push({ type: 'emoji', value: currentEmoji })
  if (currentText) segments.push({ type: 'text', value: currentText })

  return segments
}
