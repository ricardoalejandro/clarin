# Offline v4: aceptación de lotes grandes

Fecha: 2026-09-15. Resultado final: **PASS**, Chrome real, 56,5 segundos. Sólo laboratorio aislado `http://localhost:19444`, datos ficticios y perfil desechable; ninguna activación ni modificación de producción desde esta prueba.

## Alcance y resultado

- Login online real con Turnstile oficial de prueba, solicitud desde Configuración, aprobación superadmin, selección y preparación cifrada desde la UI.
- Lista nueva por corrida dentro de la cuenta sintética autorizada: no se borran ni reutilizan tareas grandes de otras corridas.
- Doce tareas con descripción de 100.000 caracteres `á` cada una: 200.000 bytes UTF-8 por descripción, 2.400.000 bytes en total.
- El compositor compacto offline no expone descripción. Las doce creaciones se ejercitan mediante el RPC público real del SharedWorker, con autenticación local propia del puerto, sin mocks, inyección en IndexedDB ni acceso a claves. Después se cierra ese puerto, se vuelve a desbloquear mediante la UI y se pulsa Sincronizar.
- Cola cifrada exacta de la cuenta/usuario: 12 antes de conectar, 0 después de sincronizar. Contraseña, títulos y texto conocido no aparecen sin cifrar en la copia persistida ni en CacheStorage.
- La API canónica devuelve exactamente los doce IDs originales, con descripción completa, autor, cuenta y lista correctos. Una sincronización adicional conserva doce tareas y cola cero: no hay duplicados ni pérdidas.
- Guardia del navegador sin solicitudes fuera del origen QA y del widget oficial permitido. El endpoint de métricas rechaza consultas sin el identificador del laboratorio con HTTP 403.

## Evidencia de transporte

El gateway QA conserva únicamente un máximo de 128 registros de bytes/HTTP y booleanos. Para un HTTP 409 examina temporalmente hasta 4 KiB de respuesta y retiene sólo si el error es exactamente `offline_replay_rejected`; no guarda cuerpos, IDs de operaciones, headers ni credenciales. Los contadores se reinician al terminar.

| Solicitud | Bytes del cuerpo | HTTP upstream | Resultado |
|---|---:|---:|---|
| Primer lote | 2.007.468 | 200 | Confirmación descartada deliberadamente por QA |
| Repetición del desafío | 2.007.468 | 409 | Rechazo exacto de replay, esperado |
| Reintento con desafío nuevo | 2.007.468 | 200 | Confirmación recuperada sin duplicados |
| Segundo lote | 401.717 | 200 | Resto de las tareas confirmado |
| Cuatro refrescos de recursos | 316 cada uno | 200 | Copias canónicas reconciliadas |

Todos los cuerpos son inferiores al límite conservador del cliente, 2.031.616 bytes, y al límite del backend, 2.097.152 bytes. El rechazo de replay no se trata como commit exitoso; se exige un HTTP 200 posterior y la comprobación canónica de las doce tareas.

Las dos primeras ejecuciones detectaron una aserción demasiado estricta del propio arnés: exigía HTTP 200 también al replay provocado por la pérdida deliberada de ACK. Se corrigió únicamente la observabilidad y la clasificación estricta del test. No se cambió código de producto para aceptar el 409.

## Artefactos y repetición

- Prueba: `tests/offline-v4-flow.spec.ts`, caso `real large UTF-8 task queue splits below 2 MiB and syncs twelve operations exactly once`.
- Reporte: `test-results/offline-v4-large-batch-report.json`, incluido adjunto `sync-wire-metadata`.
- Frontend QA: `sha256:9837767c10a5cbe6aeb98028b14c14ac10ca074707b4ff7951cd9bd7c507907b`.
- Backend QA: `sha256:341b48684c1cdd724d4ed730e39f5f015d3773218b91c6b092dcdc75aa77e321`.
- El frontend QA reutiliza el Next de localhost verificado y actualiza sólo el runtime independiente. Nunca es un artefacto de producción; el despliegue oficial se recompila con `make deploy`.

Con el laboratorio identificado y sus imágenes finales activas:

```sh
env PATH=/tmp/clarin-dependency-audit.F6zvFHNc/node-v24.21.0-linux-x64/bin:$PATH \
  OFFLINE_QA_CHROME=/tmp/clarin-v4-browsers.TVGRsT/chrome/opt/google/chrome/chrome \
  PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/offline-v4-large-batch-report.json \
  npx playwright test --config playwright.offline-v4.config.ts \
  tests/offline-v4-flow.spec.ts --project=chrome --grep 'real large UTF-8' \
  --reporter=line,json --output=test-results/offline-v4-large-batch
```

Unitarios de QA finales: 10/10 PASS con Node 24 (`browser-sync-metrics`, `browser-deploy-contract`, `browser-runtime-check`). Los dos unitarios que lanzan subprocesos requieren permiso de ejecución fuera del sandbox; el fallo inicial EPERM fue de entorno, no de las aserciones.

Esta evidencia focalizada complementa las pruebas anteriores Chrome/Edge de aislamiento y reapertura. No equivale a probar nuevamente todos esos flujos, un Windows físico, ni el proxy de producción; esas verificaciones tienen registros separados.
