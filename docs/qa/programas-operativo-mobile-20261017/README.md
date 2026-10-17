# Programas móvil: consultas, asistencia y observaciones

Base: `main` / `ff57c72d12b8cf4183d36cdec4048d687de6b83e` (PR19).
Rama: `codex/programas-movil-operativo`. Desarrollo y QA en worktrees separados; PR18 no forma parte del cambio.

## Contrato verificado

- Ancho disponible menor de 700 px o superficie táctil de poca altura: consultas, asistencia y observaciones contextuales. El teclado de una tablet no activa por sí solo este modo.
- La administración de grupos, carpetas, participantes, sesiones y Contact permanece en escritorio; Cursos admite consulta completa desde su URL móvil.
- La identidad del Contact es de solo lectura; observaciones del programa y de la sesión permiten añadir, sin editar, eliminar ni fijar.
- Los formularios administrativos y chats abiertos quedan pausados, sin portales ni foco, conservando el borrador para volver a escritorio. Los callbacks verifican la capacidad vigente antes de iniciar escrituras.
- Los guardados ya enviados conservan su reconciliación; las confirmaciones administrativas están separadas de los descartes de asistencia.

## Entorno y alcance

Pruebas de componentes en Vitest y navegador Playwright contra una compilación de producción aislada en `127.0.0.1:3022`. Sesión, API y WebSocket sintéticos; service worker bloqueado para no registrar el de producción. Las capturas contienen datos ficticios.

La validación de navegador comprueba el contrato responsive y sus payloads; no acredita una sesión real del proveedor ni una PWA instalada. Este PR no modifica API, permisos, base de datos o comportamiento offline, y no se despliega en producción durante su preparación.

## Evidencia visual

- [Sesiones, 560 × 655](programas-560x655-sesiones-consulta.png): Asistencia como acción principal; programación y edición ocultas.
- [Participantes, 522 × 655](programas-522x655-participantes.png): consulta, búsqueda y observaciones contextuales.
- [Escritorio, 1440 × 900](programas-1440x900-escritorio.png): administración conservada.

## Verificación automatizada

Con Node.js 24, desde `frontend`:

```sh
npm run test:unit -- --maxWorkers=3
npx vitest run src/components/programs src/components/contact-details/ContactDetailSurface.test.tsx src/components/ContactAvatarControl.test.tsx src/components/chat src/components/crm-detail --maxWorkers=2
npx tsc --noEmit --incremental false
npm run build
```

La regresión focalizada aprobó 68 archivos y 443 pruebas. Comprueba lectura móvil y registros heredados; guardados contextuales, fallo/reintento y conflicto; bloqueo de callbacks antiguos; retención de borradores, errores y confirmaciones; y reconciliación única de solicitudes ya enviadas. Incluye regresiones compartidas de Contact, Chats, Leads y Eventos.

Las fuentes locales y ambos worktrees QA coinciden mediante un manifiesto SHA-256 de los 35 archivos de código y pruebas del cambio. `git -c core.whitespace=cr-at-eol diff --check` reconoce el CRLF preexistente del test de ChatPanel sin reformatearlo.

Navegador Chromium: 22 escenarios aprobados, con viewports de 320, 375, 522 y 560 px y retorno a 1440 px. Incluye listado, sesiones vacías/con datos, asistencia, historial, observaciones contextuales, acceso directo a Cursos y recuperación de borradores de alta, sesión, plan y encuesta. La regresión de mensajería recorre los cinco módulos y Google Sync conserva sus guardados, fallos/reintentos y respuesta 403.

La prueba de navegación de Chats espera ahora el estado real de `history.back()` antes de resolver la respuesta retenida, en lugar de asumir que 20 ms bastan. Las pruebas de confirmación usan el diálogo de la aplicación, que permite pausar la administración al reducir la ventana.

Safari móvil: 2 escenarios aprobados (asistencia con observaciones y participantes/retorno a escritorio). El flujo extendido de asistencia dispone de 90 s de presupuesto de prueba para WebKit; conserva las mismas comprobaciones de UI y payload.

Resultado final de la suite completa: 385 archivos / 2.324 pruebas de la aplicación aprobados, 61 pruebas del fork del editor y 47 verificaciones de scripts aprobadas. Sin fallos ni pruebas omitidas. TypeScript, compilación de producción y revisión de espacios aprobados.
