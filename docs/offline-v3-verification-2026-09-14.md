# Offline web v3 — implementación y verificación

Última actualización: 2026-09-14 22:49 UTC. Servidor y web desplegados y
verificados. Piloto offline **no activado**: siguen pendientes Windows real,
entorno QA end-to-end y el gate de dependencias de seguridad.

## Alcance entregable

La interfaz permanece en la URL habitual de Clarín. El servicio Windows local
es el motor de almacenamiento y sincronización, no una segunda aplicación de
trabajo. No se requiere Vault, PKI, certificado cliente ni Authenticode comercial.
Instalar y conceder los permisos iniciales del sistema/navegador sigue siendo
necesario; no se promete cero interacción de seguridad de Windows.

El superadmin concede acceso al conjunto instalación/principal Windows/perfil
de navegador/usuario/cuenta. El usuario escoge dentro de los recursos permitidos.
Tareas permite leer, crear y completar; Contactos, Programas y Pizarras son de
sólo lectura en esta versión. El indicador distingue guardado local,
confirmación del servidor, pendientes, conflictos y vencimiento.

## Evidencia obtenida

| Capa | Resultado comprobado |
| --- | --- |
| Backend | `go test ./...`, `go build` y pruebas PostgreSQL v3 pasaron. |
| Migraciones | Arranque/Migrate repetido dos veces sobre PostgreSQL 16 de QA; revalidación de ACL durante emisión de snapshots pasó. Regresión adicional: eliminación en cascada de usuario/cuenta y revocación de membresía directa pasaron tras corregir el trigger de épocas. |
| Tareas | Transacción tarea/actividad/receipt/outbox, replay concurrente, rollback, ACL y creación seguida de completado sin conexión pasaron con PostgreSQL real de QA. |
| Autenticación | Usuario/cuenta exactos antes de emitir sesión; contraseña real y Turnstile online; step-up y throttle persistente comprobados en las capas correspondientes. |
| Firmador | Suite Go con detector de carreras pasó; validación de JOSE tipado y separación de claves. |
| Frontend | Suite global: 223 archivos/1126 pruebas Vitest, 20 del fork y 3 de hardening; 10 pruebas focalizadas finales pasaron. TypeScript y compilación de producción final pasaron (33 páginas Next, shell CSR de 509 assets/22.822.470 bytes). |
| Navegador | Reejecución final de los diez escenarios Chromium sobre el CSR congelado: 10/10 pasaron (1,5 min, sesión 60152). Corte real del origen local, respuestas Cloudflare simuladas, caché pública, latch/reload/nueva pestaña y renderer de pizarra real. |
| Instalador | Compilación NSIS y análisis sintáctico PowerShell pasaron. Tests estructurales de rutas/ACL y separación de artefactos pasaron. No equivale a ejecutar Windows. |
| Motor nativo | Suites completas sin caché (`go test -count=1 ./...`, `go test -race -count=1 ./...`), `go vet ./...` y crosscompile Windows x64 de todos los paquetes pasaron. Integración Linux usa protector de pruebas, no DPAPI real. |

El último gate de cascadas reprodujo antes del arreglo un SQLSTATE 23503 al
eliminar el usuario padre: el trigger intentaba recrear una época con FK a un
usuario ya eliminado. Ahora distingue ese caso de quitar una membresía con
padres existentes; el segundo sigue revocando la autoridad. Después del arreglo
se repitieron migraciones/QA PostgreSQL, la suite completa Go (sesión 27767),
`go build ./cmd/server` y `git diff --check`, todos aprobados.

PostgreSQL de pruebas está separado de producción. Ninguna prueba positiva
basada en un servicio simulado cuenta como evidencia del servicio Windows real.

## Gate adicional: dependencias de producción

Durante la construcción, npm notificó alertas en el árbol de dependencias. La
consulta de sólo lectura `npm audit --omit=dev --json` devolvió exit 1 y **22
alertas: 3 críticas, 12 altas y 7 moderadas**. Las críticas corresponden a los
paquetes `next`, `jspdf` y `tar` (éste transitivo). El paquete `jose`, añadido
para v3, no aparece en ese informe; eso no demuestra ausencia de vulnerabilidades.

El resultado acotado está guardado en
`docs/offline-v3-dependency-audit-2026-09-14.json`. El conteo de npm no es una
prueba de explotación de Clarín; requiere revisar alcance real y remediación.
No se ejecutó `npm audit fix`, ni se cambiaron versiones mayores durante el
despliegue. La comparación con `HEAD` confirmó que **ninguna versión previa
cambió**: la única incorporación al lockfile es `jose@5.9.6`, sin dependencias
transitivas. Next `14.2.35`, jsPDF `4.2.0`, Fabric `6.9.1`, XLSX `0.18.5` y tar
`6.2.1`, entre las versiones alertadas, ya estaban presentes. No se observó una
alerta introducida por la nueva dependencia; eso no elimina el riesgo previo.

**No se declara aprobada la seguridad global del proyecto.** Antes de habilitar
el piloto se debe resolver este gate además de Windows: código malicioso del
mismo origen puede acceder a una sesión offline desbloqueada. El cifrado local
no sustituye la seguridad de la aplicación que tiene acceso a las claves en uso.

## Invariantes y límites de seguridad

- La copia privada y la cola están cifradas en el motor, separadas por grant;
  CacheStorage sólo contiene código/assets públicos. Los permisos offline no
  crean cookies ni sesiones online.
- Usuario y contraseña se verifican durante la preparación online. El motor
  vincula el login canónico y protege las claves con Argon2id y DPAPI del
  servicio. No se persisten la contraseña ni el hash de autenticación servidor
  en la caché offline. El nombre de usuario no es un segundo factor.
- Al cambiar identidad se invalidan capacidades anteriores. El modo offline
  persiste al recargar/abrir pestaña; una cookie antigua no puede cambiarlo. La
  vuelta online es explícita y exige autenticación normal para la identidad
  esperada.
- El lease dura como máximo 72 horas; la conectividad por sí sola no lo renueva.
  Una revocación remota no puede conocerse instantáneamente sin conexión.
- La comprobación del SID Windows ocurre en el enrolamiento. Las solicitudes
  HTTP posteriores prueban la clave del navegador, no un SID Windows vivo. No
  hay garantía inviolable contra copia privilegiada de un perfil, administrador
  local, malware o extensiones con control de la página.
- Las tareas conflictivas conservan la versión servidor y muestran el conflicto;
  no hay sobrescritura silenciosa ni reintento destructivo automático.
- Cerrar navegador bloquea las claves de lectura/escritura; el motor puede
  transportar sobres ya cifrados. Desinstalar conserva la cola y los datos
  cifrados para recuperación.
- El trabajo de contraseñas se limita a dos Argon2id simultáneos; un tercer
  intento concurrente devuelve ocupado sin consumir un fallo de contraseña.

## Windows y activación: todavía pendientes

Candidato final compilado a las 22:28 UTC:

- Ruta: `.runtime/offline/v3-candidate/Clarin-Offline-Setup.exe`.
- Versión: `3.0.0`, 4.506.959 bytes.
- SHA-256: `aeaf679ec7c5137185d11e6620d61084ef3674a7827f795b3375ebe611f9a5d2`.
- Verificación de bytes y rechazo de activación sin evidencia Windows: aprobados.
- Instalador público anterior conservado, SHA-256
  `53e152719f669fb9af9cf955a696a1debd75686b0d11ae4fb0641ef62a623aaf`.

No hay ejecutor Windows 11 conectado a esta tarea. Faltan las pruebas reales de
instalación/UAC, ACL/DPAPI, permiso de red local, 10 usuarios, Chrome y Edge,
cierre/reapertura sin conexión, reinicio, revocación, disco lleno y actualización
con operaciones pendientes. El diagnóstico `Test-OfflineV3.ps1` no aprueba esos
flujos ni fabrica evidencias.

La activación de producción requiere el hash exacto del instalador probado y
un reporte de aceptación Windows. Se debe coordinar además el entorno de QA
end-to-end: necesita backend/signer v3 habilitados con datos sintéticos, separado
de producción. No basta instalar el candidato contra un backend apagado.
El candidato actual fija el origen de producción; antes de ejecutar la matriz
se debe resolver el origen/entorno de QA y volver a comprobar qué bytes exactos
se promocionan. No se ha añadido una excepción al gate ni se han habilitado
usuarios de producción para evitar esta comprobación.

## Despliegue

Iniciado a las 22:32 UTC (sesión 84024):

```sh
env OFFLINE_V3_ENABLED=false OFFLINE_V3_TASK_WRITES_ENABLED=false OFFLINE_ENROLLMENT_ENABLED=false make deploy
```

`make deploy` finalizó con exit 0. Versión desplegada y comprobada tanto en
backend como en el dominio público:
`2026.09.14-1-223220180768184-d420a6bea1a5`.

Comprobaciones reales posteriores, entre 22:47 y 22:49 UTC:

- `docker ps --filter name=clarin`: backend, signer, codex-bridge, PostgreSQL,
  Redis y MinIO saludables; frontend y task-preview-worker en ejecución.
- Health del backend: `healthy`, PostgreSQL/Redis OK; los cuatro dispositivos
  WhatsApp estaban conectados en la comprobación.
- Logs recientes: backend (56 líneas), frontend (5) y signer (1) revisados; sin
  líneas error/fatal/panic en esa ventana. No equivale a monitoreo prolongado.
- PostgreSQL real: 20 tablas `offline_v3_*`; 0 grants y 0 solicitudes nuevas;
  función de épocas con la guarda de cascada confirmada.
- Flags reales: `OFFLINE_V3_ENABLED=false`, `OFFLINE_V3_TASK_WRITES_ENABLED=false`,
  `OFFLINE_ENROLLMENT_ENABLED=false`; cliente mínimo v3 `3.0.0`.
- Por HTTP desde el frontend: 509 assets, 22.822.622 bytes; todos sus tamaños y
  SHA-256 coinciden con el manifiesto del build desplegado. Worker con latch
  presente; manifiesto servido con `no-store`.
- Dominio público: `/api/version`, `/api/offline/v3/runtime/availability`,
  `/sw.js`, `/offline-v3/index.html` y `/login` responden 200; APIs conservan
  `X-Clarin-Response: 1`; disponibilidad confirma `enabled=false`. `/mcp`
  sin credenciales responde 401.
- Hash del instalador montado en backend coincide con el artefacto público v2
  anterior. El candidato v3 **no** se publicó ni se activó.

Se retiró sólo `clarin-offline-v3-qa-postgres` después de las pruebas: sus datos
sintéticos estaban en tmpfs y se regeneran con migraciones/fixtures. No se
eliminaron contenedores de datos de producción, volúmenes ni imágenes anteriores.

Imágenes anteriores registradas para trazabilidad (no eliminadas):

- Backend: `sha256:a10f2024a29e349367e53fdb865912f9dcfc967510d34b5195b5b025471141b1`.
- Frontend: `sha256:96c0ef3c3371f733dc611e3928a78d3cbff3074611e79449c0c9980b6a9f7b76`.
- Signer: `sha256:8622ddb901b645ec65a46fcf3c3bdb7c6cce9017de5d35657514038b1aaa1678`.
