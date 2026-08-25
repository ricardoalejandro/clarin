# Pizarras: análisis técnico de formato y alineación parcial

## Estado de la entrega

- Motor: `@excalidraw/excalidraw@0.18.1-clarin.3`.
- Base upstream: tag `v0.18.1`, commit
  `a2ec2889babf7d2295469c6d90ebe77fae57df84`.
- Alcance: negrita, cursiva, subrayado y tachado por caracteres; alineación
  izquierda, centro y derecha por párrafos; precarga local de 32 fuentes.
- El HTML del editor nunca se persiste. `text` y `originalText` siguen siendo
  texto plano compatible con Excalidraw.

## Causas raíz del fallo al retirar cursiva o negrita

La regresión específica de cursiva en `0.18.1-clarin.2` estaba en la última
transición del modelo: al retirar la única marca, `updateClarinTextCustomData()`
devuelve `undefined` porque ya no queda ningún campo en `customData`.
`newElementWith()` omite deliberadamente todo update cuyo valor sea
`undefined`; por tanto concluía que el elemento no había cambiado, no aumentaba
su versión y conservaba el run con `marks: 2`. Al activar negrita, `customData`
seguía siendo un objeto definido; retirar cursiva sí producía entonces un objeto
diferente. Esa es la razón exacta por la que tocar negrita parecía "desbloquear"
la cursiva.

Además había estados de interacción que podían amplificar o enmascarar el
problema:

1. Al pulsar la barra de propiedades, el navegador movía el foco fuera del
   `contenteditable` y colapsaba o cambiaba la selección antes del `click`.
   El comando terminaba operando sobre una selección anterior, sobre el cursor o
   sobre el elemento completo.
2. La acción general de Excalidraw podía devolver una colección de `elements`
   capturada antes del cambio hecho por el controlador enriquecido. Al aplicar
   ese resultado, restauraba silenciosamente la escena anterior y parecía que la
   negrita no se podía retirar.
3. El cálculo de estado mixto contaba saltos de línea y espacios invisibles sin
   marcas. Una selección visualmente toda en negrita se clasificaba como mixta;
   por contrato, el toggle de un estado mixto aplica la marca en vez de retirarla.
4. La reconciliación de texto usaba prefijo y sufijo comunes para deducir el
   rango editado. En textos repetidos, borrados, composición IME o reemplazos
   adyacentes, varios rangos son compatibles con el mismo resultado y los runs
   podían desplazarse al fragmento equivocado.

La corrección fuerza explícitamente la mutación cuando `customData` pasa de un
objeto definido a `undefined`, tanto dentro del editor como sobre un elemento
seleccionado fuera de edición. Así se elimina el último campo, aumenta la versión
y la operación entra en historial, guardado y colaboración. También preserva
una instantánea inmutable de la selección en `pointerdown`, identifica el
controlador por `elementId`, evita que la acción general reinyecte elementos
obsoletos, calcula marcas sobre caracteres visibles y usa el rango exacto de
`beforeinput` para cada inserción o borrado. El cursor mantiene marcas futuras
explícitas y no hereda por accidente el estado de otra selección.

## Por qué la alineación es por párrafo

La alineación no es una marca de caracteres: determina el origen horizontal de
una línea dentro del ancho del elemento. Aplicarla a media palabra produciría
una geometría indefinida. Por ello, cualquier selección toca uno o más párrafos
y la orden se aplica a esos párrafos completos. Con el cursor sin selección se
afecta el párrafo actual y, fuera de edición, se mantiene el comportamiento
histórico de alinear el elemento completo.

El formato se guarda en `customData.clarinParagraphFormat`:

```ts
{
  version: 1,
  textLength: number,
  textHash: number,
  paragraphs: Array<{
    start: number, // offset UTF-16 del inicio real del párrafo
    align: "left" | "center" | "right"
  }>
}
```

Sólo se persisten excepciones respecto de `element.textAlign`. Los inicios deben
coincidir con `0` o con el carácter inmediatamente posterior a `\n`; quedan
ordenados, sin duplicados y dentro de los límites UTF-16 del texto. Inserciones,
borrados, Enter, pegado, cortar, IME, deshacer y rehacer transforman las marcas y
los párrafos en una única mutación del elemento.

## Invariantes de interacción

- Selección de caracteres: las cuatro marcas cambian sólo en el rango; la
  alineación cambia todos los párrafos tocados.
- Cursor: las marcas configuran el texto que se escribirá; la alineación cambia
  el párrafo actual.
- Elemento seleccionado fuera de edición: ambos tipos de formato se aplican a
  todo el texto.
- Estado mixto de una marca: si todo el contenido visible posee la marca, se
  retira; en otro caso se aplica a toda la selección.
- Estado mixto de alineación: el control expone `aria-pressed="mixed"`; elegir
  una alineación unifica únicamente los párrafos tocados.
- Una orden crea una sola entrada de historial y una sola versión canónica del
  elemento. Deshacer restaura conjuntamente texto, runs, párrafos y alineación.
- Los offsets nunca dividen un grafema; emojis, combinaciones Unicode, RTL y
  saltos de línea vacíos conservan límites válidos.

## Persistencia y defensa en profundidad

Frontend y backend validan de forma equivalente:

- campos exactos, versión `1`, hash y longitud coincidentes;
- marcas entre `1` y `15`, rangos canónicos y límites de grafemas;
- alineaciones permitidas e inicios reales de párrafo;
- máximo 4.096 runs/entradas por elemento y 50.000 por escena entre ambos
  formatos.

Un payload nuevo inválido se rechaza. En una escena histórica corrupta se elimina
únicamente la extensión Clarin defectuosa y se conserva el texto plano y el resto
de `customData`. Si un editor externo cambia el texto, la discrepancia de hash
descarta los rangos para impedir que se apliquen a otros caracteres.

## Render y compatibilidad

Canvas, miniaturas, PNG y SVG resuelven cada línea visual contra el párrafo
original, incluso cuando el wrapping genera varias líneas. Las marcas siguen
dibujándose por run. El texto ligado a figuras y el autoajuste reciben las mismas
medidas. Excalidraw oficial ve un único texto plano y conserva la metadata opaca;
Clarin recupera el formato al volver sólo si hash y longitud siguen coincidiendo.

## Mapa de mantenimiento

- Modelo de marcas: `frontend/vendor/excalidraw-clarin/packages/excalidraw/element/clarinRichText.ts`.
- Modelo de párrafos: `frontend/vendor/excalidraw-clarin/packages/excalidraw/element/clarinParagraphFormat.ts`.
- Edición y selección: `frontend/vendor/excalidraw-clarin/packages/excalidraw/element/textWysiwyg.tsx`.
- Acciones y accesibilidad: `frontend/vendor/excalidraw-clarin/packages/excalidraw/actions/actionProperties.tsx`.
- Canvas/SVG: `frontend/vendor/excalidraw-clarin/packages/excalidraw/renderer/clarinParagraphAlignment.ts` y renderers consumidores.
- Frontera de escena: `frontend/src/lib/whiteboardExcalidrawAdapter.ts`.
- Validación del servidor: `backend/internal/service/whiteboard_service.go`.

Una ampliación futura a listas, sangría, color parcial, tamaño parcial o fuente
parcial debe crear un modelo explícito y canónico; no debe persistir HTML ni
reutilizar `textAlign` para semánticas que no sean del elemento completo.

## Evidencia de calidad y release

- Unitarias frontend: 158 archivos, 735 pruebas.
- Go: `GOCACHE=/tmp/go-build go test ./...`.
- TypeScript y build Next de producción: 33 rutas.
- E2E de rich text: 6/6 en Chromium, Firefox y WebKit; la regresión aislada
  pasó además contra el frontend público ya desplegado.
- Compatibilidad: fixtures upstream, Clarin y reconciliación diferencial.
- Aislamiento: 68 archivos estáticos y 112 URLs runtime sin egress operativo.
- Assets: 890 artefactos, 32 fuentes locales y branding verificado.
- Supply chain: CycloneDX 1.6, 251 componentes, SHA-256
  `8136e0f99fc37d18e3ce43d89526eac73d509b65d790349a48e6ef1d9891010b`.
- Release desplegado: `2026.08.23-1-202958436936477-999483ec83f2`.
- Rollback inmutable: assets `0.18.1-clarin.1` y `0.18.1-clarin.2`
  conservados; la versión activa es `0.18.1-clarin.3`.
