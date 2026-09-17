import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ContactRound, Loader2, Mail, Phone, RefreshCw } from 'lucide-react'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineContact } from '@/offline-v3/types'
import { offlineDateLabel } from '@/offline-v3/programReadModel'

function ContactCopy({ selected, loading, close }: { selected: OfflineContact; loading: boolean; close: () => void }) {
  const [observationLimit, setObservationLimit] = useState(50)
  const observations = selected.direct_observations || selected.observations || []
  const phones = selected.phones?.length ? selected.phones : selected.phone ? [{ id: 'primary', phone: selected.phone, label: 'Principal' }] : []
  return <aside className="offline-detail" aria-label={`Detalle de ${selected.display_name}`}>
    <button type="button" className="offline-detail__close" onClick={close}>Cerrar</button>
    <div className="offline-detail__identity"><span className="offline-avatar offline-avatar--large">{selected.display_name.slice(0, 2).toUpperCase()}</span><div><p className="offline-eyebrow">Contacto · solo lectura</p><h2>{selected.display_name}</h2></div></div>
    {loading ? <p role="status"><Loader2 className="spin" />Descifrando detalle…</p> : <>
      {selected.do_not_contact && <div className="offline-alert offline-alert--warning">No contactar</div>}
      <dl>{phones.map(item => <div key={item.id}><dt>Teléfono · {item.label}</dt><dd>{item.phone}</dd></div>)}{selected.email && <><dt>Correo</dt><dd>{selected.email}</dd></>}{selected.address && <><dt>Dirección</dt><dd>{selected.address}</dd></>}{selected.district && <><dt>Distrito</dt><dd>{selected.district}</dd></>}{selected.occupation && <><dt>Ocupación</dt><dd>{selected.occupation}</dd></>}</dl>
      {!!selected.tags?.length && <section><h3>Etiquetas del contacto</h3><div className="offline-tag-list">{selected.tags.map(tag => <span className="offline-pill" key={tag.id}>{tag.name}</span>)}</div></section>}
      {selected.notes && <section><h3>Notas del contacto</h3><p className="offline-prewrap">{selected.notes}</p></section>}
      <details><summary>Observaciones directas ({observations.length})</summary>{observations.slice(0, observationLimit).map(observation => <article key={observation.id} className="offline-note"><strong>{observation.type === 'call' ? 'Llamada' : observation.type === 'note' ? 'Nota' : observation.type}</strong><p>{observation.notes}</p><small>{'author' in observation ? observation.author : 'created_by_name' in observation ? observation.created_by_name : ''} · {new Date(observation.created_at).toLocaleString('es-PE')}</small></article>)}{!observations.length && <p className="offline-muted">No hay observaciones directas en esta copia.</p>}{observations.length > observationLimit && <button className="offline-button offline-button--secondary" onClick={() => setObservationLimit(current => current + 50)}>Mostrar más ({observationLimit} de {observations.length})</button>}</details>
      {!!selected.custom_fields?.length && <details><summary>Campos del contacto ({selected.custom_fields.length})</summary><dl>{selected.custom_fields.map(field => <div key={field.id}><dt>{field.name}</dt><dd>{field.text ?? field.number ?? (field.date ? offlineDateLabel(field.date) : field.bool !== undefined ? field.bool ? 'Sí' : 'No' : field.json !== undefined ? JSON.stringify(field.json) : 'Sin valor')}</dd></div>)}</dl></details>}
    </>}
  </aside>
}

export default function OfflineContactsView({ gateway, refreshToken }: { gateway: OfflineDataGateway; refreshToken?: string }) {
  const [contacts, setContacts] = useState<OfflineContact[]>([]), [nextCursor, setNextCursor] = useState<string>()
  const [selected, setSelected] = useState<OfflineContact | null>(null), [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const generation = useRef(0), detailGeneration = useRef(0)
  const scope = useRef(gateway), selectedID = useRef<string | null>(null)
  useEffect(() => {
    const changed = generation.current === 0 || scope.current !== gateway; scope.current = gateway
    const expected = ++generation.current
    if (changed) { detailGeneration.current++; selectedID.current = null; setLoading(true); setContacts([]); setSelected(null); setNextCursor(undefined) }
    setLoadingMore(false); setError('')
    void gateway.contacts().then(page => { if (expected === generation.current) { setContacts(page.items); setNextCursor(page.next_cursor) } })
      .catch(cause => { if (expected === generation.current) { selectedID.current = null; detailGeneration.current++; setSelected(null); setContacts([]); setError(cause instanceof Error ? cause.message : 'No se pudieron cargar los contactos.') } })
      .finally(() => { if (expected === generation.current) setLoading(false) })
    if (!changed && selectedID.current) {
      const id = selectedID.current, request = ++detailGeneration.current
      void gateway.contact(id).then(detail => { if (expected === generation.current && request === detailGeneration.current) { setSelected(detail.item); setDetailLoading(false) } })
        .catch(cause => { if (expected === generation.current && request === detailGeneration.current) { selectedID.current = null; setSelected(null); setError(cause instanceof Error ? cause.message : 'La copia del contacto ya no está disponible.') } })
    }
    return () => { generation.current++; detailGeneration.current++ }
  }, [gateway, attempt, refreshToken])
  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const expected = generation.current; setLoadingMore(true)
    try { const page = await gateway.contacts(nextCursor); if (expected !== generation.current) return; setContacts(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]); setNextCursor(page.next_cursor) }
    catch (cause) { if (expected === generation.current) setError(cause instanceof Error ? cause.message : 'No se pudieron cargar más contactos.') }
    finally { if (expected === generation.current) setLoadingMore(false) }
  }
  async function open(contact: OfflineContact) {
    const expected = generation.current, request = ++detailGeneration.current
    selectedID.current = contact.id
    setSelected(contact); setDetailLoading(true); setError('')
    try { const detail = await gateway.contact(contact.id); if (expected === generation.current && request === detailGeneration.current) setSelected(detail.item) }
    catch (cause) { if (expected === generation.current && request === detailGeneration.current) { setSelected(null); setError(cause instanceof Error ? cause.message : 'No se pudo abrir el contacto.') } }
    finally { if (expected === generation.current && request === detailGeneration.current) setDetailLoading(false) }
  }
  return <section className="offline-module" aria-labelledby="offline-contacts-title">
    <header className="offline-module__header"><div><p className="offline-eyebrow">Contactos · solo lectura</p><h1 id="offline-contacts-title">Contactos disponibles</h1><p>Solo los contactos seleccionados para esta autorización.</p></div></header>
    {error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle /><span>{error}</span><button className="offline-button offline-button--secondary" onClick={() => setAttempt(current => current + 1)}>Reintentar</button></div>}
    {loading ? <div className="offline-loading"><Loader2 className="spin" />Cargando copia protegida…</div> : contacts.length === 0 && !error ? <div className="offline-empty"><ContactRound /><h2>No hay contactos preparados</h2><p>Los contactos sin descargar no se muestran como vacíos.</p></div> : <div className="offline-contact-grid">{contacts.map(contact => <button type="button" key={contact.id} className="offline-contact-card" onClick={() => void open(contact)}><span className="offline-avatar">{contact.display_name.slice(0, 2).toUpperCase()}</span><span><strong>{contact.display_name}</strong>{contact.phone && <small><Phone />{contact.phone}</small>}{contact.email && <small><Mail />{contact.email}</small>}</span></button>)}</div>}
    {nextCursor && <button className="offline-button offline-button--secondary offline-load-more" disabled={loadingMore} onClick={() => void loadMore()}><RefreshCw className={loadingMore ? 'spin' : ''} />Cargar más</button>}
    {selected && <ContactCopy key={selected.id} selected={selected} loading={detailLoading} close={() => { selectedID.current = null; detailGeneration.current++; setSelected(null) }} />}
  </section>
}
