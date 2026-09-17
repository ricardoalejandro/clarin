# Offline web v4 — entrega verificada

## Resultado

Implementado y desplegado mediante `make deploy` el 15 de septiembre de 2026. Versión final comprobada interna y públicamente:

`2026.09.15-1-040024992194032-d420a6bea1a5`

Misma web `https://clarin.naperu.cloud`, sin instalador, servicio local, extensión, certificado de cliente ni configuración Windows. Aprobación exclusiva del superadmin por perfil de navegador, usuario y cuenta; ninguna autorización real fue concedida automáticamente por este despliegue.

## Comprobaciones de producción ejecutadas

- `make deploy`: código de salida 0. El segundo despliegue incorpora límites tempranos y agrupación de la sincronización por bytes.
- `docker ps --filter name=clarin`: backend, frontend, firmante, bridge y worker en ejecución; PostgreSQL, Redis y MinIO saludables. Sin reinicios de los contenedores recién desplegados durante la observación.
- `docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health`: `healthy`, PostgreSQL/Redis `ok=true`. Comprobación posterior a las 04:14 UTC también saludable.
- `browser-runtime-check.mjs`: **38/38 PASS**, versión exacta, flags, firmas, autenticación y esquema real inspeccionado con `docker exec clarin-postgres psql`.
- Nueve tablas v4, seis índices, claves foráneas compuestas por autorización/cuenta, idempotencia de recibos, restricción de tamaño y cinco triggers de épocas: comprobados en PostgreSQL de producción.
- Flags efectivos del backend: v4 y escritura de tareas activados; v3 y enrollment nativo desactivados. La activación global no sustituye los permisos de cada autorización/recurso.
- API pública: `/api/version` correcto y disponibilidad v4 HTTP 200; consultas de grants y administración sin sesión HTTP 401. `/mcp` sin credenciales también HTTP 401.
- **510/510 archivos públicos**, 23.238.865 bytes, SHA-256 y tamaño coincidentes con el manifiesto. Origen y versión exactos, Service Worker de la misma versión, manifiesto no-cache y CSP de conexión al mismo origen sin helper localhost.
- **11/11 comprobaciones públicas finales PASS**: versión, disponibilidad, autenticación y límites. El proxy devuelve 413 antes del backend para cuerpos mayores de 2 MiB en rutas usuario/admin, mayúsculas y transferencia fragmentada sin Content-Length. El backend devuelve 413 para challenge de más de 4 KiB y 415 para cuerpo comprimido antes del parsing.
- API interna de Traefik: ruta `clarin-offline-v4-file@file` habilitada, prioridad 270, buffer máximo 2 MiB y memoria 64 KiB. La instalación forma parte de `make deploy` y no modifica rutas ajenas.

Se leyeron logs reales de backend, frontend, firmante y worker con salida sanitizada. Frontend/firmante/worker no presentaron errores en el intervalo observado. Backend registró avisos `Set status notification has unexpected content` y dos cierres WebSocket con EOF; no se observaron errores de offline, de migración ni procesos reiniciándose. La salud posterior permaneció correcta. No se presenta esto como una garantía de ausencia de incidencias externas de WhatsApp/conexión.

## QA ejecutada

| Alcance | Resultado |
| --- | --- |
| Regresión frontend completa antes del endurecimiento final | 245 archivos / 1.290 Vitest PASS |
| Motor offline tras agrupación por bytes | 51/51 PASS y TypeScript PASS |
| Backend completo después del guard final | `GOCACHE=/tmp/go-build go test ./...` PASS, incluidos seis tests nuevos del guard |
| Firmante | `go test ./...` PASS |
| Instalación segura de proxy, contrato de despliegue y comprobador runtime | 13/13 PASS |
| Helpers y observabilidad del laboratorio final | 10/10 PASS |
| Build final de producción | TypeScript, 32 páginas, shell/worker y editor PASS |
| Shell en Chrome y Edge | 22/22 PASS |
| Recorridos completos Chrome y Edge | 2/2 PASS: diez usuarios, dos cuentas, once autorizaciones sintéticas |
| Compatibilidad con Service Worker previo y nuevas solicitudes | 4/4 PASS |
| Cloudflare simulado y cierre completo/reapertura | 2/2 PASS |
| Cola grande y pérdida de confirmación en Chrome | 1/1 PASS final, 56,5 segundos |

Los recorridos completos verificaron solicitud/aprobación reales, selección y preparación, cuatro módulos, aislamiento de cuentas/usuarios, creación/completado offline, cifrado en IndexedDB, ausencia de datos privados en CacheStorage, cierre/reapertura, pérdida de confirmación y sincronización idempotente. El login de otro usuario bloquea el acceso al anterior y no envía su cola como la nueva identidad.

El caso grande usa UI real para login, aprobación, preparación y sincronización. Como la creación offline visible no tiene un campo descripción, las doce descripciones se encolaron mediante el RPC público del SharedWorker, desbloqueado con credenciales sintéticas reales; no se falsificó su estado ni se inyectaron claves. Los 2.400.000 bytes de descripción se enviaron en lotes reales de **2.007.468** y **401.717 bytes**. Tras pérdida de ACK, un reenvío de challenge consumido recibió el rechazo exacto de replay; un nuevo intento confirmó las operaciones. Servidor: exactamente doce IDs, descripciones completas, autor, cuenta y lista correctos. Otra sincronización mantuvo doce tareas y cero pendientes. [Detalle del caso](offline-v4-large-batch-qa-2026-09-15.md).

Reportes reproducibles conservados en `test-results/`:

- `offline-v4-shell-final-report.json`
- `offline-v4-flow-chrome-report.json`
- `offline-v4-flow-edge-report.json`
- `offline-v4-final-smokes-report.json`
- `offline-v4-final-restart-report.json`
- `offline-v4-large-batch-report.json`

## Correcciones encontradas durante el cierre

La comprobación del proxy detectó que este VPS usa Traefik v2.11 con Swarm/file provider, por lo que las etiquetas de contenedores Compose no aplicaban el límite. Se corrigió mediante un fragmento independiente, instalación atómica con respaldo y sintaxis compatible con v2.11. No se sustituyó la configuración general ni se reinició Traefik. Además, se añadió rechazo temprano de cuerpos excesivos/comprimidos en backend y se sustituyeron lotes de solo 50 operaciones por lotes limitados también por el JSON UTF-8 completo. Los cambios no confirmados conservan IDs, orden y almacenamiento cifrado.

## Continuidad y respaldo

- Backend final: `sha256:341b48684c1cdd724d4ed730e39f5f015d3773218b91c6b092dcdc75aa77e321`.
- Frontend final: `sha256:d9fec27f0919b269d726845ab0d78c76ef3635158727d09dbf040382d6d414eb`.
- Firmante final: `sha256:6dfeec15e23830e9477182fb52c4d8eca95a3a1769890ee00d884f6b4b4b37cc`.
- Worker final: `sha256:6705a9c3477a515209d492c168426b73e848452692d7bb5aa137090f4e92cd55`.
- Backup previo a la primera migración: `.runtime/offline/v4-backups/2026-09-15T03-25-00-291Z-416cd270`.
- Backup actualizado previo al segundo despliegue: `.runtime/offline/v4-backups/2026-09-15T03-59-40-736Z-43950106`.
- Dumps, catálogo `pg_restore --list`, hashes y archivos del firmante verificados sin imprimir secretos. **No se ensayó restauración**.
- El laboratorio v4 se detiene al concluir, conservando datos e informes. No se modifica el laboratorio v3 preexistente ni se borran perfiles/cachés de usuarios.

## Límites y uso

Chrome 153.0.8010.36 y Edge 153.0.4234.32 se ejecutaron realmente **en Linux VPS**, no en la PC Windows del usuario. Se usaron datos sintéticos y Turnstile oficial de prueba; no se simuló una caída sobre producción ni se acredita el proveedor real mediante ese laboratorio.

Hace falta preparar previamente una copia autorizada con conexión. La autorización dura hasta 24 horas y la sesión se bloquea tras 30 minutos de inactividad. El navegador cerrado no sincroniza; borrar el almacenamiento puede perder pendientes. Si no concede o pierde persistencia, se conserva lo cifrado y se bloquean nuevas escrituras offline. La prueba de cierre completo verificó específicamente este estado de solo lectura tras perderse el permiso CDP de pruebas; no garantiza que cada navegador conceda persistencia automáticamente.

Una web identifica el perfil de navegador, no acredita hardware físico. El cifrado protege datos bloqueados, no una sesión abierta frente a malware o extensiones invasivas. No se promete revocación inmediata mientras el navegador esté completamente desconectado.

Para empezar: guardar trabajo y cerrar todas las pestañas de Clarín si hay una actualización pendiente; reabrir con conexión, solicitar acceso desde Configuración → Offline, obtener aprobación del superadmin y preparar los recursos elegidos hasta «Copia verificada y lista». No borrar caché ni instalar nada. [Guía de operación](offline-v4-operacion.md).
