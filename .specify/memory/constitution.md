<!--
INFORME DE SINCRONIZACIÓN
==========================
Cambio de versión: (plantilla) → 1.0.0
Secciones añadidas: Principios Fundamentales (7), Stack y Restricciones de Arquitectura, Flujo de Trabajo, Gobernanza
Secciones eliminadas: Ninguna (ratificación inicial)
Plantillas que requieren actualización:
  ✅ constitution.md — este archivo
  ✅ plan-template.md — aplica verificación de Constitución (Docker build, SQL, WebSocket)
  ✅ spec-template.md — escenarios de aceptación deben referenciar emerald/slate y reglas de normalización
  ✅ tasks-template.md — categorías de tareas incluyen invalidación de caché y broadcast WebSocket
TODOs pendientes: Ninguno — todos los campos resueltos.
-->

# Constitución de Clarin CRM

## Principios Fundamentales

### I. Builds Solo por Docker (INNEGOCIABLE)

Toda compilación de Go/backend DEBE hacerse con `docker compose build backend`. Ejecutar
`go build` localmente está prohibido — no hay compilador Go local. El frontend se compila
con `docker compose build frontend`. Después de cada cambio de código: compilar →
`docker compose up -d` → verificar logs con `docker compose logs --tail=30 [servicio]`.
Un build que nunca se verifica no es un build.

### II. SQL Siempre Parametrizado (INNEGOCIABLE)

TODAS las queries SQL DEBEN usar placeholders parametrizados de pgx (`$1, $2, ...`).
La concatenación o interpolación de strings en SQL está estrictamente prohibida. Es tanto
un requisito de seguridad (OWASP A03 - SQL Injection) como un estándar de calidad.
Sin excepciones, incluyendo cláusulas ORDER BY dinámicas — usar listas blancas para
nombres de columnas dinámicas.

### III. Sistema de Diseño Tailwind Emerald/Slate

Toda la UI frontend DEBE usar exclusivamente Tailwind CSS. La paleta de diseño es
`emerald` (acciones primarias, destacados) y `slate` (neutros, fondos, texto). No se
permiten CSS Modules, styled-components ni estilos inline arbitrarios. Los componentes
DEBEN seguir el lenguaje visual establecido: `emerald-500/600` para elementos
interactivos, `slate-700/800` para contenedores y texto.

### IV. Actualizaciones en Tiempo Real por WebSocket

Cualquier mutación en el backend que produzca datos visibles en el frontend DEBE emitir
un evento WebSocket via `s.hub.BroadcastToAccount(accountID, ws.EventXxx, data)`.
El polling está prohibido como sustituto de los eventos en tiempo real. Las constantes
de tipo de evento están en `ws/hub.go`. Los nuevos dominios de datos DEBEN definir
nuevas constantes de event allí.

### V. Normalización de Números de Teléfono

Todos los números de teléfono que entran al sistema DEBEN normalizarse con
`kommo.NormalizePhone()` en las fronteras del sistema (handlers API, importaciones CSV,
workers de sincronización). Perú (+51) es el único prefijo de país soportado. Números
de 9 dígitos que comienzan con 9 reciben automáticamente el prefijo `51`. El código
interno DEBE asumir que los números ya están normalizados — nunca normalizar dos veces.

### VI. Invalidación de Caché Redis en Mutaciones

Todas las mutaciones a entidades cacheables (leads, pipelines, etiquetas, contactos,
dispositivos) DEBEN invalidar las claves Redis afectadas via `cache.DelPattern()`
inmediatamente después de que la escritura en DB sea exitosa. Las entradas de caché
nunca se actualizan en su lugar — siempre invalidar y dejar que la siguiente lectura
repopule. Los TTLs se establecen en el momento de escritura.

### VII. Cambios Mínimos y Enfocados

Cada cambio de código DEBE ser el mínimo necesario para satisfacer el requerimiento
indicado. No se permite refactorización no solicitada, abstracciones especulativas ni
funcionalidades más allá del alcance. Leer el código existente completamente antes de
modificar. La superficie del cambio DEBE ser proporcional al problema.

## Stack y Restricciones de Arquitectura

**Backend**: Go 1.24, Fiber v2.52, pgx v5 (PostgreSQL 16), Redis 7, MinIO (compatible con S3),
whatsmeow (WhatsApp), Kommo API v4.

**Frontend**: Next.js 14 (App Router), React 18, TypeScript (modo strict), Tailwind CSS 3.4.
Llamadas API via `@/lib/api.ts`. WebSocket via `createWebSocket()` del mismo módulo.
Rutas proxiadas por Next.js rewrites: `/api/:path*` → backend:8080.

**Infraestructura**: Orquestación con Docker Compose. Deploy en Dokploy en `clarin.naperu.cloud`.
Sin toolchain Go local — Docker es el único compilador.

**Migraciones de base de datos**: SQL en `database.go` → función `InitDB()`.
Patrón: `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
Nunca usar archivos de migración separados para cambios nuevos.

**Organización de módulos**: Features grandes se dividen en `modulo_handler.go`,
`modulo_repository.go`, `modulo_service.go` junto a los archivos principales. Los tipos
TypeScript compartidos entre múltiples páginas van en `src/types/`. Las utilidades puras
(sin efectos secundarios) van en `src/utils/`.

## Flujo de Trabajo de Desarrollo

Para **cada** cambio, esta secuencia es OBLIGATORIA e innegociable:

1. Leer y entender el código existente antes de tocar nada.
2. Hacer el cambio mínimo requerido.
3. `docker compose build [backend|frontend]` — DEBE compilar sin errores.
4. Si hay errores → corregir → volver al paso 3.
5. `docker compose up -d` → desplegar.
6. `docker compose logs --tail=30 [servicio]` → verificar arranque limpio.
7. Si hay errores en runtime → corregir → volver al paso 3.
8. Confirmar al usuario que todo está funcionando.

Para **nuevos endpoints API**: entidad en `domain/entities.go` → método en repositorio →
método en servicio → handler → registrar ruta en `setupRoutes()` → compilar → desplegar → verificar.

Para **cambios de esquema de base de datos**: añadir `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS`
al final de `InitDB()` en `database.go` → desplegar → verificar en logs del backend que la
migración ejecutó.

Todos los errores DEBEN manejarse. `err != nil` nunca se ignora silenciosamente.
Los logs usan `log.Printf` con prefijos: `[API]`, `[SYNC]`, `[WS]`, `[WHATSAPP]`, `[CACHE]`.

## Gobernanza

Esta constitución prevalece sobre todas las prácticas informales y convenciones ad-hoc.
Es la referencia autoritativa para todas las decisiones de desarrollo en Clarin CRM.

Las enmiendas DEBEN: proponerse explícitamente → aprobarse por el dueño del proyecto →
aplicarse en este archivo con incremento de versión siguiendo versionado semántico
(MAYOR: eliminación/redefinición de principio; MENOR: adición de principio; PARCHE: aclaración/redacción).

Todos los specs (`spec.md`) y planes (`plan.md`) generados por Spec Kit DEBEN incluir una
sección de Verificación de Constitución que valide el cumplimiento de los principios anteriores
antes de que comience la implementación.

El cumplimiento se verifica en: creación de spec, creación de plan, revisión de código y
verificación de logs post-deploy.

**Versión**: 1.0.0 | **Ratificada**: 2026-04-14 | **Última Enmienda**: 2026-04-14
