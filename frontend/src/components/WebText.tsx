import { Fragment } from 'react'
import { findWebLinks } from '@/lib/webLinks'

export const WEB_LINK_CLASS = 'text-blue-700 underline decoration-blue-400 underline-offset-2 hover:text-blue-800 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'

export function WebLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={WEB_LINK_CLASS} title="Abrir enlace en una pestaña nueva">{children}</a>
}

/** Plain text stays plain: descriptions do not become HTML or a second rich text editor. */
export default function WebText({ text }: { text: string }) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const link of findWebLinks(text)) {
    nodes.push(<Fragment key={`text-${cursor}`}>{text.slice(cursor, link.start)}</Fragment>)
    nodes.push(<WebLink key={`link-${link.start}`} href={link.href}>{link.text}</WebLink>)
    cursor = link.end
  }
  nodes.push(<Fragment key={`text-${cursor}`}>{text.slice(cursor)}</Fragment>)
  return <>{nodes}</>
}
