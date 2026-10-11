# Almacenamiento: QA nativa del 10 de octubre de 2026

La integración de almacenamiento pasó con PostgreSQL 16, Redis y MinIO reales
en un laboratorio desechable. La ejecución utilizó cuentas, usuarios, sesiones
y objetos sintéticos. No se consultó el almacenamiento de producción, no se
fusionó el PR y no se desplegó ninguna versión.

La referencia inicial fue `feat/storage-self-service`, commit
`22b9269a7b952e5da80fe4e72c8c9138a37bc768`. El pase final ejercita el código
incluido junto a este informe: contrato de cuota por autoridad, catálogo sin
filas vacías ni huellas innecesarias, y las pruebas ampliadas de integración.

## Entorno y reproducción

| Componente | Versión o condición observada |
| --- | --- |
| PostgreSQL | 16.15; `server_version_num=160015`. |
| Redis | 7.4.11. |
| MinIO | `RELEASE.2025-09-07T16-13-09Z`, commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`. |
| Toolchain del backend | Go 1.25.11, Linux amd64. |
| Runtime del binario MinIO | Go 1.24.6; distinto del toolchain usado para las pruebas del backend. |
| CPU | Cuota cgroup equivalente a 4 CPU (`400000/100000`); Go informa 5 CPU visibles y se ejecuta con `GOMAXPROCS=3`. |
| Memoria | Límite cgroup de 16 GiB. |
| Red de servicios | PostgreSQL `127.0.0.1:15439`, Redis `127.0.0.1:16379`, MinIO `127.0.0.1:19001`, consola MinIO `127.0.0.1:19002`. |

El runner crea servicios temporales con credenciales sintéticas y elimina sólo
sus propios recursos. No necesita el `.env` de producción ni inicia WhatsApp o
Kommo. GitHub Actions permanece retirado.

En el entorno preparado se reutilizó el binario oficial de MinIO con estas
variables, además de seleccionar Go 1.25.11 en `PATH`:

```bash
export GOMAXPROCS=3
export CLARIN_QA_MINIO_BINARY=/workspace/clarin-cloud/bin/minio
export CLARIN_QA_MINIO_SHA256=7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f
bash scripts/qa/run-storage-self-service.sh
```

La descarga inicial de MinIO mediante Go encontró una redirección bloqueada por
la política de red del entorno. El binario preparado ya estaba contrastado con
el checksum de la distribución oficial; el runner vuelve a verificarlo.
No se sustituyeron las conexiones reales por API simulada o PGlite.

## Resultado nativo registrado

Las tres suites del runner terminaron con `PASS` sobre el catálogo optimizado,
antes de comenzar `TestStorageSelfServicePerformance`:

| Suite | Resultado | Duración de la suite |
| --- | --- | --- |
| `TestStorageSelfServiceIntegration` | PASS | 5,600 s |
| `TestStorageSelfServiceSQLIntegration` | PASS | 2,721 s |
| `TestStorageReferenceGuardIntegration` | PASS | 2,465 s |

Estas duraciones corresponden a pruebas funcionales completas y no son métricas
de latencia de una cuenta de producción.

También pasó el backend completo sobre el código final con
`GOCACHE=/tmp/go-build go test -p 2 ./...`, además de `git diff --check` y
`bash -n scripts/qa/run-storage-self-service.sh`. Las suites nativas opcionales
se acreditan mediante el runner separado, no por el pase unitario que las omite.
No hubo cambios en frontend en esta continuación: sus pruebas unitarias,
TypeScript, build y los 16 casos de navegador con API simulada pertenecen al pase
anterior registrado en el PR; no se repitieron aquí.

| Área | Evidencia ejercitada |
| --- | --- |
| Aislamiento de cuentas y orígenes | Inventario, contenido, selección, Actividad, referencias y confirmaciones mantienen cuenta y actor. Medios técnicos, privados y de origen no demostrado quedan excluidos. Las referencias compartidas bloquean el retiro sin revelar el contexto de módulos no autorizados. |
| Capacidad autorizada | Un miembro recibe sólo los bytes visibles y campos de capacidad en cero. El administrador obtiene el total de su cuenta. Cambiar de cuenta o revocar el rol vuelve a resolver la autoridad actual. |
| Optimización del catálogo | Se conservan referencias con sólo URL o sólo ID de asset, se omiten filas nulas/vacías y se excluyen referencias de otra cuenta. La huella de revisión conserva el vector previo; un ETag distinto invalida la revisión aunque el archivo conserve su tamaño. El listado general no calcula esa huella. |
| Descarga ordinaria | Login real con contraseña, JWT firmado y sesión Redis; descargas mediante cookie y bearer, lectura de bytes MinIO, rangos y solicitudes condicionales. Se comprueban permisos actuales, revocación de pertenencia, usuario inactivo, logout y revocación global de sesiones. |
| Vista previa de cargas | Permiso temporal ligado al objeto, cuenta, usuario y sesión. Se rechazan otras identidades, tokens alterados y objetos retirados o pendientes de purga. |
| Bucket y publicaciones | Un bucket con política pública existente pasa de GET anónimo 200 a 403 después de inicializar Storage, conservando sus bytes y lectura autenticada. La segunda inicialización conserva la política privada. Las capacidades públicas de encuestas y dinámicas se revocan al cambiar el recurso. |
| Revisión del impacto | Selección exacta, deduplicación, caducidad y autoridad de actor/cuenta. Una referencia nueva invalida toda la revisión antes de modificar mensajes u objetos. |
| Papelera y restauración | Se preservan texto y referencias originales. La restauración recupera los mensajes existentes sin recrear uno eliminado posteriormente. La retención impide la purga temprana. |
| Concurrencia nativa | Dos confirmaciones simultáneas comparten operación y resultado; una sola fila de papelera y un solo DELETE S3. Una referencia que confirma primero invalida la purga. Una intención de purga ya confirmada rechaza nuevas referencias mientras otra cuenta puede seguir escribiendo. Los snapshots antiguos de PostgreSQL fallan de forma segura. |
| Purga física e idempotencia | Se verifica ausencia mediante errores S3 de objeto inexistente, no mediante cualquier fallo de Stat. El espacio informado procede de metadata real y borrado confirmado. La reutilización por hash no revive una clave purgada. |
| Fallos parciales | Fallo de DELETE para uno de varios objetos, fallo SQL después de borrar bytes y error en la respuesta después de que MinIO aplique DELETE. Persisten intención y estados recuperables; el reintento no inventa bytes liberados ni duplica operaciones. |
| Recuperación administrativa | La operación durable sobrevive a la eliminación del usuario iniciador. Sólo un administrador de la misma cuenta puede reanudar esa purga confirmada. |
| SQL y migraciones | Consultas de referencias, rollback, permisos vigentes, Actividad y normalización de claves contra PostgreSQL nativo. Migración de barreras repetida, conservación de estados de carga propios de otros módulos y bloqueo de referencias a objetos purgados. |
| Colecciones y reconciliación | Paginación de 205 archivos sin pérdidas ni duplicados; consulta de 205 mensajes para reconciliación, excluyendo IDs ajenos introducidos en los respaldos sintéticos. |

## Fallos del montaje de pruebas corregidos

El primer pase nativo detectó dos supuestos incorrectos en los datos sintéticos,
corregidos antes del pase final:

- El fixture de catálogo dejaba `users.display_name` en NULL, mientras que la
  hidratación del repositorio usada por el login lo lee como string. El fixture
  de sesiones ahora crea usuarios completos con `display_name`; no se relajó la
  autenticación para hacer pasar la prueba.
- El primer miembro era propietario de listas predeterminadas de Work creadas
  automáticamente. Su eliminación chocaba correctamente con
  `task_lists_created_by_fkey`. La prueba de supervivencia de la operación usa
  ahora al otro miembro, que no posee esos recursos. Se conservaron las claves
  foráneas y el comportamiento de Work.

Después de corregir ambos fixtures se repitieron las suites nativas y pasaron
con las comprobaciones descritas arriba.

## Rendimiento: resultados sintéticos completos

`TestStorageSelfServicePerformance` terminó con PASS en 703,421 s, incluyendo
preparación y limpieza. Pasaron los quince escenarios: cinco por cada volumen
de 1.000, 10.000 y 50.000 objetos. El runner completo terminó con código 0 y
retiró sus contenedores desechables. El mayor conjunto contiene 50.000 objetos
de 1 KiB, 50.000 referencias de medios y 500.000 mensajes adicionales de texto.

| Objetos de la cuenta | Primera página p50 / p95 (ms) | Apertura paralela p50 / p95 (ms) | Apertura: asignaciones p50 (MiB) | Apertura: pico RSS Go muestreado (MiB) |
| ---: | ---: | ---: | ---: | ---: |
| 1.000 | 57,8 / 64,4 | 77,1 / 86,6 | 21,2 | 42,0 |
| 10.000 | 476,9 / 504,6 | 619,3 / 777,4 | 219,6 | 96,7 |
| 50.000 | 2.267,7 / 2.389,8 | 2.574,7 / 2.758,7 | 1.112,8 | 253,5 |

Las asignaciones son bytes acumulados durante las dos peticiones de apertura;
no representan memoria retenida. RSS es el valor absoluto del proceso Go en
una petición adicional observada, no el incremento respecto a la memoria base.
MiB equivale a 1.048.576 bytes. Los quince registros completos, memoria base,
heap, GC, entorno y hashes de los archivos medidos están en
[storage-self-service-performance-20261010.json](storage-self-service-performance-20261010.json).

En 50.000 objetos, la última página y la búsqueda de un único resultado tienen
medianas de 2.164,8 y 2.132,8 ms; el resumen Usage, de 2.124,3 ms. El coste sigue
dependiendo del inventario completo aunque la respuesta tenga 40 archivos o uno.
La apertura duplica la enumeración para Uso y Archivos. No se obtuvo un perfil
que permita atribuir porcentajes del tiempo a SQL, MinIO o Go.

Se redujo trabajo evitable al excluir filas sin medios y calcular las huellas
sólo al revisar selecciones, conservando la revalidación por ETag y referencias.
La mejora siguiente de escala debería consultar un inventario con filtros y
paginación en SQL, mantenido mediante escrituras y reconciliación incremental
con S3. Debe mantener el aislamiento por cuenta, permisos actuales y comprobación
viva de referencias/bytes antes de eliminar; un índice desactualizado nunca debe
autorizar un borrado. Compartir el inventario entre Uso y Archivos reduciría
trabajo duplicado, pero seguiría recorriendo toda la cuenta.

Estas cifras no acreditan capacidad máxima, distribución representativa de
producción, un SLA ni un umbral de despliegue.

La metodología implementada en
`backend/internal/api/storage_self_service_performance_test.go` es:

- Objetos MinIO reales de 1 KiB, una referencia de Chat por objeto y diez
  mensajes de texto sin medio por objeto. Cada volumen usa una cuenta sintética
  nueva y un objeto testigo de otra cuenta. Se verifican cantidad y bytes del
  conjunto sembrado; no se deshabilitan claves foráneas ni triggers. Los mensajes
  se insertan en lotes de 1.000 con transacciones separadas; la preparación queda
  fuera de las mediciones. Cada cuenta distribuye los medios y textos entre 100 Chats sintéticos, cada
  uno con su Contact padre; `CLARIN_STORAGE_PERF_CHATS` permite cambiarlo.
- Cinco escenarios: primera página de 40 archivos, última página, búsqueda
  exacta, resumen Usage y apertura con Usage/Files en paralelo. El actor es un
  miembro con permisos de Chats y Configuración; Usage mide el alcance
  `authorized`, sin la consulta de cuota reservada a administradores.
- Dos calentamientos y diez muestras por escenario. Se registran p50, p95 y
  máximo de latencia, bytes asignados y cantidad de asignaciones, además de
  recolecciones/pausas de GC y tamaño de respuesta. Con diez muestras, p95
  coincide con el máximo según el estimador usado y tiene precisión limitada.
- Todos los objetos tienen el mismo tamaño y la ordenación encuentra claves ya
  ordenadas; no representa el coste general con tamaños variados. Cada volumen
  crea una cuenta nueva; las filas SQL de volúmenes anteriores permanecen hasta
  eliminar la base al final del pase.
- Una petición adicional por escenario para muestrear heap y RSS cada 10 ms,
  separada de las muestras de latencia. Se registra memoria base tras GC y
  memoria máxima observada; los picos breves pueden escapar al muestreo.
- Las respuestas deben ser HTTP 200, tener totales y bytes correctos y no
  contener el objeto ni el identificador de la cuenta testigo.

Conservando las variables del binario y checksum anteriores, la ejecución de
rendimiento se solicita explícitamente:

```bash
GOMAXPROCS=3 \
CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE=1 \
CLARIN_STORAGE_PERF_OBJECTS=1000,10000,50000 \
CLARIN_STORAGE_PERF_SAMPLES=10 \
CLARIN_STORAGE_PERF_CHATS=100 \
bash scripts/qa/run-storage-self-service.sh
```

Para comparaciones posteriores hay que identificar la revisión medida y
conservar las mismas condiciones. El servidor todavía enumera el
inventario y las referencias de medios completos: paginar la respuesta no limita por sí
solo ese coste.

## Límites de esta evidencia

- Los handlers se ejecutan mediante Fiber/`httptest`. PostgreSQL, Redis y MinIO
  son reales, pero este pase no es una prueba de navegador conectado de extremo
  a extremo ni mide TLS, proxy de producción, CDN o latencia remota.
- La descarga ordinaria sí usa autenticación y sesiones reales. El resto del
  fixture de almacenamiento y el benchmark inyectan identidad sintética; el
  benchmark no incluye el tiempo de login.
- El caso de respuesta DELETE fallida sustituye la respuesta exitosa de MinIO
  por un error después de aplicar el borrado. Prueba la recuperación de un
  resultado ambiguo; no prueba un corte TCP real, caída del host ni partición de
  red sostenida.
- La retención se comprueba ajustando el instante de purga en el fixture, sin
  esperar siete días de reloj. Las carreras probadas son intercalaciones
  concretas y no sustituyen una prueba prolongada de carga concurrente.
- El presupuesto de tiempo y su propagación tienen comprobaciones unitarias;
  no se ejecutó un ensayo nativo prolongado de PostgreSQL o S3 lentos ni se
  certifica una latencia máxima de recuperación.
- La memoria registrada corresponde al proceso Go de pruebas, incluidos sus
  handlers y clientes. Excluye PostgreSQL, Redis y MinIO y no representa consumo
  total del servidor. No se está midiendo rendimiento de descarga de archivos
  grandes ni distribución real de medios, módulos o cuentas de producción.
- Esta evidencia no sustituye las pruebas unitarias, TypeScript, build ni QA
  visual. Las pruebas de navegador anteriores con API simulada mantienen ese
  alcance; no se convierten en pruebas de navegador con estos servicios reales.
- Antes de desplegar siguen siendo necesarias las condiciones de
  [storage-self-service.md](../storage-self-service.md), incluyendo cachés
  públicas antiguas, permisos reales y dos cuentas de prueba. La producción no
  fue medida ni modificada.
