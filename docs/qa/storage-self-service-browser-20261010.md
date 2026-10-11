# Almacenamiento: QA de navegador y aceptación, 10 de octubre de 2026

La primera versión de autogestión pasó las comprobaciones descritas abajo en un laboratorio local con datos sintéticos. **El plan original amplio todavía no está completo:** actualmente se pueden retirar medios usados exclusivamente en Chats; la gestión de otros módulos y de usos individuales sigue pendiente. No se investigó el almacenamiento de producción.

Este informe añade navegador real y los ajustes de interfaz posteriores a `96306ec`. La [integración nativa y las mediciones de rendimiento anteriores](storage-self-service-native-20261010.md) se conservan como evidencia separada: sus afirmaciones sobre frontend corresponden a aquella etapa.

## Resultados terminados

| Comprobación | Resultado registrado |
| --- | --- |
| Backend completo | PASS. Incluye las pruebas del comando de preparación y limpieza del laboratorio. |
| Frontend unitario general | PASS: 300 archivos, 1.680 pruebas; más 28 pruebas del fork del editor y 44 de Node: **1.752 pruebas**. |
| Regresión focal de Almacenamiento tras corregir el foco | PASS: **38 pruebas** de `StoragePage` y `storageModel`, incluido un caso adicional de regresión. Se solapan con la suite general; no se suman como 38 pruebas únicas adicionales. |
| Build y TypeScript con la corrección de foco y el texto final | PASS. La aplicación utilizada para la aceptación se sirvió mediante `next start`. |
| Navegador con API simulada | **16/16 PASS** en el pase final. Cubre estados y geometría; no acredita por sí solo SQL ni S3. |
| Navegador conectado a API, PostgreSQL, Redis y MinIO reales | **5/5 PASS** en el pase final, con login y sesiones reales, sin interceptar la API. |
| Verificación posterior por CLI | PASS: 12 estados de archivos contrastados en SQL/MinIO. `restore` volvió a activo con **1.655 bytes**, hash y texto conservados; `purge`, de **1.653 bytes**, quedó sin objeto físico ni inventario activo. |
| Limpieza del fixture final | PASS: retiradas sólo las cuentas generadas y sus **11 objetos restantes, 12.612.702 bytes**; recuento posterior: **0 objetos**. Los fixtures anteriores también se limpiaron. |

**Pase final: 21/21 pruebas aprobadas en 32,5 s, sin reintentos ni omisiones.** Se reconstruyó la aplicación después del último ajuste de texto del resumen y se utilizó un fixture nuevo. La verificación SQL/MinIO y la limpieza posteriores también aprobaron. Las trece capturas entregadas proceden de este mismo pase.

Los registros locales incluyen `browser-final.log`, `browser-results.json`, `frontend-unit-final.log`, `frontend-storage-focus-final.log`, `frontend-built-final.log`, `frontend-typecheck-final.log`, `fixture-verify-final.log` y `fixture-cleanup-final.log`, bajo `work/qa-acceptance/`. Se conservaron por separado los intentos anteriores para documentar los fallos y su resolución.

## Qué recorrió el navegador real

Los cinco escenarios de `tests/storage-self-service-live.spec.ts` recorren:

1. Login real, inventario autorizado, filtros, archivo compartido protegido y sus ubicaciones. La foto se decodifica, audio y vídeo alcanzan un estado reproducible y PDF.js pinta contenido comprobable en el canvas.
2. Revisión sin retirada, Escape con devolución del foco, confirmación, Papelera y restauración. El inventario se actualiza sin recargar; el archivo restaurado vuelve a descargarse.
3. Bloqueo de borrado temprano, selección del archivo sintético cuya retención ya venció, aceptación explícita del borrado y posterior respuesta 404. Actividad refleja el resultado.
4. Cambio real de cuenta A a B, destrucción de selección y contenido anteriores, y denegación del archivo ajeno antes y después del cambio.
5. Vista de miembro sin capacidad libre de la cuenta, anchuras de 320, 375, 768, 1024, 1280 y 1440 píxeles, ausencia de desborde horizontal, selección por teclado y foco contenido en el diálogo.

La verificación CLI complementa las respuestas HTTP: comprueba referencias, texto original, estados de inventario y ledger, presencia o ausencia real en MinIO y hash de los bytes conservados. Los escenarios de concurrencia, idempotencia y fallos parciales más amplios pertenecen al informe nativo anterior; no se atribuyen a estas cinco pruebas de navegador.

| Evidencia visual | Qué permite revisar |
| --- | --- |
| [Escritorio: listado](storage-self-service-browser-20261010/01-escritorio-lista.png) | Jerarquía, resumen e inventario. |
| [Revisión antes de retirar](storage-self-service-browser-20261010/06-revision-antes-de-retirar.png) | Impacto, tamaño y confirmación previa. |
| [Móvil: resumen](storage-self-service-browser-20261010/11-movil-resumen.png) | Adaptación a una anchura de 375 píxeles. |
| [Móvil: revisión](storage-self-service-browser-20261010/13-movil-revision.png) | Lectura y acceso a las acciones del diálogo. |

## Fallos encontrados y correcciones

- **Foco al cerrar la revisión:** Chromium retiraba el foco del botón cuando quedaba deshabilitado durante la petición. El diálogo capturaba entonces un objetivo incorrecto. Ahora la página guarda el invocador antes de deshabilitarlo y lo enfoca después de cerrar y rehabilitar el DOM. Un unitario cubre también Escape con petición pendiente, aborto, selección conservada y respuesta tardía sin reapertura.
- **Mensajes de Papelera y Actividad:** Papelera prioriza el motivo del servidor —reutilización o eliminación pendiente— y presenta la fecha como retención mínima, sin prometer borrado por el mero paso del tiempo. Actividad distingue operaciones propias y los borrados definitivos de la cuenta visibles al administrador. El resumen diferencia restauración y borrado definitivo.
- **Tamaño de la revisión simulada:** el fixture de navegador devolvía cero para `trash`; ahora suma los tamaños elegibles en todas las acciones, como el backend real.
- **Prueba `ProgramDetailRefresh`:** el fixture debía esperar a que terminara el efecto previo antes de medir la siguiente interacción. Se corrigió la sincronización de la prueba, sin modificar ese producto.
- **Login en el laboratorio:** `next dev` requería evaluación de código incompatible con la CSP estricta del login. Se ejecutó la aplicación compilada con `next start`; no se relajó la CSP.
- **Miniatura diferida:** la prueba debía desplazar la fila hasta el área visible antes de exigir la carga activada por `IntersectionObserver`. Se corrigió la prueba, conservando la carga diferida del producto.
- **Inicio de la prueba de teclado:** se exige que el botón de cierre reciba el foco inicial antes de enviar Tab. No se fuerza ese foco ni se relajan las ocho comprobaciones posteriores. El caso real pasó tres repeticiones consecutivas (13,2 s) antes del pase final.

## Contraste con el plan original

| Objetivo | Estado y alcance real |
| --- | --- |
| Una opción de Almacenamiento y medios comprensibles | **Cumplido en esta versión.** Una pantalla con Archivos, Papelera y Actividad. Fotos, vídeos, audios y documentos reconocidos; logs, tablas, copias y archivos técnicos quedan fuera. |
| Aislamiento, revisión y recuperación | **Implementado y validado en escenarios sintéticos.** Permisos por cuenta/origen, revisión previa, papelera mínima de siete días, restauración, revalidación e intención durable para reintentos. |
| Todos los medios autorizados, incluidas campañas, respuestas rápidas, Work y Pizarras | **Parcial.** Se reconocen referencias para protegerlas, pero sólo se retiran objetos usados exclusivamente en Chats. Work y Pizarras conservan sus circuitos y no tienen gestión central con sus permisos por recurso. `storage_self_service_catalog.go` mantiene estas exclusiones. |
| Desvincular un uso sin borrar otros | **Pendiente.** La API selecciona objetos completos; la retirada de Chats afecta a todos sus mensajes. Una referencia de otro módulo protege el objeto completo. `storage_self_service_cleanup.go` no admite selección de referencias individuales. |
| Cargas propias abandonadas verificadas | **Pendiente.** Los objetos sin origen acreditado quedan ocultos/protegidos. Falta un flujo que demuestre autoría y antigüedad y permita gestionarlos. No equivale a las capacidades temporales de vista previa de cargas ya existentes. |
| Interfaz clara, accesible y recomendaciones útiles | **Parcial.** Se verificaron filtros, selección, vistas previas, confirmaciones, teclado y anchuras indicadas. Las recomendaciones se limitan al filtro de retirables y tamaño/antigüedad; falta priorización explicada. Tampoco hay actualización automática del resumen ante cambios de otros usuarios. |
| Escala adecuada | **Parcial.** El benchmark previo midió 1.000, 10.000 y 50.000 objetos. A 50.000, primera página: mediana 2,27 s; Uso + Archivos: 2,57 s, 1.112,8 MiB de asignaciones acumuladas y 253,5 MiB de RSS Go muestreado. Se sigue recorriendo el inventario completo; no está resuelta la escala. |
| Investigar y mejorar el consumo real de las cuentas | **Pendiente para producción.** No se midieron cuentas reales ni se conoce su distribución de medios. Los bytes verificados y eliminados en este informe pertenecen exclusivamente al laboratorio. |

El detalle del alcance vigente está en [storage-self-service.md](../storage-self-service.md). Completar esta primera versión de Chats no equivale a completar el plan original de gestión de todos los medios autorizados.

## Reproducción local y limpieza

Usar el entorno general de Clarín ya preparado, con PostgreSQL, Redis, MinIO y la API local activos. La API del fixture es `127.0.0.1:8080`. No cargar configuración de producción ni activar WhatsApp o Kommo.

El comando exige `CLARIN_STORAGE_UI_QA=1`. Comprueba tanto la URL como el destino efectivo de pgx: únicamente `127.0.0.1:15439/clarin_cloud_dev`, sin cambios de host/base de datos ni fallbacks ajenos. MinIO debe ser `127.0.0.1:19001`, bucket `clarin-cloud-media`, sin TLS. Antes de modificar o limpiar, verifica que las cuentas y prefijos pertenecen al run generado.

Primero compilar y servir el frontend; mantenerlo activo en esa terminal:

```bash
source /workspace/clarin-cloud/activate.sh
cd /workspace/clarin
CIRCLE_NODE_TOTAL=3 GOMAXPROCS=2 npm --prefix frontend run build
npm --prefix frontend run start -- --hostname 127.0.0.1 --port 3000
```

Conservar y restaurar los metadatos generados que indica `frontend/AGENTS.md`
(`AGENTS.md`, `next-env.d.ts` y `tsconfig.tsbuildinfo`) sin descartar cambios
previos del usuario. Las pruebas unitarias usan el contrato same-origin:
`env -u NEXT_PUBLIC_API_URL TZ=UTC npm --prefix frontend run test:unit`.

En otra terminal, elegir una ruta de manifiesto nueva para cada pase completo. `create` rechaza sobrescribir una existente y prepara doce archivos sintéticos, incluidos la papelera reciente y el caso de purga con fecha ajustada únicamente en el fixture.

```bash
source /workspace/clarin-cloud/activate.sh
cd /workspace/clarin
export CLARIN_STORAGE_UI_QA=1
export CLARIN_STORAGE_UI_QA_MANIFEST="$PWD/work/storage-ui-qa/acceptance.private.json"
bash scripts/qa/storage-ui-fixture.sh create
bash scripts/qa/storage-ui-fixture.sh verify

export CLARIN_STORAGE_BROWSER_QA=1
export CLARIN_QA_CHROMIUM_PATH=/usr/bin/chromium
export PLAYWRIGHT_BASE_URL=http://localhost:3000
export CLARIN_STORAGE_QA_EVIDENCE_DIR="$PWD/work/qa-acceptance/evidence"
npx playwright test --config=playwright.storage.config.ts

bash scripts/qa/storage-ui-fixture.sh verify --expect restore=active,purge=purged,trash_recent=trash
bash scripts/qa/storage-ui-fixture.sh cleanup
```

El manifiesto contiene credenciales sintéticas: se escribe de forma atómica con permisos **0600** y no debe imprimirse, publicarse ni exportarse con las evidencias. La verificación detallada también queda privada. El [JSON de ejemplo](../storage-ui-fixture.example.json) sólo documenta el esquema. Playwright desactiva trazas y vídeo para evitar capturar credenciales; el registro de solicitudes exportable conserva método, ruta y estado, sin consultas ni tokens.

Si una prueba falla, conservar el manifiesto para verificar su estado y ejecutar `cleanup` con esa misma ruta después del diagnóstico. La limpieza elimina sólo las cuentas generadas y sus prefijos, recuenta objetos y permite reintento; no es un limpiador general de la cuenta ni del bucket. No iniciar otro pase completo sobre un fixture ya purgado: crear uno nuevo tras limpiar el anterior.

## Límites

- Se utilizó **Chromium 151** en Linux y anchuras de navegador de 320–1440 píxeles. No se probaron dispositivos Android/iOS reales, Safari, Firefox ni un lector de pantalla.
- La retención se ejercita con fechas ajustadas en datos sintéticos; no se esperaron siete días reales. Los escenarios concurrentes y de fallos parciales nativos son intercalaciones concretas, no una prueba prolongada de carga.
- El navegador se conectó a servicios reales locales. No acredita TLS, proxy/CDN remotos, cachés públicas antiguas ni condiciones de red de producción.
- El benchmark previo usa objetos de 1 KiB y una distribución sintética de Chats. Las asignaciones acumuladas no son memoria retenida; el RSS medido excluye PostgreSQL, Redis y MinIO. No se certifica capacidad ni latencia de producción.
- GitHub Actions continúa retirado. Este trabajo no fusiona, despliega ni acredita una investigación del almacenamiento de producción.
