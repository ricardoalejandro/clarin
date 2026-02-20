# AI Project Handover - Clarin CRM

## 1. Project Overview
**Clarin CRM** is a customer relationship management system integrating WhatsApp (via Baileys) and Kommo CRM. It features a multi-tenant architecture with role-based access control.

### Tech Stack
- **Frontend**: Next.js 14, TailwindCSS, Lucide Icons.
- **Backend**: Go (Fiber), Gorm, PostgreSQL, Redis.
- **Infrastructure**: Docker Compose, MinIO (S3-compatible storage), Traefik.
- **External Services**: Kommo API (Leads/Pipelines), WhatsApp Web API (Baileys).

## 2. Recent Changes & Current State (Feb 2026)
### Major Refactors
- **LeadDetailPanel**: Refactored into a reusable component used in both `Leads Page` and `Chat ContactPanel`.
- **Chat Interface**: Fixed Quick Reply selector to handle media URLs correctly and prevent text duplication.

### Key Fixes
- **Quick Replies**:
  - Validated media sending from URL.
  - Fixed command text replacement (e.g., `/nota` -> Content).
  - Ensured correct rendering in `ChatPanel.tsx` by removing hardcoded mocks.
- **Authentication**:
  - Validated admin access.
  - Reset passwords for `ernesto`, `ricardo`, `kelly` to standard format (`username` + `123`) to resolve login issues.

### Deployment Status
- **Production**: Running via `docker-compose.yml` (single unified compose file).
- **Rebuild Procedure**: `docker compose up -d --build` (Required for frontend changes).

## 3. Development & Operations
### Running the Project
```bash
# Start Production (Rebuilds images)
docker compose up -d --build
```
### Key File Locations
- **Backend Entry**: `backend/cmd/api/main.go` -> `backend/internal/api/server.go`.
- **Frontend Components**:
  - `ChatPanel`: `frontend/src/components/chat/ChatPanel.tsx`.
  - `LeadDetailPanel`: `frontend/src/components/LeadDetailPanel.tsx`.
- **API Routes**: Defined in `backend/internal/api/server.go` (e.g., `/quick-replies`, `/auth/login`).

## 4. Known Credentials (Test Environment)
| User | Username | Password | Role |
|---|---|---|---|
| Admin | `admin` | `Cl@r1n#Adm2026!Sec` | Super Admin |
| Ernesto | `ernesto` | `ernesto123` (Reset) | Agent |
| Ricardo | `ricardo` | `ricardo123` (Reset) | Super Admin |
| Kelly | `kelly` | `kelly123` (Reset) | Agent |

## 5. Next Steps / Pending Tasks
1. **Message Forwarding**: UI exists (`forwardingMsg` state) but functionality needs verification.
2. **Poll Rendering**: Poll creation modal exists, but ensuring polls render correctly in chat stream is a future task.
3. **Multi-Device**: Backend supports it, frontend needed cleanup (done), but verify stability.

---
*Created by Antigravity AI - Feb 18, 2026*
