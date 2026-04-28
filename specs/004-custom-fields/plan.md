# Plan de Implementación: Campos Personalizados

**Rama**: `004-custom-fields` | **Fecha**: 2026-04-15 | **Spec**: [spec.md](spec.md)
**Entrada**: Especificación de funcionalidad de `/specs/004-custom-fields/spec.md`

## Resumen

Sistema de campos personalizados que permite a administradores definir campos tipados a nivel de cuenta (10 tipos: text, number, date, select, multi_select, checkbox, email, phone, url, currency) y a todos los usuarios asignar valores por contacto. Arquitectura: dos tablas nuevas (`custom_field_definitions` + `custom_field_values`) con almacenamiento multi-columna para filtrado SQL nativo. UI: configuración en Settings, edición inline en LeadDetailPanel, columnas dinámicas en tablas, y filtrado por tipo.

## Contexto Técnico

**Lenguaje/Versión**: Go 1.24 (backend), TypeScript 5.4 (frontend)
**Dependencias Principales**: Fiber v2.52, pgx v5, Next.js 14, React 18, Tailwind CSS 3.4, @dnd-kit/core (nuevo)
**Almacenamiento**: PostgreSQL 16 (2 tablas nuevas), Redis 7 (cache de definiciones)
**Testing**: Verificación via Docker build + logs (sin framework de test unitario configurado)
**Plataforma**: Linux server (Docker Compose), navegador web
**Tipo de Proyecto**: Aplicación web (backend API + frontend SPA)
**Objetivos de Rendimiento**: Filtrado <2s con 100K contactos, tabla sin degradación con 1K registros
**Restricciones**: Máximo 50 campos por cuenta, builds solo via Docker, SQL parametrizado obligatorio
**Escala**: ~10K contactos típico, hasta 100K máximo

## Verificación de Constitución

*GATE: Debe cumplirse antes de la investigación (Fase 0). Re-verificar después del diseño (Fase 1).*

| Principio | Estado | Evidencia |
|-----------|--------|-----------|
| I. Builds Solo por Docker | ✅ CUMPLE | Verificación con `docker compose build backend/frontend`. Sin `go build` local. |
| II. SQL Siempre Parametrizado | ✅ CUMPLE | Todas las queries usan `$1, $2...` (pgx). Filtrado dinámico usa `fmt.Sprintf("$%d", argNum)` — mismo patrón que `ContactFilter`. |
| III. Tailwind Emerald/Slate | ✅ CUMPLE | Toda la UI usa emerald-500/600 para interactivos, slate-700/800 para contenedores. Sin CSS custom. |
| IV. WebSocket en Tiempo Real | ✅ CUMPLE | Nuevo evento `custom_field_def_update` para definiciones. Reutiliza `contact_update` para valores. |
| V. Normalización de Teléfono | ✅ CUMPLE | Campos tipo `phone` se normalizan con `kommo.NormalizePhone()` al guardar. |
| VI. Invalidación de Cache Redis | ✅ CUMPLE | Cache de definiciones invalidado con `DelPattern("custom_fields:*:{accountID}")` en mutaciones. |
| VII. Cambios Mínimos y Enfocados | ✅ CUMPLE | Solo archivos necesarios modificados. Archivos nuevos siguen convención de módulo (`custom_field_handler.go`, `custom_field_repository.go`). |

### Re-verificación Post-Diseño (Fase 1)

| Principio | Estado | Nota |
|-----------|--------|------|
| I. Builds Solo por Docker | ✅ | Sin cambios |
| II. SQL Parametrizado | ✅ | Queries de filtrado dinámico usan argNum incremental, nunca concatenación. Columnas de ORDER BY en whitelist. |
| III. Tailwind Emerald/Slate | ✅ | CustomFieldInput y sección Settings usan paleta establecida |
| IV. WebSocket | ✅ | `EventCustomFieldDefUpdate` definido en hub.go |
| V. Normalización Teléfono | ✅ | Campo `phone` normalizado en handler antes de guardar en `value_text` |
| VI. Cache Redis | ✅ | `DelPattern("custom_fields:defs:{accountID}")` al crear/editar/eliminar/reordenar definiciones |
| VII. Cambios Mínimos | ✅ | 4 archivos nuevos, 8 archivos modificados. Sin refactorización no solicitada. |

## Estructura del Proyecto

### Documentación (esta funcionalidad)

```text
specs/004-custom-fields/
├── plan.md              # Este archivo
├── research.md          # Fase 0: Investigación y decisiones
├── data-model.md        # Fase 1: Modelo de datos
├── quickstart.md        # Fase 1: Guía rápida
├── contracts/
│   ├── definitions-api.md  # Contrato API definiciones
│   ├── values-api.md       # Contrato API valores
│   └── websocket-events.md # Contrato eventos WebSocket
└── tasks.md             # Fase 2: Tareas (/speckit.tasks)
```

### Código Fuente

```text
backend/
├── internal/
│   ├── domain/
│   │   └── entities.go                    # +2 structs: CustomFieldDefinition, CustomFieldValue
│   ├── repository/
│   │   ├── repository.go                  # Sin cambios
│   │   └── custom_field_repository.go     # NUEVO: CRUD defs + UPSERT vals + filtrado
│   ├── api/
│   │   ├── server.go                      # +rutas en setupRoutes(), +include_custom_fields en contacts/leads
│   │   └── custom_field_handler.go        # NUEVO: Handlers HTTP para defs y vals
│   └── ws/
│       └── hub.go                         # +EventCustomFieldDefUpdate constante
├── pkg/
│   └── database/
│       └── database.go                    # +migración: 2 tablas + índices

frontend/
├── src/
│   ├── types/
│   │   ├── contact.ts                     # +custom_field_values en Contact y Lead
│   │   └── custom-field.ts               # NUEVO: interfaces CustomFieldDefinition, CustomFieldValue
│   ├── components/
│   │   ├── LeadDetailPanel.tsx            # +sección campos personalizados
│   │   └── CustomFieldInput.tsx           # NUEVO: editor/renderizador por tipo
│   └── app/dashboard/
│       ├── settings/page.tsx              # +tab/sección gestión de campos
│       └── contacts/page.tsx              # +columnas dinámicas + selector
```

**Decisión de Estructura**: Aplicación web existente con backend Go y frontend Next.js. Archivos nuevos siguen la convención de módulo del proyecto (`custom_field_*.go`). Tipos TypeScript compartidos en `src/types/`. Componente reutilizable `CustomFieldInput` en `src/components/`.

## Seguimiento de Complejidad

> Sin violaciones de Constitución que justificar. Todos los principios se cumplen.
