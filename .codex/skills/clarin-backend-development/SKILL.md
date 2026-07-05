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

## Go And API Patterns

- Use context-aware pgx calls and parameterized SQL only.
- Avoid N+1 queries; batch, join, aggregate, or prefetch when lists need related data.
- Select only needed columns and paginate large lists.
- Add indexes for new high-cardinality filters, joins, ordering, or lookup paths.
- Keep route registration, request/response DTOs, repository methods, and domain structs consistent.
- Add WebSocket broadcasts only when the frontend needs real-time visibility of the changed data.
- Never log secrets, tokens, cookies, raw WhatsApp session data, or imported personal rows.

## Verification

- For backend code changes, run from `backend`:

```bash
GOCACHE=/tmp/go-build go test ./...
```

- Add `go build` or Docker build only when startup wiring, deploy packaging, CGO/build tags, or container behavior are affected.
