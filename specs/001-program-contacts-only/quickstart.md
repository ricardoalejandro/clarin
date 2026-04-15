# Quickstart: Participantes de Programa Solo Contactos

## Contexto

Los programas son actividades post-venta. Solo las personas que ya son contactos de WhatsApp
(con comunicación directa establecida) pueden ser participantes. Los leads (prospectos
comerciales) no deben ser seleccionables.

## Archivos a Modificar

| # | Archivo | Cambio |
|---|---------|--------|
| 1 | `frontend/src/components/ContactSelector.tsx` | Añadir prop `sourceFilter`. Cuando se pasa, forzar `sourceType` y ocultar filtro de tipo. |
| 2 | `frontend/src/app/dashboard/programs/[id]/page.tsx` | Pasar `sourceFilter="contact"` al `ContactSelector`. Simplificar `handleAddParticipants` para enviar solo `contact_id`. |
| 3 | `backend/internal/api/program_handler.go` | Simplificar `handleAddParticipant`: requerir `contact_id`, eliminar lógica de resolución de leads (~60 líneas). |

## Archivos que NO Cambian

- `domain/entities.go` — `ProgramParticipant` mantiene campo `LeadID` para compatibilidad
- `program_repository.go` — INSERT con `lead_id` puede recibir NULL, sin cambios
- `program_service.go` — pass-through, sin lógica de resolución
- `server.go` (`handleSearchPeople`) — ya soporta `type=contact`, sin cambios
- Base de datos — sin migraciones

## Orden de Implementación

1. **Backend primero** (handler) → compilar y verificar
2. **Frontend después** (ContactSelector + programa page) → compilar y verificar
3. **Deploy** → verificar logs de ambos servicios

## Verificación

- Abrir un programa → Agregar Participantes → confirmar solo contactos visibles
- Confirmar que el filtro de tipo no aparece
- `curl -X POST /api/programs/UUID/participants -d '{"lead_id":"xxx"}'` → debe dar 400
- Otros usos de ContactSelector (campañas) → confirmar que siguen mostrando leads y contactos
