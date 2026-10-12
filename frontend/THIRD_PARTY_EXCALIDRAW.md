# Pizarras Clarin: avisos de terceros

Pizarras Clarin integra el fork auditable `@excalidraw/excalidraw` **0.18.1-clarin.8**, derivado sin saltos del tag upstream `v0.18.1` y del commit exacto `a2ec2889babf7d2295469c6d90ebe77fae57df84`. El producto, sus rutas, almacenamiento, permisos, colaboración y marca pertenecen a Clarin; no se utilizan servicios operativos de Excalidraw.

El código fuente mantenido vive en `frontend/vendor/excalidraw-clarin`. La superficie propia se limita al modelo de marcas parciales de texto y alineación por párrafos, el editor `contenteditable` con navegación nativa de líneas vacías y reconciliación IME, selección y portapapeles enriquecido, medición/render de runs y párrafos, controles accesibles, precarga determinista de fuentes locales y el backport documentado de presión constante/variable. La compilación genera la ruta inmutable `/vendor/whiteboards-editor/0.18.1-clarin.8/`; el catálogo no inicia cargas por apertura, hover, foco, desplazamiento ni selección.

## Licencia del editor

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Fuente: <https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE>

Las fuentes incluidas por el paquete conservan sus licencias originales, entre ellas SIL Open Font License 1.1 y MIT. El proceso `prepare:excalidraw` las copia sin modificarlas a un directorio local versionado y distribuye junto a ellas `FONT-NOTICES.md`, `OFL-1.1.txt` y `COMIC-SHANNS-MIT.txt` desde `frontend/third_party/excalidraw/`.

El orden fraccional del editor usa `fractional-indexing@3.2.0`, publicado bajo CC0 1.0 Universal (`CC0-1.0`, sin derechos reservados). Clarin conserva esa versión exacta tanto en el lockfile como en el corpus diferencial del reconciliador; el aviso canónico y la integridad npm constan en `THIRD_PARTY_NOTICES.md`.

El modo de trazo constante usa `@excalidraw/laser-pointer@1.3.1`, publicado bajo MIT, Copyright (c) 2023 Excalidraw. La dependencia ya forma parte del cierre exacto fijado por `v0.18.1`; Clarin distribuye su licencia completa como `frontend/third_party/excalidraw/LASER-POINTER-MIT.txt` y no incorpora servicios ni tráfico de red asociados.

## Estado del candidato (2026-10-12)

La baseline vigente del candidato es [supply-chain-2026-10-12.json](third_party/excalidraw/supply-chain-2026-10-12.json), no la baseline histórica de agosto. El árbol del fork `0.18.1-clarin.8` tiene SHA-256 `b9753650b2b80704a46b670d6651a80da59c7858d774be343936f2f8c15d3eb9`. Su [SBOM CycloneDX 1.6 archivado](third_party/excalidraw/excalidraw-0.18.1-clarin.8.cdx.json) contiene 248 componentes y tiene SHA-256 `11dbd6b8a303cec9017237893fe4c715696e7c874f4325e3d158b1fc4da498ef`.

El [escaneo histórico del lock de septiembre](../docs/security-dependency-audit-after-2026-09-14.json), ejecutado el 14 de septiembre de 2026 a las 23:32 UTC, registra cero hallazgos en npm tanto con desarrollo como con `--omit=dev`. Se consultaron 710 versiones públicas exactas en OSV y GitHub, incluyendo el origen upstream `0.18.1` del fork privado. Ese cierre del motor no presentaba coincidencias activas en la fecha indicada; la baseline de octubre conserva los nuevos avisos de braces y KaTeX. Los dos resultados brutos OSV de SheetJS, fuera de ese cierre, se clasifican como no afectados por las correcciones oficiales anteriores al tarball 0.20.3 verificado byte a byte; el resultado GitHub de esbuild está retirado. El informe conserva resultados y razonamiento, sin declarar que las bases devuelven literalmente cero registros.

La capacidad `mermaidEnabled` es independiente de `aiEnabled`. Los hosts actuales de miembro e invitado deshabilitan IA, pero habilitan Mermaid local: pegar un diagrama o usar su diálogo puede cargar `mermaid-to-excalidraw`, Mermaid y KaTeX. La inspección de los 156 chunks de navegador emitidos por Next webpack en QA confirmó módulos Mermaid en 56 archivos y KaTeX en 2; no se puede declarar inalcanzable el parser por ocultar IA. La implementación y pruebas están inventariadas en `vendor/excalidraw-clarin/PATCHES.md`; no se habilitan servicios de IA ni tráfico externo.

Además, el cierre usa `nanoid@3.3.19`/`5.1.16`, `lodash-es@4.18.1`, `picomatch@2.3.2`, Radix Tabs `1.1.21` y React `19.3.0`. La rama upstream de herramientas de desarrollo no utilizadas se retira del manifiesto del fork: la compilación y las pruebas Clarin usan exclusivamente el tooling raíz documentado. El SBOM revisado pasa de 251 a 248 componentes; las versiones añadidas tienen licencia MIT y no cambian las licencias de fuentes ni de los assets existentes.

La revisión `.8` incorpora el preset semántico Amplio (16 para trazo libre constante y 8 para los demás modos), su icono propio, lectura explícita de valores personalizados y límites de exportación derivados de la tinta real. Los trazos existentes conservan sus valores y renderer. El inventario se regeneró en el checkout QA aislado desde `npm ci`, el lock exacto y el árbol candidato; el commit registrado identifica la base, mientras el hash identifica todos los cambios de código aún sin commit.

El mismo candidato publica un worker ESM local para el subconjunto de fuentes, incluyendo las copias Offline v3/v4/v5. Elimina la URL `file://` que producía Next y reemplaza la compilación dinámica de funciones de los bindings WOFF2 por cierres equivalentes. El worker incluye su WASM, tiene prohibidas las conexiones de red y recibe una política propia que permite únicamente la compilación WASM; no habilita `unsafe-eval` ni relaja la política de los documentos. La espera activa está acotada a 15 segundos y la liberación por inactividad permanece en un segundo.

El [audit npm de producción de 2026-10-12](third_party/excalidraw/npm-audit-2026-10-12.json) registra 6 hallazgos agregados (3 altos y 3 bajos), con avisos directos de braces y KaTeX heredados. Esta revisión no actualiza dependencias ni repite el escaneo exhaustivo OSV/GitHub de septiembre. Los textos legales se verifican contra el nuevo SBOM, manteniendo 247 componentes cubiertos de 248 y la exclusión explícita de `fsevents` en Linux.

El [aviso de braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) requiere que patrones de llaves profundamente anidados alcancen su parser y pueden agotar la pila de Node. La dependencia entra por Sass/Chokidar y el build del fork usa `sassPlugin`; no se hallaron importaciones de esos paquetes en la fuente de navegador ni sus módulos en los 156 chunks inspeccionados. Esto respalda alcance de compilación en este artefacto, con el límite de que son chunks de desarrollo y no una prueba global de toda la aplicación. El [aviso de KaTeX](https://github.com/advisories/GHSA-238p-pmpm-9mq7) sí afecta una dependencia alcanzable en navegador. Su explotación requiere contaminación previa de `Object.prototype` o prototipos de opciones controlados por un atacante, además de matemáticas controladas por éste; KaTeX no origina esa contaminación. No se probó explotación ni elusión del sanitizador. Ambos avisos permanecen en revisión y esta entrega no los corrige.

El estado es **candidato pendiente de verificación final**. La promoción permanece **NO-GO mientras falten los gates finales de release**, especialmente build final, navegador, egress, colaboración, artefacto de rollback y verificación del despliegue autorizado. Ningún escaneo garantiza ausencia de vulnerabilidades desconocidas. La activación Offline v3 conserva su gate independiente de aceptación Windows real. El [informe histórico de actualización](../docs/security-dependency-upgrade-2026-09-14.md) distingue pruebas realizadas en septiembre de comprobaciones pendientes.

## Registro histórico, no vigente

El [snapshot de 2026-08-29](../.codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json) conserva la evidencia de `0.18.1-clarin.6`: 251 componentes, SHA-256 `ca6a0ae4e12ecc94cd4778a2bae94b5b431c9030756cbd43b9a0966bada8c302`, y 21 hallazgos npm de producción (6 moderados, 13 altos, 2 críticos). No es una aceptación vigente del riesgo ni prueba de inalcanzabilidad.

Sus advisories registrados fueron `GHSA-mwcw-c2x4-8c55`, `GHSA-28wg-ghj8-5hjv`, `GHSA-2v37-7h3g-55p8`, `GHSA-r5fr-rjxr-66jc`, `GHSA-f23m-r3pf-42rh`, `GHSA-xxjr-mmjv-4gpg`, `GHSA-3v7f-55p6-f55p` y `GHSA-c2c7-rcm5-vvqj`. Las versiones afectadas han sido sustituidas en el candidato; no se arrastran excepciones de inalcanzabilidad del parser. Las licencias MIT de `fuzzy@0.1.3` y `khroma@2.1.0`, omitidas por los metadatos npm, siguen verificándose mediante sus archivos y hashes exactos.

## Actualización histórica de dependencias — 2026-10-11

Next 16.3.8, sharp 0.35.5, DOMPurify 3.4.16 y source-map-js 1.2.2 sustituyen las versiones afectadas dentro de sus líneas compatibles. npm audit registra 9 hallazgos agregados (6 altos, 3 bajos), y 6 (3 altos, 3 bajos) al omitir desarrollo. Los avisos directos restantes de braces y KaTeX se conservan en revisión; los resultados de septiembre citados arriba son históricos. El código del fork no cambia en esta entrega: su hash se reprodujo desde git archive HEAD y el material instalado. El inventario y las licencias se regeneraron desde el lock y los textos reales, sin inferir aprobación de despliegue.
