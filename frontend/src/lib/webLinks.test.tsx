import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import WebText from '@/components/WebText'
import { findWebLinks, safeWebHref } from './webLinks'
import { formatToHtmlPreview, renderFormattedText } from './whatsappFormat'

afterEach(cleanup)

describe('safe shared web links', () => {
  it('preserves offsets and visible text with mixed schemes, Unicode, query parameters and balanced parentheses', () => {
    const text = 'Consulta HTTPS://EXAMPLE.COM/a_b_c?q=x_y&ref=uno.\n(www.ejemplo.com/ruta_(dos)), https://example.org/niño%20feliz!'
    const links = findWebLinks(text)
    expect(links.map(link => link.text)).toEqual(['HTTPS://EXAMPLE.COM/a_b_c?q=x_y&ref=uno', 'www.ejemplo.com/ruta_(dos)', 'https://example.org/niño%20feliz'])
    expect(links.map(link => text.slice(link.start, link.end))).toEqual(links.map(link => link.text))
    expect(links[0].href).toBe('https://example.com/a_b_c?q=x_y&ref=uno')
    expect(links[1].href).toBe('https://www.ejemplo.com/ruta_(dos)')
  })

  it('trims a long mixed closing suffix while preserving all balanced pairs and exact offsets', () => {
    const url = 'https://example.com/' + '([{'.repeat(4000) + 'a_b' + '}])'.repeat(4000)
    const suffix = ')]}.,;:!?…'.repeat(8000)
    const source = 'Consulta ' + url + suffix
    const links = findWebLinks(source)
    expect(links).toHaveLength(1)
    expect(links[0]).toEqual({ start: 9, end: 9 + url.length, text: url, href: new URL(url).href })
    expect(source.slice(links[0].end)).toBe(suffix)
    expect(findWebLinks(url)[0].text).toBe(url)
  })

  it.each(['javascript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:pass@example.com', 'https://example.com\\evil', 'https://example.com/\nsecret', 'https://', 'https://example.com/\u0000', 'https://example.com/\u202e'])('rejects an unsafe or invalid destination: %s', value => {
    expect(safeWebHref(value)).toBeNull()
  })

  it('renders descriptions without interpreting HTML, formatting markers or changing whitespace', () => {
    const text = '<script>alert(1)</script> _texto_\nHTTPS://example.com/a_b y www.example.org.'
    const { container } = render(<p className="whitespace-pre-wrap"><WebText text={text} /></p>)
    expect(container.textContent).toBe(text)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('em')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(2)
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })

  it('does not salvage a safe-looking prefix from a backslash or credential URL', () => {
    expect(findWebLinks('https://example.com\\evil https://user:pass@example.com')).toEqual([])
  })

  it('keeps URLs intact before WhatsApp formatting, including paths with format markers', () => {
    render(<div>{renderFormattedText('*Título* https://example.com/a_b_c/~user?q=a*b\n*https://example.org/path*')}</div>)
    expect(screen.getByRole('link', { name: 'https://example.com/a_b_c/~user?q=a*b' })).toHaveAttribute('href', 'https://example.com/a_b_c/~user?q=a*b')
    expect(screen.getByRole('link', { name: 'https://example.org/path' }).closest('strong')).not.toBeNull()
    expect(screen.getByText('Título').tagName).toBe('STRONG')
  })

  it('leaves inline and fenced code noninteractive and preserves the editor serialization', () => {
    const source = '`https://inline.example/a_b`\n```\nhttps://block.example/a_b\n```\nhttps://visible.example/a_b'
    render(<div>{renderFormattedText(source)}</div>)
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://visible.example/a_b')
    const preview = document.createElement('div')
    preview.innerHTML = formatToHtmlPreview('Hola *negrita* https://example.com/a_b')
    expect(preview.textContent).toBe('Hola *negrita* https://example.com/a_b')
    expect(preview.querySelector('a')).toBeNull()
  })

  it('does not close surrounding emphasis at a URL path marker', () => {
    render(<div>{renderFormattedText('_https://example.com/a_b_c_\n*Ver https://example.com/a*b y seguir*\n~https://example.com/~user~')}</div>)
    expect(screen.getByRole('link', { name: 'https://example.com/a_b_c' }).closest('em')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'https://example.com/a*b' }).closest('strong')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'https://example.com/~user' }).closest('del')).not.toBeNull()
  })
})
