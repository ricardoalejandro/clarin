# Excalidraw Format Compatibility

## Version Every Layer

Record these independently on every immutable revision:

- Clarin document schema version;
- Excalidraw scene format version found in the serialized envelope;
- exact `@excalidraw/excalidraw` version or internal fork commit/artifact digest;
- Clarin adapter version;
- asset manifest version.

The scene format number is not the npm package version and may remain unchanged across releases with meaningful element changes. Never select a migrator from the scene number alone.

## Canonical Envelope

Preserve the upstream serialized envelope and its unknown fields. At minimum, expect `type`, `version`, `source`, `elements`, `appState`, and `files`, while allowing upstream to extend the structure. Keep binary bytes out of database-mode JSON; reference the account-scoped asset manifest instead.

Use the public upstream restore/load/serialize APIs through one Clarin adapter. Do not spread direct Excalidraw imports across product code and do not normalize stored JSON with ad hoc object reconstruction.

## Read, Upgrade, And Save

1. Keep the stored revision immutable.
2. Select the reader by recorded editor and adapter versions.
3. Parse with bounded size and depth before handing data to the editor.
4. Restore into the candidate editor without persisting.
5. Validate element IDs, types, bindings, group/frame/container relationships, file references, `customData`, and unknown extension data.
6. Save only after a successful user edit or an explicit, tested migration.
7. Write a new revision with the candidate versions; retain the previous revision for exact rollback.

Prefer lazy normalization on successful open/save. Use an offline backfill only when lazy compatibility is impossible, and make that backfill account-scoped, resumable, idempotent, audited, reversible, and based on immutable source revisions.

## Fixture Corpus

Keep de-identified fixtures for every editor artifact released by Clarin and every supported feature:

- text, free draw, shapes, groups, locks, deleted elements, and ordering;
- arrows, bindings, bound text, containers, frames, and nested relationships;
- images and multiple file states, duplicate hashes, missing assets, and Unicode filenames;
- every bundled font, CJK/RTL/emoji text, multiline content, and locale-sensitive state;
- links, internal links, libraries, Mermaid-generated content, embeds when allowed, and `customData`;
- large but valid scenes near accepted limits;
- malformed, oversized, hostile, legacy, and partially recovered scenes.

Fixtures must contain synthetic data only. Store the expected critical projection and originating versions beside each fixture.

Run `scripts/run-compat-fixtures.mjs` first in structural mode and then with the version-matched Clarin persistence adapter. Scene fixtures use `.excalidraw`; library fixtures use `.excalidrawlib`. An adapter used with both must export a scene and a library function:

```js
export async function roundTripScene(scene, context) {
  return scene;
}

export async function roundTripLibrary(library, context) {
  return library;
}
```

`normalizeScene`/`normalizeLibrary` remain accepted aliases. The runner checks unique item/element IDs, referenced files, an exact Clarin `fileIds`/`files` manifest when present, preservation of critical identity, relationships, links, `customData`, and opaque root/element extensions, plus second-pass idempotence. File metadata survives while `dataURL`, `url`, and `src` bytes/transport locations do not enter canonical JSON. Canonical appState follows Excalidraw 0.18.1 server persistence exactly: only `gridSize`, `gridStep`, `gridModeEnabled`, and `viewBackgroundColor` survive; theme, frame rendering preferences, viewport, selection, dialogs, collaborators, and unknown editor state do not. Frames themselves remain elements.

Run the frontend compatibility test after both structural passes. It uses the exact installed upstream `loadFromBlob`, `serializeAsJSON`, `loadLibraryFromBlob`, and `serializeLibraryAsJSON` APIs for open-edit-save-export-reopen coverage. Then run the Playwright isolation gate; JSON preservation alone cannot prove visual fidelity, collaboration recovery, or network isolation.

The backend reconciliation corpus lives at
`backend/internal/whiteboard/testdata/reconcile_v0.18.1_golden.json`. It records
the exact upstream source hashes, all upstream `reconcileElements()` ordering
cases, edge cases for versions/nonces and malformed fractional order, unknown
properties, and forward/reverse/re-reconciliation results. Verify it with
`scripts/verify-reconcile-goldens.mjs`. The oracle injects deterministic values
only for upstream's random `versionNonce` and wall-clock `updated` side effects;
production reconciliation retains fresh nonce/time semantics, while import and
snapshot normalization uses a stable representation for idempotent hashing.
The comparison domain is a valid Excalidraw scene: Clarin deliberately rejects
duplicate element IDs, missing/negative/unsafe numeric version fields, and
malformed JSON before reconciliation instead of relying on typed-client
assumptions or silently deduplicating corrupt input.

## Import And Export

Treat `.excalidraw` and library imports as untrusted user data. Bound decompression, JSON size, nesting, element count, strings, data URLs, and asset sizes. Validate remote URLs against the egress policy; strict mode rejects them. Sanitize SVG and Mermaid-derived output using the audited upstream path and current security advisories.

Raster/PDF/SVG exports are derivatives, not the canonical editable document. Record their source revision and regenerate rather than letting them replace scene truth.

## Failure And Rollback

An upgrade is incompatible when a supported fixture cannot open, critical data disappears, a second normalize/save changes the scene again, an asset reference crosses accounts, or visual/browser tests differ without an approved reason. Block release, keep the prior exact artifact deployable, and leave stored revisions untouched.
