# API Contracts: 003-programs-fix-filters

**Date**: 2026-04-15

## No Backend Changes Required

All endpoints already exist and work correctly. This document records the **existing contracts** that the frontend will use.

---

## Existing Endpoints (No Changes)

### DELETE /api/programs/:id
- **Auth**: Bearer JWT + PermPrograms
- **Response**: 204 No Content
- **Frontend fix**: Must check `res.success` before navigating

### PUT /api/programs/:id
- **Auth**: Bearer JWT + PermPrograms
- **Body**: `{ name, description, status, color, schedule_start_date, schedule_end_date, schedule_days, schedule_start_time, schedule_end_time }`
- **Response**: 200 + updated program JSON
- **Frontend fix**: Already works, but needs error toast

### DELETE /api/programs/:id/participants/:participantId
- **Auth**: Bearer JWT + PermPrograms
- **Response**: 204 No Content
- **Frontend fix**: Must check `res.success`, add toast

### DELETE /api/programs/:id/sessions/:sessionId
- **Auth**: Bearer JWT + PermPrograms
- **Response**: 204 No Content
- **Frontend fix**: Must check `res.success`, add toast

### PUT /api/programs/:id/sessions/:sessionId
- **Auth**: Bearer JWT + PermPrograms
- **Body**: `{ date, topic, start_time, end_time, location }`
- **Response**: 200 + updated session JSON
- **Frontend fix**: Needs error toast

---

## Endpoint for Advanced Filters (Existing, New Usage)

### GET /api/contacts
- **Auth**: Bearer JWT + PermContacts
- **Params used by ContactSelector** (when `advancedFilters=true`):
  - `search` — text search
  - `tag_names` — comma-separated tag names to include
  - `exclude_tag_names` — comma-separated tag names to exclude
  - `tag_mode` — `OR` | `AND`
  - `tag_formula` — advanced formula string
  - `date_field` — `created_at` | `updated_at`
  - `date_from` — ISO date string
  - `date_to` — ISO date string
  - `device_id` — UUID of device
  - `has_phone` — boolean
  - `limit` — default 100
  - `offset` — default 0
- **Response**: `{ success, contacts: Contact[], total, limit, offset }`

### Response Mapping (Contact → PersonResult)

ContactSelector expects `PersonResult` format. The mapping:

```
Contact.id                                           → PersonResult.id
Contact.custom_name || Contact.name || Contact.push_name || Contact.phone
                                                     → PersonResult.name
Contact.phone                                        → PersonResult.phone
Contact.email                                        → PersonResult.email
'contact'                                            → PersonResult.source_type
Contact.structured_tags.map(t => ({id, name, color})) → PersonResult.tags
```

---

## Component Contract: ContactSelector Props

### Current Props (unchanged)
```typescript
interface ContactSelectorProps {
  open: boolean
  onClose: () => void
  onConfirm: (selected: SelectedPerson[]) => void
  title?: string
  subtitle?: string
  confirmLabel?: string
  excludeIds?: Set<string>
  sourceFilter?: 'contact' | 'lead'
}
```

### New Prop
```typescript
interface ContactSelectorProps {
  // ... existing props
  advancedFilters?: boolean  // NEW: enable 2-column advanced filter panel
}
```

When `advancedFilters=true` AND `sourceFilter="contact"`:
- Fetch data from `/api/contacts` instead of `/api/people/search`
- Render 2-column filter panel matching Contacts page layout
- Add tag include/exclude, AND/OR toggle, FormulaEditor, date presets, device filter
