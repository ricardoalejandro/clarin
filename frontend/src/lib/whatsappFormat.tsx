import React from 'react'

/**
 * WhatsApp text formatting:
 * *bold*       → <strong>
 * _italic_     → <em>
 * ~strike~     → <del>
 * `mono`       → <code>
 * ```block```  → <pre><code>
 */

interface FormatToken {
  type: 'text' | 'bold' | 'italic' | 'strike' | 'mono' | 'code_block'
  content: string
}

function tokenize(text: string): FormatToken[] {
  const tokens: FormatToken[] = []
  let i = 0

  while (i < text.length) {
    // Code block: ```...```
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3)
      if (end !== -1) {
        tokens.push({ type: 'code_block', content: text.slice(i + 3, end) })
        i = end + 3
        continue
      }
    }

    // Inline mono: `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1 && end > i + 1) {
        tokens.push({ type: 'mono', content: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Bold: *...*
    if (text[i] === '*') {
      const end = findClosing(text, i, '*')
      if (end !== -1) {
        tokens.push({ type: 'bold', content: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Italic: _..._
    if (text[i] === '_') {
      const end = findClosing(text, i, '_')
      if (end !== -1) {
        tokens.push({ type: 'italic', content: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Strikethrough: ~...~
    if (text[i] === '~') {
      const end = findClosing(text, i, '~')
      if (end !== -1) {
        tokens.push({ type: 'strike', content: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Regular text - collect until next potential format char
    let j = i + 1
    while (j < text.length && !'*_~`'.includes(text[j])) {
      j++
    }
    tokens.push({ type: 'text', content: text.slice(i, j) })
    i = j
  }

  return tokens
}

function findClosing(text: string, start: number, char: string): number {
  // Find closing char that isn't preceded by/followed by whitespace incorrectly
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === char) {
      const inner = text.slice(start + 1, i)
      // Must have content, not just whitespace
      if (inner.trim().length > 0) {
        return i
      }
    }
    // Don't cross newlines for single-char formats
    if (text[i] === '\n' && char !== '`') {
      return -1
    }
  }
  return -1
}

export function renderFormattedText(text: string): React.ReactNode[] {
  const tokens = tokenize(text)
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'bold':
        return <strong key={i}>{renderFormattedText(token.content)}</strong>
      case 'italic':
        return <em key={i}>{renderFormattedText(token.content)}</em>
      case 'strike':
        return <del key={i}>{renderFormattedText(token.content)}</del>
      case 'mono':
        return (
          <code key={i} className="bg-gray-200/60 px-1 py-0.5 rounded text-sm font-mono">
            {token.content}
          </code>
        )
      case 'code_block':
        return (
          <pre key={i} className="bg-gray-200/60 p-2 rounded text-sm font-mono overflow-x-auto my-1">
            <code>{token.content}</code>
          </pre>
        )
      default:
        return <React.Fragment key={i}>{token.content}</React.Fragment>
    }
  })
}

/**
 * Convert WhatsApp formatting to HTML string (for contenteditable preview)
 */
export function formatToHtml(text: string): string {
  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks first (to avoid processing inside them)
  html = html.replace(/```([\s\S]*?)```/g, (_m, p1) => {
    return `<pre class="bg-gray-200/60 p-2 rounded text-sm font-mono overflow-x-auto my-1 inline-block"><code>${p1}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`\n]+?)`/g, (_m, p1) => {
    return `<code class="bg-gray-200/60 px-1 py-0.5 rounded text-sm font-mono">${p1}</code>`
  })

  // Bold
  html = html.replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g, '<strong>$1</strong>')

  // Italic
  html = html.replace(/_((?:[^_\s]|[^_\s][^_]*[^_\s]))_/g, '<em>$1</em>')

  // Strikethrough
  html = html.replace(/~([^\s~](?:[^~]*[^\s~])?)~/g, '<del>$1</del>')

  // Newlines
  html = html.replace(/\n/g, '<br>')

  return html
}

/**
 * Live preview formatting that keeps markers visible but dimmed.
 * Used in the contenteditable input so cursor position stays consistent.
 */
export function formatToHtmlPreview(text: string): string {
  if (!text) return ''

  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks: ```text```
  html = html.replace(/```([\s\S]*?)```/g,
    '<span class="opacity-40">```</span><code class="bg-gray-100 rounded px-1 font-mono text-sm">$1</code><span class="opacity-40">```</span>')

  // Inline code: `text`
  html = html.replace(/`([^`\n]+?)`/g,
    '<span class="opacity-40">`</span><code class="bg-gray-100 rounded font-mono text-sm">$1</code><span class="opacity-40">`</span>')

  // Bold: *text*
  html = html.replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g,
    '<span class="opacity-40">*</span><strong>$1</strong><span class="opacity-40">*</span>')

  // Italic: _text_
  html = html.replace(/_((?:[^_\s]|[^_\s][^_]*[^_\s]))_/g,
    '<span class="opacity-40">_</span><em>$1</em><span class="opacity-40">_</span>')

  // Strikethrough: ~text~
  html = html.replace(/~([^\s~](?:[^~]*[^\s~])?)~/g,
    '<span class="opacity-40">~</span><del>$1</del><span class="opacity-40">~</span>')

  // Newlines
  html = html.replace(/\n/g, '<br>')

  return html
}

/**
 * Caret helpers for contenteditable divs.
 * Count offsets in terms of text characters (including BR as newline).
 */
export function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return 0
  const range = sel.getRangeAt(0).cloneRange()
  range.collapse(true)
  const preRange = document.createRange()
  preRange.selectNodeContents(el)
  preRange.setEnd(range.startContainer, range.startOffset)
  const frag = preRange.cloneContents()
  frag.querySelectorAll('br').forEach(br => {
    br.parentNode?.replaceChild(document.createTextNode('\n'), br)
  })
  return (frag.textContent || '').length
}

export function setCaretOffset(el: HTMLElement, offset: number) {
  const sel = window.getSelection()
  if (!sel) return

  let remaining = offset
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).length
      if (remaining <= len) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      remaining -= len
    } else if (node.nodeName === 'BR') {
      if (remaining === 0) {
        const parent = node.parentNode!
        const index = Array.from(parent.childNodes).indexOf(node as ChildNode)
        const range = document.createRange()
        range.setStart(parent, index + 1)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      remaining -= 1
    }
  }

  // Offset past end, set caret to end
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}
