# Pizarra: tipografía por selección

El artefacto `0.18.1-clarin.9` amplía el fork local de Excalidraw v0.18.1.
La extensión `customData.clarinCharacterStyle` versión 1 conserva color,
familia y escala tipográfica por rangos UTF-16 completos de grafemas. Los
formatos anteriores de marcas y párrafos, el texto plano y los datos opacos
del documento siguen siendo independientes.

Durante la edición, las propiedades tipográficas actúan sobre la selección.
Con el cursor sin selección configuran la escritura posterior. Fuera de edición,
actúan sobre el objeto completo y eliminan solo las excepciones de la propiedad
elegida. La alineación conserva su alcance de párrafo.

El tamaño de cada fragmento es proporcional al tamaño base del objeto. Escalar
el objeto conserva esas proporciones; redimensionar su ancho reorganiza las líneas.
Las medidas incluyen la métrica base del párrafo y las métricas de los fragmentos
para evitar que se recorten fuentes o tamaños mezclados. Canvas y SVG comparten
las mismas posiciones; las fuentes de los fragmentos se incluyen en la carga y
exportación locales. Sin la nueva extensión se conserva el recorrido anterior.

Los fragmentos que comparten fuente se forman juntos para conservar kerning,
ligaduras y uniones al cambiar únicamente el color. Las mediciones nativas
temporales no conservan contenido en el DOM; sus cachés son débiles y acotadas.
La pintura por colores mantiene una sola máscara de glifos para preservar la
opacidad y evitar cortes entre fragmentos.

El historial conserva conjuntamente texto, marcas, párrafos, estilos, selección
y formato futuro del cursor. Cancelar un selector no escribe en la escena. El
portapapeles privado conserva tamaños efectivos entre objetos con distintas
bases; pegar texto plano hereda el formato del cursor.

Frontend y backend validan versión, hash, longitud, rangos, catálogo de fuentes,
colores normalizados, escalas y límites de segmentos. Las escrituras inválidas se
rechazan. Al abrir una escena histórica, una extensión inválida se retira sin
eliminar el texto ni otras extensiones.

No se reescriben escenas ni revisiones históricas. Los artefactos anteriores se
conservan para recuperación; un cliente anterior puede mostrar la tipografía base
y preservar la extensión opaca si no altera el texto.

La evidencia de verificación, límites de este entorno y estado de promoción se
registran en el informe de entrega asociado al PR. Una compilación por sí sola
no constituye una comprobación de persistencia, colaboración o despliegue.
