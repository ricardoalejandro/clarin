# Changelog — Clarin CRM

## 2026-07-31

### Build 1 — Detalle legible, descripción amplia y menús correctos
- 💄 Clarin Work unifica contraste de ventanas, descripción ampliable, menús portalizados, transiciones accesibles y cabecera contraída sin cambios de API ni persistencia.
- ✅ La entrega frontend incluye pruebas unitarias cercanas a sus helpers estables y regresión Playwright enfocada.

## 2026-07-30

### Build 7 — Destinos laterales claros, selección mínima y capas coherentes
- 🐛 Las carpetas activas ya pueden permanecer contraídas: el clic en su fila selecciona y alterna el acordeón, mientras el chevron solo expande o contrae.
- ✨ Arrastrar una o varias tareas hacia la navegación usa la posición real del puntero, resalta con claridad listas y carpetas, autoexpande destinos intencionales y mantiene una sola escritura atómica.
- 💄 La selección del tablero deja visible únicamente el control de completar; seleccionar aparece en hover, foco, modo múltiple, modificadores de teclado o pulsación táctil prolongada.
- 💄 Calendario, creación, detalle y propiedades comparten un contrato de capas portaled; los pickers permanecen por encima de su diálogo y la ventana flotante usa un velo sutil no bloqueante.
- ✅ Nuevas pruebas unitarias cubren acordeones, selección adaptativa, histéresis/autoscroll lateral, capas y densidad responsiva; Playwright verifica los flujos integrados.

### Build 6 — Movimientos profesionales, mazos y creación desde calendario
- ✨ El detalle permite trasladar tareas entre listas con un selector buscable; padre y subtareas cambian juntos y conservan la categoría equivalente del flujo.
- ✨ El tablero incorpora selección por checkbox y rango con Shift, barra de acciones masivas y un mazo animado de hasta tres cartas que representa todo el grupo.
- 🔒 Los movimientos masivos de estado o lista son account-scoped, atómicos, conservan el orden relativo y producen una única escritura y un único evento en tiempo real.
- ✨ Las listas y carpetas del panel izquierdo aceptan tareas como destinos; una carpeta siempre solicita elegir su lista concreta.
- ✨ Calendario permite crear directamente en días o franjas horarias mediante un composer compacto, y “Más opciones” conserva fechas, lista, responsable y borrador.
- 💄 El control de lista del detalle, el estado en vista Lista, la navegación contraída y el botón primario usan el lenguaje visual accesible de Clarin Work.
- ✅ Las pruebas unitarias cubren selección, rango, mazo, deduplicación masiva, destinos y fechas del composer; pasan a ser obligatorias para todo cambio funcional estable.

### Build 5 — Tablero estable, búsquedas confiables y navegación cómoda
- 🐛 Crear una tarea con búsqueda o filtros activos ya no permite que una recarga WebSocket la haga desaparecer: HTTP y tiempo real comparten un identificador y se reconcilian una sola vez.
- ⚡ La búsqueda espera 500 ms, cancela solicitudes anteriores y muestra su estado pendiente sin renderizar respuestas obsoletas.
- ✨ Las carpetas funcionan como acordeones múltiples persistentes y siguen aceptando listas durante un arrastre; la navegación incorpora scroll temático e indicadores de desbordamiento.
- 💄 El tablero admite desplazamiento con Ctrl o botón central, respira en ambos bordes y limita el color de cada columna al contenido real.
- ✅ Vitest, React Testing Library, pruebas backend y escenarios Playwright cubren creación, deduplicación, acordeones, paneo, columnas y la regresión completa del Kanban.

### Build 4 — Papelera segura con retención configurable
- ✨ Papelera separa tareas de listas y carpetas, conserva su ubicación original y permite restaurarlas con reglas estructurales claras.
- 🔒 Mover listas o carpetas a Papelera exige escribir su nombre exacto; la eliminación permanente es manual, irreversible, posterior al plazo y exclusiva de administradores.
- ⚙️ Cada cuenta puede conservar elementos entre 7 y 365 días o elegir “Nunca”; cambiar la política solo recalcula elegibilidad y jamás purga automáticamente.
- 🐛 Completar o reabrir una tarea no inicia retención: únicamente `deleted_at` o `archived_at` creados por “Mover a Papelera” cuentan para el plazo.
- 🗄️ La purga de árboles es atómica y los adjuntos sin referencias pasan por una cola durable con revalidación antes de eliminarse del almacenamiento.

### Build 3 — Jerarquía visual, creación profesional y retirada segura de Navegador
- ✨ Bandeja general queda fija arriba; las listas independientes y carpetas muestran una jerarquía clara, reordenable con mouse, touch o teclado y recuperable ante conflictos.
- 💄 Carpetas y listas se personalizan con nombre, paleta de contraste e iconos de catálogo, visibles también en selectores agrupados y breadcrumbs.
- ✨ Crear una tarea ahora abre una ventana flotante, movible, redimensionable, acoplable y maximizable que recuerda su geometría y protege borradores al cerrar.
- 🔒 Orden, ubicación, herencia de flujo e iconos se validan por cuenta y se persisten con una sola escritura estructural por gesto.
- 🗄️ El Navegador compartido se retira de frontend, API, permisos e infraestructura; su información y volumen se respaldan fuera de Git antes de eliminar el estado productivo.

### Build 2 — Clarin Work aprovecha el espacio y ordena proyectos visualmente
- ✨ Las listas se arrastran entre carpetas, se reordenan y regresan a “Sin carpeta” con previsualización, teclado, confirmación de flujo y rollback exacto.
- 💄 Las vistas principales ocupan una barra estable de dos filas; la búsqueda se expande sin desplazar el lienzo y Tablero, Calendario y Gantt aprovechan toda la superficie.
- ✨ Estado y prioridad usan selectores accesibles con color y significado, mientras los colaboradores se buscan y administran como participantes adicionales.
- 🐛 Retirar el último colaborador representa correctamente la colección vacía devuelta por el servidor.
- 🔒 Ubicación, orden, herencia de flujo y remapeo de estados se resuelven en una única transacción aislada por cuenta.

### Build 1 — Kanban estable incluso durante arrastres prolongados
- 🐛 La tarjeta activa deja de participar como destino de su propia colisión, eliminando el parpadeo y el error React #185 al mantenerla entre columnas.
- ⚡ El tablero transfiere una tarjeta una sola vez al cruzar de columna y confirma su posición final al soltar, conservando la animación fluida sin ciclos de índices.
- ✅ Una prueba de navegador estresa 90 tareas, mouse, teclado, Escape, soltado exterior, columnas vacías/contraídas y rollback ante errores o conflictos.

## 2026-07-29

### Build 3 — Mitigación inicial del arrastre Kanban
- 🐛 Se redujo la frecuencia del ciclo de medición que aparecía al mover fichas repetidamente entre columnas.
- ⚡ La previsualización del orden se agrupó por cuadro de animación como primera protección mientras se investigaba la oscilación de índices.
- 🔧 Los lineamientos de Clarin Work incorporan estabilidad referencial y una prueba de estrés obligatoria para límites entre columnas.

### Build 2 — Clarin Work ordena, filtra y coordina el trabajo
- ✨ El tablero Kanban permite mover tareas entre estados con mouse, pulsación táctil prolongada o teclado, incluso hacia columnas vacías o contraídas.
- 🔄 El orden manual y el cambio de estado se guardan como una sola operación, se reconcilian en tiempo real y se recuperan con seguridad ante conflictos.
- ✨ Los filtros combinables y las vistas privadas guardadas permiten enfocar responsables, colaboradores, fechas, prioridad, tipo y contenido sin perder el ámbito elegido.
- ✨ La creación rápida conserva lista, responsable buscable, fecha y prioridad; la creación completa mantiene el borrador y las tareas aparecen de inmediato en su lista o carpeta.
- 💄 Las tarjetas, columnas, estados vacíos, métricas y superficies responsivas hacen de Clarin Work un espacio más claro, compacto y agradable de usar.
- 🔒 Las listas, flujos, estados, vistas y movimientos validan cuenta, versión y orden durable, también cuando un tablero reúne varios flujos.
- 🔧 Se documentaron los contratos de Clarin Work y su matriz de verificación en una skill local obligatoria para futuras modificaciones.

### Build 1 — Conversaciones y detalle profesional de tareas
- ✨ Cada tarea incorpora actividad, comentarios, menciones, archivos, dependencias y subtareas reales dentro del mismo contexto de trabajo.
- ✨ El responsable se elige mediante búsqueda y los colaboradores permanecen diferenciados del dueño de la tarea.
- 💄 El detalle puede acoplarse, moverse, redimensionarse o maximizarse, y recuerda su geometría sin bloquear innecesariamente el tablero.
- 🐛 Escape cierra la creación y cancela ediciones en curso sin guardar cambios accidentales.

## 2026-07-22

### Build 3 — Google Sync vuelve a la ficha única
- 🐛 La ficha canónica recupera la sincronización individual con Google Contacts en Contactos, Leads, Chats, Eventos y Programas.
- ✨ El estado sincronizado, la actualización y la desvinculación confirmada se muestran de forma coherente en móvil y escritorio.
- 🔄 Los cambios de contacto y los errores de conexión se aíslan para evitar estados cruzados entre fichas.

### Build 2 — Programas académicos, ficha única y encuestas reutilizables
- ✨ Programas administra planes de clase, varios temas por sesión, instructores, participantes y asistencia P/F/T desde móvil y escritorio.
- ✨ Cada participante conserva una participación independiente por programa, con incorporación corregible, padrón activo, historial de retiros y seguimiento individual.
- ✨ Contactos, Leads, Chats, Eventos y Programas comparten una ficha canónica sin duplicar ni contradecir la identidad del contacto.
- ✨ Las encuestas se separan en plantillas reutilizables e instancias con destinatarios, resultados e historial propios por programa.
- 🔄 Los antiguos programas de tipo evento se trasladan de forma idempotente al módulo Eventos, conservando participantes y trazabilidad.
- 🔒 Se refuerzan el aislamiento por cuenta, la inmutabilidad de instancias publicadas, las cargas de archivos y las migraciones sin pérdida de historial.
- 💄 La experiencia móvil incorpora acordeones, búsquedas con espera inteligente, exportaciones coherentes y superficies responsivas de edición y observaciones.

## 2026-07-13

### Build 4 — Inicio y reintento confiables de Eros
- 🐛 Eros mantiene activa la ejecución durante el breve desfase de persistencia que puede ocurrir al iniciar un turno.
- 🔄 Reintentar una consulta fallida crea un turno limpio y no reutiliza identificadores de una ejecución anterior rota.

### Build 3 — Eros recuerda, aclara y decide el análisis
- ✨ Eros conserva selecciones estructuradas para reutilizar “esa lista” sin repetir filtros ni copiar datos sensibles.
- ✨ Las dudas reales se presentan como alternativas interactivas con una opción de texto libre y continuidad durable.
- ⚡ El nivel de análisis ahora es automático; el modelo permanece bajo control exclusivo del administrador.
- 🐛 Cada mensaje usa un contexto MCP aislado y los fallos totales de herramientas ya no se presentan como respuestas exitosas.

### Build 2 — Leads consistentes y Eros durable
- 🐛 Ganadas, perdidas y archivadas vuelven a mostrar los leads reales del pipeline seleccionado.
- ✨ Eros incorpora tareas rápidas de consulta, filtros operativos combinables y exportación segura.
- ✨ La ventana de Eros ahora puede moverse, redimensionarse, maximizarse o acoplarse al lado derecho.
- ✨ La mascota vive en la cabecera, anima las fases reales de trabajo y respeta movimiento reducido.
- ⚡ Las consultas continúan al cerrar Eros, navegar o recargar, con recuperación y cancelación durable.
- 🔒 Las herramientas de Eros quedan vinculadas a una sola cuenta, usuario y ejecución mediante contexto efímero.

### Build 1 — Importación Kommo sin oportunidades duplicadas
- 🔒 Si un contacto ya tiene una oportunidad abierta, el Excel la omite como duplicada y no modifica ningún lead.
- ✨ Ganados, perdidos, archivados y eliminados permanecen como historial y permiten una nueva oportunidad.
- ✨ La vista previa separa oportunidades a crear, contactos nuevos, existentes Kommo, duplicados evitados e inválidos.
- 🔧 Las importaciones de una misma cuenta se serializan y revalidan antes de crear para evitar carreras.

## 2026-07-12

### Build 2 — Importación Kommo segura y Eventos más fluidos
- 🔒 El importador de leads bloquea cualquier cambio en la estructura aprobada del Excel de Kommo.
- ✨ La vista previa distingue oportunidades nuevas, contactos nuevos y casos que requieren revisión manual.
- ✨ Los leads locales sin ID de Kommo se pueden vincular, conservar como oportunidad separada u omitir sin decisiones automáticas riesgosas.
- ✨ Se conserva el nombre del contacto, el título de la oportunidad y el nuevo campo `Atención` del export de Kommo.
- 🐛 Los eventos vuelven a abrirse con un solo clic; moverlos usa ahora un control de arrastre dedicado.
- 🔧 Eventos incorpora participantes desde contactos y mantiene su historial independiente de los leads.

## 2026-07-11

### Build 1 — Mejoras integrales del chat de WhatsApp
- 🐛 Reacciones idempotentes: sin duplicados visuales y con soporte para retirar una reacción.
- ✨ Selector de emojis con búsqueda y nombres en español.
- ✨ Pegado de imágenes y archivos desde el portapapeles con `Ctrl+V` / `Cmd+V`.
- 🐛 El texto escrito pasa a ser el pie del adjunto y se restaura si se cancela o falla el envío.
- 🐛 Adjuntos con nombre original, reintento sin duplicar la subida y reconciliación segura entre API y WebSocket.
- 🐛 Protección frente a doble envío, historial duplicado y eventos fuera de orden, incluidas reacciones en grupos.
- 🔒 Validaciones de cuenta reforzadas en operaciones sensibles del chat y webhook Cloud firmado e idempotente.
- 🔒 Descargas de medios aisladas por cuenta y protegidas frente a URLs internas inseguras.
- 🔧 WhatsMeow actualizado con correcciones de mensajes propios, envío multidispositivo y emparejamiento.

## 2026-03-27

### Build 1 — Eros AI Revamp
- ✨ Eros ahora usa exclusivamente OpenAI (se eliminó soporte Gemini)
- ✨ Selección de modelo AI después de validar API key (GPT-4o, GPT-4.1, etc.)
- ✨ Pantalla de configuración personalizada: rol, persona e instrucciones custom
- ✨ Atajo Ctrl+I / Cmd+I para abrir/cerrar Eros desde cualquier página
- 🔧 Nuevos campos en usuario: eros_model, eros_role, eros_instructions
- 🔧 Nuevo endpoint POST /api/ai/models para listar modelos disponibles
- 🔧 buildSystemPrompt acepta rol e instrucciones personalizadas

## 2026-03-26

### Build 3 — Sistema de Versionamiento
- ✨ Sistema de versionamiento con detección automática de actualizaciones
- ✨ Banner no intrusivo cuando hay nueva versión disponible
- ✨ Modal de changelog accesible desde el sidebar
- ✨ Endpoint `/api/version` con changelog embebido
- 🔧 Header `X-Clarin-Version` en todas las respuestas API

### Build 2 — Archivo y Bloqueo desde Eventos
- ✨ Archivar/bloquear leads desde la página de eventos
- ✨ Modal de razón de archivo con opciones predefinidas
- ✨ Observaciones automáticas al archivar/bloquear
- 💄 Mejora de estilos de selección en listas

### Build 1 — Mejoras de UX
- 🐛 Fix Ctrl+Enter para enviar mensajes
- 💄 Mejora de estilos de selección en listas
- ✨ Sincronización de contactos Google
- ✨ Auto-desync Google al archivar/bloquear
