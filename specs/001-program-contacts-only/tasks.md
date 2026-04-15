# Tasks: Participantes de Programa Solo Contactos

**Input**: Documentos de diseño en `/specs/001-program-contacts-only/`
**Prerequisitos**: plan.md (leído), spec.md (leído), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: No solicitados en la especificación. No se incluyen tareas de testing.

**Organización**: Tareas agrupadas por historia de usuario. US3 (backend) es independiente y puede ejecutarse en paralelo con US1+US2 (frontend).

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: Puede ejecutarse en paralelo (archivos diferentes, sin dependencias)
- **[Story]**: Historia de usuario a la que pertenece (US1, US2, US3)
- Rutas de archivo exactas incluidas en descripciones

---

## Phase 1: User Story 3 — Validación del backend (Prioridad: P2)

**Objetivo**: El backend rechaza solicitudes sin `contact_id` válido y elimina la lógica de resolución de leads.

**Test independiente**: `curl -X POST /api/programs/UUID/participants -H "Authorization: Bearer TOKEN" -d '{"lead_id":"xxx"}'` → HTTP 400

- [x] T001 [P] [US3] Simplificar struct de request en handleAddParticipant: cambiar ContactID de `*uuid.UUID` a `uuid.UUID` (obligatorio) y eliminar campo LeadID en `backend/internal/api/program_handler.go`
- [x] T002 [US3] Eliminar bloque completo de resolución lead→contacto (~60 líneas) del handler handleAddParticipant en `backend/internal/api/program_handler.go`
- [x] T003 [US3] Añadir validación: si contact_id es uuid.Nil retornar HTTP 400 con `"Se requiere contact_id"` en `backend/internal/api/program_handler.go`
- [x] T004 [US3] Ejecutar `docker compose build backend` y verificar compilación sin errores

**Checkpoint**: Backend rechaza solicitudes sin contact_id. Lógica de resolución eliminada.

---

## Phase 2: User Story 1 + User Story 2 — Solo contactos en selector + ocultar filtro (Prioridad: P1 + P2)

**Objetivo US1**: La ventana "Agregar Participantes" solo muestra contactos, nunca leads.
**Objetivo US2**: El filtro de tipo de fuente (all/contact/lead) está oculto en el contexto de programas.

**Test independiente**: Abrir programa → Agregar Participantes → solo contactos visibles, sin filtro de tipo.

- [x] T005 [P] [US1] Añadir prop `sourceFilter?: 'contact' | 'lead'` a la interfaz ContactSelectorProps en `frontend/src/components/ContactSelector.tsx`
- [x] T006 [US1] Inicializar estado `sourceType` desde prop `sourceFilter` (default `'all'` si no se pasa) y resetear a `sourceFilter` en el efecto de close en `frontend/src/components/ContactSelector.tsx`
- [x] T007 [US2] Condicionar renderizado del filtro de tipo de fuente en el dropdown: no renderizar cuando `sourceFilter` está definido en `frontend/src/components/ContactSelector.tsx`
- [x] T008 [US1] Pasar `sourceFilter="contact"` al componente ContactSelector en `frontend/src/app/dashboard/programs/[id]/page.tsx`
- [x] T009 [US1] Simplificar `handleAddParticipants`: enviar siempre `contact_id: person.id` sin condicional de source_type, eliminar `lead_id` del body en `frontend/src/app/dashboard/programs/[id]/page.tsx`
- [x] T010 Ejecutar `docker compose build frontend` y verificar compilación sin errores

**Checkpoint**: Frontend solo muestra contactos en programas. Filtro de tipo oculto. Otros usos de ContactSelector no afectados.

---

## Phase 3: Deploy y Verificación

**Objetivo**: Desplegar ambos servicios y verificar funcionamiento completo.

- [x] T011 Ejecutar `docker compose up -d` para desplegar backend y frontend
- [x] T012 Verificar logs del backend con `docker compose logs --tail=30 backend` — arranque sin errores
- [x] T013 Verificar logs del frontend con `docker compose logs --tail=30 frontend` — arranque sin errores

**Checkpoint**: Ambos servicios desplegados y funcionando. Feature completa.

---

## Dependencias y Orden de Ejecución

### Dependencias entre Fases

- **Phase 1 (US3 — Backend)**: Sin dependencias — puede empezar inmediatamente
- **Phase 2 (US1+US2 — Frontend)**: Sin dependencias con Phase 1 — puede ejecutarse en paralelo
- **Phase 3 (Deploy)**: Depende de Phase 1 Y Phase 2 completadas

### Dependencias dentro de cada Fase

**Phase 1 (Backend)**:
- T001 → T002 → T003 → T004 (secuencial — mismo archivo, cambios acumulativos)

**Phase 2 (Frontend)**:
- T005 → T006 → T007 (secuencial en ContactSelector.tsx)
- T008, T009 dependen de T005-T007 (el prop debe existir antes de usarlo)
- T010 depende de T005-T009

### Oportunidades de Paralelismo

```text
Paralelo 1:  T001-T004 (backend)  ‖  T005-T009 (frontend)
Secuencial:  T010 (build frontend)
Secuencial:  T011-T013 (deploy + verificación)
```

---

## Estrategia de Implementación

### MVP (Recomendado — Entrega única)

Esta feature es lo suficientemente pequeña para implementarse y desplegarse en una sola iteración:

1. Completar Phase 1: Backend (T001-T004) — ~5 min
2. Completar Phase 2: Frontend (T005-T010) — ~5 min
3. Completar Phase 3: Deploy (T011-T013) — ~3 min

**Total: 13 tareas, 3 archivos modificados, ~13 min estimado**

No se justifica entrega incremental por historias separadas — el cambio es atómico y coherente.
