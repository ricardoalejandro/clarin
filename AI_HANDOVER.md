# AI Project Handover - Clarin CRM

## 1. Project Overview

**Clarin CRM** is a multi-tenant SaaS CRM focused on WhatsApp operations, sales workflows and event/program management. It includes role-based access control, subscriptions, integrations and a Next.js dashboard.

Current implementation notes:
- WhatsApp Web integration uses **whatsmeow**, not Baileys.
- Database access uses **pgx**, not Gorm.
- Backend entrypoint is `backend/cmd/server/main.go`.
- Main API route registration is in `backend/internal/api/server.go`.

## 2. Tech Stack

- **Frontend**: Next.js 14, TypeScript, Tailwind CSS, Lucide React, Zustand.
- **Backend**: Go 1.24, Fiber, pgx, PostgreSQL, Redis.
- **Storage**: MinIO/S3-compatible media storage.
- **Realtime**: WebSocket hub at `/ws`.
- **Integrations**: Kommo CRM, Google Contacts, WhatsApp Cloud API.
- **AI/MCP**: Eros assistant endpoints and MCP server support.
- **Infrastructure**: Docker Compose with PostgreSQL, Redis, MinIO, backend, frontend and Traefik labels for production routing.

## 3. Product Surface

Core areas visible in the current codebase:
- Chats, WhatsApp devices, messages, media, reactions, polls and quick replies.
- Contacts, leads, pipelines, tags, campaigns and interaction history.
- Programs, events, participants, sessions, attendance and logbooks.
- Tasks, bots, automations and execution logs.
- Surveys and public dynamic pages/forms.
- Document templates, generated documents and storage management.
- SaaS admin for accounts, users, roles, plans, subscriptions and integrations.

## 4. Development & Operations

Common commands:

```bash
make up
make down
make logs
make db
make test
```

Local development:

```bash
cd backend && go run ./cmd/server
cd frontend && npm install && npm run dev
```

Production-style rebuild:

```bash
docker compose up -d --build
```

## 5. Key File Locations

- Backend entrypoint: `backend/cmd/server/main.go`.
- API routes and middleware: `backend/internal/api/server.go`.
- Domain entities: `backend/internal/domain/entities.go`.
- Repository composition: `backend/internal/repository/repository.go`.
- Service composition: `backend/internal/service/service.go`.
- WhatsApp device pool: `backend/internal/whatsapp/device_pool.go`.
- Storage integration: `backend/internal/storage/storage.go`.
- Frontend routes: `frontend/src/app`.
- API client/types: `frontend/src/lib/api.ts`, `frontend/src/types`.
- Chat UI: `frontend/src/components/chat/ChatPanel.tsx`.
- Lead detail UI: `frontend/src/components/LeadDetailPanel.tsx`.

## 6. Repository State Guidance

If the repo is dirty, treat it as active work until proven otherwise. Do not revert broad changes automatically.

Recommended triage:
1. Use `git status --short` and `git diff --stat` to classify changes by feature area.
2. Review any changed file before editing it.
3. Keep documentation fixes, frontend work, backend work and deploy changes in separate commits when possible.
4. Only discard changes with an explicit decision from the project owner.

Current observed dirty areas include backend API/domain/repository/service/storage/WhatsApp, Docker config, frontend dashboard/layout/settings/landing/chat, login/signup, storage UI, sitemap/robots and Playwright tests.

## 7. Security Note

Do not store real credentials in this handover. Use `.env.example` for placeholder values and keep production secrets in deployment-managed environment variables.
