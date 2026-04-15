# Quickstart: 003-programs-fix-filters

## 3 Key Changes

### 1. Fix Delete/Edit + Add Feedback (Programs Detail Page)
**File**: `frontend/src/app/dashboard/programs/[id]/page.tsx`

- Replace `confirm()` with inline confirmation dialog state
- Add `res.success` checks to `handleDeleteProgram`, `handleArchiveProgram`
- Add toast state (`toastMessage`, `toastType`) and render auto-dismissing toast
- Add toast calls to all 6 CRUD handlers (create session, update program, delete program, archive, remove participant, delete session)

### 2. Add Advanced Filters to ContactSelector
**File**: `frontend/src/components/ContactSelector.tsx`

- Add `advancedFilters?: boolean` prop
- When `advancedFilters=true` + `sourceFilter="contact"`: switch to `/api/contacts` endpoint
- Render 2-column filter panel: left (device, date presets), right (tags include/exclude, AND/OR, formula editor)
- Map Contact response → PersonResult format
- Import and use FormulaEditor component for advanced mode

### 3. Wire Advanced Filters in Programs Page
**File**: `frontend/src/app/dashboard/programs/[id]/page.tsx`

- Pass `advancedFilters` prop to ContactSelector:
  ```tsx
  <ContactSelector
    sourceFilter="contact"
    advancedFilters={true}
    ...
  />
  ```

## No Backend Changes
All endpoints already exist and support the needed filters.

## Verification
1. Open program → ⋮ → "Eliminar" → confirmation dialog → confirm → redirected, program gone
2. Open program → ✏️ → edit name → save → name updated, toast shown
3. Open program → "Agregar Participantes" → 2-column filter panel → apply filters → select contacts → confirm
