# Límites operativos de Pizarras

## Intercambio de enlaces públicos

`POST /api/public/whiteboard-links/:id/session` recibe sólo el nombre visible,
la contraseña opcional y el secreto del enlace. El cuerpo máximo es **16 KiB**.

La protección existe en dos capas:

1. El router Traefik `clarin-whiteboard-guest-session`, de prioridad 250, aplica
   `buffering.maxRequestBodyBytes=16384` antes de enviar la petición al backend;
   su regex es case-insensitive y admite el slash final opcional igual que Fiber.
2. `guardWhiteboardGuestSessionExchange` comprueba `Content-Length`, el cuerpo
   real y los límites por IP/enlace antes de ejecutar `BodyParser`.

No se debe quitar el límite del proxy. Fiber conserva un límite global de 52 MiB
porque otros módulos cargan ficheros grandes y fasthttp puede materializar el
cuerpo antes de ejecutar el middleware de una ruta. Si se sustituye Traefik por
Nginx u otro proxy, se debe replicar un límite exacto para esta ruta (por ejemplo,
en Nginx: `client_max_body_size 16k`) y verificar un `413` desde el exterior.

## Mutaciones pequeñas de comentarios y bibliotecas públicas

Traefik usa routers de prioridad 260, por encima del router API general, para
rechazar cuerpos antes de que Fiber los materialice:

- inicio, callback y confirmación de importación de biblioteca: **4 KiB**;
- crear, responder, editar, eliminar, resolver o reabrir comentarios: **16 KiB**.

Las reglas combinan método y forma de ruta exactos, con coincidencia
case-insensitive y slash final opcional igual que Fiber; los `GET` de hilos y
páginas de comentarios permanecen en el router API normal. Los guards repiten
los límites antes de `BodyParser` para defensa en profundidad. Los puertos 8080
y 8081 se publican sólo en `127.0.0.1`; Traefik accede por `dokploy-network`, por
lo que no existe un bypass remoto directo a los límites del borde.

Los guards JSON rechazan con `415 whiteboard_content_encoding_unsupported`
cualquier `Content-Encoding` no vacío antes de llamar `c.Body()`. Así un cuerpo
gzip pequeño no puede expandirse dentro del proceso antes de aplicar el límite.

El listado de hilos devuelve como máximo 40 hilos y cinco comentarios por hilo
(200 cuerpos / 3,2 MB globales). Informa `comment_count`,
`comments_has_more` y `comments_next_cursor`; el historial restante se obtiene
por el endpoint paginado del hilo, limitado a 100 cuerpos / 1,6 MB por página.

## Tickets de colaboración y registros de acceso

El ticket de `/ws/whiteboards/:id` dura poco y viaja en la query de una ruta de
Clarin. El access log de Fiber usa `${path}` y no `${url}` ni `${queryParams}`;
una prueba del backend garantiza que ese secreto y su query no aparecen en el
registro.

La navegación hacia el catálogo público usa otro transporte: el `POST` de
inicio coloca la prueba efímera en una cookie host-only, `HttpOnly`,
`SameSite=Strict`, con ruta exacta al `GET /navigate` de la importación y
`Secure` en producción. La URL relativa devuelta al frontend no contiene
query ni secreto. El `GET` revalida actor, cuenta, ACL, biblioteca, estado y
expiración; consume la navegación una sola vez, elimina la cookie y sólo
entonces redirige al catálogo. Así el handoff no aparece en historial ni logs
de acceso de Clarin y no depende de que el proxy conserve `Sec-Fetch-*`.

En el despliegue actual de Dokploy, Traefik no tiene `accessLog` habilitado. Por
tanto, hoy el proxy tampoco registra la query, pero esto es **ausencia de log**,
no redacción. Antes de habilitar access logs en Traefik o cambiar de proxy se
debe configurar el formato para omitir por completo la query del ticket de
WebSocket (o cambiar su transporte), comprobarlo con un ticket señuelo y
documentar la retención. No basta con confiar en que el ticket caduque: un
handshake fallido puede dejarlo válido durante su ventana breve.

## Escenas y colaboración

- Escena canónica REST: máximo 16 MiB.
- Mensaje realtime/fanout: máximo 1 MiB.
- La presentación usa una única concesión Redis por cuenta y pizarra, con TTL
  de 45 segundos y renovación servidor-side cada 15 segundos. No se persiste en
  PostgreSQL, revisiones, MinIO ni en el JSON de la escena.
- `follow.change` valida que el objetivo continúe presente en la misma sala.
  `viewport.update` acepta sólo cuatro coordenadas finitas y acotadas, tiene
  presupuesto independiente y el cliente lo agrupa a un máximo de un envío
  cada 50 ms. Ninguno de estos eventos se guarda.
- `scene.snapshot` o ACK canónico: máximo seguro 900.000 bytes, dejando espacio
  al sobre Redis y a los metadatos.
- Una escena mayor sigue siendo válida por REST. El backend emite
  `sync.required` y el cliente recarga la escena mediante su endpoint autorizado.
- Los `PUT` completos de invitados y el fallback REST `PATCH` se limitan antes
  de `BodyParser`, por sesión, IP y enlace. El `PATCH` usa presupuestos
  decrecientes por tamaño: 60 solicitudes/minuto hasta 1 MiB, 20 entre 1 y
  4 MiB, y 6 por encima de 4 MiB por sesión.
- Tras autenticar la sesión, la persistencia completa también se limita por
  pizarra y cuenta antes de comprimir, bloquear PostgreSQL o escribir en MinIO.

## Retención del historial

- Las revisiones automáticas y sus instantáneas inmutables caducan a los 30
  días. El worker las elimina por lotes y sólo libera imágenes cuando la prueba
  global de referencias confirma que ningún lienzo, revisión u otro consumidor
  vivo las utiliza.
- Las revisiones manuales, la escena inicial del sistema y las restauraciones no
  caducan. Permanecen hasta la purga permanente y autorizada de la pizarra.
- Las operaciones `patch`, las operaciones `snapshot` cuya revisión ya fue
  depurada y la actividad técnica ruidosa (`scene.patched`,
  `scene.snapshotted`, `thumbnail.updated`) se compactan después de 30 días en
  lotes acotados. Las operaciones de creación/restauración y la actividad
  significativa no se seleccionan.
- Un cliente realtime sólo recibe replay incremental cuando cada operación
  forma una cadena completa desde su secuencia base hasta la escena canónica.
  Ante un hueco por compactación, el servidor exige una sincronización de la
  escena canónica; nunca aplica una cola parcial.

## Bibliotecas y recursos

El listado de bibliotecas no devuelve `library_json`; entrega resumen, número de
elementos y tamaño. El JSON (máximo 8 MiB) se obtiene sólo desde el detalle
autorizado. Las descripciones tienen un máximo de 1.000 caracteres Unicode.

Los listados de recursos son cursor-paged (`50` por defecto, `200` máximo). Para
hidratar un editor se usa `referenced_only=1`; los identificadores se derivan en
el repositorio desde la escena o biblioteca canónica de la misma cuenta. Nunca
se aceptan IDs de fichero del cliente como prueba de autorización.
