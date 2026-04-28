# Quickstart: Campos Personalizados

## Contexto Rápido

Campos personalizados para Clarin CRM. Permite a administradores definir campos a nivel de cuenta y a todos los usuarios asignar valores por contacto. 10 tipos de campo, almacenamiento multi-columna, filtrado SQL nativo.

## Archivos Relevantes (Existentes)

| Archivo | Qué tiene |
|---------|-----------|
| `backend/internal/domain/entities.go` | Structs Contact (L147), Lead (L397) |
| `backend/pkg/database/database.go` | Migraciones en InitDB() |
| `backend/internal/repository/repository.go` | Queries de contactos y leads |
| `backend/internal/api/server.go` | Handlers HTTP y setupRoutes() |
| `backend/internal/ws/hub.go` | Eventos WebSocket |
| `frontend/src/components/LeadDetailPanel.tsx` | Panel inline-edit de lead/contacto |
| `frontend/src/app/dashboard/settings/page.tsx` | Página de configuración |
| `frontend/src/app/dashboard/contacts/page.tsx` | Tabla de contactos |
| `frontend/src/types/contact.ts` | Interfaces TypeScript Lead, Contact |

## Archivos Nuevos a Crear

| Archivo | Propósito |
|---------|-----------|
| `backend/internal/repository/custom_field_repository.go` | CRUD definiciones + UPSERT valores + queries filtrado |
| `backend/internal/api/custom_field_handler.go` | Handlers HTTP para definiciones y valores |
| `frontend/src/components/CustomFieldInput.tsx` | Componente renderizador/editor por tipo de campo |
| `frontend/src/types/custom-field.ts` | Interfaces TypeScript |

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `backend/internal/domain/entities.go` | Agregar structs CustomFieldDefinition, CustomFieldValue. Campo relación en Contact |
| `backend/pkg/database/database.go` | Migración: 2 tablas + índices |
| `backend/internal/api/server.go` | Registrar rutas custom-fields en setupRoutes() |
| `backend/internal/ws/hub.go` | Agregar constante EventCustomFieldDefUpdate |
| `frontend/src/components/LeadDetailPanel.tsx` | Renderizar campos personalizados debajo de campos estándar |
| `frontend/src/app/dashboard/settings/page.tsx` | Agregar sección/tab de gestión de campos |
| `frontend/src/app/dashboard/contacts/page.tsx` | Columnas dinámicas + selector de columnas |
| `frontend/src/types/contact.ts` | Agregar custom_field_values a Contact y Lead |

## Comandos de Verificación

```bash
# Backend
docker compose build backend
docker compose up -d
docker compose logs --tail=30 backend

# Frontend
docker compose build frontend
docker compose up -d
docker compose logs --tail=30 frontend
```

## Decisiones de Diseño Clave

1. **Valores en Contact, no Lead** — Contact es fuente de verdad
2. **Multi-columna** — value_text, value_number, value_date, value_bool, value_json (para SQL nativo)
3. **Admin gestiona definiciones** — Todos asignan valores
4. **Leads sin contacto** — No muestran campos personalizados (aviso "vincule un contacto")
5. **Slug inmutable** — Se genera al crear, no cambia al renombrar
6. **Máximo 50 campos por cuenta**
7. **Evento WS nuevo** — `custom_field_def_update` para definiciones, reutilizar `contact_update` para valores
