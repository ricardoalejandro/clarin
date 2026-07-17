# Clarin Chat And WhatsApp Verification Matrix

Run the applicable rows. Record what actually ran and report any provider-dependent gap.

## Baseline

- Run `GOCACHE=/tmp/go-build go test ./...` from `backend` for backend, repository, WhatsApp, storage, or contract changes.
- Run `npx tsc --noEmit` and `npm run build` from `frontend` for chat UI, routes, API contracts, or production rendering.
- Run `git diff --check` from the repository root.
- Add focused tests for the specific regression instead of relying only on broad builds.

## Realtime List And Messages

- Send several messages rapidly and receive messages while the list is scrolled.
- Deliver duplicate/out-of-order inbound and sent events.
- Keep filters, user search, selected chat, and multi-selection active.
- Verify no skeleton flash, row remount, scroll jump, duplicate chat/message, or stale preview/order.
- Verify receipts/reactions patch the intended message without a full-list reload.

## Layout And Details

- Test 320, 375, 768, 1024, 1280, and 1440 px.
- Test browser zoom 80%, 100%, 125%, and 150% with sidebar/Eros open and closed.
- Test no Contact and zero/one/many Opportunities, long tags/notes, and many commercial fields.
- Reach the final field/action using wheel, touch, keyboard, and screen-reader landmarks.
- Verify integrated/drawer/mobile transitions do not jump, blur content, create nested scroll traps, or reduce conversation below 480 px in three-column mode.

## Popovers And Accessibility

- Open the avatar/menu/picker at top, bottom, left, and right viewport edges.
- Test mouse, touch, Tab/Shift+Tab, Enter/Space, Escape, outside click, resize, and outside scroll.
- Verify viewport clamping/flipping, internal max-height scrolling, focus trap where modal, and focus restoration.

## Search, Delete, And Reply

- Search for a message not currently loaded; navigate previous/next and verify count.
- Delete one/many chats; test cancellation and backend transaction failure; verify Contact/Opportunities remain.
- Reply to inbound/outbound/media messages; verify immediate render, WebSocket echo, reload, pagination, and search hydration all preserve the quote.

## New Chat

- Test Contact selection and international manual numbers.
- Test registered, unregistered, malformed, provider unavailable, disconnected, Cloud-only, existing chat, duplicate submit, and initial-message failure.
- Verify frontend and backend both fail closed without positive validation and canonical JID.

## Contact Avatar

- Test initial auto-fetch once and prove normal later reads do not refetch.
- Test manual refresh from every supported context, device selection, same photo, changed photo, private/missing photo, expired/tampered preview, and disconnected device.
- Test manual JPEG/PNG upload, invalid/oversized image, edit/crop/rotation, quota failure, database failure after upload, and cache refresh.
- Verify account isolation, object prefix, `media_assets`, `storage_objects`, current reference, old-asset GC eligibility, and no deletion of shared assets.
- For SQL changes, prepare/execute the actual statement against PostgreSQL to catch parameter inference and constraint failures.

## Own Statuses

- Use a real compatible WhatsApp Web device for text, image, and video publish.
- Verify from-me synchronization, remote deletion/revocation, retry, 24-hour expiry, and media cleanup.
- Verify viewer receipts map to the correct account/device/status and update idempotently.
- Delete a Clarin-published status from WhatsApp/WhatsApp Web and verify Clarin removes or marks it revoked without waiting for 24-hour expiry.
- Confirm contact statuses are neither stored nor displayed.
- Confirm unsupported Cloud/device actions are disabled with an explanation and rejected by backend bypass.
- Test image/video crop, rotate/flip, text, emoji, overlay transforms, visual links, cancel, render failure, and final output parity. Verify unsupported native/tappable links are never advertised.

## Stickers

- Verify backend favorites across reload/device/browser, last-use Recents ordering, and save/remove from bubbles.
- Verify invalid MIME/size/dimensions, send retry, static WebP output, and touch/keyboard picker behavior.
- Test animated output only with FFmpeg present and a real device capability; otherwise verify the feature remains gated.

## Deployment Evidence

- Run `make deploy` when production application was requested.
- Run `docker ps --filter name=clarin`.
- Run `docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health`.
- Inspect fresh backend, frontend, PostgreSQL, and provider logs for the changed operation.
- Verify `/api/version` when build/version wiring is relevant.
- Verify focused database schema/data when migrations or persistence contracts changed.
- Re-run the changed operation through the authenticated UI/API when access permits; otherwise explicitly ask the user to perform that final session-bound action.
