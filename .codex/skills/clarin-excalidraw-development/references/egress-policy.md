# Whiteboard Egress Policy

## Default Policy

The Clarin whiteboard runs in strict isolation by default: no browser, worker, server, collaboration gateway, export job, or font loader may contact Excalidraw or any other third party. Allow only the exact Clarin web/API origin, the authorized Clarin media origin, and the authenticated Clarin WebSocket/collaboration origin required by the deployment.

A decision to permit user-initiated external links, images, embeds, libraries, or AI is a product and security scope change. Record an origin-specific allowlist, visible user disclosure, server-side validation, privacy impact, and tests. Never infer that permission from the upstream editor supporting the feature.

## Known Surfaces To Remove Or Replace

- Excalidraw hosted collaboration, sharing, JSON, library, Plus, and AI endpoints;
- Firebase, Google APIs, analytics, Sentry, telemetry, and remote configuration;
- font CDN fallback including `esm.sh`, remote Google fonts, and language-specific fallback fonts;
- library browse, import, publish, and raw GitHub library URLs;
- help, blog, documentation, social, video, and product-navigation links;
- web embeds, remote image fetch, Mermaid/network helpers, and URL previews;
- service workers, workers, source maps, or error handlers that fetch remote assets;
- collaboration endpoints inherited from `.env.production` or the public app.

Scan at least these host suffixes as forbidden until an explicit exception is approved:

```text
excalidraw.com
esm.sh
firebaseio.com
firebaseapp.com
googleapis.com
gstatic.com
sentry.io
youtube.com
youtu.be
vimeo.com
githubusercontent.com
```

This list is a floor, not a complete allowlist.

## Browser Enforcement

Apply a route-appropriate Content Security Policy. Derive exact origins from deployment configuration; a strict starting point is:

```text
default-src 'self';
connect-src 'self' https://api.clarin.invalid wss://api.clarin.invalid;
font-src 'self' data:;
img-src 'self' data: blob: https://media.clarin.invalid;
media-src 'self' blob: https://media.clarin.invalid;
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
```

Replace example origins with real controlled origins. Use nonces or hashes for scripts/styles where the application supports them. If existing Next.js styling temporarily requires a broader directive, document it as a separate CSP risk; never broaden `connect-src` or `frame-src` to solve styling.

Add a report endpoint and treat violations from the whiteboard route as release failures. CSP is defense in depth, not a substitute for removing the code path.

## Static Verification

Run `scripts/scan-runtime-egress.mjs` over production chunks, CSS, worker files, manifests, and server artifacts. Use strict mode with explicit allowed origins for built Clarin output. Also scan the candidate package in forbidden-host mode so newly introduced upstream literals appear before integration.

Visible product identity has a separate, reviewable policy in
`visible-branding-policy.json`. Run `scripts/scan-visible-branding.mjs` over the
locally served editor assets and over a browser-produced visible-surface
snapshot. Static engine bundles contain inert format names and translations, so
they are not proof of visible branding by themselves; the runtime snapshot is
the required evidence for rendered text and actions. It must contain at least
one surface and list only elements that the browser reports visible.

The branding scanner exempts only the exact basenames declared under
`legalArtifactBasenames`. That lets compiled distributions preserve the MIT and
font notices without allowing an `Excalidraw` product label in an ordinary JS,
HTML, JSON, CSS, or Markdown artifact. `.excalidraw`, `.excalidrawlib`, and their
MIME identifiers remain format-compatibility tokens, not branding exceptions.

```bash
node .codex/skills/clarin-excalidraw-development/scripts/scan-visible-branding.mjs \
  --root frontend/public/vendor/whiteboards-editor/0.18.1-clarin.4 \
  --snapshot /tmp/clarin-whiteboard-visible-branding.json \
  --policy .codex/skills/clarin-excalidraw-development/references/visible-branding-policy.json \
  --json /tmp/clarin-whiteboard-branding-report.json
```

Never add a broad path, directory, host, or free-text suppression to make this
gate pass. A new legal filename or visible product action is a policy review.

Review each match in context. Do not suppress an entire minified file or host suffix. If an inert legal/documentation string is unavoidable, use the narrowest file-and-value exception and prove that browser tests never request it.

## Runtime Verification

Capture every attempted request and WebSocket in Playwright or equivalent, including failed and CSP-blocked attempts. Exercise:

- first load, offline reload, and every bundled font/language;
- drawing tools, images, clipboard, import, export, and libraries;
- menu and keyboard help paths, especially `?`;
- links, embeds, Mermaid, AI, and remote images whether enabled or disabled;
- document save, share, assets, presence, and multi-user collaboration;
- errors, retries, worker startup, and source-map/error reporting.

Pass the trace to `scan-runtime-egress.mjs --strict` with exact allowed origins. A blocked attempt is still a policy defect and must appear in the trace.

Finally run the whiteboard with outbound DNS/network denied after dependencies are cached. Monitor browser, frontend, backend, collaboration, and proxy logs. An egress firewall reduces impact but does not turn an unexpected attempt into acceptance.

The visible snapshot must cover the authenticated editor and the external-share
surface whenever either changes. Record visible text plus actionable elements'
accessible name, label/title, `data-testid`, class tokens, and `href`. Hidden
upstream controls are still asserted separately in Playwright; if any becomes
visible, the snapshot gate must fail on the next run.

## Exceptions

Every exception must name the feature, origin, paths, data sent, initiator, user disclosure, retention, timeout, failure state, CSP change, tests, owner, and expiry/review date. Excalidraw-owned services remain prohibited when the product requirement is independence from Excalidraw.

### Official public library import

- Feature: browse the official public Excalidraw library directory and add a
  selected vector library to the authenticated member's personal Clarin
  library.
- Origin and paths: user-initiated top-level navigation to
  `https://libraries.excalidraw.com/`; backend-only `GET` to the exact canonical
  path `https://libraries.excalidraw.com/libraries/<author>/<name>.excalidrawlib`.
  Queries, fragments, alternate ports, credentials, redirects, proxies and all
  other origins or paths are rejected.
- Data sent: the directory receives a generic same-origin Clarin callback URL,
  an opaque one-use token and non-sensitive display/compatibility flags such as
  theme, editor version and target. It receives no account, board, library,
  scene, element, user or contact identifier. The backend request sends only
  ordinary HTTPS request metadata needed to retrieve the selected file.
- Initiator and disclosure: only a member's explicit activation of the visible
  `Explorar bibliotecas` action. Navigation leaves Clarin for the official
  catalog; returning starts a Clarin validation-and-save notice before any item
  appears in the personal library. The same-origin start link triggers an
  authenticated API `POST`; Clarin's exact Origin check, dedicated request
  header and SameSite cookies block cross-site submission. The response
  contains only an exact relative Clarin path without a query or secret. The
  one-use navigation proof is held in a host-only, HttpOnly, path-scoped,
  SameSite=Strict cookie (`Secure` in production). A subsequent top-level `GET`
  validates the proof, actor, board ACL, personal library, pending state and
  expiry, consumes the navigation transactionally, clears the cookie and only
  then redirects to the directory. Callback claim requires that prior
  navigation, and replay of `/navigate` fails closed.
- Validation and privacy: Clarin resolves every DNS answer and rejects private,
  loopback, link-local and otherwise non-public addresses; dials one resolved
  public IP with TLS verification for the allow-listed hostname; follows no
  redirect; caps response size; validates the `.excalidrawlib` schema and strips
  or rejects unsafe links, embeds and remote/data-backed file sources. Official
  v1 `library` envelopes are normalized to the single v2 `libraryItems`
  contract before persistence; ambiguous dual-format payloads are rejected.
  The browser editor never connects to or downloads from the third-party origin.
- Retention: the actor-bound import session expires after 15 minutes. The
  validated JSON payload is deleted after successful personal-library
  persistence and acknowledgement, and bounded garbage collection clears
  expired payloads. Operational activity contains identifiers/status only,
  never comment or library bodies.
- Timeout and failure state: backend fetch timeout is 12 seconds and response
  size is limited to 8 MiB. Invalid, image-dependent, expired or unavailable
  libraries fail closed with a visible retry or discard path; the existing
  personal library remains canonical and no completion ACK is sent before its
  successful persistence.
- CSP change: none. `connect-src`, `img-src`, workers and frames remain limited
  to Clarin-controlled origins. The third-party directory is reached only as a
  top-level user navigation.
- Tests: backend URL/DNS/redirect/size/schema/token tests, frontend
  merge-before-ACK and callback-binding tests, hardening/branding scans, and a
  browser assertion for the exact same-origin start link, API `POST`,
  query-free same-origin navigation path, HttpOnly one-use handoff and
  cross-browser top-level transport. An
  opt-in backend integration test downloads and validates the
  official Software Architecture v1 library used in the product acceptance
  example.
- Owner: Clarin Pizarras.
- Approved and reviewed: 2026-08-14. Next mandatory review: 2026-11-14; remove
  the exception earlier if the official protocol, origin or privacy contract
  changes.
