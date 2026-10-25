# Zoom de fotografías y administradores primero

## Alcance

Se conservan las ventanas actuales. El área de imagen captura Ctrl/Meta + rueda con un evento nativo no pasivo y admite pellizco y desplazamiento con Pointer Events; fuera de esa área no se cancela el zoom del navegador. No se cambia el viewport global ni se deshabilita el zoom de accesibilidad.

El control compartido aplica límites, zoom alrededor del cursor o centro del pellizco, desplazamiento acotado, reinicio por recurso, limpieza de capturas/listeners y observación de tamaño. Incluye controles visibles y estados de carga, error y reintento.

| Superficie | Integración |
| --- | --- |
| Chat y chat contextual | `ImageViewer`, conservando ventana, rotación, navegación y límites anteriores |
| Contactos, Leads, Eventos, Programas y detalle de Chat | Modo de visualización de `ContactAvatarControl` |
| Participantes, instructores e historial de Programas | `ContactPhotoPreview`, con propietario explícito y aislamiento de sesión |
| Foto del Programa | Modo de visualización de `ProgramAvatar` |
| Adjuntos de tareas, incluidos accesos CRM | Rama de imagen de `TaskAttachmentViewer` |

Los editores, recortes, comparaciones de WhatsApp y confirmaciones no comparten estos gestos de visualización. Los adjuntos mantienen imagen y marca bajo una única transformación; arrastrar o pellizcar no crea un comentario y un clic deliberado conserva las coordenadas normalizadas.

## Integrantes

`order=admins_first` es optativo en el endpoint existente. Los roles reales `admin` y `super_admin` preceden a los demás; cada bloque conserva el orden previo por JID. Se ordena en PostgreSQL antes del límite, incluso con búsqueda.

El cursor `gp1` vincula cuenta, chat/dispositivo, consulta, orden y revisión de membresía. Un cursor anterior o incompatible devuelve `409 participants_cursor_reset`. El cliente reinicia una sola vez bajo la misma sesión de petición, reconstruye las páginas visibles y conserva filas, búsqueda, selección y scroll. Si vuelve a fallar, conserva los datos y ofrece reintento. Rechaza una respuesta que no confirme el orden.

Los clientes sin el parámetro mantienen el JSON y el cursor anteriores. No hay migraciones, escrituras CRM, creación de Contactos, consultas al proveedor ni mensajes como consecuencia de ordenar.

## Verificación y límites

- Backend: suite Go completa y compilación Linux aprobadas con PostgreSQL aislado. Las pruebas específicas SQL y HTTP de paginación se ejecutaron sin omisiones: varias páginas, búsqueda proyectada, cambio de rol, cursor antiguo, cuenta/dispositivo distintos, ausencia de administradores, grupo vacío y preservación CRM.
- Frontend: TypeScript y compilación de producción completos aprobados (incluidas comprobaciones CSS y artefactos offline/Pizarras). Los tests específicos cubren geometría, rueda cancelable, pellizco, límites, reintento, cambio/suspensión de recurso, foco, marcas y reconciliación de páginas.
- Navegador: 58 escenarios aprobados: 45 fotos/contextos (9 × 320/375/768/1024/1440 px), 5 listas administrativas y 8 combinaciones sidebar/Eros. Incluye 18 pellizcos móviles mediante eventos táctiles CDP. Escala de imagen 1→1.35 con rueda y →3.24 con pellizco; ancho/alto/DPR/escala del viewport de página estables. Sin desbordamiento, errores JS ni escrituras de negocio. Los adjuntos conservaron marcas correctas y el listado pasó 50→72 con promoción de rol, misma fila y scroll 120. La verificación visual usa los componentes reales, estilos compilados y datos sintéticos. No equivale a navegar con una sesión autenticada por cada módulo ni a probar un teléfono físico.
- No requiere probar envío de WhatsApp. Las identidades, permisos, procesos CRM y recuperación histórica conservan su lógica.

Los resultados finales de compilación, suite completa, navegador y publicación se incorporan al cierre de esta entrega.
