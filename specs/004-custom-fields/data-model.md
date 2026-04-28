# Modelo de Datos: Campos Personalizados

**Fecha**: 2026-04-15
**Funcionalidad**: 004-custom-fields
**Base**: PostgreSQL 16 (pgx v5)

## Entidades Nuevas

### CustomFieldDefinition

Esquema/configuración de un campo personalizado a nivel de cuenta.

| Campo | Tipo | Nulable | Default | Descripción |
|-------|------|---------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `account_id` | UUID | NO | — | FK → accounts(id) ON DELETE CASCADE |
| `name` | VARCHAR(255) | NO | — | Nombre visible del campo |
| `slug` | VARCHAR(255) | NO | — | Identificador estable (no cambia al renombrar) |
| `field_type` | VARCHAR(50) | NO | — | Tipo: text, number, date, select, multi_select, checkbox, email, phone, url, currency |
| `config` | JSONB | NO | `'{}'` | Configuración específica del tipo (opciones, símbolo moneda, etc.) |
| `is_required` | BOOLEAN | NO | `FALSE` | Si el campo es obligatorio (validación suave) |
| `default_value` | TEXT | SI | NULL | Valor por defecto al crear nuevos contactos |
| `sort_order` | INTEGER | NO | `0` | Orden de visualización |
| `created_at` | TIMESTAMPTZ | NO | `NOW()` | Fecha de creación |
| `updated_at` | TIMESTAMPTZ | NO | `NOW()` | Última modificación |

**Restricciones**:
- `UNIQUE(account_id, slug)` — No puede haber dos campos con el mismo slug por cuenta
- `CHECK(field_type IN ('text','number','date','select','multi_select','checkbox','email','phone','url','currency'))`
- Índice: `CREATE INDEX idx_cfd_account ON custom_field_definitions(account_id, sort_order)`

**Estructura `config` por tipo**:

```jsonc
// select, multi_select
{ "options": [{"label": "Básico", "value": "basico"}, {"label": "Intermedio", "value": "intermedio"}] }

// currency
{ "symbol": "S/.", "decimals": 2 }

// number
{ "min": 0, "max": 999999 }

// text
{ "max_length": 500 }

// email, phone, url, date, checkbox
{} // Sin config adicional necesaria
```

### CustomFieldValue

Valor almacenado de un campo personalizado para un contacto específico.

| Campo | Tipo | Nulable | Default | Descripción |
|-------|------|---------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `field_id` | UUID | NO | — | FK → custom_field_definitions(id) ON DELETE CASCADE |
| `contact_id` | UUID | NO | — | FK → contacts(id) ON DELETE CASCADE |
| `value_text` | TEXT | SI | NULL | Para: text, email, phone, url, select |
| `value_number` | NUMERIC(18,4) | SI | NULL | Para: number, currency |
| `value_date` | TIMESTAMPTZ | SI | NULL | Para: date |
| `value_bool` | BOOLEAN | SI | NULL | Para: checkbox |
| `value_json` | JSONB | SI | NULL | Para: multi_select (array de strings) |
| `created_at` | TIMESTAMPTZ | NO | `NOW()` | Fecha de creación |
| `updated_at` | TIMESTAMPTZ | NO | `NOW()` | Última modificación |

**Restricciones**:
- `UNIQUE(field_id, contact_id)` — Solo un valor por campo por contacto
- Índices para filtrado:
  - `CREATE INDEX idx_cfv_contact ON custom_field_values(contact_id)`
  - `CREATE INDEX idx_cfv_field ON custom_field_values(field_id)`
  - `CREATE INDEX idx_cfv_text ON custom_field_values(field_id, value_text) WHERE value_text IS NOT NULL`
  - `CREATE INDEX idx_cfv_number ON custom_field_values(field_id, value_number) WHERE value_number IS NOT NULL`
  - `CREATE INDEX idx_cfv_date ON custom_field_values(field_id, value_date) WHERE value_date IS NOT NULL`
  - `CREATE INDEX idx_cfv_bool ON custom_field_values(field_id, value_bool) WHERE value_bool IS NOT NULL`

**Mapeo tipo → columna**:

| Tipo de Campo | Columna de Valor | Notas |
|---------------|-----------------|-------|
| `text` | `value_text` | Texto libre |
| `number` | `value_number` | NUMERIC(18,4) |
| `date` | `value_date` | TIMESTAMPTZ |
| `select` | `value_text` | Almacena el `value` de la opción seleccionada |
| `multi_select` | `value_json` | Array JSON: `["val1", "val2"]` |
| `checkbox` | `value_bool` | `true` / `false` |
| `email` | `value_text` | Con validación de formato |
| `phone` | `value_text` | Normalizado con `NormalizePhone()` |
| `url` | `value_text` | Con validación de formato |
| `currency` | `value_number` | NUMERIC con símbolo en definición |

## Entidades Existentes Modificadas

### Contact (sin cambios de esquema)

No se agrega columna a la tabla `contacts`. Los valores se almacenan en `custom_field_values` con FK a `contacts.id`. El struct Go se extiende con un campo de relación:

```go
// Agregar al struct Contact
CustomFieldValues []*CustomFieldValue `json:"custom_field_values,omitempty"` // Populated on demand
```

### Lead (sin cambios de esquema)

El campo `custom_fields JSONB` existente permanece intacto (usado por Kommo sync). Los valores custom se muestran via el contacto asociado. No se modifica la tabla `leads`.

## Relaciones

```
accounts 1──→ N custom_field_definitions
custom_field_definitions 1──→ N custom_field_values
contacts 1──→ N custom_field_values

Un custom_field_value vincula exactamente 1 definición con 1 contacto.
Un contacto tiene máximo 1 valor por cada definición de campo.
```

## SQL de Migración (para database.go InitDB)

```sql
-- Tabla de definiciones
CREATE TABLE IF NOT EXISTS custom_field_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    field_type VARCHAR(50) NOT NULL CHECK(field_type IN ('text','number','date','select','multi_select','checkbox','email','phone','url','currency')),
    config JSONB NOT NULL DEFAULT '{}',
    is_required BOOLEAN NOT NULL DEFAULT FALSE,
    default_value TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_cfd_account ON custom_field_definitions(account_id, sort_order);

-- Tabla de valores
CREATE TABLE IF NOT EXISTS custom_field_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id UUID NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    value_text TEXT,
    value_number NUMERIC(18,4),
    value_date TIMESTAMPTZ,
    value_bool BOOLEAN,
    value_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(field_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_cfv_contact ON custom_field_values(contact_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON custom_field_values(field_id);
CREATE INDEX IF NOT EXISTS idx_cfv_text ON custom_field_values(field_id, value_text) WHERE value_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cfv_number ON custom_field_values(field_id, value_number) WHERE value_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cfv_date ON custom_field_values(field_id, value_date) WHERE value_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cfv_bool ON custom_field_values(field_id, value_bool) WHERE value_bool IS NOT NULL;
```

## Validaciones de Negocio

1. **Límite**: Máximo 50 definiciones por `account_id` (verificar COUNT antes de INSERT)
2. **Slug inmutable**: Al renombrar un campo, solo cambia `name`, nunca `slug`
3. **Tipo inmutable con valores**: No permitir UPDATE de `field_type` si existen filas en `custom_field_values` para ese `field_id`
4. **Unicidad de nombre**: Aunque la UNIQUE constraint es sobre slug, validar también que no haya dos campos con el mismo nombre (case-insensitive) por cuenta
5. **Opciones de select**: Al eliminar una opción del `config.options`, los valores existentes se preservan como texto (no se borran)
6. **Teléfono**: Valores de campos tipo `phone` se normalizan con `kommo.NormalizePhone()` antes de guardar
