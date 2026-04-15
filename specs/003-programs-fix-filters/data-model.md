# Data Model: 003-programs-fix-filters

**Date**: 2026-04-15

## Schema Changes

**None required.** This feature modifies only frontend behavior. All backend endpoints and database schema already support the required operations.

## Existing Entities Used

### Program
- No changes. DELETE, PUT endpoints already exist and work.

### Contact
- No changes. `/api/contacts` already supports all advanced filter parameters.

### Tag
- No changes. Tag filtering (include/exclude, AND/OR, formula) already implemented in `/api/contacts`.

### ProgramParticipant
- No changes. DELETE endpoint already exists and works.

## State Changes (Frontend Only)

### Programs Detail Page — New State
| State | Type | Purpose |
|-------|------|---------|
| `toastMessage` | `string \| null` | Toast message text |
| `toastType` | `'success' \| 'error'` | Toast visual variant |
| `confirmAction` | `{ message: string, onConfirm: () => void } \| null` | Confirmation dialog state |

### ContactSelector — New Props
| Prop | Type | Default | Purpose |
|------|------|---------|---------|
| `advancedFilters` | `boolean` | `false` | Enable advanced filter panel |

### ContactSelector — New State (when advancedFilters=true)
| State | Type | Purpose |
|-------|------|---------|
| `filterTagNames` | `Set<string>` | Tags to include |
| `excludeFilterTagNames` | `Set<string>` | Tags to exclude |
| `tagFilterMode` | `'OR' \| 'AND'` | Tag combination logic |
| `formulaType` | `'simple' \| 'advanced'` | Simple tags vs formula editor |
| `formulaText` | `string` | Formula editor content |
| `filterDevice` | `string` | Device ID filter |
| `filterDateField` | `'created_at' \| 'updated_at'` | Date field to filter |
| `filterDatePreset` | `string` | Date preset key |
| `filterDateFrom` | `string` | Custom date start |
| `filterDateTo` | `string` | Custom date end |
| `devices` | `Device[]` | Available devices for filter dropdown |
