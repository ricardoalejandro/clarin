# Auditoría de etiquetas y pizarras

Fecha: 2026-10-12. Base revisada: `4cdf929e98817a08bdd6e140f38828f0edbfd1a9`, con la configuración actual de Eventos. Implementación aislada en `codex/etiquetas-pizarras`. No implica despliegue.

## Causa del fallo con el cursor

`ContactTagEditor` abría el menú en el portal contextual de las ventanas operativas. El host usa `pointer-events: none` para dejar interactivo el tablero; el menú no restauraba `pointer-events: auto`. El teclado seleccionaba porque seguía enfocado el combobox, mientras el hit test del puntero atravesaba sus opciones. Afectaba al editor completo y a la asignación directa cuando se alojaban en ese portal. Un chat independiente cuyo portal terminaba en `body` no tenía la misma herencia; el chat abierto dentro de una ventana sí podía heredarla.

El menú compartido `TagPicker` restaura explícitamente los eventos de puntero. Mantiene un solo contrato de portal, registro de overlays, cierre exterior, Escape, flechas, Enter, retorno del foco, posición visible y resultados acotados. La búsqueda cambia exactamente 500 ms después del último cambio de texto, aborta la anterior y comprueba generación y sesión de autenticación. Las etiquetas seleccionadas se muestran sin cargar el catálogo completo.

## Inventario de superficies de asociación

| Superficie activa | Implementación anterior | Implementación actual y alcance |
| --- | --- | --- |
| Contactos: detalle, gestión directa y editor completo | `ContactDetailSurface` → `ContactTagEditor`, menú afectado dentro de ventana | Mismos controles y API de Contact; `ContactTagEditor` es adaptador de `TagPicker`. Asignación directa conserva pending, reconciliación y rollback existentes; editor conserva borrador y guardado explícito. |
| Leads: detalle, gestión directa y editor completo | Identidad canónica del Contact dentro de ventana CRM | Mismo adaptador y arreglo de portal. Las etiquetas siguen perteneciendo al Contact; no se crean etiquetas comerciales independientes. |
| Eventos: participante, gestión directa y editor completo | Identidad canónica dentro de ventana operativa | Mismo arreglo compartido. Contexto `event_participant`; se conservan reglas y permisos de la ficha actual. Las etiquetas de Contact no se subordinan al cierre del Evento. |
| Programas: participante y editor completo | Identidad canónica dentro de `OperationalOverlayBoundary` | Mismo arreglo compartido. Contexto `program_participant`; no mezcla datos de varias participaciones. |
| Chats: ficha de Contact y editor completo | `ContactPanel` → `ContactDetailSurface` | Mismo selector para chat independiente y chat anidado. Sin segunda fuente de etiquetas en el Lead comercial del chat. |
| Contactos: crear Contact | Selector propio con búsqueda acotada en endpoint genérico y nuevas etiquetas temporales por nombre | `CatalogTagPicker`, selección múltiple local; consulta `contact_create`; envía `tag_ids` canónicos al crear. Selección, borrado y texto responden de inmediato. |
| Leads: crear oportunidad | Texto separado por comas | `CatalogTagPicker`, selección múltiple local; consulta `lead_create`; envía `tag_ids`, incluidos `[]`. Backend aplica unión aditiva con las etiquetas previas del Contact. |
| Importación Excel desde Contactos o Leads, modos Leads/Ambos | Selector propio, catálogo completo y creación duplicada | `CatalogTagPicker`, selección única; consulta `lead_import`; mantiene `import_tag` por nombre según contrato del importador. Cambiar/quitar etiqueta invalida la vista previa. “Sin etiqueta” limpia selección. No altera formato estricto Kommo ni reanima sincronización. |
| Contactos: Pegar desde Excel | Tabla de datos por fila, sin selector global de asociación | Conserva sus columnas de etiquetas como metadata de importación; no introduce un catálogo interactivo adicional. |
| Importación Excel en modo Contactos | Sin etiqueta global opcional del importador de Leads | Se mantiene ese alcance. Las columnas de cada fila siguen el contrato propio del importador. |
| Automatizaciones: asignar/quitar etiqueta | Campo de UUID manual | Selector visual único, consulta `automation`, hidratación acotada por ID para flujos guardados. Conserva `data.tag_id` y compatibilidad con `data.config.tag_id`; un valor vacío explícito prevalece sobre el antiguo. Un borrador inactivo puede estar incompleto; activar exige ID válido. |
| Difusiones: detalle de destinatario con Lead vinculado | Bloque activo de `LeadDetailPanel` → `TagInput`, catálogo completo y endpoints legado | `CanonicalContactTags` → editor compartido y API canónica de Contact con contexto del Lead. Capabilities efectivas, pending, bloqueo de doble escritura, rollback exacto, error y reintento; ignora respuestas de otra identidad. El resto del panel permanece intacto. |
| Difusiones: destinatario sin Lead vinculado | Ficha básica, sin asignador de etiquetas | Continúa sin introducir un editor sin identidad Contact comprobada. |
| Registro histórico legado sin Contact vinculado | Potencial escritura por ID de Lead | Etiquetas históricas legibles, con explicación de solo lectura; no inventa un Contact ni un destino de escritura. |

Todas las altas de etiquetas globales se ofrecen únicamente si el servidor devuelve `can_create` o la ficha canónica expone `can_create_tags`, y la creación sigue siendo validada por `PermTags` en backend. Seleccionar una etiqueta existente no exige permiso de administración de catálogo; exige el permiso del módulo/contexto que efectúa la acción. Los endpoints de búsqueda y escritura preservan `account_id`.

## Controles revisados que no asignan etiquetas

| Control | Resultado de la revisión |
| --- | --- |
| Filtros por etiquetas de Contactos y Leads | Son filtros de consulta con botones/checkboxes, no escrituras de Contact. Conservan sus fórmulas, inclusión/exclusión y semántica actual; no se migran al adaptador de asociación. Sus catálogos completos son deuda de escalabilidad separada. |
| Filtro de etiquetas de Difusiones / selección masiva de destinatarios | Filtra audiencia; no asigna etiquetas a cada Contact. Se mantiene su comportamiento. Su consulta general de catálogo es deuda separada. |
| `EventContactPicker` | Filtro inline de búsqueda acotada a 20, checks accesibles y selección masiva de audiencia. No se convierte en editor de etiquetas de Contact. |
| `EventRulesEditor` | La versión actual usa opciones inline acotadas y reglas booleanas de pertenencia. Se preserva la semántica incorporada en la actualización de Eventos; no se restaura el antiguo dropdown. |
| Configuración/administración del catálogo de etiquetas | Crea o modifica el catálogo; no es asociación de una etiqueta a una persona. Se conserva la autorización propia. |
| Work/Tareas | Las etiquetas de tareas son un modelo distinto; no se reutiliza metadata de Contact. No se encontró un consumidor activo de `TagInput` ni `TagSelector` dentro de Work. |
| `components/TagInput.tsx` | Permanece como componente legado sin usos productivos JSX tras migrar el bloque activo de Difusiones; se conserva su prueba previa. No se lo amplía ni duplica. |
| `components/chat/TagSelector.tsx` | Componente de filtrado sin consumidores productivos actuales; no se lo trata como asignador activo. |

No se encontró una acción masiva productiva adicional que escriba etiquetas de Contact desde las selecciones de tabla; no se añade una capacidad nueva de edición masiva.

## Contratos y estados comprobables

- Fichas existentes: búsqueda `/api/contact-profiles/:id/tags` con contexto real, límite 20; cambios por PATCH canónico de Contact. Los permisos se obtienen de capabilities y se validan de nuevo en backend.
- Formularios nuevos: `/api/tags/search?context_type=contact_create|lead_create|lead_import|automation&q=...&limit=20`; backend admite hasta 25. La hidratación de guardados usa `ids` acotados a 25, nunca catálogo completo.
- Selección única reemplaza; múltiple añade sin duplicar IDs. Retirar es explícito. Crear se bloquea durante la solicitud; guardar/analizar el formulario espera su resultado para no omitir la nueva etiqueta, conserva consulta tras fallo y permite reintentar; búsquedas y creación se cancelan al cerrar/cambiar sesión.
- La hidratación de una automatización muestra carga y distingue etiquetas eliminadas/no disponibles; una respuesta de otro nodo o cuenta no puede completar el nodo actual.
- La identidad canónica en Difusiones carga capabilities antes de editar, muestra estado pendiente, conserva hooks previos de confirmación, restaura exactamente la selección previa ante rechazo y acepta la colección canónica al éxito.
- Escape cierra primero el picker de importación y después el modal. Un rerender del propietario con un nuevo callback no borra la elección local.

## Evidencia y límites de verificación

Las pruebas unitarias cercanas cubren el contrato de puntero dentro de un host transparente, foco y cierre, modo único/múltiple, debounce exacto, carrera A-B-A, cambio de sesión, permisos, doble creación, hidratación, adapters de payload, selección de importación y rollback/reintento canónico. JSDOM verifica contrato y eventos, pero no realiza hit testing real CSS; por eso la matriz de navegador usa un navegador real y `elementFromPoint`, además de clic de Playwright.

Las focales iniciales de etiquetas pasaron en ocho archivos (38 pruebas). El suplemento sobre los últimos ajustes pasó en tres archivos (17 pruebas), con casos compartidos entre ejecuciones; no se suman como pruebas distintas. La primera ejecución focal agotó un plazo de 5 s en el flujo largo de importación bajo compilación simultánea; la repetición con presupuesto de integración de 10 s pasó. La tabla de la suite final conserva los resultados completos y sus reintentos. Las ejecuciones interrumpidas durante reinstalación o carga inicial no se declaran pasadas.

Pizarras: el aviso reportado fue “Demasiados eventos de colaboración”. Se corrigieron el scheduler y el transporte conservando las pruebas de idempotencia, colaboración, imágenes y aislamiento existentes. Los resultados efectivos se registran en las secciones de verificación.

## Backend — verificación final

Verificación ejecutada con Go 1.25.11, `GOTOOLCHAIN=local`, `GOMAXPROCS=2`, `GOCACHE=/tmp/clarin-etiquetas-go-cache` y paralelismo de paquetes `-p 1`. Se cargaron las credenciales privadas de QA sin imprimirlas. Para el helper de integración API se exportó `DATABASE_URL` desde `INTEGRITY_TEST_DATABASE_URL` y se habilitaron `CLARIN_RUN_TAG_ASSOCIATION_INTEGRATION=1` y `CLARIN_STORAGE_QA_POSTGRES_PORT=15457`.

| Comprobación | Resultado |
| --- | --- |
| `go test -p 1 ./... -count=1` | PASS en todos los paquetes; incluye API con integración PostgreSQL (125,890 s), Repository con integración PostgreSQL (119,401 s), Service (3,388 s), Whiteboard (3,396 s), WebSocket (0,022 s) y Database (1,579 s). |
| `go test -p 1 ./internal/api -count=1` después del último ajuste de `import_tag` | PASS (121,181 s). Revalida la API completa y la integración PostgreSQL, incluida la prueba multipart de conservación exacta del nombre elegido con comillas, backticks y Unicode. |
| `go test -p 1 ./internal/repository ./internal/api ./internal/service -count=1` tras la corrección final de importación | PASS: Repository con PG (62,878 s), API con PG (62,589 s), Service (3,013 s). Ejecutado después del delta final de Lead + etiqueta elegida atómicos. |
| `go build -buildvcs=false -p 1 -o /tmp/clarin-etiquetas-backend ./cmd/server` | PASS; repetido tras la corrección final de importación. Compila las rutas nuevas y la conexión de callbacks de automatizaciones. |
| `git diff --check` | PASS al terminar los cambios backend. |

La suite global `./...` se ejecutó antes del último ajuste de atomicidad del importador; las suites completas de Repository, API y Service y el build se repitieron sobre ese último delta. También pasaron antes sus focales de etiquetas con PG: Repository (20,798 s) y API (63,098 s). `TestImportedLeadSelectedTagIsAtomicAndAccountScoped` comprueba rollback sin Lead ante etiqueta ajena, ausente o borrada, aislamiento de Contact y bloqueo del DELETE concurrente hasta finalizar la transacción (`55P03` por `lock_timeout`). `TestTagAssociationAPIIntegration` prueba el ejecutor real: fallo de fila sin oportunidad parcial y reintento corregido que crea exactamente un Lead etiquetado sin omitirlo como duplicado.

El build estándar falló al obtener el estado VCS, antes de la compilación. El diagnóstico `go build -x` mostró que Go intentaba `cd /root/proyect; git status --porcelain`, fuera del worktree, y recibía exit status 128. `git status`, `git rev-parse` y `git log` sí funcionaron desde el worktree. Se desactivó únicamente el stamping VCS para el build de QA; no se modificó la metadata del directorio padre. El binario compilado no acredita despliegue ni salud de producción.

La integración usó exclusivamente PostgreSQL local de QA en `127.0.0.1:15457`, contenedor `clarin-etiquetas-pizarras-qa-postgres`, base `program_survey_integrity_test`. Los tests de Repository crean cuentas y datos sintéticos que eliminan al finalizar. El test API exige host, puerto y base permitidos, crea una base independiente con prefijo `clarin_tags_qa_`, ejecuta las migraciones reales y la elimina al terminar. La simulación del fallo del contador de observaciones fijadas cambia temporalmente una columna únicamente en esa base descartable; confirma que el PATCH falla antes de guardar las etiquetas. No se modificó el esquema ni los datos de producción, ni se activaron comunicaciones externas de Kommo o WhatsApp.

Las regresiones comprobadas cubren búsqueda por permiso de contexto y aislamiento de cuenta; hidratación acotada de IDs; `tag_ids: []` explícito y rechazo de `null`; precedencia de IDs frente a nombres legado; permiso `PermTags` para crear catálogo; unión aditiva con etiquetas previas; conservación de notas omitidas, procedencia y nombre canónico de Contact; rollback de Contact, Lead y etiquetas ante una oportunidad inválida; duplicados; ejecución de acciones de etiqueta ligada a `exec.AccountID`; asignación/quita idempotente y rechazo de etiquetas ajenas o eliminadas. Se verificó la compatibilidad de acciones de automatización guardadas como `data.tag_id` o `data.config.tag_id`, sin ampliar esa normalización a otros tipos de nodos.

Un borrador de automatización inactivo admite una acción de etiqueta vacía; activarla exige configuración válida de la cuenta. Si se elimina la etiqueta de una automatización activa, desactivarla continúa respondiendo 200; reactivarla se rechaza con 422 hasta corregir la selección. El callback de reconciliación de etiquetas usa un `RWMutex`, porque los workers pueden estar activos cuando `NewServer` configura dicho callback.

La etiqueta elegida manualmente para importar se valida por nombre exacto y cuenta en preview/import. La creación del Lead y la asociación aditiva de esa etiqueta por ID comparten una sola transacción; la fila de catálogo se bloquea con `FOR KEY SHARE` hasta el commit. Si la eliminación de la etiqueta gana primero o falla la asociación, el Lead se revierte y la fila puede reintentarse sin encontrar una oportunidad creada parcialmente. Una elección eliminada no recrea el catálogo y produce un error visible de fila. Contact puede haberse creado o actualizado previamente; su creación y las etiquetas, observaciones y metadata del archivo conservan el flujo legado fuera de esta transacción. La atomicidad integral del importador queda fuera del alcance y la sincronización Kommo permanece dormida. La alta manual mediante `POST /leads` guarda Contact, oportunidad y etiquetas dentro de una sola transacción.

También pasaron los casos backend de pizarras de presupuesto temporal independiente, distinción de tráfico temporal e inválido, preservación del `operation_id` y plazo de rate limit, y ACK final de replay únicamente tras encolar el delta completo. La saturación de la cola o un frame excesivo solicitan sincronización sin emitir un ACK falso de finalización.


Al cerrar la verificación backend se retiró exclusivamente el contenedor `clarin-etiquetas-pizarras-qa-postgres`, después de comprobar su nombre exacto y label `codex.task=etiquetas-pizarras`, y se eliminó `/tmp/clarin-etiquetas-qa.env`. Se comprobó su ausencia; se conservaron documentos, logs y el binario de QA. No se tocaron contenedores ni bases de producción.

## Frontend — suite final

Verificación con Node 24.21.0 y Vitest 4.1.11, usando las dependencias reconstruidas del worktree y un máximo de dos workers. El VPS presentó una elevada contención de CPU; se conservaron los resultados fallidos y se repitieron únicamente los archivos necesarios para investigar sus causas. No se modificó código de documentos, offline, historial de chat ni Work para hacer pasar estas comprobaciones.

| Comprobación | Resultado observado |
| --- | --- |
| `npm run test:unit -- --maxWorkers=2`, primera fase del fork | 8 archivos, 61 pruebas: 60 PASS y un timeout de 5 s de Mermaid. El encadenado se detuvo antes de scripts y aplicación. |
| Repetición de `clarinMermaidSecurity.test.ts` con un worker y timeout de 15 s | 1 archivo, 5/5 PASS; incluye el caso que agotó el plazo anterior. El fork conserva 61 casos únicos comprobados, sin sumar los repetidos. |
| Fase de scripts de `test:unit` (`node --test` de hardening, fuentes, dependencias, Tailwind, avisos y branding) | 47/47 PASS. |
| Suite de aplicación completa, `vitest run --maxWorkers=2 --testTimeout=15000` | 375 archivos: 370 PASS y 5 fallidos. 2216 pruebas: 2209 PASS y 7 fallidas. Un error no controlado adicional: un timer de `useDebouncedValue` después de destruir el entorno de `TaskMyWork.test.tsx`. Duración: 2243,97 s. Exit 1. |
| Aislamiento de los cinco archivos fallidos y `TaskMyWork.test.tsx`, un worker, timeout de 60 s | 6 archivos: 5 PASS y 1 fallido. 42 pruebas: 40 PASS y 2 fallidas. Los dos timeouts de `offline-v4/engine`, el panel offline, la exportación de documentos y Back del historial de chat pasaron. No se repitió el error del timer de Work. Persistieron dos esperas en `documents/[id]/page.test.tsx`. |
| Comparación exacta del archivo `documents/[id]/page.test.tsx` solo | Se extrajo `4cdf929e98817a08bdd6e140f38828f0edbfd1a9` con `git archive` a un directorio temporal, se enlazó el mismo `node_modules` y se usaron runtime, configuración, setup, worker y timeout equivalentes. Base: 4/4 PASS, 19,69 s. Rama actual: 4/4 PASS, 21,09 s. Ambos exit 0. |
| Suplemento final de selectores después de los últimos ajustes | 3 archivos, 17/17 PASS: `TagPicker` 8, `ImportTagPicker` 5 y `CanonicalContactTags` 4. Node 24.21.0, dos workers y timeout de 15 s. Complementa la suite; no se suma otra vez a sus casos coincidentes. |

Los siete casos fallidos de la ejecución completa obtuvieron un resultado correcto en las repeticiones. La comparación de documentos no reprodujo una regresión entre base y rama ni un fallo estable de la base. El patrón es sensible a carga u orden; su causa exacta no quedó demostrada. La ejecución completa conserva su exit 1 y no se declara una suite global completamente verde. Los resultados de navegador, typecheck y build son comprobaciones distintas y deben registrarse por separado.

Las 43 pruebas directas del cambio de pizarras pasaron en la suite de aplicación: transporte 21, clasificación de incidencias 11, scheduler 4 y guardado de invitados 7. Cubren timers vencidos, última posición del cursor, ráfagas de despertares, cooldown, cierre y reconexión; aviso hasta confirmación canónica, ACK final de delta, escena grande que requiere REST, prioridad de revocación y conservación del guardado pendiente con el mismo `operation_id`. Se mantiene el motor `0.18.1-clarin.8` y el contrato de guardado congelado de PR13.

La implementación evita dos fuentes identificadas de ráfagas: callbacks de un timer anterior que podían sobrevivir a un envío inmediato y solicitudes repetidas de recuperación al volver a la pestaña. Cursor y viewport comparten el mismo contrato de scheduler, con un valor pendiente por canal y separación mínima de 50 ms; sincronización y presencia se combinan en un lote de control cada 1 s. El rate limit incluye canal y espera, aplaza el envío y programa recuperación canónica. El timer despierta el reintento; el aviso solo desaparece tras una confirmación canónica aplicable. No se aumentaron los presupuestos de eventos del servidor.

Logs conservados en QA: `/tmp/clarin-etiquetas-frontend-tests.log`, `/tmp/clarin-etiquetas-frontend-tests-remainder.log`, `/tmp/clarin-etiquetas-unit-isolated.log`, `/tmp/clarin-documents-baseline-test.log` y `/tmp/clarin-documents-branch-test.log`. La base temporal está en `/tmp/clarin-documents-baseline.t5sowc`; no contiene credenciales y reutiliza las dependencias existentes sin reinstalarlas.


## Frontend — compilación y procedencia de QA

La fuente y las modificaciones proceden del checkout aislado del VPS. La elevada contención de CPU del VPS llevó a descargar una copia exclusivamente para QA en Windows, sin modificar el proyecto local como fuente del producto. Se compararon SHA256 de 2382 archivos elegibles de esa copia y el VPS, incluidos los tipos distribuidos del editor y los últimos componentes modificados: todos coincidieron. Los ajustes posteriores de los dos archivos de pruebas de navegador se copiaron desde el VPS y se compararon individualmente por SHA256. No se copiaron archivos de entorno ni credenciales. Los artefactos de build y referencias de tipos generadas por Next son salidas de QA.

Runtime local: Node 24.21.0, descarga oficial con SHA256 verificado, dependencias instaladas con el lockfile del VPS. El build y TypeScript se ejecutaron por separado de los navegadores después de cerrar el servidor de desarrollo propio para evitar presión de memoria. Se conservan logs en la carpeta aislada de QA.

| Comprobación | Resultado |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS sobre la fuente final, después del ajuste de anclaje. Exit 0. |
| `npm run build` | PASS sobre la fuente final, después del ajuste de anclaje. Exit 0. Preparación del editor/PDF, shell offline v4, Next webpack, TypeScript de producción, 34 páginas estáticas, CSS interactivo, shell offline v5 (671 artefactos) y verificación del editor. |
| `npm run verify:whiteboards:fixtures` | PASS: JSON base 4/4 y ciclo de archivo con adaptador Clarin 4/4. |
| Verificación final de motor y branding dentro del build | PASS: `0.18.1-clarin.8`, 946 artefactos sin rutas operativas upstream; 33 artefactos estáticos y seis avisos legales preservados. |

Logs locales de la fuente final: `local-tsc-final-geometry.log`, `local-build-final-geometry.log` y `local-compat-fixtures.log`. Las ejecuciones previas `local-tsc-final2.log` y `local-build-final.log` se conservan. El build de QA se sirve como standalone en `127.0.0.1:3018` únicamente para las comprobaciones del navegador. No equivale a un despliegue de Clarin en el VPS.


## Navegador — pizarras

Se ejecutaron seis casos Chromium contra el standalone local de Next en `http://127.0.0.1:3018`, con Node 24.21.0, un worker, `PLAYWRIGHT_LOCAL_SERVER` ausente y sin bypass de CSP. Las API y salas son fixtures controlados: esta comprobación acredita la compilación y la interacción local, no un despliegue ni una sesión real de producción.

| Caso | Resultado |
| --- | --- |
| Referencia visual 375, 768, 1024 y 1440 px | PASS, 11,2 s; cuatro PNG generados e inspeccionados. |
| Miembro abre antes de las imágenes, hidratación progresiva y guardado | PASS, 23,9 s. |
| Invitado abre antes de descargar la imagen | PASS, 6,4 s. |
| Presentación, consentimiento, viewport y entrada tardía | PASS, 38,9 s. |
| ACK perdido, error correlacionado, fallback idempotente, reconexión, revocación, aislamiento de red y adaptación responsive | PASS, 2,0 min. |
| Sesenta despertares, rate limit y aviso hasta confirmación canónica | PASS en repetición focal, 9,1 s; exit 0, 12,6 s total. La edición y el guardado posteriores pasan y el harness no registra rechazos adicionales del presupuesto. |

La primera ejecución agrupada terminó con cinco PASS y un fallo del locator global `getByRole('alert')`: la traza demuestra que encontraba el `__next-route-announcer__` de Next dentro de su shadow DOM, fuera del editor. Se acotaron aviso y alertas a `.whiteboard-editor-shell` y se repitió únicamente el caso afectado. No se cambió producto, servidor, CSP ni se añadió force click para resolverlo. El resumen inicial también contó un error fuera de cualquier test sin detalle adicional; se conserva esa evidencia. La repetición focal terminó sin ese contador. Son seis casos únicos comprobados; no se declara que la primera ejecución agrupada haya terminado con exit 0.

Se completó el fixture de Work con GET `/api/tasks/environments/:id` para el Entorno sintético exacto, usando los mismos datos que el índice. El deep link de la pizarra puede pedir el detalle antes de que termine de cargar la lista; el fallback genérico anterior no incluía `environment`. La prueba larga de Work pasó con la respuesta corregida.

Artefactos en el árbol QA de Windows: `local-whiteboard-production.log`, `local-whiteboard-production-rate.log` y `local-whiteboard-production-results/whiteboards-isolation-refe-3d917-Pizarras-en-cuatro-anchuras-chromium/pizarra-reference-{375,768,1024,1440}px.png`. La primera traza fallida se conserva en `local-whiteboard-production-results/whiteboards-isolation-cola-74819-solo-después-de-sincronizar-chromium/trace.zip`. El texto de muestra conserva el ancho de 110 px del fixture original “Entrada” al reemplazarlo por “Fuente local al abrir”; su recorte en las capturas no se presenta como una regresión del texto real del editor.


## Anclaje del selector tras inspección visual

Las capturas de Contactos en escritorio y móvil confirmaron que el puntero alcanzaba las opciones. También mostraron una separación de unos 230 px entre campo y menú cuando se abría hacia arriba con un solo resultado. El cálculo restaba el máximo de 280 px aunque la altura real del menú era de unos 54 px.

El helper ahora fija el borde inferior del menú a 6 px del campo usando `translateY(-100%)` al abrir hacia arriba. El porcentaje usa la altura efectiva del menú; se conserva el máximo según el espacio disponible y los offsets del viewport, sin añadir observers ni ciclos de medición. Abrir hacia abajo mantiene el anclaje al borde inferior del campo. Las pruebas puras cubren alturas pequeñas y máximas, offsets, bordes y clamping; la prueba del portal conserva puntero y transform. Pasaron 16/16 focales con Node 24: `contactExperience` 8 y `TagPicker` 8.

La matriz de navegador exige además una separación entre 0 y 8 px antes del clic o toque y guarda PNGs del menú de Contactos. Sobre la fuente final se comprobaron los 22 casos únicos descritos a continuación, y las dos capturas finales fueron inspeccionadas: menú junto al campo y dentro del viewport, sin el hueco previo. Las capturas anteriores se conservan como evidencia del defecto visual.


## Navegador — etiquetas

Chromium ejecutado con Node 24.21.0 contra el standalone del build final en `http://127.0.0.1:3018`, con `CLARIN_E2E_MOCK_AUTH=1`, un worker por ejecución y `PLAYWRIGHT_LOCAL_SERVER` ausente. Las API y los mensajes WebSocket usan fixtures sintéticos; no se modificaron datos ni se ejerció una sesión real del VPS. Los tests no usan clics forzados. Estas comprobaciones de interacción se complementan con la integración backend real de PostgreSQL documentada antes.

Se comprobaron **22 casos únicos: 11 del proyecto de escritorio y 11 del proyecto con capacidad táctil**. Los resultados se reconstruyen con las ejecuciones parciales y focales de la tabla; la primera ejecución agrupada terminó con exit 1 y no se declara completamente verde.

| Caso | Escritorio | Proyecto táctil | Anchura y evidencia |
| --- | --- | --- | --- |
| Contactos, Leads, Eventos, Programas, Chats y Chats incrustados | 6/6 PASS | 6/6 PASS | 1280 px con ratón y 375 px con toque. `elementFromPoint` alcanza la opción; separación campo–menú entre 0 y 8 px; asignación, persistencia tras recarga, error de guardado, rollback y reintento de retirada. |
| Difusiones: destinatario con Lead y Contact vinculados | PASS | PASS | 1280/375 px. Mismas comprobaciones de puntero, persistencia y rollback. La navegación usa el resumen en escritorio y el menú de acciones de la tarjeta a 375 px. |
| Editor completo del Contact en ventana flotante y maximizada | PASS | PASS | **1440 px en ambos proyectos**. Arrastre real de la ventana al borde inferior/derecho, scroll con rueda, picker visible y hit test; Escape conserva foco y Enter reasocia Comunidad. El borrador contiene Comunidad y Prioridad antes de un único PATCH, cuyo `tag_ids` se comprueba. Se guarda y cierra el editor bloqueante antes de maximizar su ventana propietaria; se reabre el editor y se comprueba de nuevo el selector y el descarte sin un segundo PATCH. No acredita ventana flotante a 375 px. |
| Crear Contact, crear Lead e importación | PASS | PASS | 1280/375 px. Selección por ratón o toque y por Enter; los formularios mantienen el borrador hasta guardar. Importación reemplaza la selección única sin conservar el ID anterior. Los formularios de alta se cancelan; sus payloads y persistencia se verifican en las pruebas cercanas y backend, no mediante este caso de navegador. |
| Dos sesiones del mismo Contact | PASS | PASS | 1280 px en ambas ejecuciones; la segunda sesión recibe el aviso WebSocket controlado y reconcilia el Contact canónico sin navegación ni F5. No acredita un proveedor WebSocket externo. |
| Automatización: asignar y quitar etiqueta | PASS | PASS | **1280 px en ambos proyectos** por tratarse del diseñador. Las opciones se seleccionan con ratón en escritorio y `tap()` en el proyecto táctil; el guardado conserva el ID seleccionado en ambos nodos. No acredita el diseño del editor a 375 px. |

| Log local conservado | Resultado y contribución a los 22 casos |
| --- | --- |
| `local-tag-final-geometry.log` | Exit 1: seis superficies de escritorio PASS; Difusiones falló al buscar el texto exacto del error en un contenedor que también tiene el botón Reintentar. Aporta 6 casos. |
| `local-tag-final-geometry-desktop.log` | Exit 1: Difusiones de escritorio PASS; el primer flujo de edición intentaba maximizar la ventana bajo el editor bloqueante. Aporta 1 caso. |
| `local-tag-final-geometry-desktop-rest.log` | Exit 1: el fixture devolvía la semilla de una sola etiqueta al recargar el Contact después del PATCH. Se corrigió el estado simulado para que GET y PATCH conserven las dos etiquetas guardadas; no aporta casos pasados. |
| `local-tag-final-geometry-mobile.log` | Exit 1: seis superficies táctiles PASS; el nombre de la tarjeta de Difusiones a 375 px no tiene acción de apertura. Se corrigió la navegación al menú Acciones → Ver detalles. Aporta 6 casos. |
| `local-tag-final-geometry-edit.log` | Exit 0: editor completo 2/2 PASS, 30,9 s. Aporta 2 casos. |
| `local-tag-final-geometry-desktop-last.log` | Exit 0: creación/importación, dos sesiones y automatizaciones 3/3 PASS, 42,3 s. Aporta 3 casos. |
| `local-tag-final-geometry-mobile-last.log` | Exit 0: Difusiones, creación/importación, dos sesiones y automatizaciones 4/4 PASS, 44,0 s. Aporta 4 casos. |

Los intentos fallidos, sus snapshots y sus trazas se conservan en los directorios `local-tag-final-geometry*-results`. Las ejecuciones detenidas por el primer fallo también registraron un contador de error fuera de test sin detalle adicional; no se oculta ese resultado. Las correcciones posteriores fueron exclusivamente del fixture y del flujo de prueba: navegación responsive real, locator del error, respeto al modal que protege el borrador y estado canónico simulado. No se cambió producto ni se debilitó el hit test para hacerlos pasar.

Capturas finales inspeccionadas, relativas al árbol aislado de QA de Windows:

- Escritorio: `local-tag-final-geometry-results/responsive-dashboard-Tag-p-19da2-restores-errors-and-reloads-responsive-desktop/menu-etiquetas-responsive-desktop.png`.
- Móvil: `local-tag-final-geometry-mobile-results/responsive-dashboard-Tag-p-19da2-restores-errors-and-reloads-responsive-mobile-chrome/menu-etiquetas-responsive-mobile-chrome.png`.

El viewport móvil es de 375 CSS px; la resolución del PNG incluye el factor de escala del dispositivo. La revisión visual confirma el anclaje junto al campo y ausencia de recorte horizontal; el test comprueba la separación y el puntero sobre la opción. El archivo final `tests/responsive-dashboard.spec.ts` fue editado en el VPS y copiado exactamente al árbol de QA: SHA256 coincidente `0d763e3b3a071803e8f08786c53619891ecf20ce9114b14a00b1799b10e40222`. `git diff --check` pasó tras el cierre. No se ejecutó despliegue, merge ni verificación de salud del sistema en producción.

Al terminar se cerró el standalone local de QA después de verificar su PID `57012` y la ruta del runtime Node propio. Se comprobó la ausencia del listener en `127.0.0.1:3018`; las sesiones de prueba habían finalizado. Se conservaron logs, capturas y trazas, sin detener servicios ni contenedores de producción.
