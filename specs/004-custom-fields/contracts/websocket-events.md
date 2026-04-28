# Contrato WebSocket: Campos Personalizados

**Hub**: `ws/hub.go`
**Patrón**: `s.hub.BroadcastToAccount(accountID, eventType, data)`

---

## Evento Nuevo: `custom_field_def_update`

Se emite cuando una definición de campo personalizado se crea, actualiza, elimina o reordena.

**Constante Go**: `EventCustomFieldDefUpdate = "custom_field_def_update"`

### Payloads

**Creación**:
```json
{
  "action": "created",
  "field": { /* CustomFieldDefinition completa */ }
}
```

**Actualización**:
```json
{
  "action": "updated",
  "field": { /* CustomFieldDefinition actualizada */ }
}
```

**Eliminación**:
```json
{
  "action": "deleted",
  "field_id": "uuid"
}
```

**Reordenamiento**:
```json
{
  "action": "reordered"
}
```

### Acción del Frontend

Al recibir `custom_field_def_update`, el frontend debe:
1. Invalidar/refrescar la lista local de definiciones de campos
2. Si `action === "deleted"`, remover el campo de las columnas visibles si estaba activo
3. Si `action === "reordered"`, refrescar el orden de campos en panel de detalle y columnas

---

## Evento Existente: `contact_update`

Se reutiliza para notificar cambios en valores de campos personalizados.

**Ya definido**: `EventContactUpdate = "contact_update"`

### Payload (sin cambios al existente)
```json
{
  "action": "updated",
  "contact_id": "uuid"
}
```

### Acción del Frontend

Al recibir `contact_update`, el frontend ya refresca datos del contacto. Los valores de campos personalizados se incluyen automáticamente si se cargan con `include_custom_fields=true`.
