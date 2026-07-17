---
name: clarin-quality-assurance
description: Use before finalizing Clarin changes, when selecting verification commands, reviewing risk, deploying requested changes, or checking backend/frontend/database/MCP/storage changes for completeness.
---

# Clarin Quality Assurance

## Default Checks

- Read the diff and ensure the change is focused on the user's request.
- Check for stale names, legacy product claims, wrong account vocabulary, and leaked secrets.
- Do not claim a command passed unless it actually ran in this session.
- If a verification command cannot run, report the exact reason and the residual risk.

## Commands

Backend:

```bash
cd backend
GOCACHE=/tmp/go-build go test ./...
```

Frontend:

```bash
cd frontend
npx tsc --noEmit
npm run build
```

General:

```bash
git diff --check
```

## When To Broaden Verification

- MCP/security changes: review authentication, authorization, account scoping, audit logging, credential rotation, and session revocation.
- Database changes: verify migration idempotency and repository scans.
- Storage cleanup: dry-run first, then count objects/bytes after cleanup.
- WhatsApp changes: verify device state and WebSocket behavior when runtime checks are available.
- UI state changes: manually reason through fast switching/race cases, especially lead/contact/chat panels.

## Chat And WhatsApp Regression Matrix

- Exercise chat list updates with rapid outgoing messages, incoming messages, duplicate events, active filters, selection mode, and preserved scroll. No populated list may flash skeletons.
- Exercise Details with no Contact, zero/one/many opportunities, many tags, long commercial fields, integrated/drawer/mobile modes, and ensure the final action remains reachable with one parent scroll.
- Exercise widths 320, 375, 768, 1024, 1280, and 1440 px plus browser zoom 80–150%, sidebar/Eros open and closed. Decide integrated versus drawer from actual available width.
- Exercise portaled menus near every viewport edge using mouse, touch, keyboard, Escape, resize, and outside scroll.
- Exercise replies after immediate send, WebSocket echo, reload, pagination, and search hydration; the quote must remain visible and point to the correct message.
- Exercise avatar preview/confirm, same-photo refresh, private/missing photo, upload/edit, quota failure, database failure, cross-account denial, cache revision, and orphan cleanup.
- Exercise statuses on real compatible devices: own publish, remote deletion/revocation, expiration, retry, viewer receipts, unsupported Cloud behavior, and proof that contact statuses are not stored.
- Exercise stickers with backend favorites as the source of truth, last-use ordering, invalid MIME/size/dimensions, failed sends, and animated capability gates.
- Inspect PostgreSQL and application logs for SQL type inference, constraint, storage, and provider errors after focused media mutations. A green HTTP preview does not prove confirmation/persistence works.

## Deployment Claims

- Docker build, `docker compose up`, logs, and health checks are deployment/runtime verification. Do not imply they ran unless they did.

## Deployment When Requested

- If the user asks to deploy, says "despliega", "aplícalo", "producción", "main", or clearly expects the running system to be updated, run the deploy flow. Tests/builds alone are not enough.
- Deploy from the repository root with:

```bash
make deploy
```

- After deploy, verify the live containers and report only checks that actually ran:

```bash
docker ps --filter name=clarin
docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health
docker logs --tail=80 clarin-backend
docker logs --tail=60 clarin-frontend
```

- For database/MCP schema changes, verify the real database container after deploy:

```bash
docker exec clarin-postgres psql -U clarin -d clarin -c "<focused schema check>"
```

- For MCP changes, also verify unauthenticated `/mcp` returns `401 Unauthorized`.
- Do not call work deployed, migrated, healthy, or protected until these runtime checks have passed or the exact blocker has been reported.
