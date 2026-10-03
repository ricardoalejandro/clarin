# Validación de Clarin en el entorno

GitHub Actions se encarga del despliegue por SSH del commit seleccionado y de verificar los servicios desplegados. Las pruebas y el build de verificación se ejecutan en el entorno de desarrollo antes de enviar cambios. El build Docker que necesita producción sigue formando parte del despliegue.

El workflow de despliegue ya no espera jobs de QA ni comprueba un historial de validaciones. Quien prepara el cambio debe validar el mismo commit que va a enviar. Si cambia el código después de validar, debe repetir las comprobaciones afectadas. Estos comandos no emiten certificados ni crean una configuración cloud persistente.

## Preparación del entorno

Se requiere Node.js 24 o posterior y el Go indicado por `backend/go.mod` (actualmente Go 1.25.11). En el entorno gestionado, el script prefiere `.tools/go/bin/go` del directorio padre del repositorio, cuando existe, antes del `go` del PATH. Comprueba la versión real y usa `GOTOOLCHAIN=local` para evitar descargas implícitas de toolchains.

Instalar las dependencias una vez al preparar el entorno y repetir `npm ci` cuando cambien los lockfiles:

```bash
npm ci
npm --prefix frontend ci
make qa-check
```

`make qa-check` equivale a `bash scripts/qa/validate.sh check`. Solo inspecciona versiones, ejecutables de las dependencias y disponibilidad opcional de browsers Playwright. No instala paquetes, crea cachés, levanta servicios ni ejecuta pruebas. La ausencia de browsers no impide el baseline.

El runner de browser reutiliza `/usr/bin/chromium` si está disponible. También admite `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` para un ejecutable Chromium ya instalado. Firefox y WebKit requieren sus propios browsers Playwright; instalarlos solamente si se va a verificar esos proyectos:

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/../work/clarin-qa/browsers"
npx playwright install firefox webkit
```

Para un entorno que tampoco tiene Chromium del sistema, instalar `npx playwright install chromium` después de exportar la misma ruta. El runner y `qa-check` usan por defecto ese directorio bajo `work/`, para evitar instalar browsers en el home; respetan una ruta `PLAYWRIGHT_BROWSERS_PATH` establecida explícitamente. En Linux pueden hacer falta las dependencias del sistema de cada browser. La instalación es una preparación explícita y no se ejecuta desde el runner QA.

## Baseline antes de push

```bash
make qa
```

Equivale a `bash scripts/qa/validate.sh baseline` y conserva las comprobaciones que antes ocupaban los jobs de CI, en este orden:

1. `go test ./...` en `backend` y `offline-signer`.
2. Pruebas de `codex-bridge`, salvaguardas de despliegue y del runner QA.
3. Preparación del editor Excalidraw local.
4. Tests unitarios del frontend, `typecheck` y build de producción con sus verificaciones existentes. Los tests unitarios usan `NEXT_PUBLIC_API_URL` vacío, igual que CI, para conservar las rutas locales esperadas por sus fixtures.
5. `git diff --check`.

El baseline se detiene ante el primer error. No instala dependencias, inicia servicios ni despliega. Retira los opt-ins heredados `CLARIN_RUN_*`, `CLARIN_LIVE_REPORT_TEST`, `CLARIN_TEST_OFFICIAL_EXCALIDRAW_LIBRARY` y las URLs de bases de datos de test `OFFLINE_V{3,4,5}_TEST_DATABASE_URL`, para que un entorno persistente no active pruebas live o de integración adicionales que CI no ejecutaba. Esas integraciones se ejecutan deliberadamente por separado. Las cachés de Go quedan en `work/clarin-qa/` del directorio padre del repositorio (`/workspace/work/clarin-qa/` en este entorno), fuera del home y del código versionado. El build sí genera los archivos de trabajo y assets que genera normalmente el frontend.

Antes de enviar el commit, completar también la cobertura de navegador del módulo afectado. `make qa` no ejecuta toda la matriz Playwright: la selección depende del cambio, y el baseline por sí solo no demuestra cobertura de todas las interfaces.

## Browser focal por módulo

El runner exige uno o más archivos existentes directamente bajo `tests/` y uno o más proyectos concretos. No admite un comando vacío ni comodines de proyecto. Usar `--list` primero para revisar el volumen seleccionado sin levantar el servidor:

```bash
bash scripts/qa/validate.sh browser tests/chat-attention.spec.ts --project=chromium --list
bash scripts/qa/validate.sh browser tests/chat-attention.spec.ts --project=chromium
bash scripts/qa/validate.sh browser tests/task-board-drag.spec.ts --project=chromium --grep='drag'
bash scripts/qa/validate.sh browser tests/whiteboards-isolation.spec.ts tests/work-whiteboards.spec.ts --project=chromium
```

Fija el servidor local en `http://127.0.0.1:3011`, las dos variables de URL que usan los specs, `CLARIN_E2E_MOCK_AUTH=1` y `CI=1`. También fija `NEXT_PUBLIC_API_URL` vacío: las llamadas API mantienen el mismo origen para los mocks, y el rewrite de Next usa su fallback local `http://localhost:8080` en vez de heredar una API remota del entorno. Desactiva las opciones live heredadas y retira las credenciales E2E heredadas. Usa cero reintentos, dos workers, un fallo máximo y el reporter `list`; no acepta argumentos que cambien esos límites o la configuración. También acepta `--grep-invert=patrón`.

Playwright levanta el servidor de desarrollo mediante la configuración existente y lo cierra al terminar. El puerto 3011 debe estar libre, ya que `CI=1` evita reutilizar silenciosamente otro servidor. Los mocks de estos specs prueban interacción y renderizado; no sustituyen las pruebas del backend ni una integración real cuando el cambio la necesita.

## Matrices y laboratorios separados

La matriz responsive permanece disponible y debe seleccionarse deliberadamente, con un proyecto y un filtro por vez para controlar su duración:

```bash
bash scripts/qa/validate.sh browser tests/responsive-dashboard.spec.ts --project=responsive-desktop --grep='Chats' --list
bash scripts/qa/validate.sh browser tests/responsive-dashboard.spec.ts --project=responsive-desktop --grep='Chats'
bash scripts/qa/validate.sh browser tests/responsive-dashboard.spec.ts --project=responsive-mobile-chrome --grep='Chats'
```

Repetir con `responsive-firefox`, `responsive-webkit` o `responsive-mobile-safari` cuando corresponda y sus browsers estén instalados. Revisar los títulos mediante `--list` antes de elegir un filtro: un filtro sin coincidencias debe corregirse, no tratarse como validación satisfactoria. Los proyectos normales `chromium`, `firefox` y `webkit` excluyen ese archivo en la configuración actual.

Los specs `offline-*`, `*live*`, `reaction-*`, `example.spec.ts` y `pwa-runtime-recovery.spec.ts` quedan fuera de este runner. PWA recovery necesita preparar por separado su dependencia Turnstile. Los tests de shell offline usan su corpus generado y sus configuraciones dedicadas; el laboratorio offline real requiere su propia identidad, fixtures y servicios aislados. Seguir [la guía del laboratorio offline](offline-v3-qa-laboratory.md) y las configuraciones `playwright.offline*.config.ts` que correspondan al escenario. Nunca incluir estos escenarios en un `npx playwright test` global como parte del push o despliegue.

Los smoke tests live de pizarras/offline y las pruebas de reacción con credenciales siguen siendo flujos separados que requieren su preparación y autorización específicas. El runner habitual no activa integración live ni accede a producción. La salud de producción se comprueba en el flujo de despliegue y debe informarse solo después de ejecutar sus verificaciones reales.
