# Clarin CRM — Guía de Desarrollo

## Inicio Rápido

```bash
# Levantar todos los servicios
docker compose up -d

# Ver logs
docker compose logs -f backend
docker compose logs -f frontend

# Rebuild después de cambios
docker compose build backend && docker compose up -d backend
docker compose build frontend && docker compose up -d frontend
```

## Estructura de Servicios

| Servicio | Puerto | Descripción |
|----------|--------|-------------|
| frontend | 3001 | Next.js App Router |
| backend | 8080 | Go Fiber API + WebSocket |
| postgres | 5432 | PostgreSQL 16 |
| redis | 6379 | Redis 7 |

## URLs de Desarrollo

- **Frontend:** http://localhost:3001
- **Backend API:** http://localhost:8080/api
- **Producción:** https://clarin.naperu.cloud

## Comandos Útiles

```bash
# Makefile shortcuts
make build        # Build todos los servicios
make up           # Levantar servicios
make down         # Detener servicios
make logs         # Ver todos los logs
make shell-back   # Shell en container backend
make shell-front  # Shell en container frontend

# Rebuild individual
docker compose build backend
docker compose build frontend

# Logs específicos
docker compose logs --tail=50 backend
docker compose logs --tail=50 frontend

# Restart limpio
docker compose down && docker compose build && docker compose up -d
```

## Flujo de Desarrollo

### 1. Backend (Go/Fiber)

```
Leer código existente → Modificar → docker compose build backend → Verificar errores → docker compose up -d → Verificar logs
```

**No hay Go instalado localmente.** Todo se compila dentro de Docker.

### 2. Frontend (Next.js/React)

```
Leer código existente → Modificar → docker compose build frontend → Verificar errores → docker compose up -d → Verificar logs
```

### 3. Base de Datos

Las migraciones viven en `backend/pkg/database/database.go` dentro de `InitDB()`.

```go
// Agregar al final de InitDB():
_, _ = db.Exec(ctx, `ALTER TABLE tabla ADD COLUMN IF NOT EXISTS campo TEXT DEFAULT ''`)
```

## Paleta de Colores UI

| Uso | Color | Ejemplo |
|-----|-------|---------|
| Primario | emerald | `bg-emerald-600`, `text-emerald-500` |
| Neutro | slate | `bg-slate-800`, `text-slate-300` |
| Fondo oscuro | slate-900 | `bg-slate-900` |
| Bordes | slate-700 | `border-slate-700` |
| Hover | emerald-700 | `hover:bg-emerald-700` |

## Variables de Entorno

Definidas en `.env` y referenciadas en `docker-compose.yml`:

```
POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
REDIS_HOST, REDIS_PORT
JWT_SECRET
KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN, KOMMO_ACCOUNT_ID
```
