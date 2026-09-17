# Pizarras Clarin: avisos de terceros

Pizarras Clarin integra el fork auditable `@excalidraw/excalidraw` **0.18.1-clarin.7**, derivado sin saltos del tag upstream `v0.18.1` y del commit exacto `a2ec2889babf7d2295469c6d90ebe77fae57df84`. El producto, sus rutas, almacenamiento, permisos, colaboración y marca pertenecen a Clarin; no se utilizan servicios operativos de Excalidraw.

El código fuente mantenido vive en `frontend/vendor/excalidraw-clarin`. La superficie propia se limita al modelo de marcas parciales de texto y alineación por párrafos, el editor `contenteditable` con navegación nativa de líneas vacías y reconciliación IME, selección y portapapeles enriquecido, medición/render de runs y párrafos, controles accesibles, precarga determinista de fuentes locales y el backport documentado de presión constante/variable. La compilación genera la ruta inmutable `/vendor/whiteboards-editor/0.18.1-clarin.7/`; el catálogo no inicia cargas por apertura, hover, foco, desplazamiento ni selección.

## Licencia del editor

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Fuente: <https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE>

Las fuentes incluidas por el paquete conservan sus licencias originales, entre ellas SIL Open Font License 1.1 y MIT. El proceso `prepare:excalidraw` las copia sin modificarlas a un directorio local versionado y distribuye junto a ellas `FONT-NOTICES.md`, `OFL-1.1.txt` y `COMIC-SHANNS-MIT.txt` desde `frontend/third_party/excalidraw/`.

El orden fraccional del editor usa `fractional-indexing@3.2.0`, publicado bajo CC0 1.0 Universal (`CC0-1.0`, sin derechos reservados). Clarin conserva esa versión exacta tanto en el lockfile como en el corpus diferencial del reconciliador; el aviso canónico y la integridad npm constan en `THIRD_PARTY_NOTICES.md`.

El modo de trazo constante usa `@excalidraw/laser-pointer@1.3.1`, publicado bajo MIT, Copyright (c) 2023 Excalidraw. La dependencia ya forma parte del cierre exacto fijado por `v0.18.1`; Clarin distribuye su licencia completa como `frontend/third_party/excalidraw/LASER-POINTER-MIT.txt` y no incorpora servicios ni tráfico de red asociados.

## Estado de seguridad del candidato (2026-09-14)

La baseline vigente del candidato es [supply-chain-2026-09-14.json](third_party/excalidraw/supply-chain-2026-09-14.json), no la baseline histórica de agosto. El árbol del fork `0.18.1-clarin.7` tiene SHA-256 `da5a8d51ecf03dda77fa668954710ee994c8c43d8ba3703fdfbc684df372797a`. Su [SBOM CycloneDX 1.6 archivado](third_party/excalidraw/excalidraw-0.18.1-clarin.7.cdx.json) contiene 248 componentes y tiene SHA-256 `f0bc6879b5d913e8f1f7e250c448edb17f1a72d0af491cf0982c28225aebdef2`.

El [escaneo nuevo del lock final](../docs/security-dependency-audit-after-2026-09-14.json), ejecutado el 14 de septiembre de 2026 a las 23:32 UTC, registra cero hallazgos en npm tanto con desarrollo como con `--omit=dev`. Se consultaron 710 versiones públicas exactas en OSV y GitHub, incluyendo el origen upstream `0.18.1` del fork privado. El cierre del motor no presenta coincidencias activas. Los dos resultados brutos OSV de SheetJS, fuera de ese cierre, se clasifican como no afectados por las correcciones oficiales anteriores al tarball 0.20.3 verificado byte a byte; el resultado GitHub de esbuild está retirado. El informe conserva resultados y razonamiento, sin declarar que las bases devuelven literalmente cero registros.

La revisión `.7` añade una frontera de capacidad real: el pegado de texto similar a Mermaid y la apertura del diálogo no cargan el parser cuando el host deshabilita IA. Se corrige así la suposición histórica de que ocultar las funciones de IA hacía inalcanzable cualquier entrada al parser: antes existía conversión implícita desde el portapapeles. El texto pegado conserva el comportamiento ordinario del editor. La implementación y pruebas están inventariadas en `vendor/excalidraw-clarin/PATCHES.md`; no se habilitan servicios de IA, red externa ni nuevos formatos de importación.

Además, el cierre usa `nanoid@3.3.19`/`5.1.16`, `lodash-es@4.18.1`, `picomatch@2.3.2`, Radix Tabs `1.1.21` y React `19.3.0`. La rama upstream de herramientas de desarrollo no utilizadas se retira del manifiesto del fork: la compilación y las pruebas Clarin usan exclusivamente el tooling raíz documentado. El SBOM revisado pasa de 251 a 248 componentes; las versiones añadidas tienen licencia MIT y no cambian las licencias de fuentes ni de los assets existentes.

El estado es **candidato verificado solamente para supply chain**. La promoción permanece **NO-GO mientras falten los gates finales de release**, especialmente build final, navegador, egress, colaboración, artefacto de rollback y verificación del despliegue autorizado. Ningún escaneo garantiza ausencia de vulnerabilidades desconocidas. La activación Offline v3 conserva su gate independiente de aceptación Windows real. El [informe de actualización](../docs/security-dependency-upgrade-2026-09-14.md) distingue pruebas realizadas de comprobaciones pendientes.

## Registro histórico, no vigente

El [snapshot de 2026-08-29](../.codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json) conserva la evidencia de `0.18.1-clarin.6`: 251 componentes, SHA-256 `ca6a0ae4e12ecc94cd4778a2bae94b5b431c9030756cbd43b9a0966bada8c302`, y 21 hallazgos npm de producción (6 moderados, 13 altos, 2 críticos). No es una aceptación vigente del riesgo ni prueba de inalcanzabilidad.

Sus advisories registrados fueron `GHSA-mwcw-c2x4-8c55`, `GHSA-28wg-ghj8-5hjv`, `GHSA-2v37-7h3g-55p8`, `GHSA-r5fr-rjxr-66jc`, `GHSA-f23m-r3pf-42rh`, `GHSA-xxjr-mmjv-4gpg`, `GHSA-3v7f-55p6-f55p` y `GHSA-c2c7-rcm5-vvqj`. Las versiones afectadas han sido sustituidas en el candidato; no se arrastran excepciones de inalcanzabilidad del parser. Las licencias MIT de `fuzzy@0.1.3` y `khroma@2.1.0`, omitidas por los metadatos npm, siguen verificándose mediante sus archivos y hashes exactos.
