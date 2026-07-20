# WhatsApp Cloud API directo con Meta

Clarin mantiene dos productos separados:

- `Chats`: sesiones históricas de WhatsApp Web mediante QR.
- `Chat API`: WhatsApp Cloud API oficial, conectado directamente con Meta.

No hay un BSP intermediario. Cada cliente conserva su propio WhatsApp Business Account (WABA), acepta los términos de Meta y configura su método de pago directamente en Meta. Clarin actúa como Tech Provider y aloja el flujo Embedded Signup.

## Configuración de Meta

1. Usar el Business Portfolio verificado que administra Clarin.
2. Crear o seleccionar una Meta App de tipo Business y agregar el producto WhatsApp.
3. Configurar Embedded Signup con Coexistence para WhatsApp Business App.
4. Solicitar mediante App Review los accesos avanzados que Meta exige para el flujo: `business_management`, `whatsapp_business_management` y `whatsapp_business_messaging`.
5. Configurar el webhook público `https://<dominio>/api/whatsapp/cloud/webhook`. Para Cloud API se requiere `messages`; en Coexistence también deben habilitarse, según las capacidades aprobadas por Meta para la app, `smb_message_echoes`, `history` y `smb_app_state_sync`.
6. Registrar el dominio público de Clarin y sus URLs permitidas en la app/configuración de Meta.

Documentación oficial:

- [Meta Tech Providers](https://developers.facebook.com/docs/whatsapp/solution-providers/tech-providers/)
- [Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/)
- [Embedded Signup para usuarios de WhatsApp Business App](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/)
- [Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/)
- [Cloud API messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/)

## Variables del servidor

```dotenv
WHATSAPP_CLOUD_APP_ID=
WHATSAPP_CLOUD_APP_SECRET=
WHATSAPP_CLOUD_CONFIG_ID=
WHATSAPP_CLOUD_GRAPH_VERSION=v23.0
WHATSAPP_CLOUD_VERIFY_TOKEN=
WHATSAPP_CLOUD_TOKEN_ENCRYPTION_KEY=
PUBLIC_URL=https://clarin.example.com
```

Generar los secretos de infraestructura:

```bash
openssl rand -hex 32     # WHATSAPP_CLOUD_VERIFY_TOKEN
openssl rand -base64 32  # WHATSAPP_CLOUD_TOKEN_ENCRYPTION_KEY
```

La clave de cifrado protege los business tokens con AES-256-GCM y autenticación ligada a `account_id + device_id`. No debe exponerse al frontend, imprimirse ni cambiarse sin recifrar las credenciales existentes.

## Flujo implementado

1. El administrador abre `Configuración -> WhatsApp API` y pulsa `Conectar con Meta`.
2. El navegador ejecuta Embedded Signup en modo `whatsapp_business_app_onboarding`.
3. Meta devuelve un código de un solo uso y el WABA; algunas versiones del evento también incluyen el ID del número.
4. El backend intercambia el código por un business token y solo acepta el número que Meta confirme dentro de ese WABA con `is_on_biz_app=true` y `platform_type=CLOUD_API`; después cifra el token.
5. Clarin suscribe su app al WABA, sincroniza plantillas y activa el canal.
6. Webhooks entrantes crean o reutilizan el `Contact` padre y escriben el chat en el canal Cloud independiente.
7. Los mensajes libres solo se habilitan dentro de la ventana oficial de 24 horas. Fuera de ella se exige una plantilla aprobada sincronizada desde Meta.
8. Un mensaje entrante registra opt-in conversacional. Si un operador inicia con plantilla, debe declarar el origen y evidencia del consentimiento; Clarin lo audita por cuenta, contacto, número y usuario.

## Límites funcionales de este corte

- La bandeja inicial permite texto dentro de la ventana y plantillas para iniciar/continuar conversaciones.
- El selector inicial admite plantillas de texto con variables posicionales en encabezado/cuerpo. Las plantillas que exigen archivos, encabezados multimedia o botones dinámicos se muestran como no compatibles hasta implementar sus parámetros específicos.
- No habilita campañas, grupos, estados, stickers, reacciones ni envío de archivos por Cloud API.
- Los mensajes nuevos enviados desde la app de WhatsApp Business se incorporan mediante `smb_message_echoes` cuando Meta entrega ese evento. Las ediciones y revocaciones se conservan en la auditoría del webhook, pero todavía no modifican el mensaje local.
- La solicitud e ingestión del histórico previo, contactos sincronizados y descarga de sus medios todavía no forman parte de este corte.
- Desactivar un canal en Clarin y dar de baja la suscripción en Meta se implementarán como una operación explícita posterior; eliminar una sesión QR no equivale a desconectar Cloud API.
