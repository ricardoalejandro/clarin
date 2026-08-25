# Clarin Whiteboard Architecture

## Ownership Boundary

Clarin owns the product shell, accounts, users, module permission, folders,
whiteboards, grants, revisions, sharing, search, activity, storage,
collaboration sessions and operational controls. Excalidraw supplies only the
MIT-licensed in-browser scene editor and its compatible import/export and
client reconciliation functions.

The editor is client-only in Next.js and is loaded with SSR disabled. Clarin
hosts every required font and runtime asset under the versioned
`/vendor/whiteboards-editor/0.18.1-clarin.4/` path. Product menus, persistence, sharing,
history and libraries are Clarin controls. The complete `excalidraw-app`,
Firebase integrations and Excalidraw-hosted collaboration are not part of the
runtime.

## Implemented Canonical Model

The startup migration in `backend/pkg/database/whiteboard_migration.go` is the
schema source of truth:

- `whiteboard_folders`: account-scoped hierarchy, durable `sort_order`,
  optimistic `version`, archive state and a maximum depth of 20;
- `whiteboards`: account-scoped identity, optional folder, canonical bounded
  `scene_json`, editor/schema versions, monotonic `scene_sequence`, lifecycle,
  thumbnail and access revision;
- `whiteboard_grants`: direct user grants with cumulative `view`, `comment`,
  `edit` and `manage` levels; `manage` is the only level with access
  governance;
- `whiteboard_operations`: immutable idempotency and replay log keyed by board,
  operation ID and canonical sequence;
- `whiteboard_revisions`: immutable compressed snapshots, integrity, format,
  actor/guest provenance, kind and retention metadata;
- `whiteboard_revision_assets`: immutable revision-to-media manifest;
- `whiteboard_share_links` and `whiteboard_guest_sessions`: hashed secrets,
  capability, expiry, revocation and board-scoped guest identity;
- `whiteboard_assets`: current board or library file-ID mapping to
  `media_assets`, with draft/commit lifecycle;
- `whiteboard_libraries`: private personal or account-visible library JSON;
- `whiteboard_comment_threads`, `whiteboard_comments` and their operation
  records: account/board-scoped conversations stored outside the scene, with
  element or free-point anchors, optimistic versions and idempotent writes;
- `whiteboard_library_import_sessions`: short-lived, actor-bound public-catalog import
  sessions whose validated payload is cleared after acknowledgement or expiry;
- `whiteboard_activity` and `whiteboard_access_audit`: account/board-scoped
  operational and authorization history;
- `whiteboard_media_gc_jobs` and `whiteboard_snapshot_gc_jobs`: durable,
  retryable, reference-safe physical cleanup.

Every relation that can cross an account boundary uses `account_id` in its
foreign key. Guest provenance additionally includes `board_id`. Repository
queries derive the active account and actor from authenticated context; a
whiteboard ID, file ID, folder ID or guest-provided value is never authority.

Folders are organizational account data. They neither grant nor inherit
whiteboard access. Any user who reaches their endpoints has already passed the
account membership, active session and `whiteboards` module-permission gates.
Whiteboards are private by default; their creator receives `manage`. Direct
grants override account visibility, while account administrators retain
recovery. Hidden boards return 404 and visible boards with insufficient action
rights return 403.

## Canonical Scene And Save Path

PostgreSQL holds the current canonical scene as JSONB, limited to 16 MiB and
50,000 elements. Binary bytes, remote URLs and storage keys are forbidden in
that JSON. Root and element extension properties are preserved; only the exact
Excalidraw 0.18.1 server-persistable app-state fields survive. Images are
referenced by file ID and resolved through private Clarin asset manifests.

The normal save path is:

1. Load authorized metadata, scene and only the scene's referenced assets.
2. Restore through the exact `@excalidraw/excalidraw@0.18.1-clarin.4` public APIs, based on upstream `v0.18.1`.
3. Upload new image bytes to the board-scoped private asset path before
   committing a live scene reference.
4. Send an `operation_id`, `base_sequence`, changed elements and allowed
   document app state through the Clarin room; use REST for a bounded full
   snapshot when a patch is unsuitable.
5. Lock the whiteboard row, re-authorize, reconcile by
   `id/version/versionNonce/index`, persist PostgreSQL before ACK and increment
   the canonical sequence exactly once.
6. Reconcile the ACK or remote patch with still-unacknowledged local edits. A
   lost ACK retries the same operation ID rather than inventing another write.

The browser is never canonical. Current scene writes are durable before they
are broadcast. Redis transports only bounded ephemeral fanout and presence;
PostgreSQL remains the recovery source if Redis is unavailable.

## Revisions And Retention

Creation writes a system revision. Active collaboration schedules an automatic
revision after five minutes and flushes the pending checkpoint after the final
modified session closes. Imports, restores and explicit user actions create
their required immutable revision. Automatic revisions expire after 30 days;
manual and system revisions have no time expiry and survive until an eligible
administrative purge.

Revision JSON is gzip-compressed deterministically and stored under
`account_id/_private/whiteboards/<board>/revisions/...`. PostgreSQL records its
hash, size, compression, sequence and exact asset manifest. Cleanup first
removes a proven-expired database reference transactionally, then uses a
durable job to delete the object only after rechecking that no live reference
exists.

The board trash retention defaults to 30 days and is account-configurable
within the migration constraint. Permanent purge requires account-admin
authority, expiry eligibility, exact-name confirmation and an idempotency
operation ID. It revokes active rooms and schedules only reference-safe media
cleanup.

## Assets And Libraries

Board and library assets accept only normalized PNG, JPEG, WebP or GIF, with
bounded bytes, dimensions and pixel count. SVG import is sanitized and
rasterized in the browser before upload. Object keys are generated by Clarin
under the account-private whiteboard prefix; a client file ID never becomes a
storage authorization key. Quota reservation and media/storage inventory are
transactional.

Asset list endpoints derive the current referenced file IDs on the server and
enforce a bounded manifest. Clients also filter against the exact scene
references, page with stable cursors, stop once all references resolve and use
bounded download concurrency.

Library list responses are summaries only. The editor fetches bounded detail
records separately; a private personal library is writable only by its owner,
while account libraries are visible read-only to other account members.
Local `.excalidrawlib` import/export stays inside Clarin. A member may also
explicitly open the official public directory through a same-origin Clarin
start route. The directory receives only an opaque, short-lived callback token;
the editor never fetches the selected third-party file. Clarin's backend accepts
only the exact official library path, resolves and pins a public address,
downloads without redirects under strict time/size bounds, validates and
sanitizes the document, and then exposes it once to the originating actor for
merge into that actor's personal library. The callback is a generic Clarin
page and never reveals a board, account, user or library identifier.

## Sharing

An external URL contains a public link UUID in the path and a high-entropy
secret only in its fragment. The browser removes the fragment immediately and
posts the secret once; PostgreSQL stores only its SHA-256 hash. Optional link
passwords use the configured slow password hash. A successful exchange creates
a `Secure` production, `HttpOnly`, `SameSite=Strict` cookie scoped to
`/api/whiteboard-guest` and a guest session bound to exactly one account,
whiteboard and link.

Links default to `view`, seven-day expiry and disabled export. They may grant
bounded `edit`, use a password/session cap and be revoked immediately. Link or
session revocation closes matching local and Redis-connected sockets. Public
surfaces expose no account navigation or sibling-resource authority.

The public session exchange is a credential endpoint, not an upload surface.
Cap its JSON body at 16 KiB twice: with a high-priority edge-proxy request-body
limit and with Fiber middleware before `BodyParser`. Keep the proxy limit when
changing ingress providers because Fiber's application-wide limit is larger for
real file uploads and fasthttp may otherwise allocate the body before route code
runs. Invalid JSON and credentials still consume the public abuse budget.

## Collaboration Protocol

The endpoint is `/ws/whiteboards/:id`. A browser first obtains a short-lived,
one-use Clarin ticket; the server consumes it atomically and derives account,
board, user/guest and access. The current Fiber access-log format records
`${path}`, never `${url}` or `${queryParams}`, and therefore omits the ticket
query. The current Dokploy Traefik deployment has access logging disabled; this
is omission, not redaction. Before enabling ingress access logs, configure them
to exclude query strings (or move ticket transport off the URL), and verify that
the raw ticket is absent. Tickets are never persisted as product data.

Client events are `scene.patch`, `sync.request`, `cursor.update`,
`presence.update`, `presentation.start`, `presentation.stop`, `follow.change`
and `viewport.update`. Server events are `scene.patch`, `scene.snapshot`,
`sync.required`, `ack`, `room.ready`, `presence.snapshot`, `presence.update`,
`cursor.update`, `presentation.snapshot`, `presentation.changed`, relayed
`follow.change`/`viewport.update`, member-only `comment.changed`,
`access.revoked` and `error`.

Presentation ownership is an account-and-board-scoped Redis lease with one
presenter, a 45-second TTL and server-side renewal every 15 seconds. It is
never persisted in a scene or revision. Editors may acquire it; viewers may
follow only after individual consent. Viewport bounds are bounded, coalesced,
ephemeral and applied with non-capturing editor updates.

Durable patches are at most 1 MiB on the wire, 2,000 changed elements and a
small allow-listed app-state delta. Presence and cursors have independent,
smaller limits and are never persisted. Full canonical scenes remain available
through authorized REST, but a realtime snapshot or canonical ACK over the
900,000-byte safe realtime budget is represented by `sync.required`; the client
reloads the REST snapshot and reconciles local dirty edits. This prevents copying a 16 MiB scene
into every socket queue or Redis Pub/Sub message.

Room and account rates, connection leases, origin checks, periodic
reauthorization and immediate revocation are enforced on every backend
instance. Redis keys and fanout envelopes include account and board. A Redis
outage may delay cross-instance live presence but cannot undo a PostgreSQL
commit.

## Egress And Encryption

The whiteboard route CSP limits scripts, connections, frames, images, fonts and
workers to the Clarin origin plus `data:`/`blob:` only where required. Embeds,
remote images, AI, Mermaid network helpers, telemetry, public library
publication and upstream help/product routes are removed, blocked or replaced.
The only catalog exception is the explicit top-level navigation and validated
backend retrieval described above and recorded in `egress-policy.md`; it does
not broaden browser `connect-src`. Normal `http`, `https` and `mailto` element
links are sanitized and open only after an explicit user action.

The security model is TLS, Clarin ACL and infrastructure encryption, not E2EE.
That deliberate boundary permits server reconciliation, revisions, recovery,
search and thumbnails without sending data to Excalidraw.

## Operational Proof

Do not infer runtime safety from a successful build. Verify repository unit
tests, PostgreSQL migration/isolation tests, Redis multi-instance fanout,
historical format fixtures, differential reconciliation goldens, two-browser
reconnect/conflict/revocation behavior, production build CSP and a captured
strict egress trace. Deployment and live health remain a separate, explicit
user-authorized phase.
