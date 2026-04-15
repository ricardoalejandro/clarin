# Modelo de Datos: Participantes de Programa Solo Contactos

**Feature**: 001-program-contacts-only
**Fecha**: 2026-04-14

## Entidades Afectadas

### ProgramParticipant (sin cambios de esquema)

| Campo | Tipo | Nullable | Descripción |
|-------|------|----------|-------------|
| id | UUID | No | PK, gen_random_uuid() |
| program_id | UUID | No | FK → programs(id) CASCADE |
| contact_id | UUID | No | FK → contacts(id) CASCADE |
| lead_id | UUID | Sí | FK → leads(id) SET NULL — se mantiene para datos históricos |
| status | VARCHAR(50) | No | 'enrolled', 'active', 'dropped', 'completed' |
| enrolled_at | TIMESTAMPTZ | No | DEFAULT NOW() |

**Constraint**: UNIQUE(program_id, contact_id)

**Cambio de comportamiento**: El campo `lead_id` ya no se asigna en nuevas inserciones. Los registros existentes que tengan `lead_id` no se modifican.

### Contact (sin cambios)

Usado por referencia. Solo contactos WhatsApp (con JID) son seleccionables.

### Lead (sin cambios)

Ya no participa en el flujo de adición de participantes a programas.

## Relaciones

```text
Program 1───N ProgramParticipant N───1 Contact
                                      │
                                      └──(opcional)── Lead (solo referencia histórica)
```

## Migración Requerida

Ninguna. No hay cambios de esquema. Solo cambios de comportamiento en código.
