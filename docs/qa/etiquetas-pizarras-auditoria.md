# Auditoría de etiquetas y pizarras

Fecha: 2026-10-12. Base revisada: `4cdf929e98817a08bdd6e140f38828f0edbfd1a9`, con la configuración actual de Eventos. Implementación aislada en `codex/etiquetas-pizarras`. No implica despliegue.

## Causa del fallo con el cursor

`ContactTagEditor` abría el menú en el portal contextual de las ventanas operativas. El host usa `pointer-events: none` para dejar interactivo el tablero; el menú no restauraba `pointer-events: auto`. El teclado seleccionaba porque seguía enfocado el combobox, mientras el hit test del puntero atravesaba sus opciones. Afectaba al editor completo y a la asignación directa cuando se alojaban en ese portal. Un chat independiente cuyo portal terminaba en `body` no tenía la misma herencia; el chat abierto dentro de una ventana sí podía heredarla.

El menú compartido `TagPicker` restaura explícitamente los eventos de puntero. Mantiene un solo contrato de portal, registro de overlays, cierre exterior, Escape, flechas, Enter, retorno del foco, posición visible y resultados acotados. La búsqueda cambia exactamente 500 ms después del último cambio de texto, aborta la anterior y comprueba generación y sesión de autenticación. Las etiquetas seleccionadas se muestran sin cargar el catálogo completo.

## Inventario de superficies de asociación

| Superficie activa | Implementación anterior | Implementación actual y alcance |
| --- | --- | --- |
| Contactos: detalle, gestión directa y editor completo | `ContactDetailSurface` → `ContactTagEditor`, menú afectado dentro de ventana | Mismos controles y API de Contact; `ContactTagEditor` es adaptador de `TagPicker`. Asignación directa conserva pending, reconciliación y rollback existentes; editor conserva borrador y guardado explícito. |
| Leads: detalle, gestión directa y editor completo | Identidad canónica del Contact dentro de ventana CRM | Mismo adaptador y arreglo de portal. Las etiquetas siguen perteneciendo al Contact; no se crean etiquetas comerciales independientes. |
| Eventos: participante, gestión directa y editor completo | Identidad canónica dentro de ventana operativa | Mismo arreglo compartido. Contexto `event_participant`; se conservan reglas y permisos de la ficha actual. Las etiquetas de Contact no se subordinan al cierre del Evento. |
| Programas: participante y editor completo | Identidad canónica dentro de `OperationalOverlayBoundary` | Mismo arreglo compartido. Contexto `program_participant`; no mezcla datos de varias participaciones. |
| Chats: ficha de Contact y editor completo | `ContactPanel` → `ContactDetailSurface` | Mismo selector para chat independiente y chat anidado. Sin segunda fuente de etiquetas en el Lead comercial del chat. |
| Contactos: crear Contact | Selector propio con búsqueda acotada en endpoint genérico y nuevas etiquetas temporales por nombre | `CatalogTagPicker`, selección múltiple local; consulta `contact_create`; envía `tag_ids` canónicos al crear. Selección, borrado y texto responden de inmediato. |
| Leads: crear oportunidad | Texto separado por comas | `CatalogTagPicker`, selección múltiple local; consulta `lead_create`; envía `tag_ids`, incluidos `[]`. Backend aplica unión aditiva con las etiquetas previas del Contact. |
| Importación Excel desde Contactos o Leads, modos Leads/Ambos | Selector propio, catálogo completo y creación duplicada | `CatalogTagPicker`, selección única; consulta `lead_import`; mantiene `import_tag` por nombre según contrato del importador. Cambiar/quitar etiqueta invalida la vista previa. “Sin etiqueta” limpia selección. No altera formato estricto Kommo ni reanima sincronización. |
| Importación Excel en modo Contactos | Sin etiqueta global opcional del importador de Leads | Se mantiene ese alcance. Las columnas de cada fila siguen el contrato propio del importador. |
| Automatizaciones: asignar/quitar etiqueta | Campo de UUID manual | Selector visual único, consulta `automation`, hidratación acotada por ID para flujos guardados. Conserva `data.tag_id` y compatibilidad con `data.config.tag_id`; un valor vacío explícito prevalece sobre el antiguo. Un borrador inactivo puede estar incompleto; activar exige ID válido. |
| Difusiones: detalle de destinatario con Lead vinculado | Bloque activo de `LeadDetailPanel` → `TagInput`, catálogo completo y endpoints legado | `CanonicalContactTags` → editor compartido y API canónica de Contact con contexto del Lead. Capabilities efectivas, pending, bloqueo de doble escritura, rollback exacto, error y reintento; ignora respuestas de otra identidad. El resto del panel permanece intacto. |
| Difusiones: destinatario sin Lead vinculado | Ficha básica, sin asignador de etiquetas | Continúa sin introducir un editor sin identidad Contact comprobada. |
| Registro histórico legado sin Contact vinculado | Potencial escritura por ID de Lead | Etiquetas históricas legibles, con explicación de solo lectura; no inventa un Contact ni un destino de escritura. |

Todas las altas de etiquetas globales se ofrecen únicamente si el servidor devuelve `can_create` o la ficha canónica expone `can_create_tags`, y la creación sigue siendo validada por `PermTags` en backend. Seleccionar una etiqueta existente no exige permiso de administración de catálogo; exige el permiso del módulo/contexto que efectúa la acción. Los endpoints de búsqueda y escritura preservan `account_id`.

## Controles revisados que no asignan etiquetas

| Control | Resultado de la revisión |
| --- | --- |
| Filtros por etiquetas de Contactos y Leads | Son filtros de consulta con botones/checkboxes, no escrituras de Contact. Conservan sus fórmulas, inclusión/exclusión y semántica actual; no se migran al adaptador de asociación. Sus catálogos completos son deuda de escalabilidad separada. |
| Filtro de etiquetas de Difusiones / selección masiva de destinatarios | Filtra audiencia; no asigna etiquetas a cada Contact. Se mantiene su comportamiento. Su consulta general de catálogo es deuda separada. |
| `EventContactPicker` | Filtro inline de búsqueda acotada a 20, checks accesibles y selección masiva de audiencia. No se convierte en editor de etiquetas de Contact. |
| `EventRulesEditor` | La versión actual usa opciones inline acotadas y reglas booleanas de pertenencia. Se preserva la semántica incorporada en la actualización de Eventos; no se restaura el antiguo dropdown. |
| Configuración/administración del catálogo de etiquetas | Crea o modifica el catálogo; no es asociación de una etiqueta a una persona. Se conserva la autorización propia. |
| Work/Tareas | Las etiquetas de tareas son un modelo distinto; no se reutiliza metadata de Contact. No se encontró un consumidor activo de `TagInput` ni `TagSelector` dentro de Work. |
| `components/TagInput.tsx` | Permanece como componente legado sin usos productivos JSX tras migrar el bloque activo de Difusiones; se conserva su prueba previa. No se lo amplía ni duplica. |
| `components/chat/TagSelector.tsx` | Componente de filtrado sin consumidores productivos actuales; no se lo trata como asignador activo. |

No se encontró una acción masiva productiva adicional que escriba etiquetas de Contact desde las selecciones de tabla; no se añade una capacidad nueva de edición masiva.

## Contratos y estados comprobables

- Fichas existentes: búsqueda `/api/contact-profiles/:id/tags` con contexto real, límite 20; cambios por PATCH canónico de Contact. Los permisos se obtienen de capabilities y se validan de nuevo en backend.
- Formularios nuevos: `/api/tags/search?context_type=contact_create|lead_create|lead_import|automation&q=...&limit=20`; backend admite hasta 25. La hidratación de guardados usa `ids` acotados a 25, nunca catálogo completo.
- Selección única reemplaza; múltiple añade sin duplicar IDs. Retirar es explícito. Crear se bloquea durante la solicitud; guardar/analizar el formulario espera su resultado para no omitir la nueva etiqueta, conserva consulta tras fallo y permite reintentar; búsquedas y creación se cancelan al cerrar/cambiar sesión.
- La hidratación de una automatización muestra carga y distingue etiquetas eliminadas/no disponibles; una respuesta de otro nodo o cuenta no puede completar el nodo actual.
- La identidad canónica en Difusiones carga capabilities antes de editar, muestra estado pendiente, conserva hooks previos de confirmación, restaura exactamente la selección previa ante rechazo y acepta la colección canónica al éxito.
- Escape cierra primero el picker de importación y después el modal. Un rerender del propietario con un nuevo callback no borra la elección local.

## Evidencia y límites de verificación

Las pruebas unitarias cercanas cubren el contrato de puntero dentro de un host transparente, foco y cierre, modo único/múltiple, debounce exacto, carrera A-B-A, cambio de sesión, permisos, doble creación, hidratación, adapters de payload, selección de importación y rollback/reintento canónico. JSDOM verifica contrato y eventos, pero no realiza hit testing real CSS; por eso la matriz de navegador usa un navegador real y `elementFromPoint`, además de clic de Playwright.

Resultados de ejecución de etiquetas: focales de ocho archivos, 38 pruebas pasadas con Node 24 y dependencias reconstruidas (`vitest run src/components/tags src/components/contact-details/ContactTagEditor.test.tsx src/components/contact-details/quickTagMutation.test.ts src/components/contact-details/CreateContactModal.test.tsx --maxWorkers=1`). La primera ejecución encontró un timeout de 5 s en el flujo largo de importación bajo compilación simultánea; la repetición con presupuesto de integración de 10 s pasó. La suite completa, las dos regresiones finales del editor y el typecheck/build se registrarán al terminar la integración. No se declaran pasadas las ejecuciones interrumpidas durante la reinstalación. Las pruebas de navegador con respuestas controladas verifican interacción, portal y payload; no sustituyen una sesión autenticada real ni una comprobación de producción. El informe final debe indicar qué escenarios se ejecutaron efectivamente.

Pizarras: el aviso reportado fue “Demasiados eventos de colaboración”. La corrección de scheduler/transporte y sus pruebas se revisan junto a esta matriz, conservando pruebas de idempotencia, colaboración e aislamiento existentes. Los resultados finales de backend, navegador y build deben constar antes de solicitar revisión del PR.
