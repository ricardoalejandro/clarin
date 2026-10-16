# Offline: revisión aislada y reversión

Esta rama mejora el acceso offline de las páginas actuales de Tareas, Contactos,
Programas y Pizarras. El punto de partida es
`7b777ef347b4e8156450312f5f8a7b74be5cdf07`, el commit que tenía el VPS al iniciar
la revisión. Este documento no autoriza fusionar ni desplegar el PR.

## Aislamiento de esta entrega

- Código en un worktree `codex/offline-parity`; el checkout del VPS y sus cambios
  locales no se usan para implementar, compilar ni ejecutar tests.
- Pruebas en Linux local (WSL), con contenedores `clarin-offline-qa-*`, código de
  esta rama, PostgreSQL descartable `v5_integration` y datos sintéticos.
- Sin `.env`, cookies, sesiones, claves del firmante, dumps ni medios de producción.
- Las pruebas nuevas de navegador exigen un origen HTTP loopback explícito;
  rechazan un origen remoto. Nunca tienen la URL productiva como valor por defecto.
- No ejecutar `make deploy`, modificar flags productivos, migrar la base real,
  reiniciar servicios ni publicar esta compilación de laboratorio.

La compilación QA contiene direcciones locales. Una futura publicación requiere
una compilación de producción nueva mediante el flujo habitual, después de una
autorización de despliegue independiente.

## Factibilidad e intento anterior

Es viable reutilizar las páginas, ventanas y editores actuales con una capa local
de datos. La equivalencia cubre los recursos preparados y las operaciones que
pueden validarse localmente; los servicios externos y las acciones no preparadas
necesitan conexión. La selección, la vigencia y el estado de sincronización deben
permanecer visibles para que una copia parcial no parezca toda la cuenta.

La revisión del punto de partida encontró dos problemas distintos:

- `frontend/src/offline-v4/OfflineRuntimeApp.tsx` montaba vistas separadas de
  `components/offline-v3`. `OfflineProgramsView.tsx` era de sólo lectura y
  `OfflineTasksView.tsx` tenía un formulario reducido. El documento
  `docs/offline-v4-verificacion-2026-09-15.md` reconoce que las descripciones se
  probaron por RPC porque su interfaz offline no incluía ese campo.
- v5 ya empaquetaba las páginas canónicas, pero su adaptador no siempre respetaba
  sus contratos: la ruta de Pizarras devolvía la escena cruda cuando el editor
  esperaba un registro con `scene` y `sequence`. Las pruebas de shell comprobaban
  HTML y cabeceras sin abrir, editar y recargar los módulos con datos preparados.

Por eso esta rama conserva los componentes actuales y prueba sus flujos reales.
Chromium permite simular la desconexión con Playwright `context.setOffline(true)`;
el laboratorio corta además la autoridad HTTP sintética para que un Service Worker
no pueda seguir consultándola. El almacenamiento, el cifrado y los workers del
navegador son reales. Esta prueba no necesita desconectar ni intervenir el VPS.

## Comportamiento que debe revisar el PR

La interfaz sigue siendo la canónica. El adaptador local conserva la jerarquía
autorizada, filtros, páginas y contadores de Tareas, el perfil Contact contextual
de participantes y los registros de escena/permisos/confirmación de Pizarras.
Los cambios sucesivos conservan su base y dependencias; una confirmación antigua
no sustituye un borrador más reciente. Los conflictos conservan las variantes
local y servidor hasta una decisión explícita.

Los adjuntos originales verificables de hasta 50 MiB se preparan cifrados y
cuentan para la cuota. Imágenes, PDF y texto se abren en el visor habitual; otros
formatos preparados permiten descargar el original. Convertir documentos,
añadir archivos nuevos y comentar adjuntos siguen requiriendo conexión.
Las imágenes existentes de Pizarras conservan su transporte cifrado. Un perfil
v5 no cae automáticamente en la interfaz paralela v4 si falta su shell; sus
pendientes se conservan. Las copias exclusivamente v4 mantienen su recuperación.

El editor carga también sus 32 familias tipográficas desde la caché preparada:
`navigator.onLine` no sustituye la comprobación real de `FontFace.load()`.
La preparación termina sólo después de cargar las familias disponibles; una
fuente que realmente falte conserva el estado de fallo y su reintento. Se
mantienen el catálogo, las rutas locales, la concurrencia y la política de red.

Límites que siguen siendo explícitos: movimientos entre listas/Entornos,
administración de estructura/acceso, cambios de colaboradores, recurrencia,
eventos de calendario y colaboración remota requieren conexión. Los indicadores
offline describen sólo la selección preparada y su fecha de actualización.
Se mantienen la autorización existente, 20 raíces y vigencia máxima de 24 horas.

Los cambios de campos acotados reservan espacio para poder materializar sus
conflictos dentro de la misma cuota, sin duplicar las variantes cifradas. Una
escena no acotada, una operación anterior sin reserva o un nuevo reintento sin
espacio pueden fallar explícitamente por cuota; el fallo es atómico y conserva
la operación, el borrador o el conflicto para recuperarlos. No truncar variantes
ni borrar pendientes para liberar espacio forma parte de este contrato.

## Verificación y aceptación

Ejecutar en la copia aislada:

```sh
cd frontend
npm ci --no-audit --no-fund
npm run test:unit -- --maxWorkers=3
npx tsc --noEmit
NEXT_PUBLIC_APP_URL=http://127.0.0.1:19445 \
NEXT_PUBLIC_API_URL=http://127.0.0.1:19445 \
NEXT_PUBLIC_BUILD_VERSION=offline-pr-review npm run build
cd ../backend
GOCACHE=/tmp/go-build go test ./...
cd ..
OFFLINE_QA_ORIGIN=http://127.0.0.1:19445 \
  npx playwright test --config=playwright.offline-isolated.config.ts
node scripts/offline/qa-conflict-dialog.mjs
node --test scripts/offline/isolated-qa-guard.test.mjs
```

Las integraciones PostgreSQL exigen `OFFLINE_V5_TEST_DATABASE_URL` apuntando a la
base descartable exacta `/v5_integration`. Las pruebas de navegador deben cubrir
preparación firmada sintética, corte real de red, mismos componentes/ventanas,
guardado, F5, reapertura, conflictos y ausencia de llamadas remotas. Un fixture
HTTP sintético comprueba cliente/almacenamiento/UI, mientras las integraciones
PostgreSQL comprueban autorización/persistencia del backend. No confundir estos
dos alcances con una prueba autenticada sobre datos reales.

El recorrido de módulos rechaza cualquier intento de red para sus datos o
archivos. Permite registrar exclusivamente las comprobaciones fallidas de
`GET /login`, `GET /sw.js`, `GET /api/public/security-config` y el intento
explícito de `POST /api/auth/login`: el login existente busca primero una
respuesta online para recuperar su CSP y el navegador comprueba actualizaciones
del Service Worker. La autoridad HTTP destruye también esas conexiones, sin
servir respuestas. El informe adjunta las rutas rechazadas y el estado de red
del navegador; no presenta «cero respuestas online» como «cero intentos de red».
La comprobación de fuentes incluye HTTP del contexto y del Service Worker, y
WebSockets de página y workers inspeccionados. No certifica captura de WebSockets
del SharedWorker: adjuntar ese inspector alteró su ciclo de acceso en Chromium,
por lo que el recorrido funcional lo deja sin inspección. El cargador modificado
usa `window.document.fonts`; no introduce transporte de fuentes en ese worker.

Los resultados ejecutados se registran en la descripción del PR. No aprobar la
equivalencia completa de todas las operaciones sólo por obtener un build o una
prueba de carga de HTML correcta.

## Reversión

Mientras el PR esté abierto, cerrarlo descarta la propuesta sin modificar el
sistema desplegado. La rama y los commits conservan todo el trabajo para revisarlo.

Si posteriormente se autoriza fusionar y desplegar:

1. Registrar los commits/imágenes de la versión anterior y respaldar los datos
   mediante el procedimiento habitual antes de la publicación.
2. Ante una regresión, detener nuevas preparaciones/operaciones con los controles
   existentes y conservar los datos locales. No borrar CacheStorage, IndexedDB,
   OPFS ni copias v4/v5 como reparación.
3. Recuperar o sincronizar los pendientes afectados antes de degradar el cliente.
   Las operaciones de esta rama con campos ampliados pueden requerir esta versión
   para sincronizar; un rollback no debe convertirlas en descartes silenciosos.
4. Abrir un PR de `git revert` de los commits fusionados (si hubo merge commit,
   usar su padre principal), sin `reset --hard` ni force-push sobre `main`.
5. Revisar ese PR y, sólo con autorización de despliegue, reconstruir y desplegar
   con `make deploy`; verificar contenedores, `/health`, logs y versión real.

Esta rama no agrega migraciones destructivas ni elimina tablas. Revertir código
no deshace las ediciones de negocio ya sincronizadas; esas correcciones requieren
su propia operación auditada. La conservación de pendientes forma parte de la
aceptación del rollback, no de una limpieza automática.
