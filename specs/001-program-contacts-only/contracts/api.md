# Contratos API: Participantes de Programa Solo Contactos

## POST /api/programs/:id/participants

**Cambio**: Simplificación del payload. Solo acepta `contact_id`.

### Request (ANTES)

```json
{
  "contact_id": "uuid | null",
  "lead_id": "uuid | null",
  "status": "string"
}
```

### Request (DESPUÉS)

```json
{
  "contact_id": "uuid (obligatorio)",
  "status": "string (opcional, default: 'active')"
}
```

### Responses

**201 Created** — Participante creado exitosamente:
```json
{
  "id": "uuid",
  "program_id": "uuid",
  "contact_id": "uuid",
  "status": "active",
  "enrolled_at": "2026-04-14T00:00:00Z"
}
```

**400 Bad Request** — Sin `contact_id`:
```json
{
  "error": "Se requiere contact_id"
}
```

**400 Bad Request** — `contact_id` inválido:
```json
{
  "error": "Invalid contact_id"
}
```

---

## GET /api/people/search (sin cambios de contrato)

Uso desde programas: `?type=contact&search=xxx&limit=100`

El parámetro `type=contact` ya existe y funciona. No se requieren cambios en este endpoint.

---

## ContactSelector Component Props (Frontend)

### Cambio: Nueva prop `sourceFilter`

```typescript
interface ContactSelectorProps {
  open: boolean
  onClose: () => void
  onConfirm: (selected: SelectedPerson[]) => void
  title?: string
  subtitle?: string
  confirmLabel?: string
  excludeIds?: Set<string>
  /** Nuevo: fuerza un tipo de fuente y oculta el filtro de tipo */
  sourceFilter?: 'contact' | 'lead'
}
```

**Comportamiento cuando `sourceFilter='contact'`**:
- El estado interno `sourceType` se fuerza a `'contact'`
- El selector de tipo (all/contact/lead) se oculta del dropdown de filtros
- La query a `/api/people/search` siempre incluye `type=contact`
