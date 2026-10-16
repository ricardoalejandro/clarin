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

Límites que siguen siendo explícitos: movimientos entre listas/Entornos,
administración de estructura/acceso, cambios de colaboradores, recurrencia,
eventos de calendario y colaboración remota requieren conexión. Los indicadores
offline describen sólo la selección preparada y su fecha de actualización.
Se mantienen la autorización existente, 20 raíces y vigencia máxima de 24 horas.

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
```

Las integraciones PostgreSQL exigen `OFFLINE_V5_TEST_DATABASE_URL` apuntando a la
base descartable exacta `/v5_integration`. Las pruebas de navegador deben cubrir
preparación firmada sintética, corte real de red, mismos componentes/ventanas,
guardado, F5, reapertura, conflictos y ausencia de llamadas remotas. Un fixture
HTTP sintético comprueba cliente/almacenamiento/UI, mientras las integraciones
PostgreSQL comprueban autorización/persistencia del backend. No confundir estos
dos alcances con una prueba autenticada sobre datos reales.

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
