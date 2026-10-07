# Integridad de Chats, Contactos, Programas y Encuestas

La revisión y la corrección abarcan UI, API, permisos, PostgreSQL, MinIO,
WhatsApp y WebSocket. Contact sigue siendo la identidad única. Todas las
operaciones conservan el aislamiento por `account_id`.

## Regresiones cubiertas

| Área | Comportamiento y prueba |
| --- | --- |
| Baja de dispositivos | Operación persistente, detach transaccional, mismo ID al reintentar, cuota hasta completar, leases y recuperación del checkpoint. |
| Sesiones | Identidad completa y fingerprint, reserva antes del ACK de vinculación, fencing de callbacks y preservación ante error. |
| Relaciones | Migración repetible `SET NULL (device_id)` conserva cuenta, Contact, Lead, Chat y Message. |
| Sincronización | Cuenta validada en handler, servicio y pool antes del proveedor. |
| Chat | `chat_id` autoritativo, fallback acotado y filtro reconciliado después de una baja. |
| Quotes | Extracción compartida y relleno auténtico sin cambiar cuerpo, lectura, autor ni contadores; PN/LID ambiguos no se adivinan. |
| Fichas | Sesión por cuenta, contexto y generación; abortos, respuestas antiguas y enlaces directos con inicialización tardía. |
| Observaciones | Permisos y pendiente por nota, pin idempotente y contadores canónicos incluidos ceros. |
| Historial | Cursor estable de 50, máximo 200, conjuntos de 0/50/51/205 y edición de nota fuera de las primeras 200. |
| Contactos | Borrador/aplicar, un único estado para lista/conteo/exportación, búsqueda 500 ms y catálogo personalizado. |
| Fotos | JPEG/PNG, cinco contextos, almacenamiento e inventario reales, cuota, archivo inválido, eliminación con `null` y scope/revisión. |
| Programas | Doce dependencias, carreras de borrado/creación, archivo/restauración e historial preservado. |
| Asistencia | Incorporación inclusiva y cierre exclusivo, sesiones celebradas y registros fuera de ventana conservados como historia. |
| Destinatarios | Cancelación y recarga al escribir/limpiar; identidades de participación y audiencia congelada. |
| Encuestas | Pendiente/errores de estado, resultados separados de vacío, página correcta y reintento. |
| Plantillas | Comparación de revisión bajo bloqueo y hasta tres lecturas/cálculos completos; copia íntegra y slug reservado. |
| Autenticación | 401 antiguo, barrera reemplazada, renovación pendiente, cancelación y Web Locks entre pestañas para cambios de cookie. |
| Teclado | Menú de fotos en portal, restauración tras cambio de etapa lento y preservación del foco elegido durante la espera. |
| Móvil | Exportación desde menú portaled y paginación de resultados con controles táctiles accesibles. |

## Laboratorio y comandos

El laboratorio utiliza PostgreSQL 16, Redis y MinIO con volúmenes independientes
y API/WebSocket propios. Los E2E exigen `synthetic: true` y URLs loopback; no
tienen fallback de producción. Credenciales, trazas y material de sesión quedan
fuera de Git.

Los archivos seleccionados son `tests/contact-integrity.spec.ts`,
`tests/program-survey-integrity.spec.ts` y `tests/device-integrity.spec.ts`.
La matriz de interfaz cubre 320, 375, 768, 1024, 1280 y 1440 px.

```text
backend: GOCACHE=/tmp/go-build go test ./...; go build ./...
backend HTTP: go test ./internal/api -count=3
frontend: Node 24, TZ=UTC, npm run test:unit -- --maxWorkers=2
frontend: npx tsc --noEmit; npm run build
git diff --check
```

UTC hace explícita la zona asumida por fixtures históricos de calendario.
El presupuesto del harness HTTP es acotado a 5 s. La inicialización fría de
Mermaid tiene un hook de 20 s con comprobación de ausencia de red; las
conversiones mantienen sus aserciones y el límite original de 5 s.

## Cierre de publicación

Este documento describe cobertura, no acredita por sí solo un despliegue.
La evidencia final debe registrar resultados completos, commit, versión,
respaldo, imágenes previas y verificaciones posteriores por SSH mediante
`make deploy`, health, logs y PostgreSQL. GitHub Actions permanece retirado.

El QA real se limita a la cuenta, el dispositivo y el único destinatario
autorizados por el usuario; sus identificadores quedan en evidencia privada.
Una prueba vinculada de desvinculación necesita el QR de un dispositivo
temporal; el dispositivo operativo se conserva.
El usuario indicó que esta ejecución termine sin vincular el dispositivo
temporal; la baja sin sesión se verifica con API, WebSocket y PostgreSQL reales.
