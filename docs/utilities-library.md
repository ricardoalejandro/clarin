# Biblioteca personal de Utilitarios

## Comportamiento

Los documentos pertenecen a un usuario dentro de una cuenta. El permiso `utilities` es obligatorio también en el backend. El acceso administrativo a la cuenta no convierte la biblioteca de otro usuario en una biblioteca compartida.

La biblioteca conserva pestañas, nombres, carpetas de un nivel, favoritos, configuración y archivos. Cerrar una pestaña conserva el documento. Eliminar confirma el nombre, retira su acceso y programa la eliminación física de los objetos. No elimina el archivo original del ordenador, exportaciones ni copias de seguridad externas.

El autoguardado espera dos segundos desde la última edición, con un máximo de cinco segundos durante escritura continua. `Guardado` significa que el servidor confirmó una escritura durable; la consolidación posterior no cambia esa garantía. Los cambios llevan versión base y `operation_id`; un conflicto conserva el borrador y permite descargarlo o guardarlo como una copia. Una salida interna espera al guardado; una salida con cambios pendientes se protege. Al cerrar sesión o cambiar cuenta se abortan las operaciones y se liberan los recursos de memoria.

Las búsquedas esperan exactamente 500 ms, cancelan consultas anteriores y rechazan respuestas obsoletas. La búsqueda de biblioteca examina nombres y contenido ordinario indexado, con texto literal de 3 a 128 caracteres para contenido. La indexación es por versión y puede ir detrás del guardado; la interfaz muestra ese estado. La búsqueda dentro del editor recorre todo el documento, incluso fuera del fragmento visible.

## Contenido y almacenamiento

Las rutas viven bajo `/api/utilities`, separadas en `documents`, `folders`, `workspace` y `vault`. Cada consulta utiliza cuenta y propietario del contexto autenticado. Ninguna ruta acepta al propietario desde el cliente como autoridad.

Los metadatos se almacenan en PostgreSQL. Los cuerpos y archivos usan MinIO privado, con prefijo de cuenta y propietario, inventario de almacenamiento, cuotas y trabajos duraderos de limpieza. Las rutas autenticadas entregan contenido con `no-store`; no se publican enlaces directos al objeto privado.

Cada documento puede tener varios archivos o paneles independientes. Los cambios pequeños se guardan como un journal de rangos UTF-16; los reemplazos completos se suben como objetos binarios. Los trabajos consolidan el journal y actualizan fragmentos de búsqueda `pg_trgm`. Una versión anterior solo se elimina después de confirmar su sustitución y comprobar referencias. Los fallos entre subida y asociación dejan una intención de limpieza duradera.

Las migraciones forman parte de `Migrate()` y deben poder ejecutarse repetidamente. La limpieza revalida referencias antes de borrar y evita que un trabajo de indexación anterior vuelva a crear contenido eliminado.

El borrado físico es asíncrono y reintentable. Incluye las versiones de objetos de un bucket con versionado; no basta con crear una marca de eliminación. Una referencia vigente de otro recurso o de la papelera impide borrar el objeto hasta que se libere.

Los documentos no se guardan en `localStorage`, `sessionStorage`, URLs, telemetría ni contexto Eros. Las llamadas de fondo pueden renovar el JWT, pero no representan actividad humana y no amplían el plazo de inactividad.

## Editor de archivos grandes

- Tamaño recomendado habitual: 30 MiB. Máximo de entrada, edición, transformación, guardado y reapertura: 60 MiB por panel, medidos en UTF-8.
- Reparación: 2 MiB; comparación: 5 MiB; profundidad: 160 niveles. Fallos o límites conservan el original.
- Las líneas enormes utilizan fragmentos editables con límites Unicode seguros, una fuente completa y revisión para rechazar resultados antiguos. El contenido no atraviesa React por cada pulsación.
- Validación, formato y búsqueda utilizan workers locales y cancelables. Cerrar o cambiar documento destruye modelos, workers y URLs de su sesión.
- Los archivos admiten UTF-8, UTF-16LE/BE y selección de Windows-1252/ISO-8859-1. BOM, declaración y selección deben ser coherentes. La descarga UTF-8 respeta la declaración XML y protege originales firmados.
- Se mantienen JSON/JSONC, lexemas numéricos, claves duplicadas, comentarios, contenido XML mixto, CDATA, `xml:space` y las restricciones contra DOCTYPE/entidades externas.

## Claves y certificados

La biblioteca criptográfica soporta AES-128/256, RSA-2048/3072/4096 y ECDSA P-256/P-384. Importa PEM/DER SPKI o PKCS#8, JWK, certificados X.509 y P12/PFX con algoritmos compatibles con Web Crypto. Un P12 con varias claves privadas se rechaza explícitamente: se importa una entrada por archivo, con su cadena de certificados.

La importación conserva la cadena completa y comprueba la correspondencia entre certificado y clave privada. Un P12 con varias claves privadas o elementos no compatibles se rechaza completo; no se presenta una importación parcial como exitosa. Eliminar una clave seleccionada limpia su referencia; un error temporal conserva la selección para reintentar.

PKIjs 4.0.1 y ASN1js 4.0.0 se cargan en un worker local para formatos, CSR y certificados. Las licencias de estas dependencias y sus nuevas dependencias transitivas se distribuyen en `/licenses/utilities/NOTICE.txt`; las versiones y huellas de los paquetes constan en el lockfile.

El catálogo permite renombrar, describir, inspeccionar, buscar metadatos, seleccionar claves compatibles, exportar y eliminar. Permite crear CSR, certificados autofirmados de prueba y firmar/verificar JWT con RS256/ES256/ES384. Un certificado dentro de fechas no equivale a confianza de una CA; la verificación JWT comprueba firma y restricciones temporales aplicables.

Las exportaciones PKCS#8/P12 privadas requieren contraseña de al menos ocho caracteres. AES ofrece JWK protegido por contraseña en JWE (PBES2-HS512+A256KW/A256GCM), con su importación correspondiente. La exportación JWK sin protección se identifica explícitamente. Las contraseñas se conservan solo durante la operación. Los CSR y certificados generados quedan asociados a la entrada y se pueden volver a exportar. La generación local temporal original permanece disponible.

### Configuración de custodia del servidor

Configurar por el mecanismo de secretos del despliegue:

- `UTILITIES_VAULT_ACTIVE_KEY_ID`: identificador de la maestra activa.
- `UTILITIES_VAULT_MASTER_KEYS`: objeto JSON que asigna identificadores a claves maestras AES de 32 bytes codificadas en Base64.

No reutilizar JWT, contraseñas de usuarios ni claves de otras integraciones. No incluir valores reales en este documento, commits, salidas de herramientas o registros. La ausencia o invalidez de esta configuración deshabilita la bóveda con una explicación; no impide usar el resto del producto. El arranque nunca genera una maestra sustituta silenciosamente.

Cada entrada utiliza una clave de datos aleatoria y AES-256-GCM. La maestra protege esa clave; cuenta, propietario e identidad de la entrada autentican el contexto. El contenido privado nunca se incluye en configuración general, índices de búsqueda, eventos o registros. El backend descifra en memoria únicamente después de autorizar al propietario. La recuperación operativa depende del respaldo de las maestras; no da lectura ordinaria de otras bibliotecas a administradores desde la interfaz.

Para rotar, respaldar el nuevo conjunto, añadir una maestra con identificador nuevo y cambiar la activa, manteniendo las anteriores. El proceso reenvuelve claves de datos por lotes sin reescribir objetos. Las antiguas no se retiran hasta verificar la rotación y que tampoco las necesitan los respaldos retenidos. Probar restauración del respaldo de base, objetos y maestras juntos en un entorno aislado.

La rotación modifica el sobre únicamente desde el trabajo transaccional que bloquea la fila. Leer material no modifica ese sobre, para evitar carreras con una sustitución concurrente durante una actualización de varias instancias.

JKS/JCEKS, firmas XML/PDF, una CA operativa y acceso al almacén del sistema quedan fuera de esta versión.

## Sesiones y verificación

El plazo de cuenta es por inactividad. Se copia al iniciar sesión o seleccionar cuenta; las sesiones abiertas conservan su plazo. La interfaz presenta el configurado y el efectivo, con vencimiento estimado y límite absoluto de siete días. El autoguardado no amplía la sesión.

Verificar pruebas unitarias frontend completas, TypeScript, build de producción y `go test ./...`. Las pruebas de integración de Utilitarios requieren PostgreSQL y MinIO aislados: cubren migración idempotente, cuenta/propietario, CAS, journal, búsqueda, cifrado y eliminación física. Las pruebas de navegador `utilities-library`, `utilities-large-documents`, `utilities-vault`, `utilities-access` y `utilities-images` cubren los flujos y las regresiones de controles existentes.

Las pruebas con servicios aislados o API simulada no acreditan un despliegue. Antes de publicar, revisar la configuración protegida, capacidad de disco para índices y los resultados medidos de archivos grandes. Despliegue y sus verificaciones de salud requieren un paso separado.

La prueba de navegador del 14/11/2026 importó un XML de 30 MiB en 3517 ms y encontró una coincidencia fuera de los primeros 20 MiB en 1045 ms, incluidos los 500 ms de espera de búsqueda. Comprobó dos ediciones consecutivas, descarga y deshacer. Se ejecutó en un equipo de 12 procesadores lógicos y 32 GiB de memoria, con la API de biblioteca simulada; mide el procesamiento local y no la latencia real de almacenamiento. Estos valores no garantizan el mismo tiempo en otro equipo ni con cualquier estructura de archivo.

El cierre histórico de sesión a los 40 minutos no se reprodujo. Se conserva la política de inactividad por sesión y se incorporan el plazo efectivo visible y motivos de cierre correlacionables, sin registrar credenciales, para distinguir expiración, revocación, cambio de cuenta y fallos del servicio.
