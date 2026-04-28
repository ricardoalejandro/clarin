# Contratos API: Campos Personalizados — Valores

**Base URL**: `/api/contacts/:contactId/custom-fields`
**Autenticación**: Bearer token (header `Authorization`)
**Permisos**: Todos los usuarios autenticados pueden leer y asignar valores.

---

## GET /api/contacts/:contactId/custom-fields

Obtiene todos los valores de campos personalizados de un contacto.

**Respuesta 200**:
```json
{
  "success": true,
  "values": [
    {
      "id": "uuid",
      "field_id": "uuid",
      "contact_id": "uuid",
      "field_name": "Ciudad de Origen",
      "field_slug": "ciudad_de_origen",
      "field_type": "text",
      "value": "Lima",
      "created_at": "2026-04-15T10:00:00Z",
      "updated_at": "2026-04-15T10:00:00Z"
    },
    {
      "id": "uuid",
      "field_id": "uuid",
      "contact_id": "uuid",
      "field_name": "Presupuesto",
      "field_slug": "presupuesto",
      "field_type": "currency",
      "value": 1500.50,
      "created_at": "2026-04-15T10:00:00Z",
      "updated_at": "2026-04-15T10:00:00Z"
    },
    {
      "id": "uuid",
      "field_id": "uuid",
      "contact_id": "uuid",
      "field_name": "Intereses",
      "field_slug": "intereses",
      "field_type": "multi_select",
      "value": ["marketing", "ventas"],
      "created_at": "2026-04-15T10:00:00Z",
      "updated_at": "2026-04-15T10:00:00Z"
    }
  ]
}
```

**Nota**: El campo `value` se serializa según el tipo:
- `text/email/phone/url/select` → string
- `number/currency` → number
- `date` → string ISO 8601
- `checkbox` → boolean
- `multi_select` → string[]

---

## PUT /api/contacts/:contactId/custom-fields/:fieldId

Crea o actualiza el valor de un campo personalizado para un contacto (UPSERT).

**Request body**:
```json
{
  "value": "Lima"
}
```

El tipo de `value` en el JSON depende del `field_type` de la definición:
- `text/email/phone/url/select`: string
- `number/currency`: number
- `date`: string ISO 8601 (`"2026-04-15"` o `"2026-04-15T00:00:00Z"`)
- `checkbox`: boolean
- `multi_select`: string[] (`["val1", "val2"]`)

**Validaciones**:
- El `fieldId` debe ser una definición válida de la misma cuenta
- Validación de formato según tipo:
  - `email`: formato email válido
  - `phone`: se normaliza con `NormalizePhone()`
  - `url`: debe empezar con `http://` o `https://`
  - `number/currency`: debe ser numérico, respetar min/max si está en config
  - `select`: el valor debe existir en `config.options`
  - `multi_select`: todos los valores deben existir en `config.options`
- Para borrar un valor: enviar `{"value": null}`

**Respuesta 200**:
```json
{
  "success": true,
  "value": {
    "id": "uuid",
    "field_id": "uuid",
    "contact_id": "uuid",
    "value": "Lima",
    "created_at": "2026-04-15T10:00:00Z",
    "updated_at": "2026-04-15T12:30:00Z"
  }
}
```

**WebSocket**: Emite `contact_update` con `{"action": "updated", "contact_id": "uuid"}`

---

## PUT /api/contacts/:contactId/custom-fields (batch)

Actualiza múltiples valores de campos personalizados en una sola petición.

**Request body**:
```json
{
  "values": [
    { "field_id": "uuid-1", "value": "Lima" },
    { "field_id": "uuid-2", "value": 5000 },
    { "field_id": "uuid-3", "value": null }
  ]
}
```

**Respuesta 200**:
```json
{
  "success": true,
  "values": [ /* array de CustomFieldValue actualizados */ ]
}
```

**WebSocket**: Emite `contact_update` con `{"action": "updated", "contact_id": "uuid"}`

---

## Integración con Endpoints Existentes

### GET /api/contacts (con custom field values)

Se agrega query param opcional `include_custom_fields=true` para incluir los valores en la respuesta de listado.

```json
{
  "success": true,
  "contacts": [
    {
      "id": "uuid",
      "name": "Juan Pérez",
      "custom_field_values": [
        { "field_id": "uuid", "field_slug": "ciudad", "field_type": "text", "value": "Lima" }
      ]
    }
  ]
}
```

### GET /api/leads (con custom field values del contacto)

Los leads que tienen `contact_id` incluyen automáticamente los valores de campos personalizados del contacto asociado cuando se incluye `include_custom_fields=true`.

### Filtrado por Campos Personalizados

Se agrega query param `cf_filter` con formato JSON para filtrar por valores:

```
GET /api/contacts?cf_filter=[{"field_id":"uuid","op":"gt","value":5000},{"field_id":"uuid2","op":"eq","value":"avanzado"}]
```

**Operadores por tipo**:

| Tipo | Operadores soportados |
|------|----------------------|
| text, email, phone, url | `eq`, `neq`, `contains`, `starts_with` |
| number, currency | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` |
| date | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` |
| select | `eq`, `neq`, `in` |
| multi_select | `contains_any`, `contains_all` |
| checkbox | `eq` (true/false) |
