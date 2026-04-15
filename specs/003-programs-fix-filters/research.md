# Research: 003-programs-fix-filters

**Date**: 2026-04-15
**Spec**: [spec.md](./spec.md)

## R1: Root Cause — Delete/Edit Not Working

**Decision:** The handlers exist and the backend endpoints work correctly. The issues are:

1. `handleDeleteProgram` doesn't check `res.success` before calling `router.push()`. If the API call fails (network, permission, 500), it still navigates away. Combined with browsers that may suppress `confirm()`, this creates a "nothing happens" experience.
2. `handleArchiveProgram` doesn't check `res.success` before refreshing UI.
3. All error handlers only use `console.error()` — zero user-visible feedback.
4. `handleUpdateProgram` is correctly coded (checks `res.success`), but its errors are also silent.

**Rationale:** Subagent verified all 5 backend endpoints (DELETE program, PUT program, DELETE participant, PUT session, DELETE session) — all work, return correct status codes, use parametrized SQL, and have proper permission checks.

**Alternatives Considered:**
- Backend bug: Eliminated — endpoints verified working with correct SQL and error handling.
- CORS issue: Eliminated — DELETE/PUT explicitly allowed in Fiber config.
- Permission issue: Eliminated — `PermPrograms` middleware is applied correctly.

## R2: Toast/Feedback System

**Decision:** Create a simple inline toast state within the Programs detail page (`toastMessage`, `toastType`). Auto-dismiss after 3 seconds. No global toast system.

**Rationale:** Constitution VII (Cambios Mínimos) — only Programs page needs it now. A global toast system would be useful but is out of scope.

**Alternatives Considered:**
- Global toast provider: More scalable but violates minimal change principle.
- Native `alert()`: Works but is blocking and inconsistent with modern UI.
- Third-party library (react-hot-toast): Adds dependency for one feature.

## R3: API Endpoint for Advanced Filters

**Decision:** Switch ContactSelector to use `/api/contacts` when `sourceFilter="contact"` is set. Keep `/api/people/search` for mixed contact+lead scenarios.

**Rationale:** `/api/contacts` already supports ALL the filters we need: `tag_names`, `exclude_tag_names`, `tag_mode` (AND/OR), `tag_formula`, `date_field`/`date_from`/`date_to`, and `device_id`. Adding these to `/api/people/search` would duplicate logic. Since Programs only needs contacts (never leads), using `/api/contacts` is correct.

**Alternatives Considered:**
- Enhance `/api/people/search`: Would require duplicating 200+ lines of SQL filtering logic already in `handleGetContacts`.
- New endpoint: Unnecessary when `/api/contacts` does exactly what we need.

**API Permission Note:** `/api/contacts` requires `PermContacts`. Programs page already operates within authenticated context, and any user managing programs should have contact permissions.

## R4: ContactSelector Architecture Change

**Decision:** Add `advancedFilters?: boolean` prop to ContactSelector. When `true` AND `sourceFilter="contact"`:
- Switch from `/api/people/search` to `/api/contacts`
- Map Contact response → PersonResult format for compatibility
- Render 2-column advanced filter panel (copied from Contacts page patterns)
- Add: tag include/exclude cycle, AND/OR toggle, FormulaEditor, date presets, device filter

**Rationale:** Backward-compatible. Existing callers (broadcasts, ChatPanel, events) don't pass `advancedFilters` and keep current behavior unchanged.

**Response mapping** (Contact → PersonResult):
```
id → id
COALESCE(custom_name, name, push_name, phone) → name
phone → phone
email → email
'contact' → source_type
structured_tags → tags (map {id, name, color})
```

## R5: Confirmation Modals

**Decision:** Replace `confirm()` with inline confirmation state in the same page. When delete is triggered, show a confirmation bar/modal with "¿Seguro?" + Confirm/Cancel buttons.

**Rationale:** `confirm()` can be blocked by browsers and is inconsistent with the app's visual language. An inline state is simpler than a full modal component.

**Alternatives Considered:**
- Keep `confirm()`: Unreliable in modern browsers.
- Shared ConfirmModal component: More reusable but violates minimal change (only Programs page needs it).
