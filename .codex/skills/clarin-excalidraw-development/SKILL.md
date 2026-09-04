---
name: clarin-excalidraw-development
description: Use when analyzing, designing, implementing, reviewing, testing, or updating Excalidraw-powered whiteboards in Clarin, including the editor package or fork, document and folder storage, revisions, assets, import/export, sharing, collaboration, offline behavior, format compatibility, licensing, upstream release audits, and proof that the whiteboard makes no unauthorized external connections. Enforces Clarin ownership of product data and UI, account isolation, exact upstream pinning, a minimal auditable fork, immutable recovery, and staged production verification.
---

# Clarin Excalidraw Development

Treat Excalidraw as an audited MIT-licensed editor engine inside a Clarin-owned product. Keep Clarin authoritative for identity, folders, documents, permissions, revisions, media, collaboration, sharing, audit, and network policy.

## Start With Scope And Evidence

1. Read the repository `AGENTS.md` and preserve unrelated dirty work.
2. Identify whether the request is analysis, implementation, an upstream upgrade, data repair, collaboration, or deployment.
3. Record the exact installed package version or fork commit, lockfile integrity, local patch queue, document format versions, and runtime network policy. Do not infer them from an earlier report.
4. Trace any implementation vertically through editor state, API, authorization, persistence, MinIO, WebSocket or collaboration transport, and rendered reconciliation.
5. Never deploy unless the user explicitly requests deployment.

## Load Only The Needed References

- Read [upstream-map.md](references/upstream-map.md) before choosing upstream code, auditing a release, or changing the fork boundary.
- Read [architecture.md](references/architecture.md) before designing or changing documents, folders, permissions, assets, sharing, or collaboration.
- Read [format-compatibility.md](references/format-compatibility.md) before changing serialization, import/export, revisions, migrations, or editor versions.
- Read [egress-policy.md](references/egress-policy.md) before changing fonts, libraries, embeds, AI, help links, analytics, CSP, or any network behavior.
- Read [supply-chain.md](references/supply-chain.md) before auditing packages, licenses, SBOMs, advisories, release evidence, or a GO/NO-GO decision.
- Read [upgrade-runbook.md](references/upgrade-runbook.md) completely for every upstream upgrade.

Also read every applicable Clarin layer skill before editing: frontend, interface design, backend, database, storage, and quality assurance. Collaboration normally requires all six. This skill adds Excalidraw-specific constraints; it does not replace those skills.

## Preserve The Integration Boundary

- Consume an exact stable `@excalidraw/excalidraw` release or an exact internal artifact built from a narrow fork of the editor package. Never track `master`, `next`, a floating Git ref, `latest`, `^`, or `~` in production.
- Do not embed or vendor the complete `excalidraw-app`. It includes product-specific cloud, sharing, analytics, and Firebase integration that Clarin must not inherit.
- Do not copy proprietary Excalidraw Plus behavior or source. Reimplement desired workspace capabilities against Clarin contracts.
- Keep fork patches minimal, explained, tested, and mapped to upstream paths. Prefer host-provided menus, persistence, and collaboration hooks before patching upstream.
- Keep legal attribution in `THIRD_PARTY_NOTICES.md` and compiled distribution notices without exposing third-party branding as Clarin product navigation.

## Enforce Product And Data Truth

- Scope every folder, document, revision, share, asset, presence session, and authorization decision by `account_id`.
- Persist canonical scenes and immutable revisions through Clarin. Store binary assets under account-prefixed MinIO keys represented by `media_assets` and `storage_objects`; never treat browser IndexedDB or a provider link as canonical storage.
- Preserve exact editor package or fork version with each saved revision. Use optimistic concurrency and return an explicit conflict instead of silent last-write-wins.
- Derive document and collaboration permissions on the server. Ignore client-supplied account IDs, room membership, roles, and broadcast targets.
- Treat public sharing as a separate, explicit capability using hashed high-entropy tokens, expiry, revocation, read/edit separation, and audit.
- Reuse upstream restore and serialization APIs behind a Clarin adapter. Never hand-edit unknown Excalidraw fields or destructively rewrite all stored scenes during an upgrade.

## Audit Upstream Changes

Use a temporary directory and never run candidate lifecycle scripts. Inspect only an official stable package/tag and record its version, integrity, commit, license, public exports, peer dependencies, asset manifest, network literals, advisories, and relevant source diff.

Run the bundled tools from the repository root:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/audit-upstream-release.mjs \
  --candidate /tmp/excalidraw-candidate/package \
  --current /tmp/excalidraw-current/package \
  --expected-version 0.0.0 \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --tarball /tmp/excalidraw-candidate/excalidraw-0.0.0.tgz \
  --expected-integrity sha512-OFFICIAL_NPM_VALUE \
  --upstream-root /tmp/excalidraw-v0.0.0 \
  --expected-tag v0.0.0 \
  --expected-commit 0000000000000000000000000000000000000000

node .codex/skills/clarin-excalidraw-development/scripts/verify-third-party-notices.mjs \
  --notices THIRD_PARTY_NOTICES.md \
  --package /tmp/excalidraw-candidate/package

node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline .codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

Replace every placeholder with values independently resolved from official npm
metadata and the official Git tag; never copy a version, integrity or commit
from this skill as current truth. Download the tarball with lifecycle scripts
disabled. Refresh the advisory snapshot on the decision day; a matching stored
SBOM does not make a stale vulnerability scan current. A non-zero result is a
release blocker until explained and resolved.

## Prove Compatibility And Isolation

Run the historical fixture corpus through the Clarin adapter before approving an upgrade:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/run-compat-fixtures.mjs \
  --fixtures .codex/skills/clarin-excalidraw-development/assets/compat-fixtures/v0.18.1

node .codex/skills/clarin-excalidraw-development/scripts/run-compat-fixtures.mjs \
  --fixtures .codex/skills/clarin-excalidraw-development/assets/compat-fixtures/v0.18.1 \
  --adapter .codex/skills/clarin-excalidraw-development/scripts/clarin-v0.18.1-compat-adapter.mjs

npm --prefix frontend run test:whiteboards:compat
npm run test:whiteboards:egress

node .codex/skills/clarin-excalidraw-development/scripts/scan-visible-branding.mjs \
  --root frontend/public/vendor/whiteboards-editor/0.18.1-clarin.6 \
  --snapshot /tmp/clarin-whiteboard-visible-branding.json \
  --policy .codex/skills/clarin-excalidraw-development/references/visible-branding-policy.json
```

Replace the fixture/adapter version only as part of an explicit upstream upgrade. The first pass proves the raw corpus, the second proves Clarin's canonical file cycle, the frontend test calls the installed upstream restore/serialization APIs, and the Playwright gate captures every HTTP/WebSocket attempt while exercising two sessions, lost ACK recovery, reconnection, fanout, and revocation.

Verify the server reconciliation port against the committed JavaScript oracle.
For an upstream audit or upgrade, pass the extracted exact tag checkout so the
tool also verifies source hashes and re-imports every upstream ordering case:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/verify-reconcile-goldens.mjs \
  --upstream-root /tmp/excalidraw-vX.Y.Z
```

Regenerate with `--write` only after deliberately auditing changed
`reconcile.ts`, `fractionalIndex.ts`, their tests, and the exact
`fractional-indexing` version/license. A changed golden is an upgrade decision,
not an automatic formatting step.

Scan built output, captured browser traffic, and the visible UI snapshot, not
source alone:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/scan-runtime-egress.mjs \
  --root frontend/.next/static \
  --trace /tmp/whiteboard-network-trace.json \
  --strict \
  --allow-origin https://clarin.example.invalid
```

Use the real Clarin origin during verification. Exercise every bundled font, images, import/export, libraries, help shortcuts, embeds, sharing, and collaboration. Fail on attempted unauthorized traffic even when the request was blocked.

## Require A Release Decision

Before merging an integration or upgrade, produce a GO or NO-GO report containing:

- exact current and candidate versions/commits/integrities;
- upstream and local patch diff summary;
- format and fixture results;
- static and runtime egress results;
- SBOM and license/asset notice changes;
- unit, type, build, browser, security, and collaboration results appropriate to scope;
- migration, canary, observability, and exact rollback plan;
- unresolved provider, browser, session, or deployment limitations.

Treat a reachable unremediated high/critical advisory, missing license evidence,
stale scan, or supply-chain digest drift as NO-GO unless an authorized security
owner explicitly accepts the exact scoped risk. Keep the engine-only decision
separate from the whole Clarin frontend audit: either can block production.

Never turn a successful build into a claim of compatibility, isolation, migration, or runtime health.
