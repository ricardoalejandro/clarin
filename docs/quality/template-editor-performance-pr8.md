# Rendimiento del editor de plantillas — PR8

Mediciones ejecutadas el 11 de octubre de 2026 en el VPS, con Chromium headless y Fabric 7.4 real. No se repitieron para redactar este informe.

## Método y límites

- Ventana de 1100 × 800 px; superficie de edición de 900 × 650 px; página de 210 × 297 mm.
- Escenas de 30, 200 y 1000 objetos: 25 % Textbox y 75 % Rect, distribuidos en una cuadrícula.
- Zoom de 25 %, 100 % y 400 %. Cada combinación mide 24 desplazamientos de 5/−3 px con renderAll síncrono. p95 es el elemento floor(24 × .95) de las muestras ordenadas.
- Exportación de página PNG a 96 DPI y snapshot independiente; el documento interactivo no se reconstruye para exportar.
- El benchmark no mide latencia de red, apertura de imágenes, fuentes externas, PDF ni cuadros presentados por segundo. Las peticiones externas se respondieron con CSS vacío para aislar Fabric.
- Son costes de render en un VPS compartido, no una garantía de FPS. No hubo sincronización con requestAnimationFrame ni medición de presentación del navegador.

## Implementación final medida

| Objetos | Inicio (ms) | p95 25 % (ms) | p95 100 % (ms) | p95 400 % (ms) | Snapshot (ms) | PNG (ms) | PNG (bytes) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 62.0 | 4.7 | 3.0 | 1.3 | 5.7 | 230.3 | 29 532 |
| 200 | 82.5 | 9.7 | 5.6 | 2.8 | 23.2 | 516.5 | 64 775 |
| 1000 | 236.1 | 42.6 | 15.4 | 4.7 | 51.5 | 1596.3 | 237 035 |

Los 1000 objetos a 25 % siguen siendo el caso más costoso: media 19.21 ms y p95 42.6 ms. No se afirma fluidez constante a 60 FPS en esa escena. El inverso matemático de ese p95 es 23.5 operaciones de render por segundo; no equivale a FPS observados. A 100 % y 400 %, los respectivos inversos son 64.9 y 212.8, también sin incluir composición, interacción ni presentación.

## Caché y comparación

Se desactivó objectCaching en figuras simples, texto e imágenes sin sombra ni clipPath; grupos y objetos que necesitan esos efectos conservan su caché. Esto evita multiplicar el mínimo de caché raster de Fabric por cientos de objetos sencillos.

Una ejecución experimental previa con caché desactivada midió 1000 objetos a 25 % con media 9.5 ms y p95 19.2 ms; la ejecución final, durante otras compilaciones del VPS, registró 42.6 ms. Ambos resultados originales se conservan. No se presenta 19.2 ms como garantía final ni como comparación controlada entre cargas de máquina.

En la inspección inicial se observó p95 102.6 ms antes del ajuste de caché. Ese resultado quedó en la salida de la sesión, pero su JSON fue reemplazado por la ejecución final: no se usa como evidencia durable de una mejora porcentual.

Las ejecuciones experimental y final produjeron el mismo número de objetos y los mismos tamaños de PNG en las tres escenas. Esto es una comprobación de consistencia, no una comparación byte a byte ni una prueba exhaustiva de paridad visual entre modos de caché.

## Integridad y evidencia

El script compara el JSON de la escena antes y después de snapshot/export y falla ante cambios. Los objetos exportados fueron exactamente 30, 200 y 1000. El campo viewportUnchanged del JSON es una etiqueta del resultado; la comprobación separada de la matriz del viewport vive en runtime.test.ts, que también verifica píxeles PNG y el PDF real.

Las pruebas Fabric reales cubren además matrices de grupos transformados y anidados, desagrupar, clipboard en coordenadas de escena, límites de selección, visibilidad de objetos ocultos y fondo compartido.

- [Resultados finales](evidence/template-editor-performance-pr8.json)
- [Experimento previo sin caché](evidence/template-editor-performance-pr8-experiment.json)
- [Script utilizado](evidence/template-editor-performance-pr8.cjs)
- Pruebas: frontend/src/lib/fabric/runtime.test.ts.

No se modificó el formato V2/V3 ni se sustituyó Fabric. Las composiciones con imágenes tienen preflight independiente de 40 MP por fuente/filtro, 64 MP agregados y cuatro lecturas concurrentes; este benchmark de figuras no valida sus tiempos.
