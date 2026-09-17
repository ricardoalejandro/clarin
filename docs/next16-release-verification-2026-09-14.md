# Actualización estable Next.js: verificación de entrega

Estado: **actualización web desplegada y verificada el 2026-09-15; GO web / NO-GO activación offline por aceptación Windows pendiente**.

## Decisión y alcance

- Next.js 16.3.5 estable, React/React DOM 19.3.0, Node.js 24.21.0 LTS.
- Imagen Node fijada por digest `sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2` en construcción y ejecución. El Node global del VPS no se cambia.
- Se conserva Webpack explícitamente: no habilitar como efecto secundario Turbopack, React Compiler ni Cache Components.
- `middleware.ts` pasa a `proxy.ts`; conserva selección de host y navegación. No sustituye la autenticación ni el aislamiento de cuentas del backend.
- Ajustes React 19: parámetros de rutas cliente, referencias nullable y atributos `inert` booleanos. Los paneles cerrados y el editor durante una carga pendiente siguen bloqueando interacción.
- Fabric 7 conserva geometría y opacidad de documentos existentes mediante adaptador. jsPDF y SheetJS tienen pruebas de exportación/importación y entradas hostiles.
- Pizarras conserva el formato upstream 0.18.1; el fork interno pasa a `clarin.7`, con carga Mermaid negada antes de importar cuando IA está deshabilitada. Las revisiones anteriores no se reescriben.
- Se mantienen no-store, CSP y caché pública del shell; no se cachean credenciales ni respuestas privadas como parte de esta actualización.

Fuentes: [soporte Next.js](https://nextjs.org/support-policy), [migración oficial a 16](https://nextjs.org/docs/app/guides/upgrading/version-16), [ciclo Node.js](https://nodejs.org/en/about/previous-releases). Documentación de API contrastada con `frontend/node_modules/next/dist/docs/` del paquete instalado.

Comprobación repetida tras la advertencia del usuario, 2026-09-14 23:36 UTC:

- Producción todavía ejecutaba Next **14.2.35** / Node **20.20.2**, verificado dentro de `clarin-frontend`; no confundir candidato local con runtime.
- El registro oficial devuelve `latest=16.3.5`, distinto de `canary=16.4.0-canary.30`. El paquete viene de `https://registry.npmjs.org/next/-/next-16.3.5.tgz`, con SRI `sha512-MdtsTgzyfCPRLC6uJ1mN8ao7lyJ4BB0U6Inhnx3gta1UcCIdHK3yxLG0E8OWQteWD8/Q0qb8A5o7wJaL8M9y2w==` fijado en lockfile.
- Los avisos oficiales [AVIF RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4) y [Windows-hosted RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), publicados el 25 de agosto, señalan **16.3.3** como versión corregida.
- [16.3.4](https://github.com/vercel/next.js/releases/tag/v16.3.4) restablece AVIF con las correcciones subyacentes; [16.3.5](https://github.com/vercel/next.js/releases/tag/v16.3.5) es un release oficial estable de correcciones, no incluye todos los cambios pendientes de canary. Se comprobaron las notas de caché de imágenes, standalone y CSP. No se presenta ningún release como invulnerable ni se interpreta un advisory como evidencia de intrusión en este VPS.

## Evidencia previa al despliegue

- Compilación Next 16 con Node 24: PASS, TypeScript integrado y todas las rutas generadas; hardening de 909 artefactos y branding PASS.
- npm audit completo y producción: cero vulnerabilidades conocidas reportadas. El informe de supply-chain separado documenta también consultas OSV/GitHub y sus discrepancias; no equivale a ausencia absoluta de vulnerabilidades.
- Revisión independiente: una omisión de empaquetado detectada y corregida (`.gitignore` excluía SheetJS vendorizado); sin otros hallazgos accionables en el alcance revisado.
- Chromium Fabric: 2/2 PASS, movimiento real, geometría histórica, píxeles/alpha PNG y exportación PDF.
- Corpus histórico Pizarras: 4/4 estructural y 4/4 adaptador PASS. Reconciliación: 60 casos, incluidos 54 upstream, PASS.
- Vitest global final con Node24 y `--maxWorkers=2`: **228 archivos / 1.197 pruebas PASS**, 244,97 s. Fork23/23; scripts Node de hardening/fuentes/branding/seguridad29/29, incluidos los dos casos nuevos de empaquetado. TypeScript final PASS.
- La primera corrida detectó los fallos reales de `inert` y whitelist, corregidos con tests. Una repetición concurrente encontró timeouts y se interrumpió; los 13 casos afectados pasaron aislados y después en la suite global completa. No se aumentaron timeouts ni relajaron assertions.
- Go-all final tras alinear versión del editor en backend: PASS. El primer intento sandbox no podía abrir un socket local de httptest; repetición con ese permiso: PASS.
- Node gates instalador/laboratorio:14/14 PASS; ninguna prueba fabrica evidencia Windows.
- Pizarras producción local: Mermaid + colaboración Chromium2/2 PASS; el escenario de fuentes está limitado a Firefox y pasó1/1 allí. Egress:282 solicitudes, cero violaciones CSP/intentos no autorizados; una navegación a `whiteboard-link.invalid` fue un click explícito de la prueba, no conexión automática. Dos abortos de chunks locales durante navegación quedaron registrados.
- Shell/SW Chromium:10/10 PASS, caída real de socket, Cloudflare503/challenge, rechazo Clarin403/429 respetado, caché sin datos privados, reconexión/reload/nueva pestaña, actualización corrupta y renderer/fuentes offline.
- Scanner del trace con los orígenes controlados de la prueba (incluido el enlace explícito) PASS; scanner de branding PASS,2 superficies/92acciones/32archivos/6avisos. La primera ejecución del scanner sin la excepción del enlace explícito falló correctamente; se contrastó con el caso de prueba antes de repetir.
- Comando completo `npm run test:unit -- --maxWorkers=2`: PASS exit0 (fork23, scripts29, Vitest1197) antes de incorporar las9 pruebas adicionales de licencias, que pasaron separadamente y ya forman parte del comando habitual.
- Distribución de licencias: bundle determinista de247 componentes/123textos, con exclusión explícita de fsevents opcional Darwin no distribuido. Nueve pruebas PASS; append al NOTICE existente, sin ampliar la política de branding. El caso react-remove-scroll-bar usa el MIT explícito del paquete y el texto oficial del mantenedor fijado a commit; se documenta que su gitHead npm no está disponible, sin afirmar equivalencia de fuente inexistente. No cambia el lock ni el SBOM.
- Renovación tras medianoche: [audit público del15 de septiembre](security-dependency-audit-refresh-2026-09-15.json),00:00:38–00:00:44 UTC,710 versiones consultadas completamente en OSV/GitHub y npm all/prod cero, sin errores de consulta. Lock, advisories brutos y paquetes coincidentes se compararon con `assert.deepEqual`: idénticos al informe anterior, por lo que sigue aplicando su clasificación documentada SheetJS/no afectado y esbuild/retirado.

## Recuperación y límites

Imágenes previas conservadas, sin eliminarlas:

- frontend: `sha256:2bdff8c1f3b389de1a5047575e7202042d7350640c5da2dc61e559c7a95abc64`.
- backend: `sha256:9fa0d0a6f703272ca85a82e763aacb4c6d08a0e5f903ac04763f47488afa9b6f`.

La actualización no añade migraciones de datos. La recuperación operativa puede reutilizar las imágenes anteriores conservadas sin revertir datos; sólo procede ante una regresión verificada y debe restaurar después una versión parcheada. El despliegue anterior contiene las alertas documentadas, por lo que no es una alternativa de seguridad permanente.

El piloto offline v3 permanece deshabilitado, igual que las escrituras v3 y nuevas inscripciones v2. La aceptación Windows 11 real Chrome/Edge del instalador exacto sigue pendiente: Linux, Chromium y el laboratorio aislado no la sustituyen. No se publica el candidato Windows ni se fabrican reportes de aceptación.

## Despliegue y comprobaciones reales

`make deploy` finalizó **exit 0** (sesión74216), con `OFFLINE_V3_ENABLED=false OFFLINE_V3_TASK_WRITES_ENABLED=false OFFLINE_ENROLLMENT_ENABLED=false`, usando Node24 temporal. Log: `/tmp/clarin-next16-deploy.log`. La instalación limpia Docker pasó con cero alertas npm; compilación, TypeScript, 32 páginas estáticas y empaquetado completados.

Verificación real posterior, 2026-09-15 00:11–00:16 UTC:

- Versión interna y pública: `2026.09.14-1-235507698122867-d420a6bea1a5`.
- Dentro del frontend: Next **16.3.5**, Node **24.21.0**, UID **1000**. No se ejecuta como root.
- Imagen frontend: `sha256:8e14b1a4e70a6fac1ce50b770977a1d1e3029337b36db644596418ecc90874b2`.
- Imagen backend: `sha256:21fbdd6fed0d54fcf78989744019d9651e7bbeaebfba221c8086f7dc04dc27c0`.
- `docker ps` comprobado; backend, PostgreSQL, Redis y signer saludables; frontend/worker activos. `/health` confirma PostgreSQL y Redis.
- Logs frontend: arranque listo, sin errores/advertencias en la ventana inspeccionada. Backend: dos WARN de cierre de socket WhatsApp con EOF; no son fallos Next/SQL. WhatsApp **2/4**, igual que antes del despliegue; no se afirma 4/4 ni salud de todas las sesiones del proveedor.
- Login, SW, shell, manifiesto y versión disponibles por origen interno y dominio público. SW conserva ámbito `/` y no-store; shell conserva CSP restrictiva, nosniff y DENY. No se presenta esto como endurecimiento completo de todas las rutas históricas.
- **509/509 archivos / 23.230.112 bytes** descargados por HTTP desde el frontend real: SHA-256 y tamaño correctos. El manifiesto público coincide byte a byte. Fuente WOFF2 pública comprobada. NOTICE público legible y con los **305.734 bytes íntegros** del bundle de licencias archivado, SHA `8118dca3712a632e9fc4b035dda13f14fc81df4e4c8ac62a1134070a6f492aba`.
- `/mcp` sin bearer devuelve **401** en puerto interno8081 y dominio público. El primer diagnóstico apuntó por error al puerto API8080 y obtuvo404; se contrastó el enrutamiento existente y se corrigió el diagnóstico, no el producto.
- PostgreSQL real: **20 tablas v3, 0 grants, 0 solicitudes**. Los tres flags siguen false; disponibilidad pública v3=false/task-writes=false/minimum-client3.0.0.
- Instalador candidato y público conservan sus SHA previos; ninguno fue reconstruido ni promovido en este cierre.
- Evidencia estructurada sin credenciales: [runtime verificado](next16-runtime-verification-2026-09-15.json).

Laboratorio recapturado con estas imágenes exactas (captura4): refresh/up/smoke7/kit PASS. Login real con claves oficiales de prueba Turnstile, identidad en `/api/me`, cambio A→B autorizado y cambio de cuenta ajena403 sin cookie ni cambio de identidad: cuatro comprobaciones PASS. Dos cuentas sintéticas/diez usuarios, cero grants/solicitudes. Los nueve unitarios QA y seis gates de artefactos pasaron también en la comprobación final. [Informe QA](offline-v3-qa-verification-2026-09-14.md).

**Decisión:** actualización de dependencias web entregada. Offline v3 sigue deshabilitado. Falta conectar una Windows11 x64 de pruebas y completar Chrome/Edge, instalación/UAC, DPAPI/ACL, cierre/reinicio, sincronización y aislamiento nativos sobre el EXE exacto. El laboratorio y el kit están listos; ninguna prueba Linux o mock reemplaza esa aceptación. No hace falta repetir implementación, build o despliegue para retomar ese gate.
