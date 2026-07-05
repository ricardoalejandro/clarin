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
