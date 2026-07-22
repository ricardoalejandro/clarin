---
name: clarin-backend-development
description: Use when modifying Clarin backend Go/Fiber handlers, services, repositories, domain entities, WhatsApp logic, API routes, or backend behavior. Enforces account isolation, contact/lead/chat integrity, efficient SQL, and current verification commands.
---

# Clarin Backend Development

## Core Rules

- Read existing handlers, services, repositories, and domain structs before editing.
- Preserve `account_id` isolation on every query, mutation, repair, batch job, import, and WebSocket event.
- Use "cuenta" or "tenant" for `accounts`; do not introduce "empresa" wording unless quoting literal UI text.
- `Contact` is the parent entity. `Lead` and `Chat` are parallel children. Creating a lead or chat must ensure a same-account contact exists first.
- Deleting a lead must not delete its contact or chat. Deleting a chat must not delete its contact or lead. Contact deletion must be an explicit account-scoped transaction.
- Kommo API is dormant unless the user explicitly asks to reactivate it.
- Preserve the canonical Contact profile contract across Contactos, Leads, Chats, Eventos and Programas. Identity updates must keep compatibility projections synchronized without making snapshots a read fallback for linked rows.
- Treat `program_participants.enrolled_at` as the real, editable start of participation. Default it automatically when adding a participant, validate explicit corrections in the program/account context, and never derive it silently from attendance.
- Count participant attendance only within the inclusive participation window; return real out-of-window attendance separately as history and use language that distinguishes "no sessions in the period" from "no attendance exists".
- Keep Program participation lifecycle contextual to `program_participant_id`: current rosters exclude retired/completed rows, historical metrics preserve eligible past slots, and a normal withdrawal never hard-deletes attendance or notes.
- Keep event creation in the Eventos module; Programas is for class groups and must not grow a second partial event workflow.
- Treat survey templates as non-answerable definitions and survey instances as immutable applications. Scope Program survey recipients to both Contact and `program_participant_id`, and never mutate answered instance questions through template edits.

## Go And API Patterns

- Use context-aware pgx calls and parameterized SQL only.
- Avoid N+1 queries; batch, join, aggregate, or prefetch when lists need related data.
- Select only needed columns and paginate large lists.
- For large shared catalogs such as tags, expose bounded account-scoped search instead of returning the full catalog with every detail response. Creating global tags must still require `PermTags`.
- Add indexes for new high-cardinality filters, joins, ordering, or lookup paths.
- Keep route registration, request/response DTOs, repository methods, and domain structs consistent.
- Add WebSocket broadcasts only when the frontend needs real-time visibility of the changed data.
- Scope every WebSocket event to the owning account and, when device-specific, the owning device. Include stable entity IDs so the frontend can patch instead of refetching entire lists.
- Enforce device capabilities in handlers/services even when the frontend already hides an action. Return an explicit unsupported/disconnected response instead of attempting unsupported WhatsApp behavior.
- Preserve quoted-message identity and preview data through send, persistence, history/search hydration, and realtime payloads.
- When a PostgreSQL parameter is reused across assignments, comparisons, CASE branches, arrays, JSON, or nullable expressions, cast it explicitly to one stable type. Validate fragile SQL against PostgreSQL itself; compilation alone does not prove parameter inference.
- Keep client-facing errors safe and actionable, and log the underlying operational error without secrets or raw personal content.
- Never log secrets, tokens, cookies, raw WhatsApp session data, or imported personal rows.

## Media And Avatar Mutations

- Normalize and validate media before persistence; keep object keys account-prefixed and inventory rows account-scoped.
- Treat upload, inventory creation, entity attachment, replacement, and orphan scheduling as one failure-aware workflow. A failed attachment must not leak an untracked object or delete a still-referenced asset.
- For WhatsApp avatar refresh, require a signed/expiring preview tied to account, Contact, device, and content hash before confirmation. Never interpret a private/missing remote photo as permission to erase the current photo.

## Verification

- For backend code changes, run from `backend`:

```bash
GOCACHE=/tmp/go-build go test ./...
```

- Add `go build` or Docker build only when startup wiring, deploy packaging, CGO/build tags, or container behavior are affected.
