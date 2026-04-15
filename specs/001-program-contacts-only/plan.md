# Plan de Implementación: Participantes de Programa Solo Contactos

**Rama**: `001-program-contacts-only` | **Fecha**: 2026-04-14 | **Spec**: [spec.md](spec.md)
**Input**: Especificación de feature desde `/specs/001-program-contacts-only/spec.md`

## Resumen

Restringir la adición de participantes en programas exclusivamente a contactos de WhatsApp.
Eliminar la posibilidad de seleccionar leads y la lógica de resolución lead→contacto del backend.
Cambio en 3 archivos, sin migraciones de base de datos.

## Contexto Técnico

**Lenguaje/Versión**: Go 1.24 (backend), TypeScript/React 18 (frontend)
**Dependencias Principales**: Fiber v2.52, Next.js 14, pgx v5
**Almacenamiento**: PostgreSQL 16 — sin cambios de esquema
**Testing**: Verificación manual + Docker build
**Plataforma**: Linux server, Docker Compose, Dokploy
**Tipo de Proyecto**: Web service (SPA + API)
**Restricciones**: Docker-only builds, SQL parametrizado, Tailwind emerald/slate

## Verificación de Constitución

*GATE: Verificado antes de Phase 0 y después de Phase 1. APROBADO.*

| Principio | Aplica | Estado |
|-----------|--------|--------|
| I. Docker-First Builds | Sí | ✅ Build via `docker compose build` |
| II. SQL Parametrizado | No introduce queries nuevas | ✅ N/A |
| III. Tailwind Emerald/Slate | No añade CSS nuevo | ✅ N/A |
| IV. WebSocket Broadcast | No hay mutaciones nuevas | ✅ N/A |
| V. Normalización Teléfono | Se elimina normalización del handler | ✅ N/A |
| VI. Cache Redis | No afecta datos cacheables | ✅ N/A |
| VII. Cambios Mínimos | 3 archivos, ~60 líneas eliminadas, ~15 añadidas | ✅ PASS |

## Estructura del Proyecto

### Documentación (esta feature)

```text
specs/001-program-contacts-only/
├── spec.md              # Especificación de requerimientos
├── plan.md              # Este archivo
├── research.md          # Investigación y decisiones técnicas
├── data-model.md        # Modelo de datos (sin cambios de esquema)
├── quickstart.md        # Guía rápida de implementación
├── contracts/
│   └── api.md           # Contratos de API modificados
├── checklists/
│   └── requirements.md  # Checklist de calidad del spec
└── tasks.md             # Tareas (generado con /speckit.tasks)
```

### Código Fuente (archivos afectados)

```text
backend/
└── internal/
    └── api/
        └── program_handler.go     → Simplificar handleAddParticipant

frontend/
└── src/
    ├── components/
    │   └── ContactSelector.tsx    → Añadir prop sourceFilter
    └── app/
        └── dashboard/
            └── programs/
                └── [id]/
                    └── page.tsx   → Pasar sourceFilter="contact", simplificar handler
```

**Decisión de Estructura**: Web application existente. Sin nuevos archivos. Solo modificaciones.

## Diseño Detallado

### Cambio 1: ContactSelector.tsx — Prop `sourceFilter`

**Archivo**: `frontend/src/components/ContactSelector.tsx`
**Impacto**: ~10 líneas añadidas

1. Añadir prop opcional `sourceFilter?: 'contact' | 'lead'` a la interfaz `ContactSelectorProps`
2. Cuando `sourceFilter` está definido:
   - Inicializar `sourceType` con el valor de `sourceFilter` en vez de `'all'`
   - En el reset on close: resetear a `sourceFilter` en vez de `'all'`
   - En el dropdown de filtros: no renderizar la sección de tipo de fuente (contact/lead/all)
3. Cuando `sourceFilter` NO está definido: comportamiento idéntico al actual

**Retrocompatibilidad**: 100%. Prop es opcional. Si no se pasa, el componente funciona igual.

### Cambio 2: programs/[id]/page.tsx — Solo contactos

**Archivo**: `frontend/src/app/dashboard/programs/[id]/page.tsx`
**Impacto**: ~8 líneas modificadas

1. En el JSX del `ContactSelector`, añadir `sourceFilter="contact"`
2. Simplificar `handleAddParticipants`:
   - Antes: `contact_id: person.source_type === 'contact' ? person.id : null`
   - Después: `contact_id: person.id` (siempre es un contacto)
   - Eliminar `lead_id` del body del POST

### Cambio 3: program_handler.go — Simplificar handler

**Archivo**: `backend/internal/api/program_handler.go`
**Impacto**: ~60 líneas eliminadas, ~10 líneas nuevas

1. Cambiar el struct de request: `ContactID` pasa de `*uuid.UUID` a `uuid.UUID` (obligatorio)
2. Eliminar TODO el bloque `else if req.LeadID != nil` (líneas ~207-262):
   - Eliminada: búsqueda de lead por ID
   - Eliminada: verificación de lead.ContactID existente
   - Eliminada: normalización de teléfono y búsqueda de contacto por teléfono
   - Eliminada: creación de contacto nuevo desde datos de lead
   - Eliminada: vinculación lead↔contact via UPDATE SQL
3. Validar que `contact_id` es no-nil. Si falta, retornar 400 con `"Se requiere contact_id"`.
4. Crear participante directamente con el `contact_id` proporcionado.

## Secuencia de Implementación

```
1. Backend: program_handler.go
   ├── Simplificar handleAddParticipant
   ├── docker compose build backend
   └── Verificar compilación

2. Frontend: ContactSelector.tsx
   ├── Añadir prop sourceFilter
   ├── Condicionar UI según prop
   └── (no se compila aún, depende del paso 3)

3. Frontend: programs/[id]/page.tsx
   ├── Pasar sourceFilter="contact"
   ├── Simplificar handleAddParticipants
   ├── docker compose build frontend
   └── Verificar compilación

4. Deploy + Verificación
   ├── docker compose up -d
   ├── docker compose logs --tail=30 backend
   ├── docker compose logs --tail=30 frontend
   └── Verificación funcional manual
```

## Tracking de Complejidad

> No hay violaciones de constitución que justificar. Tabla vacía.

| Violación | Por qué necesaria | Alternativa simple rechazada porque |
|-----------|-------------------|-------------------------------------|
| — | — | — |
