# Utilitarios: guardado y documentos de texto

Ctrl+S (Cmd+S en macOS) y Guardar ejecutan el mismo guardado del documento
activo, incluidos sus dos paneles. El autoguardado continúa disponible. Descargar
es una acción independiente y conserva una extensión compatible con el formato.

La biblioteca permite renombrar y eliminar desde el menú de cada documento sin
abrirlo. La eliminación conserva su confirmación y la limpieza durable de archivos.
Las acciones sobre un documento cerrado no cambian el editor activo.

JSON, JSON con comentarios (JSONC) y XML conservan sus operaciones especializadas.
También se pueden editar TXT, Markdown, CSV, LOG, YAML, INI, HTML, CSS, JavaScript,
TypeScript y SQL. Los lenguajes adicionales usan resaltado local cuando existe;
sus contenidos siguen siendo documentos privados de texto.

Los guardados y cambios de metadatos de un documento se serializan. Los reintentos
tras respuestas perdidas conservan la identidad de la operación. El contenido
descargado utiliza su propia cabecera de versión; en el servidor, una lectura
mantiene el bloqueo compartido del documento hasta materializar su snapshot y diario.
Una eliminación sin respuesta no se repite desde el autoguardado: requiere
volver a confirmar la eliminación o conservar el borrador en una copia.

Un conflicto de documento es distinto de una desconexión o una sesión caducada.
Un conflicto conserva el borrador y detiene los reintentos con la versión antigua.
Se puede descargar el borrador, guardarlo en una copia independiente, o guardar
la copia y abrir después la versión canónica del documento original. La copia
completa debe quedar confirmada antes de sustituir el borrador original.

La privacidad por cuenta y propietario, el almacenamiento inventariado, los
límites, los originales importados y las reglas de sesión se mantienen. El
contenido de los documentos no se guarda en almacenamiento compartido del navegador.
