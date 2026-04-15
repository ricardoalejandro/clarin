# Investigación: Participantes de Programa Solo Contactos

**Fecha**: 2026-04-14
**Feature**: 001-program-contacts-only
**Estado**: Completo — sin incógnitas pendientes

## Hallazgos del Código Actual

### 1. Endpoint `/api/people/search` (handleSearchPeople)

**Decisión**: Reutilizar el endpoint existente con el parámetro `type=contact` ya soportado.
**Razón**: El handler ya construye sub-queries condicionales basadas en `sourceType`. Cuando `type=contact`, solo ejecuta la query de contactos. El UNION ALL con leads se omite automáticamente.
**Alternativas consideradas**: Crear un endpoint nuevo `/api/contacts/search` → rechazado porque duplica funcionalidad existente sin valor añadido.

### 2. Componente ContactSelector

**Decisión**: Añadir prop `sourceFilter` al componente para forzar un tipo de fuente y ocultar el filtro de tipo.
**Razón**: El componente se usa en múltiples contextos (campañas, eventos, programas). Un prop permite restringir sin romper otros usos. El estado interno `sourceType` se inicializa desde el prop.
**Alternativas consideradas**: (a) Clonar el componente → rechazado por duplicación masiva (535 líneas). (b) Crear componente wrapper → rechazado por innecesario, un prop basta.

### 3. Handler handleAddParticipant (backend)

**Decisión**: Simplificar el handler para requerir `contact_id` obligatorio. Eliminar toda la lógica de resolución de leads (búsqueda por teléfono, creación de contacto desde lead, vinculación lead↔contact).
**Razón**: La lógica de resolución es compleja (~60 líneas), con múltiples paths de error, y ya no es necesaria porque el frontend solo enviará `contact_id`.
**Alternativas consideradas**: Mantener la resolución como fallback → rechazado porque contradice el spec (RF-004) y mantiene código muerto.

### 4. Frontend handleAddParticipants

**Decisión**: Simplificar para enviar siempre `contact_id` directamente, sin condicional `source_type`.
**Razón**: Como el selector solo devuelve contactos, `person.id` siempre es un `contact_id`.
**Alternativas consideradas**: Ninguna — es la consecuencia directa de RF-001.

### 5. Datos existentes

**Decisión**: No migrar datos. La columna `lead_id` en `program_participants` permanece.
**Razón**: Todos los participantes existentes ya tienen `contact_id` resuelto (NOT NULL + FOREIGN KEY). El campo `lead_id` es informacional y no afecta el funcionamiento.
**Alternativas consideradas**: Eliminar columna `lead_id` → rechazado por romper datos históricos sin beneficio.
