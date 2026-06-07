# Clarin

CRM SaaS multi-tenant centrado en WhatsApp, con dashboard web, automatizaciones, Kommo CRM, Google Contacts, documentos, encuestas, formularios dinamicos y almacenamiento de media.

## Arquitectura

```
┌─────────────┐     ┌─────────────────────────────────────────┐
│   Frontend  │     │              Backend Go                 │
│   Next.js   │────▶│  ┌─────────┐  ┌──────────────────────┐  │
│   :3000     │     │  │ Fiber   │  │     DevicePool       │  │
└─────────────┘     │  │ API     │  │  ┌────────────────┐  │  │
                    │  └────┬────┘  │  │ whatsmeow x200 │  │  │
                    │       │       │  │ connections    │  │  │
                    │  ┌────▼────┐  │  └────────────────┘  │  │
                    │  │WebSocket│  │  ┌────────────────┐  │  │
                    │  │  Hub    │  │  │ MCP Server     │  │  │
                    │  └─────────┘  │  │ :8081          │  │  │
                    └───────────────┴──┴────────────────┴──┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              ┌─────▼────┐  ┌──────▼─────┐  ┌─────▼────┐
              │PostgreSQL│  │   Redis    │  │  MinIO   │
              │  :5432   │  │   :6379    │  │ S3 media │
              └──────────┘  └────────────┘  └──────────┘
```

## Stack Tecnologico

### Backend (Go)
- **Go 1.25** - Lenguaje principal y toolchain del modulo.
- **Fiber v2** - Framework HTTP.
- **whatsmeow** - Integracion directa con WhatsApp Web.
- **pgx v5** - Driver PostgreSQL nativo.
- **Redis** - Cache, sesiones y soporte operativo.
- **MinIO** - Almacenamiento S3-compatible para archivos y media.
- **mcp-go** - Servidor MCP expuesto por SSE en despliegue.

### Frontend (Next.js)
- **Next.js 14** - React framework con App Router.
- **TypeScript** - Tipado estatico.
- **Tailwind CSS** - Estilos utility-first.
- **Lucide React** - Iconos.
- **Zustand** - Estado global.
- **Fabric.js, Nivo, XYFlow** - Edicion visual, graficos y flujos.

### Infraestructura
- **PostgreSQL 16** - Base de datos principal.
- **Redis 7** - Cache y mensajeria auxiliar.
- **MinIO** - Storage de media.
- **Docker Compose** - Orquestacion local/produccion.
- **Traefik** - Routing HTTPS en el compose de despliegue.

## Modulos Principales

- **WhatsApp y chats**: dispositivos, QR, mensajes, media, contactos, stickers, reacciones, encuestas y WebSocket en tiempo real.
- **CRM comercial**: contactos, leads, pipelines, tags, interacciones, campañas y respuestas rapidas.
- **Programas y eventos**: participantes, etapas, asistencia, sesiones, bitacoras, formulas y sincronizacion con Google Contacts.
- **Automatizaciones y bots**: flujos visuales, ejecuciones, logs, simulacion y activacion por plan.
- **Encuestas y dinamicas publicas**: formularios publicos por slug, registros, uploads y links compartibles.
- **Documentos y storage**: plantillas, generacion de documentos, uso de almacenamiento, deduplicacion y media proxy.
- **Administracion SaaS**: cuentas, usuarios, roles, planes, suscripciones, integraciones y permisos por modulo.
- **Integraciones**: Kommo multi-instancia, Google Contacts, WhatsApp Cloud API y MCP.

## Inicio Rapido

### Prerrequisitos
- Docker & Docker Compose.
- Go 1.25+ para desarrollo local.
- Node.js 20+ para desarrollo local.

### Con Docker

```bash
cp .env.example .env
make up
make logs
```

La aplicacion local queda disponible en:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8080
- MCP/SSE: http://localhost:8081/mcp cuando esta configurado por el despliegue.

### Desarrollo Local

```bash
# Base de datos y cache
make db

# Backend
cd backend && go run ./cmd/server

# Frontend
cd frontend && npm install && npm run dev
```

## Configuracion

Variables principales en `.env`:

```env
POSTGRES_USER=clarin
POSTGRES_PASSWORD=change-me
POSTGRES_DB=clarin

DATABASE_URL=postgres://clarin:change-me@localhost:5432/clarin?sslmode=disable
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me

PORT=8080
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=ws://localhost:8080

MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=clarinadmin
MINIO_SECRET_KEY=change-me
MINIO_BUCKET=clarin-media
MINIO_USE_SSL=false
```

El compose de produccion tambien contempla variables para Kommo, Google Contacts, WhatsApp Cloud API, URLs publicas y storage.

## API

Las rutas se definen principalmente en `backend/internal/api/server.go`.

Grupos principales:
- Publico: `/health`, `/api/version`, `/api/public/plans`, `/api/public/surveys/*`, `/api/public/dynamics/*`, webhooks de Kommo y WhatsApp Cloud API.
- Auth: `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh`, `/api/auth/logout`.
- Dashboard protegido: `/api/me`, `/api/settings`, `/api/storage`, `/api/devices`, `/api/chats`, `/api/messages`, `/api/contacts`, `/api/leads`, `/api/pipelines`, `/api/tags`, `/api/campaigns`, `/api/programs`, `/api/events`, `/api/tasks`, `/api/document-templates`, `/api/quick-replies`, `/api/bots`, `/api/automations`, `/api/surveys`, `/api/dynamics`.
- Integraciones: `/api/kommo`, `/api/google`, `/api/google/contacts`, `/api/whatsapp-api`.
- Admin SaaS: `/api/admin/*`.
- WebSocket: `/ws?token=<jwt>`.

## Comandos Make

```bash
make up             # Levantar servicios
make down           # Detener servicios
make logs           # Ver logs
make restart        # Reiniciar servicios
make db             # Solo postgres, redis y dependencias basicas
make build          # Construir imagenes
make migrate        # Ejecutar migraciones via backend
make seed           # Ejecutar seed via backend
make test           # go test ./...
make deploy         # Build con version y despliegue backend/frontend
```

## Estructura del Proyecto

```
clarin/
├── backend/
│   ├── cmd/server/        # Entry point
│   ├── internal/
│   │   ├── api/           # HTTP handlers y rutas
│   │   ├── domain/        # Entidades y contratos internos
│   │   ├── repository/    # Acceso a datos
│   │   ├── service/       # Logica de negocio
│   │   ├── whatsapp/      # DevicePool + whatsmeow
│   │   ├── kommo/         # Integracion Kommo
│   │   ├── google/        # Google Contacts
│   │   ├── mcp/           # Servidor MCP
│   │   ├── storage/       # MinIO/S3
│   │   └── ws/            # WebSocket Hub
│   └── pkg/
│       ├── config/        # Configuracion
│       ├── database/      # DB, migraciones y seed
│       └── cache/         # Redis
├── frontend/
│   └── src/
│       ├── app/           # App Router y paginas dashboard/publicas
│       ├── components/    # Componentes UI
│       ├── lib/           # API client y utilidades
│       ├── types/         # Tipos frontend
│       └── utils/         # Helpers de dominio
├── deploy/                # Dockerfiles
├── specs/                 # Specs historicas de features
├── docker-compose.yml
└── Makefile
```

## Multi-tenancy y Seguridad

- Las cuentas funcionan como tenants aislados por `account_id`.
- Los usuarios pueden pertenecer a una o mas cuentas.
- Hay roles, permisos por modulo y middleware de plan/suscripcion.
- Las contrasenas se almacenan con bcrypt.
- La autenticacion usa JWT y refresh tokens.
- El backend aplica CORS, Helmet y rate limiting.

## Nota sobre el estado del repositorio

Si `git status` muestra muchos cambios, no los reviertas sin revisar su origen. En este proyecto hay cambios grandes y coherentes en backend, frontend, Docker, storage, login/signup y tests; eso normalmente indica trabajo activo. La recomendacion es:

1. Revisar con `git diff --stat` para ver el alcance.
2. Separar cambios por tema antes de commitear.
3. Stashear o crear una rama solo si necesitas aislar una correccion nueva.
4. No usar `git reset --hard` salvo que se haya decidido descartar explicitamente ese trabajo.

## Licencia

MIT
