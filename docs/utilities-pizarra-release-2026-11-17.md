# Entrega Utilitarios y Pizarra — 17 de noviembre de 2026

El usuario autorizó implementar el plan y dejarlo desplegado. Se preparan dos PR
independientes desde `057d344a70a1a7b4966ac1ae93a8364be385e5d8`; la rama de entrega
combina sus commits sin fusionar los PR ni `main`. No hay migración masiva de
documentos o escenas ni cambios de política de sesión.

## Identidad del artefacto

Pizarra pasa de `0.18.1-clarin.8` a `0.18.1-clarin.9`, sobre Excalidraw v0.18.1,
commit `a2ec2889babf7d2295469c6d90ebe77fae57df84`. Se conserva la instalación
local exacta, sin cambiar dependencias de ejecución. Los hashes del árbol,
lockfile y SBOM están en
`frontend/third_party/excalidraw/supply-chain-2026-11-17.json`; el inventario
CycloneDX y la evidencia de licencias se archivan junto a ese archivo.

La huella usa los bytes LF canónicos ya guardados en Git. La copia inicial de
Windows contenía CRLF en 987 archivos sin diferencias de código, por lo que la
primera promoción se detuvo antes de reconstruir servicios. Tras normalizar esa
copia se regeneraron SBOM y avisos y se compararon los 303 archivos del paquete
de producción: sus bytes son idénticos a los de la versión probada. La huella
canónica coincide ahora entre Windows y el servidor Linux.

Los cambios del fork se limitan al formato por selección, su historial y
portapapeles, medición y pintura, y regresiones relacionadas. Los formatos de
marcas/párrafos anteriores y los datos desconocidos se conservan. Los nuevos
rangos se validan en cliente y servidor. Las escenas sin la extensión nueva
conservan el recorrido de renderizado anterior. Se mantienen los artefactos
anteriores para recuperación.

## Revisión de dependencias y alcance de las alertas

El análisis `npm audit --omit=dev --json` del día registra seis hallazgos
agregados: cinco altos en la cadena de herramientas y uno moderado de Next.js;
ninguno crítico. Se consultaron nuevamente los avisos primarios y OSV el 17 de
noviembre; las respuestas de OSV se archivan en
`frontend/third_party/excalidraw/osv-2026-11-17.json`.
Esta revisión distingue alcance del código y versión vulnerable;
no afirma que las versiones estén parcheadas.

El 18 de noviembre se repitieron npm audit y las consultas OSV antes de la
promoción: permanecen los mismos seis hallazgos agregados y los avisos OSV
conservan sus fechas de modificación. Se archivan como
`npm-audit-2026-11-18.json` y `osv-2026-11-18.json` junto al SBOM.
El inventario exacto original del artefacto del día 17 se conserva sin reescribir.

- [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf):
  picomatch admite expresiones extglob repetidas que pueden provocar ReDoS.
  La instalación de producción resuelve `sass@1.51.0 -> chokidar@3.6.0 ->
  anymatch/readdirp -> picomatch@2.3.2`. Es una dependencia de compilación del
  motor. La aplicación no importa picomatch/chokidar ni acepta patrones de
  compilación proporcionados por usuarios. Los documentos importados no se
  convierten en patrones glob. Inferencia acotada: la condición del aviso no
  es alcanzable mediante los flujos publicados. Una futura importación en
  ejecución o aceptación de patrones externos obliga a revisar esta decisión.
- [GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h) y
  [GHSA-vc7v-qv4w-wrv8](https://github.com/advisories/GHSA-vc7v-qv4w-wrv8):
  Next.js 16.4.1 figura dentro de los rangos afectados; 16.4.5 los corrige.
  Sus condiciones requieren funciones `use cache` y escenarios de caché de
  parámetros raíz. La búsqueda en todo `frontend/src` y `next.config.js` no
  encontró `use cache`, `unstable_cache` ni `cacheComponents`. Inferencia:
  esos caminos no están habilitados en esta aplicación. Se conserva la versión
  establecida por el repositorio; habilitar estas funciones reabre la revisión.

La decisión de esta entrega se limita al código y configuración inspeccionados,
con pruebas de aislamiento de red y comprobación del artefacto final. No se
admite una excepción para una vulnerabilidad alta/crítica alcanzable. Un fallo
de integridad, licencias, compatibilidad o aislamiento impide desplegar.

## Verificación

| Comprobación | Resultado observado |
| --- | --- |
| Suite principal del frontend | 489 archivos y 3.233 pruebas ejecutadas; dos expectativas del nombre antiguo del editor y de la versión `.8` fallaron. Ambas se corrigieron; la repetición afectada aprobó 43 archivos / 319 pruebas. |
| Cola de guardado y API | 68 pruebas aprobadas después de proteger la repetición explícita de una eliminación incierta. |
| Integración de Pizarra en frontend | 48 archivos / 359 pruebas aprobadas. |
| Fork final de Pizarra | 13 archivos / 127 pruebas aprobadas, incluidas selección, composición, historial, portapapeles y limpieza de Highlights. |
| Herramientas de compilación | 48 pruebas Node aprobadas. |
| Reconciliación histórica | 54 casos upstream, 60 totales; 14 claves exactas y seis rechazos aprobados. |
| Backend completo | Suite Go completa aprobada en Linux con Go 1.27.2; compilación Go también aprobada. |
| PostgreSQL y almacenamiento | Integración de lectura/compactación con PostgreSQL aprobada; los 12 casos del fixture estricto PostgreSQL + MinIO reales también pasaron. [Evidencia de Utilitarios](https://github.com/ricardoalejandro/clarin/blob/codex/utilitarios-edicion/docs/utilities-reliable-editing.md). |
| Geometría y pintura reales | Tres motores aprobados: kerning, árabe, bidi, líneas, opacidad, giro y color/U/S por Highlights. Los píxeles de decoración cambiados acreditan pintura real, no sólo una declaración CSS. |
| Producción y TypeScript | Compilación optimizada, TypeScript y 39 páginas aprobados; CSS en nueve artefactos aprobado; shell offline v5 de 802 recursos generado; verificación de 1.098 artefactos de Pizarra y branding aprobada. |
| Utilitarios en navegador | 36 escenarios verificados en los tres motores: 33 aprobados en la ejecución completa y tres afectados de WebKit aprobados sobre el build definitivo; incluye bytes nativos, Ctrl/Cmd+S, recuperación, reapertura, acciones de filas, geometría y foco. |
| Contrato tipográfico en la aplicación | Aprobado en Chromium, Firefox y WebKit: fragmento/cursor/objeto, cancelación de fuente, Deshacer/Rehacer, párrafos vacíos, guardado, reapertura y exportación sincronizada entre dos sesiones. |
| Entrada táctil | El flujo completo de Chromium usa un toque real emulado. Firefox y WebKit aprobaron una comprobación adicional con herramienta de texto, toque del lienzo, selección y toque del control de color, guardando sólo el rango elegido. |
| Colaboración y aislamiento de red | Aprobados los casos de ACK perdido, reconexión, revocación y límites de colaboración; análisis estricto de 297 URL de la traza sin infracciones. Branding aprobado en dos superficies, 98 acciones y 33 archivos estáticos, conservando seis avisos legales. |
| Regresiones finales de la aplicación | Tres casos del contrato completo, 12 casos de edición/colaboración y dos casos táctiles adicionales aprobados; seis combinaciones específicas de Chromium no aplican a los otros motores. Se verificó además en Firefox que cerrar el selector conserva la fuente confirmada y sus tamaños parciales. |

El build definitivo de Next se ejecutó en su modo CI automatizado y terminó con
código cero, seguido por las mismas etapas restantes del pipeline. La revisión
actual de los avisos de Next consta arriba; se mantienen las versiones y la
configuración de ejecución fijadas por el repositorio.

Las pruebas de geometría comparan fuentes representativas y la representación
nativa del motor en ejecución; no afirman que el fallback de una fuente sin
glifos árabes sea idéntico entre sistemas operativos. Se verifican los archivos,
hashes y licencias del catálogo local completo durante la compilación.

Las pruebas de aplicación se completan antes de promover la rama. Se ejecutan
sobre el servidor standalone real del build, con la política CSP de producción
sin la excepción de desarrollo `unsafe-eval`. Los registros locales se conservan
en la caché ignorada de verificación;
no contienen documentos ni credenciales de cuentas reales. En Windows las pruebas
preexistentes de sincronización de directorios y privilegios de enlaces de
`cmd/storage-ui-qa` requieren Linux; la suite Linux completa las aprobó.

## Despliegue y recuperación

Se utiliza `make deploy` desde `/root/proyect/clarin`. Antes de cambiar de rama
se conservan los hashes, bytes y permisos de los archivos previamente modificados
en producción, además del commit y los identificadores de las imágenes activas.
El archivo `backend/CHANGELOG.md` se restaura incluso si falla la compilación;
su contenido ajeno a esta entrega no entra en un commit.

La comprobación posterior incluye contenedores, `/health`, `/api/version`,
registros de backend/frontend y una prueba de la interfaz publicada con datos
sintéticos interceptados. No se cambia el despliegue de módulos offline ni se
reactivan integraciones dormidas.

Si falla la comprobación de servicio, se restauran las imágenes etiquetadas antes
de la entrega y el commit de despliegue anterior mediante un archivo override de
Compose; se recrean únicamente los servicios actualizados y se repiten salud y
versión. No se retrocede ni reescribe el almacenamiento de documentos/escenas.
Las revisiones anteriores y la extensión opaca permiten la recuperación.

Estado de promoción: **GO manual, 18 de noviembre de 2026**. Identidad,
licencias, alcance de avisos, compatibilidad, pruebas, conexiones y recuperación
revisados. No se requiere excepción para una vulnerabilidad alta/crítica
alcanzable. El despliegue se completa únicamente después de comprobar salud,
versión pública y registros del sistema actualizado.
