---
name: clarin-utilities-experience
description: Analyze, implement, or review Clarin Utilitarios, including the JSON/XML Monaco workspace, QR, image/Base64, cryptography, and the adjacent per-account browser-session inactivity policy.
---

# Clarin Utilities Experience

## Load The Relevant Context

- Read `AGENTS.md`, `clarin-frontend-development`, `clarin-interface-design-system` and its design/verification references, and `clarin-quality-assurance` before changing a utility.
- Add backend and database skills when changing authorization or session policy. This skill does not change the repository's PR, merge, or deployment authorization rules.
- Inspect `frontend/src/components/utilities`, its dashboard routes, and the implementation behind reported screenshots. Keep the four-tool catalog and local processing contract coherent.

## Access And Local Data

- Preserve the account-scoped `utilities` permission and the server check at `/api/utilities/access`, including revocation and account switching. Sidebar visibility alone cannot authorize a workspace.
- Keep JSON/XML, image bytes, QR content, plaintext, passwords, keys and results in memory. Clear them on leaving, account/session changes, and history restoration. Explicit copy and download are user-owned exports.
- Keep utility content out of browser persistence, URLs, logs, telemetry, Eros context and request bodies. Existing authentication and authorization traffic carries only its own metadata.
- Bundle parsers, editors, workers and QR libraries locally. Scope asynchronous work to its source/version, reject stale completions, and release workers, models, listeners, canvas and object URLs on cancellation or disposal.

## Compact Document Workspace

- Keep the JSON/XML editor full-height within the measured dashboard surface, with a compact header and one active-document toolbar. Reflow complete control groups when sidebar, Eros or mobile space changes.
- Keep Formatear, Formato inteligente, Compactar, Validar, Ajustar líneas, history, local-file actions, Reparar, Escapar, Desescapar and Limpiar directly discoverable through grouped icons. Preferences may remain in their own popover.
- Use distinct Lucide icons, accessible names, meaningful hover/focus labels and visible pressed/disabled states. Touch targets remain at least 44 by 44 px. Explain format-specific unavailability.
- Panels A and B own independent editable Monaco models, syntax, history, selection, folding and scroll. Hiding/restoring, narrow-mode tabs and comparison must preserve both drafts and reading positions, including the current long-line chunk.
- Apply operations to the active document as one undoable edit. Keep representation, inferred syntax and raw line-ending fidelity coherent through Undo/Redo, copy and download. Plaintext produced by Desescapar exports as `.txt`.
- Store word wrap independently per panel. `Ajustar líneas` and focused-editor `Alt+Z` share the same state. Wrapping changes visual lines only and preserves bytes, undo and selection. Long-line chunk previews keep bounded wrapping with an explained disabled toggle, then restore the panel preference in the full editor.
- Keep editor zoom separate from browser geometry. Provide the visible percentage, 100% reset, A−/A+ and a maximum of 500% (`14 px` default, `70 px` maximum). Ctrl+wheel changes font size only over the focused editor and comparison, with the same shared percentage.
- Preserve focus after operations, repair apply/discard and comparison close, while respecting deliberate focus changes during asynchronous work. Popovers stay within the visual viewport and reposition or dismiss with focus return on reflow.

## Document Integrity And Limits

- Reuse `jsonLimits.ts`, `editorWorkspaceState.ts`, the worker and bounded output helpers. Current limits are 25 MiB input, 50 MiB output, 2 MiB repair and 160 nesting levels. Check actual UTF-8 bytes and preserve the original on failure.
- Process whole documents in a cancellable local worker with bounded time. Very long lines use read-only, surrogate-safe chunks. Large documents use simplified highlighting rather than mounting the whole representation as DOM.
- Preserve scalar lexemes, wide integers, exponent/decimal spelling, key order and duplicate keys through JSON formatting and compaction. Warn about duplicates or bounded duplicate checking. JSONC retains comments under its explicit syntax mode.
- Standard JSON formatting places each entry on its own line. Smart formatting is deterministic and idempotent, using the current 100-column budget. It keeps fitting short containers inline and packs adjacent complete scalar fields/items in longer comment-free flat containers. Preserve intact string values and explicit repair. Visual wrapping remains independent.
- Repair produces a reviewable proposal tied to the source version, then applies once on confirmation. Escapar adds one JSON-string layer and Desescapar removes one complete layer.
- Read local files as validated UTF-8. Report line/column failures and keep the prior draft when size, encoding or parsing fails.
- XML uses the local XML 1.0 parser with namespaces. Reject DOCTYPE and external entity loading. Preserve text, attributes, comments, CDATA, processing instructions, mixed content and inherited `xml:space`.
- Structural XML whitespace changes require the explicit option. Detect XML signatures and preserve signed originals. Validate the encoding declaration before a UTF-8 XML download.
- Comparison uses separate read-only models and retains both editing models. Current limits are 5 MiB and 100,000 lines per document with bounded line length. Report timeout/incomplete computation truthfully and restore editing state on exit.

## QR, Image And Cryptography

- QR generates local PNG/SVG and decodes selected, dropped or pasted images through a local worker. Render decoded content as text and require an explicit action before following any link.
- Share validated image intake and clipboard fallback. Current PNG/JPEG/WebP limits are 10 MiB and 16 megapixels. Validate bytes and dimensions before decoding, and preserve source bytes through Base64/Data URL round trips.
- Keep image conversion distinct from OCR. Copy/download must contain the complete result even when the displayed text preview is bounded.
- Reuse Web Crypto and `jose`. Current cipher profiles are AES-128/256-GCM and RSA-OAEP-256 with AES-256-GCM in compact JWE. Authenticate before revealing plaintext, validate the selected algorithms, and generate fresh cryptographic randomness per encryption.
- Keep hashes/HMAC explicitly labelled with SHA-256/384/512. AES keys use Base64, RSA uses SPKI/PKCS#8 PEM, and text uses strict UTF-8. Keep Base64/Base64URL and binary download behavior explicit.
- Preserve bounded crypto inputs, actionable key/format/authentication errors and hidden secret outputs with deliberate reveal/copy/download. Changing operation or inputs invalidates obsolete results and late completions.
- When changing dependencies, verify the exact package/version and update required license evidence. Use current audit results rather than retaining historical vulnerability claims.
- Mermaid's KaTeX dependency is part of Pizarras. Follow the Excalidraw supply-chain skill when changing it, verify the effective browser entrypoint and the compiled web/offline bundles, and exercise formula conversion for members and authorized guests. A clean package audit alone does not verify bundled copies.

## Adjacent Account Session Policy

- Configure `session_idle_timeout_minutes` under Admin → Cuentas. Only global `IsSuperAdmin` may update it, with an account-scoped write and audit record. Account-admin authority and wildcard module permission do not grant this action.
- Current policy is an integer from 5 to 1440 minutes, default 30. Snapshot it on login or account selection, retain the existing session's policy, and preserve the seven-day absolute limit.
- Enforce server deadlines and browser snapshots together, including refresh rotation, WebSocket authorization, cross-tab scope changes and legacy sessions. Background traffic must not manufacture user activity. Keep offline unlock rules governed by their own runtime.

## Verification

- Follow the QA skill for affected layers. Cover pure state/transform invariants and source/version races at the nearest stable test boundary.
- Browser-check direct controls, keyboard/focus, both panels, hidden-panel restoration, 500% font zoom, independent wrap, diff and narrow reflow with sidebar/Eros. Include long strings, wide numbers, duplicate keys, JSONC, mixed/signed XML and oversized input.
- Exercise clipboard denial/native paste, corrupt/oversized images, QR and Base64 round trips, invalid/authentication-failed crypto, and proof that utility payloads never enter requests or persisted storage.
- Session changes also verify global-superadmin enforcement, account isolation, policy snapshots, idle/absolute deadlines and refresh/realtime races.
