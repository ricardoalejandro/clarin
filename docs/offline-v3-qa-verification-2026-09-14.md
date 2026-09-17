# Verificación del laboratorio offline v3 — 2026-09-14

Estado a las 23:16 UTC: **laboratorio aislado operativo; Windows sigue sin
ejecutar**. No se modificaron flags, contenedores, DNS, Cloudflare, datos ni
credenciales de producción desde este trabajo de QA.

Se ejecutó realmente:

- `node --test scripts/offline/qa-environment.test.mjs`: 8 pruebas aprobadas.
  Cubren imágenes inmutables, redes/mounts/binding, raíz privada y symlinks,
  host/routing, egress restringido, destino fijo de fixtures, aislamiento de las
  cuentas ficticias, contraseñas con política real y disponibilidad v3 estricta.
- `init` y `up --turnstile-test`: PostgreSQL, Redis, MinIO, signer, backend,
  frontend, proxy de validación y gateway TLS reales. El único puerto publicado
  es `127.0.0.1:19443`; los demás no tienen binding al host.
- `smoke`: 7 rutas reales por HTTPS con CA validada y hostname exacto. Incluye
  `enabled=true`, `signer_ready=true`, `task_writes_enabled=true`, protocolo 3 y
  mínimo 3.0.0, además de Turnstile requerido en backend de modo producción.
- `qa-seed`: login real con claves oficiales de test Turnstile y llamadas al
  API con cookies sólo en memoria; 2 cuentas sintéticas y 10 usuarios no
  superadmin. Por cuenta, 2 listas, 2 tareas, 3 Contactos sin teléfono, un
  Programa de clases y una Pizarra. El segundo usuario recibe `403` sin cookie
  nueva cuando intenta cambiar a la cuenta B.
- Repetición del seed: no duplica las escrituras confirmadas.
- `refresh → up → smoke → kit`: preserva fixtures y credenciales, archiva la
  captura anterior, detiene/reinicia sólo QA y exporta kit sin secretos.
- PostgreSQL QA comprobado: 2 cuentas sintéticas, 10 usuarios sintéticos,
  **0 solicitudes y 0 grants offline**. La cuenta inicial del superadmin de
  laboratorio es adicional y no corresponde a una cuenta de producción.
- `git diff --check` focalizado: sin errores.

Errores del scaffold detectados y corregidos durante su ejecución:

1. Docker no materializaba el binding con gateway conectado únicamente a red
   `internal`: gateway recibió una red loopback propia; datos/app siguen aislados.
2. Las contraseñas aleatorias hexadecimales no satisfacían la política de
   mayúscula/minúscula/número/símbolo: los fixtures ahora cumplen sin reducir
   entropía ni modificar la política del producto.
3. El cliente signer restringe el hostname para proteger SSRF: el laboratorio
   usa su alias canónico `clarin-offline-signer` **sólo dentro de su red**. No se
   relajó el cliente backend. El smoke exige signer listo, no sólo HTTP 200.
4. El kit inicial omitía la plantilla que lee el diagnóstico PowerShell: el
   export final incluye una plantilla nueva vinculada al SHA exacto, con todos
   los flujos en `not_run`.

Candidato capturado:

`aeaf679ec7c5137185d11e6620d61084ef3674a7827f795b3375ebe611f9a5d2`

Evidencia local (privada, no contiene credenciales dentro de los reportes):

- `.runtime/offline/v3-qa/smoke-1789427739389.json`.
- `.runtime/offline/v3-qa/fixtures.json`.
- `.runtime/offline/v3-qa/lab.json`: imágenes exactas y revisión de captura.
- `.runtime/offline/v3-qa/windows-kit-aeaf679ec7c5-1789427739739`.

Después del despliegue final de dependencias, ejecutar `refresh`, `up
--turnstile-test`, `smoke` y `kit` para capturar las imágenes finales. `refresh`
**no vuelve a generar fixtures, credenciales, CA o signer**; requiere cero
enrollments/grants para no cambiar una validación Windows en curso. Todas las
evidencias anteriores quedan vinculadas a su captura, no a una imagen futura.

No se encontró un ejecutor Windows disponible entre las herramientas
conectadas. Quedan sin probar DPAPI, UAC, ACL, permisos Chrome/Edge, cierre y
reinicio reales, y la matriz de flujos nativos. La VM, su trust/hosts y túnel
se coordinan según `docs/offline-v3-qa-laboratory.md`. El laboratorio elimina el
bloqueo del backend QA, pero **no fabrica ni sustituye evidencia Windows**.

## Recaptura después del despliegue de dependencias — 2026-09-15 00:14 UTC

Después de la confirmación de `make deploy` exit 0 del agente principal se
ejecutó, con Node `24.21.0`, el ciclo completo de actualización del laboratorio.
No se tocó producción desde estos comandos.

- Revisión de captura **4**, creada `2026-09-15T00:12:04.451Z`.
- `/api/version` QA devuelve `2026.09.14-1-235507698122867-d420a6bea1a5`.
- Frontend real: Next `16.3.5`, React `19.3.0`, Node `v24.21.0`.
- Imagen frontend `sha256:8e14b1a4e70a6fac1ce50b770977a1d1e3029337b36db644596418ecc90874b2`.
- Imagen backend `sha256:21fbdd6fed0d54fcf78989744019d9651e7bbeaebfba221c8086f7dc04dc27c0`.
- El candidato Windows conserva el SHA exacto indicado arriba. No se recompiló,
  publicó ni reemplazó con otro artefacto.

Pruebas repetidas realmente:

1. Suite `qa-environment.test.mjs`: **9/9 aprobadas**, incluida regresión de
   identidad y respuesta denegada que intentase emitir una cookie.
2. `refresh → up --turnstile-test → smoke → kit`: aprobado. Siete rutas HTTPS,
   v3/signer/task-writes listos exclusivamente en el laboratorio.
3. `qa-seed`: confirmó que los fixtures ya estaban completos, sin duplicarlos.
4. Nuevo `qa-verify-fixtures.mjs`: **4 comprobaciones aprobadas**; autentica
   realmente los dos usuarios con el proveedor Turnstile usando sus claves
   oficiales de prueba; verifica `/api/me`; permite a user_01 cambiar A→B
   conservando el actor; rechaza a user_02 con `403`, sin cookie nueva ni cambio
   posterior de identidad/cuenta. Cierra las sesiones al terminar y no guarda
   cookies, JWT o contraseñas en el reporte.
5. Docker QA saludable; único binding `127.0.0.1:19443`. PostgreSQL sigue con
   **2 cuentas sintéticas, 10 usuarios sintéticos, 0 solicitudes y 0 grants**.

Evidencia nueva:

- `.runtime/offline/v3-qa/smoke-1789431151507.json`.
- `.runtime/offline/v3-qa/auth-verification-1789431209833.json`.
- `.runtime/offline/v3-qa/windows-kit-aeaf679ec7c5-1789431151752`.

Fixtures, credenciales, CA y claves signer de laboratorio se conservaron. El
kit y las verificaciones anteriores pertenecen a sus capturas anteriores, no
prueban esta actualización. **Windows real permanece `not_run`; no se activó
ni se sorteó ningún gate.**
