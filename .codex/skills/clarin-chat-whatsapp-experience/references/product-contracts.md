# Clarin Chat And WhatsApp Product Contracts

Read the sections relevant to the requested change before editing.

## CRM Entity Contract

- Treat Contact as the single parent identity record.
- Treat Chat and Opportunity/Lead as parallel Contact children.
- Render name, phone, avatar, notes, contact tags, and contact status once in Details.
- Render Opportunity data as commercial context only: title, pipeline, stage, lifecycle, commercial fields, tasks/interactions, and commercial actions.
- Allow zero, one, or many Opportunities without changing the Details architecture.
- Never delete or silently mutate Contact/Opportunity when performing a chat-local deletion.

## Responsive Workspace Contract

- Measure the chat workspace container after sidebar, Eros, and surrounding chrome.
- Show list + conversation + Details only when configured list width + 480 px conversation minimum + configured Details width + separators fit.
- Show list + conversation with Details as a 360–440 px right drawer when three columns do not fit.
- Show one full-screen surface at a time on mobile with explicit Back navigation.
- Keep only the Details header fixed and use one parent vertical scroll for the entire Details content.
- Avoid blur on the drawer overlay; use light dimming so chat context remains legible.
- Persist only valid integrated-panel sizes. Disable dragging/resizing in drawer/mobile mode.

## Chat List And Realtime Contract

- Reserve full-list skeletons for initial entry and explicit filter/device changes.
- Patch `new_message`, `message_sent`, receipts, reactions, avatar/contact updates, and deletion events by stable chat/message ID.
- Deduplicate echo/duplicate events and reconcile silently in the background.
- Preserve mounted rows, virtualizer keys, scroll position, selected chat, multi-selection, and active user search.
- Clear multi-selection when device/filter/search semantics change and explain whether “select all” means loaded rows only.
- Keep rows dense and scannable. Make the selected state unmistakable with more than a subtle background tint.

## Details Contract

- Use the permanent title `Detalles` and one identity header.
- Show the actual selected device/provider and connection/capability state.
- Show an honest no-Contact state with create/link action.
- Show an empty Opportunity state, direct detail for one, and a compact selector for many.
- Prevent embedded Opportunity components from owning viewport height or nested page scroll.
- Keep every field/action reachable with wheel, touch, and keyboard.

## Controls, Search, Deletion, And Replies

- Expose actions through visible buttons or `…` menus; keep context menu only as an optional shortcut.
- Remove or explicitly disable controls without an implemented backend path.
- Search messages across server history, not only loaded DOM nodes; expose result count and previous/next navigation.
- Explain chat deletion precisely: remove local chat/messages, preserve Contact/Opportunities, do not delete the WhatsApp conversation, and allow reappearance on a new inbound message.
- Delete local chat/messages transactionally and verify the backend response before showing success.
- Preserve quote identifiers and preview metadata through send, database, WebSocket echo, pagination/search hydration, and rendering.

## New Chat Contract

- Show only connected devices with `can_start_chat` and `can_check_whatsapp`.
- Treat Peru `+51` as the initial country, not a restriction.
- Search Contact phone/name/account metadata with cancellation and exact-phone priority.
- Invalidate previous selection and validation whenever phone, Contact, or device changes.
- Require positive WhatsApp validation in frontend and repeat validation in backend using the canonical JID.
- Open an existing chat instead of creating a duplicate.
- If initial message sending fails after chat creation, open the chat and expose retry/partial-success feedback.

## Visual And Accessibility Contract

- Use the established slate/emerald dashboard language, visible focus, at least 44 px touch targets where space permits, and sufficient selected-state contrast.
- Render overflow-sensitive menus/pickers through `document.body`; flip/clamp to viewport and restore focus on close.
- Support mouse, touch, keyboard, Escape, outside click, resize, and outside scroll.
- Keep the exact historical WhatsApp-style wallpaper as a local repeated asset over `#efeae2`; keep one CSS source and a color fallback.
- Keep the primary action visible and move secondary actions into an accessible overflow menu when the toolbar cannot fit; never clip or squeeze labels into illegibility.
- Avoid layout jumps, excessive whitespace, clipped labels, nested cards, and marketing-page styling.

## Contact Avatar Contract

- Auto-fetch only at Contact creation and claim that attempt idempotently.
- Refresh later only on explicit user action from Contact, Opportunity, Chat, event participant, or program participant context linked to the same Contact.
- Resolve a connected WhatsApp Web device and preserve account/context authorization.
- Preview before replacement using an expiring signed token bound to account, Contact, device, content hash, and expiry.
- Never remove the current photo because WhatsApp returns no photo or privacy blocks access.
- Allow manual upload/edit; crop/rotate as supported, normalize to a compact JPEG, strip unnecessary metadata, and keep quality recognizable.
- Store under account-prefixed keys, record `media_assets` and `storage_objects`, update the Contact transactionally, bump cache revision, and schedule the previous asset only after detachment.
- Cast reused PostgreSQL parameters explicitly when assignments and CASE/comparisons impose different inference contexts.

## Own Status Contract

- Keep `Mis estados` separate from chat device multiselect filters.
- Store and display only own/from-me statuses. Never ingest contact statuses.
- Publish text/image/video only when the selected provider/device capability is proven.
- Reconcile own from-me events, remote deletion/revocation, expiry, retry state, and viewer receipts by account + device + WhatsApp message ID.
- Process own revoke/delete events immediately and add a bounded reconciliation path only when the provider can reliably enumerate own active statuses. Never keep claiming device truth after synchronization becomes unavailable.
- Show `Publicados desde Clarin` when device history cannot prove all statuses published elsewhere.
- Treat WhatsApp privacy/audience as read-only truth; do not invent a CRM audience.
- Retain for 24 hours and delete physical media only when no other references remain.

## Status Composer And Editor Contract

- Keep edits non-destructive until publish and retain an explicit editor model for crop, rotate/flip, text, emoji, link-like overlays, position, scale, rotation, color, background, layer order, and safe-area bounds.
- Render image overlays into the published image. Render video overlays through the supported backend media pipeline; do not show editor features whose output is discarded on send.
- Treat tappable/native links as a provider capability. If unsupported, allow only a visual URL/text overlay and label it honestly as non-interactive.
- Preserve aspect-ratio preview, video duration limits, output dimensions, MIME, file size, caption, progress, cancel, error, and retry behavior.
- Revalidate the final rendered output in backend even when the source file was already validated in frontend.

## Sticker Contract

- Use backend saved stickers as the only favorites source; never split truth with `localStorage`.
- Order Recents by actual last use.
- Validate MIME, size, dimensions, and static/animated semantics in frontend and backend.
- Gate animated GIF/video conversion behind FFmpeg availability and a per-device capability proven with a real device.
- Never silently flatten an animation while presenting it as animated.

## Error And Observability Contract

- Distinguish unavailable provider, disconnected device, validation failure, storage quota, invalid media, database failure, and partial success.
- Return safe Spanish user messages and stable machine codes where recovery differs.
- Log the internal operation/error with account-safe identifiers but never tokens, session material, signed URLs, media bodies, or message content.
- Inspect both application and PostgreSQL logs for persistence failures; a successful preview/fetch is not proof that confirmation/save succeeded.
