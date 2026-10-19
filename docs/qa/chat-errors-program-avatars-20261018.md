# Seguimiento: errores de Chats y carga de fotos de Programas

## Causas reproducidas

| Síntoma | Causa | Corrección |
| --- | --- | --- |
| `Bad Request` al cambiar a Grupos, con conversaciones individuales aún visibles | Un scroll durante el cambio podía enviar el cursor del filtro anterior y cancelar la primera página correcta. Además, el límite relativo de fechas de reacciones se recalculaba en cada página y cambiaba el alcance del cursor. | Reinicio de filas, cursor y paginación antes de pintar otro filtro; bloqueo de páginas adicionales durante su primera carga; fechas estables para la misma consulta y rechazo de respuestas tardías. |
| Error de historial al abrir un grupo sin mensajes | El servidor respondía HTTP 200 y `success:true`, pero serializaba la colección vacía como `messages:null`. El cliente rechazaba ese contrato. Se reprodujo por GET autenticado en producción. | El repositorio devuelve `[]` y la proyección de caché normaliza los valores `null` antiguos. Los datos malformados y errores HTTP siguen siendo errores reales. |
| Fotos de Programas que vuelven a tardar al navegar | Cada montaje descargaba otra vez la foto privada y creaba una URL temporal. Cambiar de vista, abrir un detalle o volver repetía las descargas. | Caché de bytes únicamente en RAM por sesión, programa y revisión, con deduplicación de descargas; cada componente sigue creando y revocando su propia URL. |

Un grupo vacío muestra «Aún no hay mensajes en Clarin». Los fallos reales mantienen un aviso compacto en tonos neutros, icono semántico y acción de reintento accesible; los errores genéricos se presentan en español y conservan su código HTTP. No se sustituye un fallo por un éxito vacío ni se oculta una respuesta inválida.

La caché de fotos caduca a los 60 segundos, con un máximo de 32 imágenes completas y 8 MiB. Los accesos no prolongan la caducidad. El cambio de identidad cancela y vacía la caché; la revisión, retirada o reintento invalidan los bytes correspondientes. Una superficie con revisión antigua no puede cancelar la descarga de una revisión más nueva. Los permisos del servidor y `Cache-Control: private, no-store` permanecen intactos; no se guardan fotos en almacenamiento persistente del navegador.

## Medición anterior a la corrección

Se midió sólo la cuenta indicada explícitamente por el titular y se comprobó previamente la membresía del mismo actor de QA. El navegador bloqueó las escrituras de API y se cerró al terminar. No se publican identificadores, URLs privadas ni fotos en este informe.

Las cinco fotos respondieron HTTP 200. Desde el servidor, la lista tardó 116 ms y las fotos 60–70 ms, con tamaños entre 42 645 y 73 636 bytes. Desde el navegador, la lista tardó 184,7 ms; las imágenes tuvieron TTFB de 131–155 ms y duración de 159–269 ms. Quedaron visibles entre 346 y 478 ms desde el inicio de la petición de programas.

El recorrido Cuadrícula → Lista → Compacta → Cuadrícula → detalle → volver hizo 26 descargas: cinco por cada vista/lista y una del detalle. Las transiciones posteriores esperaban 427–599 ms y la vuelta 496 ms. Esa repetición, además de la primera descarga inevitable, es el defecto medido.

## Verificación de implementación

- Backend: reproducción roja de caché `messages:null`; corrección y pruebas focalizadas PASS. El fixture HTTP PostgreSQL cubre grupo vacío, página agotada, otro dispositivo y otra cuenta; usa el gate de contexto existente.
- Chats frontend: las tres reproducciones fallaban antes del cambio. Después pasaron 58 pruebas en seis archivos, incluidas respuestas tardías de recarga silenciosa y conservación de la ventana cargada durante eventos de WebSocket.
- Fotos de Programas: 27 pruebas aprobadas. Incluyen descargas simultáneas, reutilización al remontar, expiración, límites de bytes/entradas, revisión, retirada, reintento, sesión tardía, cancelación, timeout y conservación de la revisión más reciente. Dos reproducciones adicionales demostraron que una vista antigua sin foto o reintentando podía cancelar una revisión nueva; la invalidación ahora recibe la revisión conocida y sólo afecta revisiones iguales o anteriores. La retirada canónica de una revisión más reciente sigue cancelando las anteriores.
- Revisión independiente: aislamiento, recursos de fotos, paginación, Pendientes FIFO y honestidad de errores revisados. No hay cambios de esquema, dependencia WhatsApp, almacenamiento persistente, Leads ni permisos.
- `npx tsc --noEmit`: PASS sobre la corrección frontend combinada.
- Suite completa Go 1.27.2: PASS, con los cinco gates PostgreSQL aislados activados, dos CPU lógicas y un paquete a la vez. Incluye el fixture HTTP de historia vacía. Árbol backend `15184c0b25e0c0a1a2f4cef5446c00e090404ff4`, idéntico en `ddc086cc150c`, `0936f3815e2f` y el commit funcional final `3c7c7342ef36`; artefacto LF SHA-256 `8bc3c7e76323f835865b2639bac0831d18b5403a6af08b9c8c682b55b308d244`.

La compilación inicial se detuvo en el builder dedicado al detectar las dos carreras adicionales de invalidación, antes de sustituir servicios. Se verificó que los cinco contenedores de aplicación seguían ejecutando exactamente las imágenes previas respaldadas. Se conservó el log del intento cancelado y se preparó una reanudación que comprueba esa misma identidad antes de publicar el arreglo completo.

## Despliegue y aceptación final

El commit funcional `3c7c7342ef36bc227c76a53ee6cf54900a58d98a` está desplegado mediante `make deploy` desde `/root/proyect/clarin`, con exit 0 y compilación optimizada de Next.js aprobada. La versión pública comprobada es `2026.10.19-1-011923073661125-3c7c7342ef36`. El respaldo previo incluye base de datos, configuración e imágenes de reversión; los cambios posteriores a ese commit sólo documentan la aceptación. La fecha técnica de versión es UTC; esta intervención corresponde al 18 de octubre en Lima.

La aceptación de Chats sobre esa versión pasó diez comprobaciones en 1440 y 375 px. El GET real del grupo vacío devuelve HTTP 200, `success:true` y `messages:[]`, y la interfaz muestra su estado vacío sin alerta. Todos → Grupos → Todos → Grupos se probó reteniendo la primera respuesta de Grupos y desplazando la lista antes de liberarla: las veinte lecturas devolvieron 200, sin cursor anterior, sin HTTP 400 y sin conversaciones individuales bajo Grupos.

Se simuló únicamente en el navegador un HTTP 503 de lectura de historial, una vez en cada ancho. El aviso neutro siguió visible con su código; «Reintentar historial» recuperó el GET real 200/[] y retiró el aviso. Cero errores de JavaScript o transporte, cero intentos de escritura y cero mutaciones. Las capturas de conversaciones están protegidas con máscaras de privacidad, que no forman parte del producto; se inspeccionaron el vacío móvil y el error de escritorio.

La repetición real de Programas en la cuenta indicada pasó de **26 a 5 descargas de fotos (81 % menos)**. Las cinco pertenecen a la primera carga; Lista, Compacta, vuelta a Cuadrícula, detalle y regreso hicieron cero descargas adicionales. El GET de programas tardó 150,9 ms y las fotos 248–253 ms; quedaron visibles 259–274 ms después de la respuesta de la lista. Se conservaron las dimensiones de 40×40, 36×36 y 32×32 px según vista, sin saltos de diseño. Cero errores y cero escrituras. Los tiempos completos de navegación no mejoraron uniformemente, por lo que la mejora demostrada es la eliminación de descargas repetidas; la primera visita sigue necesitando red.

Las comprobaciones reales de `docker ps`, health, logs, versión pública, PostgreSQL y MCP sin bearer (401) pasaron. PostgreSQL y Redis respondieron correctamente, las mismas dos sesiones WhatsApp autenticadas permanecen conectadas y no hay indicadores fatales en los logs revisados. Los flags globales de grupos mantienen la activación autorizada. La huella completa de los 227 Leads de la cuenta de aceptación continúa idéntica; hay cero Leads o Pendientes grupales, teléfonos ficticios de grupos, preferencias inválidas y constraints nuevas sin validar.

El contador genérico de seis palabras de error del backend corresponde a dos líneas del socket upstream de WhatsApp con fin de lectura EOF, tres coincidencias por línea. No son seis fallos independientes ni errores de API, SQL o medios. No hubo `panic`, fatalidad o cierre de sesión; el health posterior sigue acreditando dos conexiones activas. Ese fragmento de log no demuestra por sí mismo una reconexión.

Las 85 pruebas frontend focalizadas, TypeScript, Go completo y compilación de producción complementan esta aceptación real. Los dos navegadores se cerraron, las dos sesiones temporales de QA se revocaron y sus archivos locales de credenciales se eliminaron. El builder dedicado quedó detenido y la base aislada de esta repetición fue retirada; se preservaron respaldos, caché de compilación e imágenes de reversión, sin purgas globales ni limpieza de datos vivos.
