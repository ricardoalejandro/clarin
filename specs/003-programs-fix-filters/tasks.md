# Tasks: Corregir Eliminación/Edición de Programas y Filtros Avanzados

**Input**: Documentos de diseño en `/specs/003-programs-fix-filters/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/api.md ✅, quickstart.md ✅

**Tests**: No solicitados — no se incluyen tareas de test.

**Organización**: Las tareas están agrupadas por user story para permitir implementación y testing independiente de cada historia.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: Puede ejecutarse en paralelo (archivos diferentes, sin dependencias)
- **[Story]**: A qué user story pertenece (US1, US2, US3, US4)
- Incluye rutas de archivo exactas en las descripciones

## Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `frontend/src/app/dashboard/programs/[id]/page.tsx` | Fix delete/edit, toast, confirmación, wiring filtros |
| `frontend/src/components/ContactSelector.tsx` | Prop `advancedFilters`, panel de filtros 2 columnas, endpoint `/api/contacts` |

---

## Fase 1: Setup (Infraestructura Compartida)

**Propósito**: No se requiere setup de proyecto — el proyecto ya existe. Esta fase cubre la infraestructura de UI compartida entre múltiples user stories.

- [x] T001 [US4] Agregar estado de toast (`toastMessage`, `toastType`) y componente toast auto-dismissible (3s) en `frontend/src/app/dashboard/programs/[id]/page.tsx`
- [x] T002 [US1] Agregar estado de diálogo de confirmación (`confirmAction: { message, onConfirm } | null`) y componente modal de confirmación en `frontend/src/app/dashboard/programs/[id]/page.tsx`

---

## Fase 2: User Story 1 — Eliminar Programa desde Menú de Tres Puntos (Prioridad: P1) 🎯 MVP

**Objetivo**: El usuario puede eliminar un programa desde el menú ⋮, con diálogo de confirmación personalizado y feedback visual.

**Test Independiente**: Abrir programa → ⋮ → "Eliminar Programa" → aparece diálogo de confirmación → confirmar → toast de éxito → redirige a /dashboard/programs.

### Implementación

- [x] T003 [US1] Refactorizar `handleDeleteProgram` en `frontend/src/app/dashboard/programs/[id]/page.tsx`: reemplazar `confirm()` nativo por `setConfirmAction()` con mensaje "¿Estás seguro de eliminar este programa?", verificar `res.success` antes de `router.push()`, mostrar toast de éxito/error
- [x] T004 [US1] Refactorizar `handleArchiveProgram` en `frontend/src/app/dashboard/programs/[id]/page.tsx`: verificar `res.success` antes de refrescar UI, mostrar toast de éxito/error

**Checkpoint**: Eliminar y archivar programa funciona con confirmación y feedback visual ✅

---

## Fase 3: User Story 2 — Editar Programa desde Botón Lápiz (Prioridad: P1)

**Objetivo**: El usuario edita un programa desde el botón ✏️, ve un modal con datos precargados, y recibe feedback visual al guardar.

**Test Independiente**: Abrir programa → ✏️ → cambiar nombre → guardar → toast de éxito → nombre actualizado en el encabezado sin recargar.

### Implementación

- [x] T005 [US2] Agregar toast de éxito/error a `handleUpdateProgram` en `frontend/src/app/dashboard/programs/[id]/page.tsx`: mostrar "Programa actualizado" en éxito, "Error al actualizar programa" en fallo
- [x] T006 [US2] Verificar que el modal de edición cierra correctamente tras éxito y permanece abierto con toast de error en caso de fallo en `frontend/src/app/dashboard/programs/[id]/page.tsx`

**Checkpoint**: Editar programa funciona con feedback visual completo ✅

---

## Fase 4: User Story 4 — Feedback Visual en Todas las Operaciones (Prioridad: P2)

**Objetivo**: Todas las operaciones CRUD de la página muestran feedback visual (toast éxito/error). Las destructivas usan confirmación personalizada.

**Test Independiente**: Realizar cualquier operación (crear sesión, editar sesión, eliminar sesión, eliminar participante) → siempre aparece toast.

### Implementación

- [x] T007 [P] [US4] Refactorizar `handleRemoveParticipant` en `frontend/src/app/dashboard/programs/[id]/page.tsx`: reemplazar `confirm()` por `setConfirmAction()`, verificar `res.success`, mostrar toast éxito/error
- [x] T008 [P] [US4] Refactorizar `handleDeleteSession` en `frontend/src/app/dashboard/programs/[id]/page.tsx`: reemplazar `confirm()` por `setConfirmAction()`, verificar `res.success`, mostrar toast éxito/error
- [x] T009 [US4] Agregar toast de éxito/error a `handleCreateSession` y `handleUpdateSession` en `frontend/src/app/dashboard/programs/[id]/page.tsx`

**Checkpoint**: 100% de las operaciones de la página muestran feedback visual, cero errores silenciosos ✅

---

## Fase 5: User Story 3 — Filtros Avanzados al Agregar Participantes (Prioridad: P2)

**Objetivo**: El selector de participantes ofrece filtros avanzados idénticos a la página de Contactos: tag include/exclude, AND/OR, fórmula, fecha, dispositivo.

**Test Independiente**: Abrir programa → "Agregar Participantes" → panel de filtros 2 columnas → aplicar filtros → seleccionar contactos filtrados → confirmar → participantes agregados.

### Implementación

- [x] T010 [US3] Agregar prop `advancedFilters?: boolean` a la interfaz `ContactSelectorProps` en `frontend/src/components/ContactSelector.tsx`
- [x] T011 [US3] Agregar estado de filtros avanzados (filterTagNames, excludeFilterTagNames, tagFilterMode, formulaType, formulaText, filterDevice, filterDateField, filterDatePreset, filterDateFrom, filterDateTo, devices) en `frontend/src/components/ContactSelector.tsx`
- [x] T012 [US3] Implementar fetch a `/api/contacts` cuando `advancedFilters=true` y `sourceFilter="contact"`, con mapeo Contact → PersonResult en `frontend/src/components/ContactSelector.tsx`
- [x] T013 [US3] Implementar fetch de dispositivos (`/api/devices`) al montar cuando `advancedFilters=true` en `frontend/src/components/ContactSelector.tsx`
- [x] T014 [US3] Renderizar panel de filtros de 2 columnas: izquierda (dispositivo + fecha con 9 presets + rango personalizado), derecha (tags include/exclude ciclo 3-clic + AND/OR toggle) en `frontend/src/components/ContactSelector.tsx`
- [x] T015 [US3] Agregar toggle Simple/Avanzado y renderizar FormulaEditor (import existente) para modo avanzado de fórmulas en `frontend/src/components/ContactSelector.tsx`
- [x] T016 [US3] Actualizar contador de filtros activos y botón "Limpiar filtros" para incluir los nuevos filtros avanzados en `frontend/src/components/ContactSelector.tsx`

**Checkpoint**: ContactSelector con filtros avanzados completos, retrocompatible con otros callers ✅

---

## Fase 6: Integración + Build + Deploy

**Propósito**: Conectar filtros avanzados en la página de programas y verificar todo funciona en producción.

- [x] T017 Pasar `advancedFilters={true}` al componente ContactSelector en `frontend/src/app/dashboard/programs/[id]/page.tsx`
- [x] T018 Build frontend: ejecutar `docker compose build frontend` y verificar compilación sin errores
- [x] T019 Deploy: ejecutar `docker compose up -d` y verificar logs con `docker compose logs --tail=30 frontend`
- [x] T020 Ejecutar validación de quickstart.md: (1) eliminar programa con confirmación, (2) editar programa con toast, (3) agregar participantes con filtros avanzados

---

## Dependencias y Orden de Ejecución

### Dependencias entre Fases

- **Fase 1 (Setup)**: Sin dependencias — T001 y T002 crean la infraestructura de toast y confirmación
- **Fase 2 (US1 - Eliminar)**: Depende de T001 (toast) y T002 (confirmación)
- **Fase 3 (US2 - Editar)**: Depende de T001 (toast). Puede ejecutarse en paralelo con Fase 2
- **Fase 4 (US4 - Feedback)**: Depende de T001 (toast) y T002 (confirmación). Puede ejecutarse en paralelo con Fases 2 y 3
- **Fase 5 (US3 - Filtros)**: Sin dependencia sobre otras fases — modifica archivo diferente (`ContactSelector.tsx`)
- **Fase 6 (Integración)**: Depende de TODAS las fases anteriores

### Dependencias entre User Stories

- **US1 (Eliminar)**: Independiente tras infraestructura (T001, T002)
- **US2 (Editar)**: Independiente tras T001 — no requiere T002
- **US3 (Filtros)**: Totalmente independiente — archivo diferente
- **US4 (Feedback)**: Independiente tras infraestructura (T001, T002)

### Dentro de Cada User Story

- Infraestructura de toast/confirmación antes de handlers
- Handlers destructivos requieren confirmación (T002) antes de implementar
- Handlers no-destructivos solo requieren toast (T001)

### Oportunidades de Paralelismo

```
Paralelo 1 (tras T001 + T002):
  ├── T003 + T004 (US1: delete + archive)
  ├── T005 + T006 (US2: edit)
  └── T007 + T008 (US4: remove participant + delete session)

Paralelo 2 (independiente, archivo diferente):
  └── T010 → T011 → T012 → T013 → T014 → T015 → T016 (US3: filtros avanzados)
```

---

## Ejemplo de Ejecución Paralela

```bash
# Paso 1: Infraestructura compartida (secuencial, mismo archivo)
T001: Agregar toast state + componente
T002: Agregar confirmación state + componente

# Paso 2: Fix handlers (paralelo posible entre stories, MISMO archivo — ejecutar secuencial)
T003: Fix handleDeleteProgram (US1)
T004: Fix handleArchiveProgram (US1)
T005: Toast en handleUpdateProgram (US2)
T006: Verificar modal edición (US2)
T007: Fix handleRemoveParticipant (US4)
T008: Fix handleDeleteSession (US4)
T009: Toast en create/update session (US4)

# Paso 2b: Filtros avanzados (PARALELO con Paso 2 — archivo diferente)
T010 → T011 → T012 → T013 → T014 → T015 → T016

# Paso 3: Integración (secuencial)
T017: Wire advancedFilters prop
T018: Build
T019: Deploy
T020: Validación quickstart
```

---

## Estrategia de Implementación

### MVP Primero (Solo US1 + US2 — P1)

1. Completar Fase 1: Toast + Confirmación (T001, T002)
2. Completar Fase 2: Eliminar programa funciona (T003, T004)
3. Completar Fase 3: Editar programa funciona (T005, T006)
4. **PARAR Y VALIDAR**: Las operaciones básicas de delete/edit funcionan
5. Build y deploy parcial posible

### Entrega Incremental

1. T001 + T002 → Infraestructura lista
2. T003–T006 → US1 + US2 resueltos → **MVP: bugs P1 corregidos** 🎯
3. T007–T009 → US4 completo → Feedback visual en todas las operaciones
4. T010–T016 → US3 completo → Filtros avanzados en ContactSelector
5. T017–T020 → Integración, build, deploy, validación
6. Cada fase agrega valor sin romper lo anterior

---

## Notas

- Todas las tareas de Fases 2–4 modifican el MISMO archivo (`programs/[id]/page.tsx`) — ejecutar secuencialmente
- Las tareas de Fase 5 modifican un archivo DIFERENTE (`ContactSelector.tsx`) — pueden ejecutarse en paralelo con Fases 2–4
- No se requieren cambios en backend — todos los endpoints ya existen y funcionan (research.md R1)
- La paleta Tailwind obligatoria es emerald/slate (constitution III)
- Usar `e.preventDefault()` + `e.stopPropagation()` en componentes con dropdowns anidados
- FormulaEditor ya existe y se importa sin modificaciones
- Mapeo Contact → PersonResult documentado en contracts/api.md
