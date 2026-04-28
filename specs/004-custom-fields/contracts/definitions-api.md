# Contratos API: Campos Personalizados — Definiciones

**Base URL**: `/api/custom-fields`
**Autenticación**: Bearer token (header `Authorization`)
**Permisos**: Lectura → todos los usuarios autenticados. Escritura → solo rol `admin`.

---

## GET /api/custom-fields

Lista todas las definiciones de campos personalizados de la cuenta.

**Permisos**: Todos los usuarios autenticados
**Query params**: Ninguno

**Respuesta 200**:
```json
{
  "success": true,
  "fields": [
    {
      "id": "uuid",
      "account_id": "uuid",
      "name": "Ciudad de Origen",
      "slug": "ciudad_de_origen",
      "field_type": "text",
      "config": {},
      "is_required": false,
      "default_value": null,
      "sort_order": 0,
      "created_at": "2026-04-15T10:00:00Z",
      "updated_at": "2026-04-15T10:00:00Z"
    },
    {
      "id": "uuid",
      "name": "Nivel Educativo",
      "slug": "nivel_educativo",
      "field_type": "select",
      "config": {
        "options": [
          {"label": "Básico", "value": "basico"},
          {"label": "Intermedio", "value": "intermedio"},
          {"label": "Avanzado", "value": "avanzado"}
        ]
      },
      "is_required": true,
      "default_value": "basico",
      "sort_order": 1,
      "created_at": "2026-04-15T10:00:00Z",
      "updated_at": "2026-04-15T10:00:00Z"
    }
  ]
}
```

---

## POST /api/custom-fields

Crea una nueva definición de campo personalizado.

**Permisos**: Solo `admin`

**Request body**:
```json
{
  "name": "Presupuesto",
  "field_type": "currency",
  "config": { "symbol": "S/.", "decimals": 2 },
  "is_required": false,
  "default_value": null
}
```

**Validaciones**:
- `name` obligatorio, max 255 caracteres
- `field_type` debe ser uno de los 10 tipos soportados
- No exceder 50 campos por cuenta
- Nombre no duplicado (case-insensitive) en la misma cuenta
- `slug` se genera automáticamente a partir de `name`

**Respuesta 201**:
```json
{
  "success": true,
  "field": { /* CustomFieldDefinition completa */ }
}
```

**Errores**:
- `400`: Validación fallida (nombre vacío, tipo inválido, duplicado)
- `403`: Usuario no es admin
- `409`: Límite de 50 campos alcanzado

**WebSocket**: Emite `custom_field_def_update` con `{"action": "created", "field": {...}}`

---

## PUT /api/custom-fields/:id

Actualiza una definición existente.

**Permisos**: Solo `admin`

**Request body** (campos opcionales):
```json
{
  "name": "Presupuesto Mensual",
  "config": { "symbol": "S/.", "decimals": 2 },
  "is_required": true,
  "default_value": "0"
}
```

**Validaciones**:
- `field_type` NO se puede cambiar si existen valores asignados
- `name` no duplicado en la misma cuenta
- `slug` NO cambia aunque cambie `name`

**Respuesta 200**:
```json
{
  "success": true,
  "field": { /* CustomFieldDefinition actualizada */ }
}
```

**WebSocket**: Emite `custom_field_def_update` con `{"action": "updated", "field": {...}}`

---

## DELETE /api/custom-fields/:id

Elimina una definición y todos sus valores asociados (CASCADE).

**Permisos**: Solo `admin`

**Respuesta 200**:
```json
{
  "success": true
}
```

**WebSocket**: Emite `custom_field_def_update` con `{"action": "deleted", "field_id": "uuid"}`

---

## PUT /api/custom-fields/reorder

Reordena las definiciones de campos.

**Permisos**: Solo `admin`

**Request body**:
```json
{
  "field_ids": ["uuid-3", "uuid-1", "uuid-2"]
}
```

El orden del array define el nuevo `sort_order` (posición 0, 1, 2...).

**Respuesta 200**:
```json
{
  "success": true
}
```

**WebSocket**: Emite `custom_field_def_update` con `{"action": "reordered"}`
