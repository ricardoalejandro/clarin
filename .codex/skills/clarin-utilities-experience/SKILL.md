---
name: clarin-utilities-experience
description: Analyze, implement, or review Clarin Utilitarios, including the JSON/XML Monaco workspace, QR, image/Base64, cryptography, and the adjacent per-account browser-session inactivity policy.
---

# Clarin Utilities Experience

## Load The Relevant Context

- Read `AGENTS.md`, `clarin-frontend-development`, `clarin-interface-design-system` and its design/verification references, and `clarin-quality-assurance` before changing a utility.
- Add backend and database skills when changing authorization or session policy. This skill does not change the repository's PR, merge, or deployment authorization rules.
- Inspect `frontend/src/components/utilities`, its dashboard routes, and the implementation behind reported screenshots. Keep the four-tool catalog, private document library and local processing contract coherent.

## Access And Local Data

- Preserve the account-scoped `utilities` permission and the server check at `/api/utilities/access`, including revocation and account switching. Sidebar visibility alone cannot authorize a workspace.
- Ordinary JSON/XML, image and QR documents persist through authorized utility APIs and private inventoried storage, scoped by account and owner. Tabs may close without deleting documents; leaving a tool saves its state and releases heavy resources. Account/session changes clear in-memory content.
- Never put utility content in shared browser persistence, URLs, logs, telemetry or Eros context. Only utility persistence APIs carry document payloads. Autosave and background traffic never manufacture user activity.
- Private keys and symmetric secrets persist only in the encrypted server vault, protected by a dedicated versioned master key. General document configuration stores public options and key references only. Passwords, crypto plaintext and decrypted results remain temporary and out of ordinary autosave and search.
- Use CAS versions and idempotent operation IDs; preserve drafts on conflicts and save failures. Delete objects through a durable, reference-aware cleanup job, including failed-upload orphans. Do not claim physical deletion before checking storage.
- Bundle parsers, editors, workers and QR libraries locally. Scope asynchronous work to its source/version, reject stale completions, and release workers, models, listeners, canvas and object URLs on cancellation or disposal.

## Compact Document Workspace

- Keep every utility within the measured dashboard surface without outer padding. Utilities own account/user-scoped presentation preferences: 68px icon navigation and a closed library by default; never overwrite the ordinary dashboard navigation preference. An opened 224px library docks only when at least 840px remain for work, otherwise it overlays without remounting the editor.
- Use one 44px document header for library, scrollable tabs, New, save/index status and document actions. Show the name once in its tab; keep errors and conflict recovery visible. Put session timing in an on-demand detail.
- Keep a single active-document toolbar without horizontal scrolling. Format, Formatear, Validar, Buscar and Más remain visible; promote complete undo/redo, file, smart/compact and view groups only when measured space permits. Secondary commands and displaced groups appear exactly once in the keyboard-accessible portaled Más menu. Put zoom and panel selection in the compact footer.
- Use distinct Lucide icons, accessible names, meaningful hover/focus labels and visible pressed/disabled states. Controls use real compiled CSS for 32px mouse targets and at least 44px touch targets, with coarse input taking precedence on hybrid devices. Explain format-specific unavailability.
- Panels A and B own independent editable Monaco models, syntax, history, selection, folding and scroll. Hiding/restoring, narrow-mode tabs and comparison must preserve both drafts and reading positions, including the current long-line chunk.
- Apply operations to the active document as one undoable edit. Keep representation, inferred syntax and raw line-ending fidelity coherent through Undo/Redo, copy and download. Plaintext produced by Desescapar exports as `.txt`.
- Store word wrap independently per panel. `Ajustar líneas` and focused-editor `Alt+Z` share the same state. Wrapping changes visual lines only and preserves bytes, undo and selection. Long-line chunk previews keep bounded wrapping with an explained disabled toggle, then restore the panel preference in the full editor.
- Keep editor zoom separate from browser geometry. Provide the visible percentage, 100% reset, A−/A+ and a maximum of 500% (`14 px` default, `70 px` maximum). Ctrl+wheel changes font size only over the focused editor and comparison, with the same shared percentage.
- Preserve focus after operations, repair apply/discard and comparison close, while respecting deliberate focus changes during asynchronous work. Popovers stay within the visual viewport and reposition or dismiss with focus return on reflow.

## Document Integrity And Limits

- Reuse `jsonLimits.ts`, `editorWorkspaceState.ts`, the worker and bounded output helpers. Maximum document/input/output is 60 MiB; 30 MiB is the recommended ordinary size. Repair remains 2 MiB, comparison 5 MiB and nesting 160. Check actual UTF-8 bytes and preserve the original on failure.
- Process whole documents in a cancellable local worker with bounded time. Very long lines use bounded, editable, surrogate-safe chunks mapped to the original revision. Search must cover the entire document, not only the visible chunk. Large documents use simplified highlighting rather than mounting the whole representation as DOM.
- Preserve scalar lexemes, wide integers, exponent/decimal spelling, key order and duplicate keys through JSON formatting and compaction. Warn about duplicates or bounded duplicate checking. JSONC retains comments under its explicit syntax mode.
- Standard JSON formatting places each entry on its own line. Smart formatting is deterministic and idempotent, using the current 100-column budget. It keeps fitting short containers inline and packs adjacent complete scalar fields/items in longer comment-free flat containers. Preserve intact string values and explicit repair. Visual wrapping remains independent.
- Repair produces a reviewable proposal tied to the source version, then applies once on confirmation. Escapar adds one JSON-string layer and Desescapar removes one complete layer.
- Detect UTF-8/UTF-16 BOM and XML encoding declarations; support explicit Windows-1252/ISO-8859-1 selection and explain conflicts. Preserve the prior draft on decoding failure; UTF-8 exports must have a coherent XML declaration and protect signed originals.
- XML uses the local XML 1.0 parser with namespaces. Reject DOCTYPE and external entity loading. Preserve text, attributes, comments, CDATA, processing instructions, mixed content and inherited `xml:space`.
- Structural XML whitespace changes require the explicit option. Detect XML signatures and preserve signed originals. Validate the encoding declaration before a UTF-8 XML download.
- Comparison uses separate read-only models and retains both editing models. Current limits are 5 MiB and 100,000 lines per document with bounded line length. Report timeout/incomplete computation truthfully and restore editing state on exit.

## QR, Image And Cryptography

- QR/image mode and primary action share a compact toolbar. Intake and result headings own their local actions; use 8–12px padding, a roughly 112px empty intake and two columns only from 672px of measured usable width.
- Keep cryptographic operation, algorithm and selected key visible. Reveal secondary formats and help on demand. Vault creation/import and rename/export/CSR/certificate/JWT sections open on demand without losing temporary fields when closed. Preserve the existing boundary that keeps passwords and plaintext out of autosave.
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
- Exercise clipboard denial/native paste, corrupt/oversized images, QR and Base64 round trips, invalid/authentication-failed crypto, and proof that only authorized private utility persistence receives ordinary content. Verify that vault material is encrypted at rest and excluded from generic autosave, search, telemetry and events.
- Session changes also verify global-superadmin enforcement, account isolation, policy snapshots, idle/absolute deadlines and refresh/realtime races.
