# Pizarras Clarin: avisos de terceros

Pizarras Clarin integra el fork auditable `@excalidraw/excalidraw` **0.18.1-clarin.4**, derivado sin saltos del tag upstream `v0.18.1` y del commit exacto `a2ec2889babf7d2295469c6d90ebe77fae57df84`. El producto, sus rutas, almacenamiento, permisos, colaboración y marca pertenecen a Clarin; no se utilizan servicios operativos de Excalidraw.

El código fuente mantenido vive en `frontend/vendor/excalidraw-clarin`. La superficie propia se limita al modelo de marcas parciales de texto y alineación por párrafos, el editor `contenteditable`, medición/render de runs y párrafos, controles accesibles y precarga determinista de fuentes locales. La compilación genera la ruta inmutable `/vendor/whiteboards-editor/0.18.1-clarin.4/`; el catálogo no inicia cargas por apertura, hover, foco, desplazamiento ni selección.

## Licencia del editor

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Fuente: <https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE>

Las fuentes incluidas por el paquete conservan sus licencias originales, entre ellas SIL Open Font License 1.1 y MIT. El proceso `prepare:excalidraw` las copia sin modificarlas a un directorio local versionado y distribuye junto a ellas `FONT-NOTICES.md`, `OFL-1.1.txt` y `COMIC-SHANNS-MIT.txt` desde `frontend/third_party/excalidraw/`.

El orden fraccional del editor usa `fractional-indexing@3.2.0`, publicado bajo CC0 1.0 Universal (`CC0-1.0`, sin derechos reservados). Clarin conserva esa versión exacta tanto en el lockfile como en el corpus diferencial del reconciliador; el aviso canónico y la integridad npm constan en `THIRD_PARTY_NOTICES.md`.

## Riesgo de dependencias conocido (2026-08-23)

`npm audit --omit=dev --json` informa 21 hallazgos en el grafo completo de producción del frontend: 6 moderados, 13 altos y 2 críticos. No todos pertenecen al motor, pero siguen siendo un gate de producción de Clarin. Para el cierre de `@excalidraw/excalidraw@0.18.1-clarin.4`, npm agrega hallazgos originados en estas dependencias transitivas fijadas por upstream:

- `nanoid@3.3.3` y `nanoid@4.0.2`: [GHSA-mwcw-c2x4-8c55](https://github.com/advisories/GHSA-mwcw-c2x4-8c55), rangos `<3.3.8` y `>=4.0.0 <5.0.9`.
- `nanoid@3.3.3` y `nanoid@4.0.2`: [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), rangos `<3.3.16` y `>=4.0.0 <5.1.16`.
- `nanoid@3.3.3` y `nanoid@4.0.2`: [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8), rangos `<3.3.17` y `>=4.0.0 <5.1.6`.
- La ruta `@excalidraw/mermaid-to-excalidraw@2.2.2 -> @mermaid-js/parser@0.6.3 -> langium@3.3.1 -> lodash-es@4.17.21` queda afectada por [GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) (`>=4.0.0 <=4.17.23`), [GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh) (`<=4.17.23`) y [GHSA-xxjr-mmjv-4gpg](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg) (`>=4.0.0 <=4.17.22`).
- `picomatch@2.3.1`, presente solo en la rama de tooling `sass -> chokidar -> anymatch`, queda afectado por [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) y [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj). Pizarras no lo importa en sus chunks de navegador y la compilación usa globs del repositorio, no entradas del usuario.

El remedio automático ofrecido por npm es bajar el editor a `0.17.6`, incompatible con la versión funcional requerida. No se aplican overrides transitivos no validados. Mermaid y las funciones de IA quedan deshabilitados en la integración de Clarin; el riesgo debe reevaluarse con cada actualización upstream.

En el código oficial `v0.18.1`, `nanoid` se invoca sin tamaño o con el entero positivo fijo `40`; no hay tamaño dinámico, cero, negativo o fraccionario, y Clarin no usa esos identificadores de cliente como secretos de autenticación, enlaces compartidos o sesiones. Esta es una mitigación de alcance, no una actualización de la dependencia: cualquier cambio en esas llamadas reabre los tres advisories. La ruta vulnerable de `lodash-es` queda confinada al parser Mermaid deshabilitado; exponer Mermaid o IA exige corregirla y repetir la revisión.

La decisión actual es **NO-GO para promoción automática/no atendida a producción**. Esto no es un bloqueo absoluto del feature: Pizarras queda **elegible para una decisión manual de release** porque Mermaid/IA está eliminado, `nanoid` no recibe tamaños vulnerables ni protege secretos y `picomatch` es solo tooling de build. Los 2 hallazgos críticos agregados (`jspdf` y `tar`, este último por la cadena preexistente Fabric/canvas), además de las ramas Fabric, Next, xlsx, ws, form-data, brace-expansion y PostCSS, están fuera del cierre Excalidraw y no fueron introducidos por Pizarras. Aun así, el responsable del release debe registrar su aceptación o remediación, ejecutar un escaneo fresco del mismo lockfile y confirmar bundle/trazas antes del despliegue. El inventario CycloneDX reproducible, sus hashes de licencias y los criterios completos están en [la baseline](../.codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json) y [el gate de supply chain](../.codex/skills/clarin-excalidraw-development/references/supply-chain.md).
