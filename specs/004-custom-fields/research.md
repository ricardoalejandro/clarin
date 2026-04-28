# Investigación: Campos Personalizados

**Fecha**: 2026-04-15
**Funcionalidad**: 004-custom-fields

## I1: Almacenamiento Multi-Columna vs JSONB para Valores

### Decisión
Almacenamiento multi-columna en tabla `custom_field_values` con columnas tipadas separadas: `value_text`, `value_number`, `value_date`, `value_bool`, `value_json`.

### Justificación
- PostgreSQL puede indexar columnas nativas eficientemente (B-tree en `value_number`, GIN en `value_json`)
- Permite filtros SQL directos: `WHERE value_number > 5000` sin necesidad de casting JSONB
- JSONB puro requiere `::numeric`, `::date` que impiden uso de índices y complican las queries
- El campo `custom_fields JSONB` existente en leads (usado por Kommo) demuestra las limitaciones: no es filtrable ni indexable por tipo

### Alternativas consideradas
- **JSONB puro**: Más simple de implementar, pero inhabilita filtrado eficiente y requiere casting explícito
- **EAV clásico con una sola columna TEXT**: Requiere casting en cada lectura, pérdida de integridad de tipos
- **Columnas dinámicas (ALTER TABLE por campo)**: Máximo rendimiento pero inmanejable con 50 campos × N cuentas

## I2: Esquema de Definiciones → Tabla Separada vs Config en Cuenta

### Decisión
Tabla separada `custom_field_definitions` con FK a `accounts`.

### Justificación
- Cada definición es una entidad con su propio ciclo de vida (CRUD independiente)
- Permite reordenamiento con `sort_order`, validación de unicidad por `(account_id, slug)`
- Mantener en un JSONB de la tabla `accounts` complicaría las queries JOIN con valores y no permitiría FK desde `custom_field_values`

### Alternativas consideradas
- **Campo JSONB en accounts**: Más simple pero sin referential integrity, sin ORDER BY nativo, sin JOIN eficiente
- **Tabla por tipo de campo**: Normalización excesiva para 10 tipos que comparten >90% de atributos

## I3: Valores en Contact vs Lead vs Ambos

### Decisión
Valores solo en Contact. Los leads muestran los valores del contacto asociado.

### Justificación
- Contact es fuente de verdad (decisión confirmada por el usuario)
- Un contacto puede tener múltiples leads; duplicar valores en leads generaría inconsistencias
- El campo `Lead.CustomFields` existente (JSONB) es patrimonio de la integración Kommo y opera independientemente
- Leads sin contacto simplemente no muestran campos personalizados (decisión clarificada)

### Alternativas consideradas
- **Valores en ambos**: Duplicación de datos, riesgo de inconsistencia, doble escritura
- **Valores solo en Lead**: Contradice el modelo donde Contact es la entidad principal de datos personales

## I4: Permisos de Gestión

### Decisión
Solo rol `admin` puede crear/editar/eliminar/reordenar definiciones. Todos los usuarios pueden leer definiciones y asignar/editar valores.

### Justificación
- La configuración del esquema es una operación administrativa infrecuente
- La asignación de valores es operación diaria que todos los usuarios necesitan
- El sistema ya tiene `s.requirePermission()` y middleware de roles en server.go
- Clarificación confirmada por el usuario (Opción A)

## I5: Drag-and-Drop para Reordenamiento

### Decisión
Usar `@dnd-kit/core` + `@dnd-kit/sortable` para reordenamiento en el frontend.

### Justificación
- Librería estándar de React para drag-and-drop accesible
- Soporta teclado, lectors de pantalla, y touch
- Tamaño ligero (~15KB gzipped) comparado con alternatives como react-beautiful-dnd (deprecated)
- Endpoint backend: `PUT /api/custom-fields/reorder` recibe array de IDs en nuevo orden

### Alternativas consideradas
- **react-beautiful-dnd**: Deprecated por Atlassian, sin mantenimiento activo
- **Botones arriba/abajo**: Funcional pero UX inferior para listas de 10-50 items
- **Sortable nativo HTML5**: Inconsistente entre navegadores, sin accesibilidad

## I6: Generación de Slug

### Decisión
Generar slug al crear el campo usando `slugify(name)` (lowercase, reemplazar espacios por guiones bajos, remover caracteres especiales). El slug NO cambia al renombrar el campo.

### Justificación
- El slug sirve como identificador estable para queries, exports, y API
- Inmutabilidad del slug evita romper integraciones externas o referencias guardadas
- Si hay colisión, añadir sufijo numérico (`_2`, `_3`, etc.)

## I7: Límite de Campos por Cuenta

### Decisión
50 campos máximo por cuenta. Validación en el backend al crear.

### Justificación
- Suficiente para casos de uso reales (ClickUp Enterprise permite ~100)
- Limita el número de JOINs en queries de filtrado
- Configurable en el futuro si se necesita más

## I8: Broadcast WebSocket para Custom Fields

### Decisión
Nuevos eventos: `EventCustomFieldDefUpdate` para cambios en definiciones, reutilizar `EventContactUpdate` para cambios en valores.

### Justificación
- Las definiciones afectan a todos los usuarios de la cuenta → necesitan invalidar cache local de definiciones
- Los valores son per-contact → el evento existente `EventContactUpdate` ya cubre esta necesidad
- Patrón existente: `s.hub.BroadcastToAccount(accountID, ws.EventXxx, data)`

## I9: Persistencia de Preferencias de Columnas

### Decisión
Almacenar en `localStorage` del navegador con clave `cf_columns_{accountId}_{page}`.

### Justificación
- No requiere tabla adicional en el backend
- Es una preferencia puramente de presentación, no de datos
- Patrón ya usado en el frontend para otras preferencias de UI
- Si se pierde (limpieza de navegador), se restaura a "sin columnas custom" — impacto mínimo

### Alternativas consideradas
- **Tabla user_preferences en backend**: Over-engineering para una preferencia de UI. Se puede migrar después si se necesita sincronización entre dispositivos.
