# Tareas: Campos Personalizados

**Entrada**: Documentos de diseño de `/specs/004-custom-fields/`
**Prerequisitos**: plan.md (requerido), spec.md (requerido), research.md, data-model.md, contracts/

**Tests**: No solicitados en la especificación. No se generan tareas de test.

**Organización**: Tareas agrupadas por historia de usuario para permitir implementación y prueba independiente.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: Puede ejecutarse en paralelo (archivos diferentes, sin dependencias)
- **[Story]**: A qué historia de usuario pertenece (US1, US2, US3, US4)
- Incluye rutas exactas de archivos en las descripciones

## Convenciones de Rutas

- **Backend**: `backend/internal/`, `backend/pkg/`
- **Frontend**: `frontend/src/`

---

## Fase 1: Setup (Infraestructura Compartida)

**Propósito**: Entidades de dominio, migración de base de datos, tipos TypeScript — cimientos que todas las historias necesitan.

- [ ] T001 Agregar structs `CustomFieldDefinition` y `CustomFieldValue` en `backend/internal/domain/entities.go`
- [ ] T002 Agregar constante `EventCustomFieldDefUpdate` en `backend/internal/ws/hub.go`
- [ ] T003 Agregar migración SQL (2 tablas + índices) en `backend/pkg/database/database.go` función `InitDB()`
- [ ] T004 [P] Crear interfaces TypeScript `CustomFieldDefinition`, `CustomFieldValue`, `CustomFieldFilter` en `frontend/src/types/custom-field.ts`
- [ ] T005 [P] Agregar campo `custom_field_values` a las interfaces `Contact` y `Lead` en `frontend/src/types/contact.ts`

**Checkpoint**: Entidades, migración y tipos base listos. Build backend y frontend deben compilar sin errores.

---

## Fase 2: Fundacional (Prerequisitos Bloqueantes)

**Propósito**: Repository y handlers HTTP que DEBEN estar completos antes de que cualquier historia de usuario pueda funcionar.

**⚠️ CRÍTICO**: Ninguna historia de usuario puede comenzar hasta que esta fase esté completa.

- [ ] T006 Crear repositorio con CRUD de definiciones (Create, GetByAccountID, GetByID, Update, Delete, Reorder, CountByAccount) en `backend/internal/repository/custom_field_repository.go`
- [ ] T007 Agregar métodos de repositorio para valores: UpsertValue, GetValuesByContact, GetValuesByContacts (batch), DeleteValue en `backend/internal/repository/custom_field_repository.go`
- [ ] T008 Crear handler HTTP con endpoints CRUD de definiciones (GET, POST, PUT, DELETE /api/custom-fields + PUT /api/custom-fields/reorder) en `backend/internal/api/custom_field_handler.go`
- [ ] T009 Agregar endpoints de valores al handler (GET/PUT /api/contacts/:contactId/custom-fields, PUT /api/contacts/:contactId/custom-fields/:fieldId) en `backend/internal/api/custom_field_handler.go`
- [ ] T010 Registrar todas las rutas de custom-fields en `setupRoutes()` en `backend/internal/api/server.go` con permisos admin para definiciones y autenticado para valores
- [ ] T011 Agregar validaciones de negocio en handlers: límite 50 campos, slug automático, nombre único case-insensitive, tipo inmutable con valores, NormalizePhone para tipo phone en `backend/internal/api/custom_field_handler.go`
- [ ] T012 Agregar broadcast WebSocket `EventCustomFieldDefUpdate` en handlers de definiciones y `EventContactUpdate` en handler de valores en `backend/internal/api/custom_field_handler.go`
- [ ] T013 Agregar cache Redis para definiciones (GET con cache, invalidación en mutaciones con `DelPattern`) en `backend/internal/api/custom_field_handler.go`

**Checkpoint**: API de campos personalizados completamente funcional. Se puede probar con curl/Postman: crear definiciones, asignar valores, verificar WebSocket.

---

## Fase 3: Historia de Usuario 1 — Configuración Admin (Prioridad: P1) 🎯 MVP

**Objetivo**: Los administradores pueden crear, editar, reordenar y eliminar definiciones de campos personalizados desde la página de Configuración.

**Prueba Independiente**: Crear, editar, reordenar y eliminar campos desde Settings. Verificar persistencia tras recarga.

### Implementación

- [ ] T014 [US1] Instalar dependencia `@dnd-kit/core` y `@dnd-kit/sortable` en `frontend/package.json`
- [ ] T015 [US1] Crear sección "Campos Personalizados" en la página de Settings con lista de campos, botón "Nuevo Campo" y estado vacío en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T016 [US1] Implementar modal/formulario de creación de campo con: input nombre, selector de tipo (10 tipos), toggle obligatorio, input valor por defecto en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T017 [US1] Implementar editor de opciones para campos tipo select/multi_select (agregar, editar, eliminar, reordenar opciones) en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T018 [US1] Implementar configuración específica por tipo: símbolo moneda (currency), max_length (text), min/max (number) en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T019 [US1] Implementar edición inline de nombre y configuración de campos existentes en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T020 [US1] Implementar drag-and-drop para reordenar campos con @dnd-kit/sortable y llamada PUT /api/custom-fields/reorder en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T021 [US1] Implementar eliminación de campo con diálogo de confirmación que advierte sobre valores asociados en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T022 [US1] Agregar listener WebSocket para `custom_field_def_update` que refresca la lista de definiciones en tiempo real en `frontend/src/app/dashboard/settings/page.tsx`
- [ ] T023 [US1] Agregar validaciones frontend: nombre obligatorio, nombre duplicado, límite 50 campos, opciones requeridas para select/multi_select en `frontend/src/app/dashboard/settings/page.tsx`

**Checkpoint**: Administradores pueden gestionar campos completos desde Settings. MVP funcional.

---

## Fase 4: Historia de Usuario 2 — Valores en Panel de Detalle (Prioridad: P2)

**Objetivo**: Los usuarios ven y editan valores de campos personalizados inline en el panel lateral de detalle de un lead/contacto.

**Prueba Independiente**: Abrir un lead, ver campos personalizados, editar valores de diversos tipos, verificar guardado.

### Implementación

- [ ] T024 [P] [US2] Crear componente `CustomFieldInput` con renderizado y edición por tipo de campo (text, number, date, select, multi_select, checkbox, email, phone, url, currency) en `frontend/src/components/CustomFieldInput.tsx`
- [ ] T025 [US2] Implementar modo de visualización en `CustomFieldInput`: formateado de moneda con símbolo y separadores, fecha localizada, checkbox como toggle visual, multi_select como badges, email/phone/url como enlaces clickeables en `frontend/src/components/CustomFieldInput.tsx`
- [ ] T026 [US2] Implementar modo de edición en `CustomFieldInput`: input texto, input numérico, date picker nativo, dropdown select, checkboxes multi_select, toggle checkbox, validación por tipo en `frontend/src/components/CustomFieldInput.tsx`
- [ ] T027 [US2] Implementar validación frontend por tipo: formato email, formato URL, normalización teléfono, rango numérico, opciones válidas para select en `frontend/src/components/CustomFieldInput.tsx`
- [ ] T028 [US2] Agregar sección "Campos Personalizados" en `LeadDetailPanel` debajo de campos estándar: carga de definiciones, carga de valores del contacto, renderizado de cada campo con `CustomFieldInput` en `frontend/src/components/LeadDetailPanel.tsx`
- [ ] T029 [US2] Implementar guardado inline (blur/Enter) que llama PUT /api/contacts/:contactId/custom-fields/:fieldId y actualiza estado local en `frontend/src/components/LeadDetailPanel.tsx`
- [ ] T030 [US2] Implementar aviso "Vincule un contacto para ver campos personalizados" cuando el lead no tiene contact_id en `frontend/src/components/LeadDetailPanel.tsx`
- [ ] T031 [US2] Implementar indicador visual de campo obligatorio sin valor (borde emerald punteado, texto suave "Requerido") en `frontend/src/components/CustomFieldInput.tsx`

**Checkpoint**: Usuarios pueden ver y editar todos los tipos de campos personalizados desde el panel de detalle.

---

## Fase 5: Historia de Usuario 3 — Columnas en Tablas (Prioridad: P3)

**Objetivo**: Los usuarios configuran qué campos personalizados aparecen como columnas en las tablas de contactos y leads.

**Prueba Independiente**: Agregar columnas personalizadas en tabla de contactos, verificar valores formateados, ocultar/mostrar columnas, verificar persistencia.

### Implementación

- [ ] T032 [US3] Agregar query param `include_custom_fields=true` al endpoint GET /api/contacts para incluir valores de campos en la respuesta y modificar query SQL con LEFT JOIN a custom_field_values en `backend/internal/api/server.go` y `backend/internal/repository/repository.go`
- [ ] T033 [US3] Crear componente selector de columnas (dropdown con checkboxes de campos disponibles) con persistencia en localStorage clave `cf_columns_{accountId}_contacts` en `frontend/src/app/dashboard/contacts/page.tsx`
- [ ] T034 [US3] Implementar renderizado de columnas dinámicas en tabla de contactos: headers y celdas con valores formateados según tipo en `frontend/src/app/dashboard/contacts/page.tsx`
- [ ] T035 [US3] Agregar query param `include_custom_fields=true` al endpoint GET /api/leads para incluir valores de campos del contacto asociado en la respuesta en `backend/internal/api/server.go` y `backend/internal/repository/repository.go`
- [ ] T036 [US3] Implementar columnas dinámicas y selector en la vista de lista de leads con persistencia localStorage `cf_columns_{accountId}_leads` en `frontend/src/app/dashboard/leads/page.tsx`
- [ ] T037 [US3] Agregar listener WebSocket `custom_field_def_update` en las páginas de contactos y leads para sincronizar columnas disponibles cuando se crean/eliminan campos en `frontend/src/app/dashboard/contacts/page.tsx` y `frontend/src/app/dashboard/leads/page.tsx`

**Checkpoint**: Tablas de contactos y leads muestran columnas personalizadas formateadas. Preferencias persisten.

---

## Fase 6: Historia de Usuario 4 — Filtrado por Campos Personalizados (Prioridad: P4)

**Objetivo**: Los usuarios filtran contactos y leads por valores de campos personalizados con operadores sensibles al tipo.

**Prueba Independiente**: Aplicar filtros por distintos tipos de campos y verificar que los resultados coinciden con los criterios.

### Implementación

- [X] T038 [US4] Agregar método de repositorio `BuildCustomFieldFilterSQL` que genera cláusulas WHERE con JOINs a custom_field_values, operadores por tipo (eq, neq, gt, lt, between, contains, starts_with, in, contains_any, contains_all) y parámetros numerados en `backend/internal/repository/custom_field_repository.go`
- [X] T039 [US4] Integrar `BuildCustomFieldFilterSQL` en las queries existentes de `GetByAccountIDWithFilters` de contactos y `GetLeadsPaginated` de leads, parseando query param `cf_filter` JSON en `backend/internal/repository/repository.go` y `backend/internal/api/server.go`
- [X] T040 [US4] Crear componente de filtro por campo personalizado: selector de campo, selector de operador (filtrado por tipo), input de valor (reutilizando controles de CustomFieldInput) en `frontend/src/app/dashboard/contacts/page.tsx`
- [X] T041 [US4] Implementar UI de filtros múltiples: agregar/quitar filtros, combinar con AND lógico, serializar a query param `cf_filter` JSON en `frontend/src/app/dashboard/contacts/page.tsx`
- [X] T042 [US4] Replicar componente de filtro por campos personalizados en la página de leads (vista lista) en `frontend/src/app/dashboard/leads/page.tsx`

**Checkpoint**: Filtrado funcional por todos los tipos de campos con operadores específicos. Resultados correctos.

---

## Fase 7: Pulido y Aspectos Transversales

**Propósito**: Mejoras que afectan múltiples historias de usuario.

- [X] T043 [P] Verificar build backend completo: `docker compose build backend` sin errores
- [X] T044 [P] Verificar build frontend completo: `docker compose build frontend` sin errores
- [X] T045 Desplegar con `docker compose up -d` y verificar logs limpios de backend y frontend con `docker compose logs --tail=30 backend frontend`
- [X] T046 Validar flujo completo end-to-end: crear campo en Settings → asignar valor en LeadDetailPanel → ver columna en tabla de contactos → filtrar por valor → verificar WebSocket actualiza en tiempo real

---

## Dependencias y Orden de Ejecución

### Dependencias entre Fases

- **Setup (Fase 1)**: Sin dependencias — puede comenzar inmediatamente
- **Fundacional (Fase 2)**: Depende de Setup — BLOQUEA todas las historias de usuario
- **US1 - Config Admin (Fase 3)**: Depende de Fundacional. Sin dependencias de otras historias.
- **US2 - Panel Detalle (Fase 4)**: Depende de Fundacional. Puede paralelizarse con US1.
- **US3 - Columnas (Fase 5)**: Depende de Fundacional. Requiere T032/T035 (backend). Puede paralelizarse con US1/US2.
- **US4 - Filtrado (Fase 6)**: Depende de Fundacional (T006/T007 para repositorio). Puede paralelizarse con US1/US2/US3.
- **Pulido (Fase 7)**: Depende de que todas las historias estén completas.

### Dependencias entre Historias de Usuario

- **US1 (P1)**: Independiente tras Fundacional — no requiere otras historias
- **US2 (P2)**: Independiente tras Fundacional — necesita definiciones existentes (creadas via API, no requiere UI de US1)
- **US3 (P3)**: Independiente tras Fundacional — necesita valores existentes (creados via API, no requiere UI de US2)
- **US4 (P4)**: Independiente tras Fundacional — usa el repositorio de valores directamente

### Dentro de Cada Historia

- Modelos antes que servicios
- Backend antes que frontend (APIs disponibles para consumir)
- Componentes base antes de integración
- Historia completa antes de pasar a la siguiente prioridad

### Oportunidades de Paralelismo

- T004 y T005 pueden ejecutarse en paralelo (archivos diferentes)
- T024 (CustomFieldInput) puede ejecutarse en paralelo con T015-T023 (Settings)
- T032/T035 (backend de columnas) pueden ejecutarse en paralelo con frontend de otras historias
- T038/T039 (backend de filtrado) pueden ejecutarse en paralelo con frontend de otras historias

---

## Ejemplo de Paralelismo: Historia de Usuario 2

```bash
# Lanzar en paralelo (archivos diferentes):
Tarea: T024 "Crear componente CustomFieldInput" en frontend/src/components/CustomFieldInput.tsx
Tarea: T028 "Agregar sección campos personalizados en LeadDetailPanel" en frontend/src/components/LeadDetailPanel.tsx
# (T028 puede empezar la estructura mientras T024 implementa el componente)

# Secuencial (mismo archivo, dependencias):
T024 → T025 → T026 → T027 (evolución del componente CustomFieldInput)
T028 → T029 → T030 → T031 (evolución de la sección en LeadDetailPanel)
```

---

## Estrategia de Implementación

### MVP Primero (Solo Historia de Usuario 1)

1. Completar Fase 1: Setup
2. Completar Fase 2: Fundacional (CRÍTICO — bloquea todo)
3. Completar Fase 3: US1 — Config Admin
4. **PARAR Y VALIDAR**: Probar creación/edición/reorden/eliminación de campos
5. Deploy y verificar en producción

### Entrega Incremental

1. Setup + Fundacional → Base lista
2. Agregar US1 → Probar → Deploy (¡MVP!)
3. Agregar US2 → Probar → Deploy (panel de detalle)
4. Agregar US3 → Probar → Deploy (columnas en tablas)
5. Agregar US4 → Probar → Deploy (filtrado)
6. Cada historia agrega valor sin romper las anteriores

---

## Notas

- Las tareas [P] tienen archivos diferentes y sin dependencias → pueden paralelizarse
- La etiqueta [Story] mapea cada tarea a su historia de usuario
- Cada historia es completable y testeable independientemente
- Commit después de cada tarea o grupo lógico
- Parar en cada checkpoint para validar la historia de forma independiente
- **Builds solo via Docker** — nunca `go build` local
- **SQL siempre parametrizado** — nunca concatenar strings en queries
