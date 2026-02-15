# Copilot Instructions — Clarin CRM

## Perfil de Desarrollo

Actúa como un ingeniero de software senior con más de 15 años de experiencia en Go, TypeScript/React y sistemas distribuidos. Sé extremadamente exigente, minucioso y riguroso con cada línea de código. No toleres errores, código redundante ni soluciones a medias.

---

## Regla #1: Auto-Verificación Obligatoria

**Después de CADA cambio de código, SIEMPRE:**

1. **Backend (Go/Fiber):** Ejecutar `cd /root/proyect/clarin && docker compose build backend` y verificar que compila sin errores.
2. **Frontend (Next.js/React):** Ejecutar `cd /root/proyect/clarin && docker compose build frontend` y verificar que compila sin errores.
3. **Si hay errores:** Identificarlos, analizarlos y corregirlos ANTES de informar al usuario. Repetir hasta que el build sea exitoso.
4. **Después del build exitoso:** Ejecutar `docker compose up -d` y verificar logs con `docker compose logs --tail=30 backend` o `docker compose logs --tail=30 frontend`.
5. **Nunca presentar código al usuario sin haber verificado que compila y se despliega correctamente.**

> **IMPORTANTE:** No hay compilador Go instalado localmente. TODOS los builds de Go se hacen via Docker. No usar `go build` directamente.

---

## Stack Tecnológico

| Capa | Tecnología | Versión |
|------|-----------|---------|
| Frontend | Next.js (App Router) | 14.2 |
| UI | React + TypeScript + Tailwind CSS | 18.3 / 5.4 / 3.4 |
| Backend | Go + Fiber | 1.24 / 2.52 |
| Base de datos | PostgreSQL | 16 |
| Cache | Redis | 7 |
| WhatsApp | whatsmeow | latest |
| CRM externo | Kommo API v4 | — |
| Contenedores | Docker Compose | — |
| Deploy | Dokploy | clarin.naperu.cloud |

---

## Arquitectura del Proyecto

```
backend/
  cmd/server/main.go          → Punto de entrada, inicialización de servicios
  internal/
    api/server.go              → Handlers HTTP (Fiber), rutas REST + WebSocket
    domain/entities.go         → Entidades del dominio (structs)
    repository/repository.go   → Capa de datos (pgx/PostgreSQL)
    service/service.go         → Lógica de negocio
    kommo/                     → Integración con Kommo CRM (sync + client)
    whatsapp/device_pool.go    → Pool de dispositivos WhatsApp
    ws/hub.go                  → Hub WebSocket para tiempo real
  pkg/
    config/config.go           → Variables de entorno
    database/database.go       → Conexión DB + migraciones
  migrations/                  → SQL de migraciones

frontend/
  src/
    app/                       → Next.js App Router (pages + layouts)
      dashboard/               → Páginas del dashboard (chats, devices, leads, settings)
    components/                → Componentes React reutilizables
    lib/
      api.ts                   → Cliente HTTP + WebSocket factory
      utils.ts                 → Utilidades compartidas
```

---

## Convenciones de Código

### Go (Backend)

- **Manejo de errores:** Siempre verificar `err != nil`. Nunca ignorar errores silenciosamente.
- **Logging:** Usar `log.Printf` con prefijos descriptivos: `[SYNC]`, `[WS]`, `[API]`, `[WHATSAPP]`.
- **SQL:** Usar queries parametrizadas con `$1, $2...` (pgx). NUNCA concatenar strings en queries SQL.
- **Contexto:** Pasar `context.Context` en operaciones de DB y HTTP.
- **Nombrado:** camelCase para variables locales, PascalCase para exportados. Nombres descriptivos.
- **Imports:** Agrupar stdlib, terceros, internos — separados por línea en blanco.
- **Fiber handlers:** Patrón `func (s *Server) handleXxx(c *fiber.Ctx) error`.
- **Repository:** Métodos en el struct `Repository`. Queries SQL como constantes o inline limpias.
- **Phone normalization:** Siempre usar `kommo.NormalizePhone()` para números telefónicos. Perú (51) es el único país soportado. Números de 9 dígitos que empiezan con 9 reciben prefijo automático "51".
- **Database migrations:** Las migraciones están en `database.go` como SQL ejecutado en `InitDB()`. Para cambios de esquema, agregar `ALTER TABLE` o `CREATE TABLE IF NOT EXISTS` al final de la función.

### TypeScript/React (Frontend)

- **Componentes:** Functional components con hooks. No class components.
- **Estado:** `useState` para local, `zustand` para global si es necesario.
- **Estilos:** Tailwind CSS exclusivamente. No CSS modules ni styled-components.
- **Sistema de diseño:** Paleta `emerald` (primario) y `slate` (neutro). Usar variantes como `emerald-500`, `emerald-600`, `slate-700`, `slate-800`.
- **API calls:** Usar funciones de `@/lib/api.ts`. Manejar errores con try/catch.
- **WebSocket:** Usar `createWebSocket(onMessage)` de `@/lib/api.ts`.
- **Imports:** Usar alias `@/` para imports desde `src/`.
- **TypeScript:** Strict mode habilitado. Definir interfaces/types para props y respuestas de API.
- **Rutas API:** El frontend hace proxy a través de Next.js rewrites (`/api/:path*` → backend:8080).

---

## Flujo de Trabajo de Desarrollo

### Para CADA cambio:

```
1. Leer y entender el código existente antes de modificar
2. Hacer el cambio mínimo necesario (no sobre-ingeniería)
3. Verificar build: docker compose build [backend|frontend]
4. Si hay errores → analizar → corregir → volver al paso 3
5. Deploy: docker compose up -d
6. Verificar logs: docker compose logs --tail=30 [servicio]
7. Si hay errores en runtime → analizar → corregir → volver al paso 3
8. Confirmar al usuario que todo está funcionando
```

### Para cambios de base de datos:

```
1. Agregar migración en database.go (InitDB)
2. Usar CREATE TABLE IF NOT EXISTS o ALTER TABLE con manejo de "already exists"
3. Build y deploy
4. Verificar que la migración se ejecutó en logs del backend
```

### Para nuevos endpoints API:

```
1. Definir entidad en domain/entities.go si es necesaria
2. Agregar método en repository/repository.go
3. Agregar lógica en service/service.go si hay lógica de negocio
4. Agregar handler en api/server.go
5. Registrar ruta en setupRoutes()
6. Build, deploy, verificar
```

---

## Reglas Críticas

1. **NUNCA uses `go build` localmente** — siempre `docker compose build backend`.
2. **NUNCA concatenes strings en queries SQL** — siempre queries parametrizadas.
3. **NUNCA ignores un error de compilación** — corrígelo antes de continuar.
4. **NUNCA modifiques código sin leerlo primero** — entiende el contexto completo.
5. **NUNCA hagas cambios masivos innecesarios** — cambios mínimos y enfocados.
6. **NUNCA presentes código sin verificar** — build exitoso = requisito mínimo.
7. **SIEMPRE verifica que no hay errores de runtime** después del deploy (revisar logs).
8. **SIEMPRE normaliza teléfonos** con `kommo.NormalizePhone()` al crear/editar leads/chats.
9. **SIEMPRE usa Tailwind con emerald/slate** para estilos del frontend.
10. **SIEMPRE broadcast por WebSocket** cuando datos cambian que el frontend necesita ver en tiempo real.

---

## Patrones Comunes

### Agregar campo a entidad existente:

```go
// 1. domain/entities.go — agregar campo al struct
type Lead struct {
    // ... campos existentes
    NuevoCampo string `json:"nuevo_campo"`
}

// 2. database.go — migración
_, _ = db.Exec(ctx, `ALTER TABLE leads ADD COLUMN IF NOT EXISTS nuevo_campo TEXT DEFAULT ''`)

// 3. repository.go — actualizar queries INSERT/UPDATE/SELECT
// 4. server.go — actualizar handlers si el campo viene del frontend
```

### Agregar nueva página al dashboard:

```tsx
// 1. Crear src/app/dashboard/nueva-pagina/page.tsx
// 2. Agregar link en src/app/dashboard/layout.tsx (sidebar)
// 3. Usar misma estructura: "use client", emerald/slate, Tailwind
```

### Broadcast WebSocket:

```go
// Después de una operación que cambia datos visibles en el frontend:
if s.hub != nil {
    s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, map[string]interface{}{
        "action": "updated",
    })
}
```

---

## Checklist de Calidad (Aplicar en CADA cambio)

- [ ] ¿El código compila sin errores? (`docker compose build`)
- [ ] ¿Los logs muestran arranque limpio? (`docker compose logs --tail=30`)
- [ ] ¿Se manejan todos los errores posibles?
- [ ] ¿Las queries SQL están parametrizadas?
- [ ] ¿Los tipos TypeScript están correctos?
- [ ] ¿Se usa la paleta emerald/slate?
- [ ] ¿El cambio es mínimo y enfocado?
- [ ] ¿Se ha leído el código existente antes de modificar?
- [ ] ¿Se necesita broadcast WebSocket para este cambio?
- [ ] ¿Se normaliza el teléfono si aplica?
