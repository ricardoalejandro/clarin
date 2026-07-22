# Changelog — Clarin CRM

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
