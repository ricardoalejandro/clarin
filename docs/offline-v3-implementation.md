# Offline web v3 — diseño histórico, sustituido por v4

**No es el contrato vigente.** El usuario requiere web sin instalar nada. Continuar desde `offline-v4-checkpoint.md`; no desde los requisitos Windows descritos como historia debajo.

Estado: implementación autorizada el 2026-09-14. No constituye evidencia de pruebas ni despliegue.
Sustituye el diseño Electron v2; no elimina sus datos ni el historial de implementación.

## Resultado y límites aprobados

- Entrada por la URL web habitual, Chrome/Edge en Windows 11 x64, incluso tras cerrar navegador/reiniciar Windows sin Internet.
- Motor Windows invisible, servicio restringido; instalación UAC y permiso de red local del navegador una vez. Sin Vault, PKI, certificado cliente ni firma comercial obligatorios.
- Superadmin autoriza instalación + principal Windows + perfil navegador + usuario Clarín + cuenta. Una instalación software no equivale a atestación inviolable de PC física.
- Diez usuarios por turnos en un perfil; una identidad activa por perfil, todas las pestañas bloqueadas al cambiarla. Datos/claves/colas separados por grant, también entre usuarios de la misma cuenta.
- Usuario selecciona recursos dentro de aprobación y ACL vigente. Hasta 20 recursos/grant; hasta 5 cuentas en piloto; presupuesto total 5 GiB (incluye margen de shell, spool y transacciones).
- Tareas: lectura, creación y completado. Contactos, Programas y Pizarras: solo lectura. Ninguna otra escritura offline implícita.
- Lease máximo 72 horas, sin requisito de mismo arranque. Renovación únicamente tras validación autenticada completa de grant, épocas y controles, nunca por mera conectividad.
- Caída de Internet/Cloudflare/backend ofrece entrar offline o esperar. No desbloquear ni encolar automáticamente.
- Reconexión conserva sesión local, ruta y borradores. Sincronización sellada independiente de login online. Nunca emitir cookie online desde lease/prueba de dispositivo.
- Mismo usuario y contraseña Clarín para desbloqueo local; nunca persistir contraseña, hash servidor ni JWT online en almacenes offline. Bootstrap y lease incluyen `login_binding_sha256` (SHA-256 hexadecimal lowercase del username canónico exacto, misma semántica de trim/case que el login online). El motor comprueba esa vinculación antes de abrir las claves; no admite fallback sólo-contraseña. El username no es un segundo factor: conocer usuario y contraseña compartida permite autenticarse igual que online. No prometer resistencia a administrador local/malware privilegiado.

## Contrato entre componentes

- Versión protocolo: `3`; namespace servidor `/api/offline/v3`; namespace local `/v3`; servicio loopback `http://127.0.0.1:17373`.
- Origin permitido: el origen HTTPS configurado de Clarín; nunca comodines. Loopback debe validar Host/Origin/preflight, tamaño, tasa, nonce y prueba de posesión.
- Identificadores UUID independientes: `installation_id`, `windows_principal_id`, `browser_profile_id`, `authorization_id`, `grant_id`, `user_id`, `account_id`. Backend deriva identidad desde grant; cuerpo del cliente nunca concede cuenta/usuario.
- Acciones exactas: `tasks.read`, `tasks.create`, `tasks.complete`, `contacts.read`, `programs.read`, `whiteboards.read`. Efectivas = aprobación superadmin ∩ ACL actual ∩ funciones implementadas y flags.
- Un `grant_id` pertenece a una autorización/usuario/cuenta y no se reasigna. FKs de datos por `(grant_id, account_id)`; receipts por grant/operation; no caché compartida privada entre grants.
- Backend v3 aditivo y flag desactivado por defecto hasta gates. HTTP 503 JSON `offline_v3_disabled` si desactivado. No migrar aprobaciones v2 automáticamente.
- Lease firmado incluye tuple completo, épocas/revisiones, selección digest/revisión, acciones, cuotas, issued_at/expires_at y versión de clave. Rechazar más de 72 horas y downgrade.
- JOSE estándar: JWS ES256; JWE ECDH-ES+A256KW + A256GCM; P-256; claves separadas para firma/cifrado. Allowlist estricta de algoritmos. No criptografía DH artesanal.
- AAD/claims interiores vinculan versión/grant/usuario/cuenta/navegador/módulo/recurso/revisión. Sustituir un sobre entre grants debe fallar cerrado.
- DTO local solo permite comandos finitos, nunca proxy arbitrario HTTP, SQL, shell o rutas de archivos.
- API error estable y seguro: `{error: string, message?: string}`; nada de credenciales, rutas privadas o datos personales en logs.

## Dos planos de seguridad

1. Datos desbloqueados: DEK, clave firma de operaciones y clave descifrado snapshots por grant, envueltas por contraseña con Argon2id (64 MiB, t=3, p=1) y protección servicio. Claves abiertas solo RAM. Bloqueo tras cierre/logout/30 min inactividad/heartbeat perdido; throttle persistente de contraseñas.
2. Transporte sellado: snapshots/resultados servidor→grant JWE; operaciones firmadas al editar y JWE a ingesta servidor. Servicio puede transportar sobres tras reinicio sin abrir el vault. ACK de transporte no significa reconciliación descifrada.

SQLite separado por grant y cifrado por registro; ningún campo privado en DB/WAL/temp/log/index. Consulta paginada y memoria acotada; no cargar 5 GiB o diez usuarios completos.

Servicio LocalService + SID propio; ProgramData ACL restringida a servicio/SYSTEM/admin. SID de inscripción obtenido por helper nativo y named pipe autenticado, no declarado por JavaScript. Identidad hardware opcional; BitLocker/TPM no requisitos manuales.

Reloj: tiempo firmado, high-water durable, detectar retroceso y fallar cerrado. No hay contador software inviolable frente a restauración completa privilegiada. Revocación sin conexión limitada por tiempo restante del lease; máximo 72 h. Preservar cola pendiente al caducar y no borrarla silenciosamente.

## Web y sesión

- CSR estático sin Next/RSC, reutilización de componentes a través de adapters de navegación/datos/capacidades. Navegación History API sin recargas; no cachear documentos personalizados por ID.
- Service Worker cachea solo shell/activos públicos versionados con manifiesto íntegro staged/commit; jamás `/api`, HTML con sesión o datos privados. Conservar build actual/anterior; chunk recovery no destruye último shell válido.
- Registro SW en raíz (incluido login); login normal continúa con Turnstile. HTML Cloudflare o 52x significa infraestructura no disponible, no contraseña incorrecta. JSON Clarin 401/403 no se transforma en autorización offline.
- IndexedDB navegador solo clave WebCrypto no exportable, IDs opacos/públicos; capacidades de sesión en RAM. Ningún fallback a cuenta predeterminada.
- Indicador persistente: modo, usuario/cuenta, pendiente/última sync/caducidad/conflictos. Distinguir guardado local de confirmado servidor.
- Recursos no descargados no se representan como vacíos. Estado preparando/disponible/error. No anunciar listo hasta shell+datos+lease durables completos.
- Cambios de identidad invalidan requests, sockets, borradores activos y tabs anteriores antes de abrir siguiente grant. Auth online de otra identidad nunca sincroniza esa cola.

## Backend y consistencia

- Usuario activo, cuenta activa, membresía actual y ACL actor-aware por recurso dentro del repositorio. Épocas durables de credenciales/autoridad y controles separados de permisos de datos.
- Control por instalación/principal/navegador/autorización/grant/selección; revocado conserva canal solo-control, no snapshots ni nuevo lease.
- Snapshot: autorización+selección+versión+payload coherentes en transacción, orden de locks compatible con revocación. DTO allowlist; no `domain.*` completo.
- Contacto: identidad funcional; sin metadatos WhatsApp/Google/dispositivo; solo observaciones directas autorizadas. Sin contexto CRM transitivo implícito.
- Programa: cierre explícito mínimo roster/sesiones/asistencia; joins cuenta/programa/sesión/participante; matrícula inclusiva, retiro/completado exclusivos; separar activos/historia/fuera de ventana.
- Pizarra: escena y assets referenciados; sin bibliotecas/pizarras enlazadas remotas.
- Tareas: lista real/Entorno/workflow/status, filas actor-autorizadas; sin relaciones CRM no seleccionadas. Create/complete comparten comando canónico con online.
- Mutación+actividad+receipt+event outbox en una transacción. Dispatcher idempotente; redelivery de evento estable permitido, nunca doble mutación/recurrencia.
- Crear y completar la misma tarea aún sin red: `tasks.complete` puede llevar `base_version=0` y `depends_on_operation_id` del create local durable, derivado por el motor. El servidor sólo resuelve la versión desde un receipt create aplicado al mismo grant/cuenta/recurso. Dependencia aún no recibida es reintentable sin emitir receipt; dependencia rechazada no autoriza escritura. Una modificación posterior del servidor sigue produciendo conflicto; la dependencia nunca implica sobrescritura incondicional.
- `operation_id` antes de mutación online. Respuesta perdida = `outcome_unknown`; no reenviar como operación offline distinta. Resolver receipt antes de retry.
- Conflictos conservar servidor, exponer cambio rechazado para revisión; nunca pérdida silenciosa.

## Gates de calidad y publicación

- Unitarios por cambio funcional; Go backend/agente/signer, frontend unitarios/tsc/build. DB PostgreSQL desechable real: migración dos veces, FKs/ACL/locks/recibos/rollback.
- Matriz de 10 usuarios, dos en misma cuenta, uno en dos cuentas, switch simultáneo/stale tabs/swap de sobre, acciones denegadas, contraseña errónea/reinicio/throttle, expiración/rollback reloj/revocación, corrupción/disco lleno/cuota, replay/out-of-order.
- E2E: mismo URL, cierre/reapertura offline, reinicio real, Cloudflare HTML/52x vs JSON401/403, Turnstile, reconexión sin cambiar identidad/ruta/borradores, ACK perdido sin duplicados, cache sin PII.
- Windows 11 real Chrome y Edge, UAC/servicio/ACL/LNA. Runner Windows Server hospedado no sustituye evidencia Windows 11.
- PC local ofrecida por usuario pero no hay shell Windows conectado a esta tarea. Preparar harness acotado iniciable una vez por usuario, sin shell remoto permanente ni acceso a perfiles personales. Coordinar reinicio real.
- Objetivos: shell offline conocido <=2s, detección servidor inaccesible <=5s, consulta local 50 filas p95<300ms, unlock objetivo <2s; regresión online medida <=10%.
- Artefacto exacto comprobado y SHA-256 fijado; deploy no recompila instalador después del gate.
- `make deploy`; después docker ps, health backend, logs backend/frontend/signer, /api/version, esquema real Postgres y hashes del instalador publicado. Nunca declarar listo Windows por crosscompile/Linux.
- Rollback flags v3 off preservando DB/outbox/shell y v2 histórico. No borrar caches/grants para esconder fallos.

## Evidencia y continuidad

Actualizar `docs/offline-v3-checkpoint.md` después de cada bloque con archivos, pruebas reales, límites y siguiente acción. Este contrato no autoriza ampliar a otras escrituras ni desactivar controles de seguridad.
