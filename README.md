# Clarin

CRM WhatsApp multi-tenant con integración directa de whatsmeow. Soporta hasta 200+ conexiones simultáneas de WhatsApp.

## Arquitectura

```
┌─────────────┐     ┌─────────────────────────────────────────┐
│   Frontend  │     │              Backend Go                 │
│   Next.js   │────▶│  ┌─────────┐  ┌──────────────────────┐  │
│   :3000     │     │  │ Fiber   │  │     DevicePool       │  │
└─────────────┘     │  │ API     │  │  ┌────────────────┐  │  │
                    │  └────┬────┘  │  │  whatsmeow x200│  │  │
                    │       │       │  │  connections   │  │  │
                    │  ┌────▼────┐  │  └────────────────┘  │  │
                    │  │WebSocket│  └──────────────────────┘  │
                    │  │  Hub    │                             │
                    │  └─────────┘                             │
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              ┌─────▼────┐  ┌──────▼─────┐  ┌─────▼────┐
              │PostgreSQL│  │   Redis    │  │  Files   │
              │  :5432   │  │   :6379    │  │ /media   │
              └──────────┘  └────────────┘  └──────────┘
```

## Stack Tecnológico

### Backend (Go)
- **Go 1.22** - Lenguaje principal
- **Fiber v2** - Framework HTTP rápido
- **whatsmeow** - Implementación WhatsApp Web protocol
- **pgx v5** - Driver PostgreSQL nativo
- **Redis** - Cache, sessions, pub/sub

### Frontend (Next.js)
- **Next.js 14** - React framework con App Router
- **TypeScript** - Tipado estático
- **Tailwind CSS** - Estilos utility-first
- **Lucide React** - Iconos
- **Zustand** - Estado global

### Infraestructura
- **PostgreSQL 16** - Base de datos principal
- **Redis 7** - Cache y mensajería
- **Docker Compose** - Orquestación local

## Inicio Rápido

### Prerrequisitos
- Docker & Docker Compose
- Go 1.22+ (para desarrollo local)
- Node.js 20+ (para desarrollo local)

### Con Docker (Recomendado)

```bash
# Clonar repositorio
git clone <repo-url> clarin
cd clarin

# Copiar configuración
cp .env.example .env

# Levantar servicios
make up

# Ver logs
make logs
```

La aplicación estará disponible en:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8080

### Desarrollo Local

```bash
# Terminal 1 - Base de datos
make db

# Terminal 2 - Backend
make dev-backend

# Terminal 3 - Frontend
make dev-frontend
```

## Configuración

Variables de entorno en `.env`:

```env
# Base de datos
DATABASE_URL=postgres://clarin:clarin123@localhost:5432/clarin?sslmode=disable

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-secret-key-change-in-production

# API
API_PORT=8080

# Frontend
NEXT_PUBLIC_API_URL=http://localhost:8080
```

## API Endpoints

### Autenticación
- `POST /api/auth/login` - Iniciar sesión
- `POST /api/auth/register` - Registrar cuenta
- `GET /api/auth/me` - Usuario actual

### Dispositivos
- `GET /api/devices` - Listar dispositivos
- `POST /api/devices` - Crear dispositivo
- `POST /api/devices/:id/connect` - Conectar (genera QR)
- `POST /api/devices/:id/disconnect` - Desconectar
- `DELETE /api/devices/:id` - Eliminar

### Chats
- `GET /api/chats` - Listar chats
- `GET /api/chats/:id/messages` - Mensajes de un chat
- `POST /api/chats/:id/read` - Marcar como leído

### Mensajes
- `POST /api/messages/send` - Enviar mensaje de texto
- `POST /api/messages/send/media` - Enviar media

### Leads
- `GET /api/leads` - Listar leads
- `POST /api/leads` - Crear lead
- `PUT /api/leads/:id` - Actualizar lead
- `DELETE /api/leads/:id` - Eliminar lead

### WebSocket
- `GET /ws?token=<jwt>` - Conexión WebSocket para eventos en tiempo real

Eventos WebSocket:
- `new_message` - Nuevo mensaje recibido
- `device_status` - Cambio de estado de dispositivo
- `qr_code` - Código QR para escanear
- `message_sent` - Mensaje enviado confirmado

## Comandos Make

```bash
make up          # Levantar todos los servicios
make down        # Detener servicios
make logs        # Ver logs
make restart     # Reiniciar servicios
make db          # Solo base de datos
make build       # Construir imágenes
make dev-backend # Backend en modo desarrollo
make dev-frontend # Frontend en modo desarrollo
make migrate     # Ejecutar migraciones
make test        # Ejecutar tests
```

## Estructura del Proyecto

```
clarin/
├── backend/
│   ├── cmd/server/        # Entry point
│   ├── internal/
│   │   ├── api/           # HTTP handlers
│   │   ├── domain/        # Entidades
│   │   ├── repository/    # Acceso a datos
│   │   ├── service/       # Lógica de negocio
│   │   ├── whatsapp/      # DevicePool + whatsmeow
│   │   └── ws/            # WebSocket Hub
│   └── pkg/
│       ├── config/        # Configuración
│       └── database/      # Conexión DB
├── frontend/
│   └── src/
│       ├── app/           # Pages (App Router)
│       │   ├── dashboard/ # Dashboard pages
│       │   └── page.tsx   # Login
│       └── lib/           # Utilidades
├── deploy/                # Dockerfiles
├── docker-compose.yml
└── Makefile
```

## Multi-tenancy

El sistema soporta múltiples cuentas (tenants) aisladas:

1. Cada cuenta tiene su propio conjunto de dispositivos
2. Los datos están completamente separados por `account_id`
3. Los usuarios pertenecen a una cuenta específica
4. El DevicePool mantiene las conexiones de todas las cuentas

## Escalabilidad

- Soporta 200+ conexiones WhatsApp simultáneas
- DevicePool con lazy initialization
- Connection pooling para PostgreSQL
- Redis para cache y rate limiting
- WebSocket Hub con broadcast eficiente

## Seguridad

- JWT con refresh tokens
- Bcrypt para contraseñas
- CORS configurado
- Rate limiting en endpoints sensibles
- Validación de account_id en todas las queries

## Licencia

MIT
