# Actualización de dependencias: candidato del 14 de septiembre de 2026

## Estado y alcance

**Supply chain verificada; actualización web promovida después de completar los gates de release el 15 de septiembre.** La revisión independiente descrita debajo conserva su alcance original; el cierre posterior, con compilación, navegador, despliegue y runtime, está en [el informe de entrega](next16-release-verification-2026-09-14.md). Offline v3 permanece NO-GO hasta aceptación Windows real; no se habilita por haber corregido las dependencias.

El snapshot [anterior](offline-v3-dependency-audit-2026-09-14.json) conserva las alertas iniciales. El [informe nuevo, legible por máquina](security-dependency-audit-after-2026-09-14.json) conserva los resultados completos npm y las consultas/respuestas de OSV y GitHub del lock final, con clasificación explícita de cada coincidencia.

## Identidad inmutable

| Material | Identidad verificada |
| --- | --- |
| Entorno de auditoría | Node `24.21.0` |
| Frontend | Next `16.3.5`, React/React DOM `19.3.0` |
| PDF / canvas / hojas de cálculo | jsPDF `4.2.1`, Fabric `7.4.0`, SheetJS CE `0.20.3` |
| Tooling | Vitest/mocker `4.1.11`, Vite `6.4.3`, esbuild `0.25.12`, esbuild-sass-plugin `3.3.1`, jsdom `26.1.0` |
| Lock SHA-256 | `d0369d439b9b1fd3526996892f5a05efafa8fb55974f5a6670a9c08459e42b70` |
| Motor | `@excalidraw/excalidraw@0.18.1-clarin.7` |
| Origen del motor | Tag `v0.18.1`, commit `a2ec2889babf7d2295469c6d90ebe77fae57df84` |
| Árbol del fork SHA-256 | `da5a8d51ecf03dda77fa668954710ee994c8c43d8ba3703fdfbc684df372797a` |
| SBOM del motor | 248 componentes; SHA-256 `f0bc6879b5d913e8f1f7e250c448edb17f1a72d0af491cf0982c28225aebdef2` |
| SheetJS tarball SHA-256 | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |

El tag y la integridad npm de Excalidraw se resolvieron nuevamente en sus servicios oficiales. El archivo local de SheetJS se comparó byte a byte contra una descarga nueva del CDN oficial: coincide y el paquete instalado declara `0.20.3`. No se ejecutaron lifecycle scripts durante estas consultas de procedencia.

La [baseline vigente](../frontend/third_party/excalidraw/supply-chain-2026-09-14.json) y el [SBOM archivado](../frontend/third_party/excalidraw/excalidraw-0.18.1-clarin.7.cdx.json) sustituyen, para este candidato, los datos históricos de `.codex`, que se mantienen intactos. La generación verifica el árbol, el cierre runtime/optional/peer y las licencias omitidas de `fuzzy@0.1.3` y `khroma@2.1.0`; `--verify` exige igualdad byte a byte con el archivo archivado.

Se comparó el cierre anterior de 251 componentes con el nuevo de 248. Las sustituciones incluyen React/Radix, nanoid, lodash-es, picomatch y el parser Mermaid; los componentes añadidos tienen licencia MIT. Se eliminan duplicados y dependencias que ya no forman parte del cierre. No se cambiaron licencias ni archivos de fuentes. Esta revisión no convierte las 248 dependencias instaladas en 248 módulos ejecutados por el navegador.

## Auditoría nueva y discrepancias entre bases

Ventana de consulta: **2026-09-14 23:32:44–23:32:49 UTC**. Se consultaron 710 pares públicos nombre/versión del lock, incluidos tooling y dependencias opcionales. El fork privado también se consultó con su origen upstream `0.18.1`; la identidad `.7` se acredita mediante árbol, revisión local y pruebas, no mediante un registro público inexistente.

| Fuente / alcance | Resultado bruto | Clasificación |
| --- | --- | --- |
| npm, grafo completo | 0 hallazgos | Sin alertas npm |
| npm, `--omit=dev` | 0 hallazgos | Sin alertas npm |
| OSV, todas las versiones | 2 advisories, ambos SheetJS | No afectados en el tarball oficial 0.20.3 |
| GitHub reviewed, todas las versiones | 1 advisory esbuild | Retirado por GitHub |
| Cierre Excalidraw | 0 coincidencias activas | No requiere excepciones históricas de dependencia |

No se suprimen resultados por severidad o conveniencia:

- `GHSA-4r6h-8v6p-xvw6` / CVE-2023-30533: OSV representa `xlsx` con un rango npm abierto, pero registra `last_known_affected_version_range: <0.19.3`. El [aviso oficial de SheetJS](https://cdn.sheetjs.com/advisories/CVE-2023-30533) sitúa la corrección en 0.19.3. El artefacto CDN 0.20.3 verificado está corregido.
- `GHSA-5pgg-2g8v-p4x9` / CVE-2024-22363: OSV repite ese rango abierto y registra como última franja afectada `<0.20.2`. El [aviso oficial](https://cdn.sheetjs.com/advisories/CVE-2024-22363) sitúa la corrección en 0.20.2. El candidato usa los bytes oficiales 0.20.3.
- `GHSA-gv7w-rqvm-qjhr`: [GitHub lo retiró el 17 de junio de 2026](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) porque identificaba incorrectamente el paquete afectado. El hallazgo trataba la distribución Deno, no el paquete npm/Node utilizado aquí. Se conserva el registro bruto y su fecha de retirada.

Los contratos de consulta y paginación son los oficiales de [OSV querybatch](https://google.github.io/osv.dev/post-v1-querybatch/) y [GitHub global advisories](https://docs.github.com/en/rest/security-advisories/global-advisories#list-global-security-advisories). Todos los lotes terminaron y no hubo errores de consulta. Cero coincidencias activas aplicables no significa ausencia de vulnerabilidades desconocidas ni prueba de autorización correcta.

## Fronteras corregidas y compatibilidad exigida

- **Mermaid:** el host ya ocultaba IA, pero el portapapeles podía invocar la conversión. `.7` añade una comprobación compartida antes de importar/invocar el parser tanto en pegado como en diálogo. Los advisories transitivos también se corrigen: no se usa la ocultación de UI como excepción de seguridad. La prueba de navegador nueva exige pegado como texto, segundo pegado ordinario, cero entradas al cargador mediante cobertura precisa y ausencia de egress; su resultado final lo registra el responsable de la matriz.
- **Fabric:** la fachada central conserva orígenes left/top y los defaults de interacción de v6. Los gradientes legacy convierten alpha con la semántica upstream sin perder orígenes explícitos. [Aviso de atribución y MIT completo](../frontend/THIRD_PARTY_FABRIC.md). La garantía de compatibilidad exige JSON legacy, V2, raster/PDF y geometría real, no solo compilación.
- **SheetJS:** las importaciones de usuario sí alcanzan el parser; no se consideraron mitigadas por ser locales. Las pruebas utilizan un XLSX real alterado con referencias de comentario especiales y controles legítimos, además del contrato de 62 columnas/Unicode/ceros iniciales/fechas.
- **jsPDF:** Clarin usa exportación legítima de texto e imágenes; las pruebas ejercitan también las superficies vulnerables de anotaciones y ventanas HTML para confirmar la corrección instalada sin abrir código activo externo.
- **Tooling del fork:** se elimina solo el bloque upstream de devDependencies no utilizado. Los imports reales de esbuild/Sass y los tres tests Clarin resuelven el tooling raíz; esto no equivale a prometer que la suite completa upstream o sus scripts de aplicación siguen disponibles.

Los cambios de Next/React requieren el pase final de rutas, autenticación, CSP, workers y render de producción. El informe de supply chain no sustituye esas pruebas ni autoriza cambios de comportamiento adicionales.

## Evidencia ejecutada en esta revisión

- Resolución oficial del origen Excalidraw y comparación byte a byte de SheetJS: PASS.
- Árbol `.7`, hashes de ambas licencias omitidas y cierre SBOM de 248 componentes: PASS.
- SBOM regenerado contra el archivo temporal previo y archivado bajo `frontend/third_party/excalidraw`: PASS.
- Suite de regresión del generador SBOM: PASS.
- Verificador de avisos contra el paquete `.7` y sus fuentes: PASS, sin bloqueos ni advertencias. Conserva los marcadores históricos que exige el verificador de `.codex`; la identidad vigente se verifica separadamente contra la baseline nueva.
- Auditorías npm completas y producción; consultas OSV/GitHub con clasificación de resultados: PASS para los límites descritos.
- `src/lib/securityDependencyRegression.test.ts`, Node24/Vitest4.1.11: **10/10 PASS** (jsPDF y SheetJS).

El build completo y la matriz final de navegador/collaboración/egress están coordinados por el responsable del release. No se afirman terminados en esta revisión independiente. Tampoco se realizaron despliegue ni comprobaciones de salud de contenedores.

## Gate de promoción y rollback

Antes de promover: registrar build/TypeScript y suites finales; ejecutar la matriz de navegador incluyendo Mermaid, autenticación, raster/gradientes y egress; verificar avisos en el artefacto generado; identificar el artefacto anterior exacto de rollback; y completar las comprobaciones de runtime tras cualquier despliegue autorizado. La actualización del aviso fuente requiere regenerar su copia `public/vendor/whiteboards-editor/0.18.1-clarin.7/NOTICE.md` antes de distribuirla.

No se cambia el esquema canónico de escenas ni se reescriben revisiones almacenadas. El rollback debe restaurar juntos el artefacto frontend, lock, fork, fachada y CSP compatibles; no degradar destructivamente datos. No se vuelve a considerar seguras las dependencias vulnerables anteriores por usarlas como recuperación temporal. Offline v3 permanece deshabilitado hasta su aceptación Windows real independiente.

## Cierre del responsable de release — 2026-09-15

Gates de web completados: suite global1197, fork23, scripts29 y licencias9; TypeScript/Go/build; Fabric, SW/offline y Pizarras Chromium/Firefox; manifiesto y licencias servidas; `make deploy` exit0; versión pública/interna e imágenes exactas; runtime no-root; laboratorio final con login Turnstile y aislamiento real. Los detalles, límites y artefactos de recuperación están en el informe de entrega, sin atribuir estas tareas posteriores al revisor independiente.

Auditoría pública repetida00:00:38–00:00:44 UTC: [evidencia nueva](security-dependency-audit-refresh-2026-09-15.json). Los710 pares y resultados brutos se compararon con el snapshot anterior: idénticos, sin errores, npm all/prod0; se mantiene la clasificación explícita de las dos coincidencias SheetJS y el advisory retirado. No se afirma ausencia de vulnerabilidades desconocidas.
