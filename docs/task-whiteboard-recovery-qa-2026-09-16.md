# Recuperación de Tareas y Pizarras — verificación de despliegue

Fecha: 2026-09-16

## Resultado

La recuperación fue implementada, verificada y desplegada. No se aplicaron migraciones ni reparaciones de datos.

- Versión pública: `2026.09.16-1-192948301995053-d420a6bea1a5`
- Next.js: `16.3.5`
- Build ID frontend: `H6PvPizf_PFX00nwpYm5p`
- SHA-256 agregado del CSS desplegado: `6c7cd43e626126320972ae3991fabb9dffe665c29d305d83ef415163a1984287`
- Etiqueta de rollback previa: `rollback-task-whiteboard-20260916-192857`

## Contratos comprobados

- El CSS de producción contiene las variantes críticas de `group-hover`, `group-focus-within`, `focus-visible` y puntero táctil.
- Tareas conserva selección, teclado, menús, creación, subtareas, arrastre, rollback, permisos, calendario, Gantt, adjuntos, Archivo y Papelera.
- Las pizarras contextuales permanecen en Work, sin duplicarse como pizarras independientes.
- Mermaid funciona localmente, crea elementos editables y no habilita IA ni tráfico externo.
- Login y la raíz responden con `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`.
- La CSP permite Turnstile solamente mediante `https://challenges.cloudflare.com` para scripts, frames y conexiones.
- Un navegador ordinario o revocado no recibe autoridad, controles ni navegación Offline. El motor experimental no se registra globalmente.

## Dependencias relevantes

- `tailwindcss@3.4.19`
- `postcss-selector-parser@7.1.6`, sin copias de la rama 6
- `@excalidraw/mermaid-to-excalidraw@2.2.2`
- `mermaid@11.16.1`
- `npm audit`: 0 vulnerabilidades

## Pruebas anteriores al despliegue

- Frontend: 262 archivos y 1417 pruebas unitarias aprobadas.
- Fork Excalidraw: 28 pruebas aprobadas.
- Dependencias y seguridad focalizadas: 35 pruebas aprobadas.
- `npx tsc --noEmit`: aprobado.
- `npm run build`: aprobado, incluida la verificación del CSS compilado y del bundle Excalidraw.
- Backend: `GOCACHE=/tmp/go-build go test ./...` y `go build ./...` aprobados.
- Pizarras: 18 pruebas Chromium aprobadas, 1 ruta exclusiva de Firefox omitida intencionalmente; la exportación Firefox se aprobó por separado.

## Pruebas sobre la versión pública desplegada

- Tareas: 54/54.
- Pizarras de Work: 14/14.
- Pizarras — gestor, hidratación/guardado, ACK perdido, reconexión y revocación: 3/3.
- Mermaid local y sin egress: 1/1.
- Login, Turnstile, recursos, F5, recuperación de chunks y móvil: 4/4.
- Aislamiento Offline para perfil normal, perfil revocado y F5: 3/3.

Dos aserciones temporales del harness de Tareas fueron estabilizadas durante la comprobación pública: ahora validan una única búsqueda final tras el debounce y el número exacto de reconciliaciones, sin depender de que una petición de fondo siga pendiente en un instante arbitrario. La repetición completa terminó 54/54.

## Estado del runtime

- `clarin-frontend`: activo.
- `clarin-backend`: activo y saludable.
- `clarin-offline-signer`: activo y saludable.
- PostgreSQL y Redis: saludables según `/health`.
- Frontend: sin errores de runtime en logs.
- Backend: sin panic, fatal ni errores de Tareas/Pizarras; solo se observaron avisos transitorios de cierre EOF en conexiones WhatsApp, ajenos a este cambio.

