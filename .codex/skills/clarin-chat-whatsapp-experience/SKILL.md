---
name: clarin-chat-whatsapp-experience
description: Use when analyzing, designing, implementing, reviewing, testing, or deploying Clarin Chats and WhatsApp behavior, including chat layout/list/details, realtime WebSocket updates, new chat and number validation, replies/search/deletion, device capability flags, contact avatars, own statuses/viewers, stickers, media editing, and WhatsApp Web or Cloud provider boundaries. Enforces CRM entity truth, polished responsive UX, account/device isolation, honest provider capabilities, storage integrity, and production-grade verification.
---

# Clarin Chat And WhatsApp Experience

Implement chat work as a complete CRM/WhatsApp vertical slice. Preserve product truth, responsive usability, realtime stability, provider limitations, storage integrity, and observable failure behavior together.

## Load Required Context

1. Read repository `AGENTS.md`.
2. Read every matching layer skill: frontend, backend, database, storage, and quality assurance as applicable.
3. Read [product-contracts.md](references/product-contracts.md) before changing behavior, layout, data relationships, device capabilities, avatars, statuses, replies, stickers, or media.
4. Read [verification-matrix.md](references/verification-matrix.md) before writing the test/deployment checklist or claiming completion.

## Execute The Work

### 1. Establish The Existing Truth

- Trace the feature from visible control through component state, API client, route, handler/service/repository, database/storage, WhatsApp provider, WebSocket payload, and final rendering.
- Reproduce or identify the actual failure before redesigning. Inspect runtime/database logs when an HTTP 500 or provider mismatch is involved.
- Identify whether the requested behavior is CRM-local, WhatsApp-remote, or a synchronized projection. State honestly what the provider can verify.
- Inspect the previous asset or implementation when the user requests the exact historical appearance; reuse it instead of approximating it.

### 2. Protect Domain And Capability Boundaries

- Keep Contact as the identity parent and Chat/Opportunity as parallel children.
- Scope every read, write, event, asset, and background action by `account_id`; add `device_id` scope when behavior belongs to one device.
- Treat backend capability flags as authoritative. Hide or explain unsupported UI and reject backend bypasses.
- Keep Cloud API and WhatsApp Web paths distinct. Do not infer parity from similar UI.

### 3. Implement A Complete Vertical Slice

- Implement every visible control through success, loading, empty, timeout, provider-unavailable, retry, and partial-success states.
- Prefer local deterministic updates for immediate UX and silent server reconciliation for eventual truth.
- Preserve stable IDs, mounted rows, scroll, focus, selected chat, and selection mode during realtime events.
- Keep the central conversation usable first; allow secondary panels only when measured space fits.
- Use explicit transactions and durable cleanup for multi-table/media mutations.
- Return safe actionable user errors and retain enough non-sensitive server logging to diagnose persistence/provider failures.

### 4. Review Failure Modes Before Testing

- Switch chat/contact/device/filter/account while requests are in flight.
- Deliver duplicate and out-of-order WebSocket events.
- Reload after optimistic send, reply, avatar update, status publish, or sticker mutation.
- Test same-content/deduplicated media, quota failures, database failures after upload, provider disconnects, and private/missing WhatsApp data.
- Confirm destructive behavior describes the exact local and remote effect.

### 5. Verify And Deploy

- Run the layer commands required by the quality skill and the focused cases in the verification reference.
- Validate fragile PostgreSQL queries against PostgreSQL, not only Go compilation.
- Use a real compatible WhatsApp device for provider-dependent claims; otherwise keep the capability gated and report it as unverified.
- If deployment was requested, run `make deploy`, then verify containers, backend health, frontend/backend logs, relevant database state, `/api/version`, and the changed operation where credentials/session access permit.
- Never claim the feature works in production solely because image build or container startup succeeded.

## Non-Negotiable Review Questions

- Can any late response overwrite another chat/contact/device/account?
- Can any WebSocket event flash skeletons, reset scroll, or duplicate a row/message?
- Can the Contact identity appear twice or conflict with an Opportunity?
- Can any control appear enabled while its backend/provider path is absent?
- Can any popover be clipped by overflow or become unreachable by keyboard/touch?
- Can an upload leave an untracked object or delete a shared object?
- Can a WhatsApp-private/missing result erase valid CRM data?
- Can a reply lose its quoted context after reload or reconciliation?
- Can remote status deletion or viewer receipts be attributed to the wrong account/device/status?
