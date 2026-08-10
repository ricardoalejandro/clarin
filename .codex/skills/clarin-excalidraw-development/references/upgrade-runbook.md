# Excalidraw Upgrade Runbook

## 1. Establish The Baseline

1. Read `AGENTS.md`, this skill, and every affected layer skill.
2. Confirm scope: audit only, implementation, release preparation, or deployment.
3. Record current package spec, lockfile integrity, fork commit/artifact digest, adapter version, source patch inventory, SBOM, notices, CSP, fixture baseline, and last known-good image.
4. Confirm the worktree state and preserve unrelated changes.
5. Stop if the current artifact cannot be reproduced exactly.

## 2. Resolve An Official Candidate

Use the official npm registry and GitHub release/tag. Select an exact stable semantic version; reject `latest`, `next`, prerelease, branch, or unpinned Git dependencies unless the user explicitly requested a prerelease evaluation.

Record:

- package name and exact version;
- `dist.integrity`, tarball URL, npm provenance when available, and package `gitHead`;
- official release/tag commit and publication date;
- license files, dependency lock/material, and security advisories.

Download to a fresh temporary directory with lifecycle scripts disabled. Do not execute the candidate build scripts merely to inspect the tarball.

## 3. Audit Package And Source

Extract current and candidate packages in temporary directories, then run:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/audit-upstream-release.mjs \
  --candidate /tmp/excalidraw-candidate/package \
  --current /tmp/excalidraw-current/package \
  --expected-version X.Y.Z \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --tarball /tmp/excalidraw-candidate/excalidraw-X.Y.Z.tgz \
  --expected-integrity sha512-OFFICIAL_NPM_VALUE \
  --upstream-root /tmp/excalidraw-vX.Y.Z \
  --expected-tag vX.Y.Z \
  --expected-commit FULL_OFFICIAL_TAG_COMMIT \
  --json /tmp/excalidraw-audit.json
```

Review blockers and warnings. Independently diff the official tag against the current tag for every path listed in `upstream-map.md`. Compare public exports/types, CSS/assets, peer dependencies, serialization, restore, UI, collaboration protocol, security-sensitive parsing/export, and all local fork patches.

For each local patch, decide: remove because upstream solved it, rebase unchanged, redesign against a new public hook, or block. Never carry a patch forward without rereading its new upstream context.

If `data/reconcile.ts`, `fractionalIndex.ts`, their upstream tests, or
`fractional-indexing` changed, run the differential oracle before touching the
Go port:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/verify-reconcile-goldens.mjs \
  --upstream-root /tmp/excalidraw-candidate
```

Source-hash drift is an expected blocker for a new version. Audit the semantic
diff, update the minimal oracle and Go port together, record any dependency
license change, then regenerate with `--write` and review the golden diff.

## 4. Audit Licenses And Supply Chain

Read `supply-chain.md`. Generate the deterministic CycloneDX 1.6 SBOM from the
exact npm lock and installed material using the repository-owned, dependency-free
generator:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline .codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

For a candidate, first create a reviewed candidate baseline with exact identity,
fresh advisories and hashed evidence for any license omitted from npm lock
metadata. Never silence digest drift by copying the new hash before reviewing
the component/license/advisory diff. Archive the SBOM, baseline, package
integrity, audit report, fork commit, font/asset manifest and build digest
together. Use `--verify <archived.cdx.json>` for byte-for-byte release evidence.

On the release-decision day, run `npm audit --omit=dev --json` against the exact
lock and query OSV and GitHub advisories. Record both the Excalidraw-rooted closure
and the whole frontend graph. Classify findings as enabled engine runtime,
disabled engine path, build-only engine material, or inherited non-engine
frontend baseline. An engine-only mitigation cannot silently waive the inherited
baseline, but unrelated pre-existing findings receive a separate explicit manual
release decision instead of being misreported as introduced by Pizarras. Review
runtime/optional/peer material separately from build-only tooling. A clean
scanner does not replace manual review of nanoid call sites, parsing,
SVG/Mermaid, embeds, URLs, files, collaboration messages and postMessage
behavior.

Update `THIRD_PARTY_NOTICES.md` for every distributed dependency or asset and run:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/verify-third-party-notices.mjs \
  --notices THIRD_PARTY_NOTICES.md \
  --package /tmp/excalidraw-candidate/package
```

The SBOM is not a replacement for copyright and license notices. Missing
license metadata or unverified license-file hashes are release blockers.

## 5. Update In A Reviewable Change

Pin the exact package or private artifact and lockfile integrity. Keep the Clarin adapter as the single product boundary. Rebase the minimal fork as individual explained commits. Do not edit generated/minified distribution files as the source of truth.

Do not combine an upstream upgrade with unrelated whiteboard features, bulk scene migration, or broad visual redesign. Add a focused unit test for each changed contract.

## 6. Verify Compatibility

Run structural and adapter-backed historical fixtures:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/run-compat-fixtures.mjs \
  --fixtures path/to/fixtures \
  --adapter path/to/adapter.mjs \
  --json /tmp/excalidraw-compat.json
```

Then render representative fixtures and compare behavior visually. Test open, edit, save, reopen, conflict, rollback, import, export, missing assets, old revisions, large scenes, every shipped font, and supported browsers. Never overwrite the fixture sources.

Run `verify-reconcile-goldens.mjs` again after the port change, followed by the
Go `internal/whiteboard` tests. A corpus mismatch or loss of bidirectional
convergence is a NO-GO even when document round trips still pass.

## 7. Prove No Unauthorized Egress

Build the real production bundle. Run the static and trace scanner using exact controlled origins, exercise all paths in `egress-policy.md`, enforce CSP, and repeat with outbound networking denied:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/scan-runtime-egress.mjs \
  --root frontend/.next/static \
  --trace /tmp/whiteboard-network-trace.json \
  --strict \
  --allow-origin https://clarin.example.invalid \
  --json /tmp/excalidraw-egress.json
```

## 8. Complete Product Verification

Run the nearest unit tests plus the mandatory Clarin frontend, backend, database, storage, browser, and collaboration checks for the layers actually changed. Test success, loading, empty, offline, disabled, permission, validation, quota, conflict, cancellation, rollback, retry, and canonical realtime reconciliation.

Run the supply-chain script tests and regenerate the baseline-bound SBOM:

```bash
node --test .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.test.mjs
node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline .codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

Do not claim runtime health from local tests. If deployment was explicitly requested, follow the repository deployment and post-deploy verification rules exactly.

## 9. Decide And Roll Back

Write a GO or NO-GO report with evidence paths, fresh scan date, engine and
whole-frontend advisory decisions, known differences, unresolved risks,
migration need, canary scope, metrics/logs and approver. Reachable unremediated
high/critical findings, stale scans, missing legal evidence or SBOM drift are
NO-GO unless the authorized security owner explicitly approves the exact scoped
exception. Require manual approval before production promotion.

Keep the last-known-good exact artifact, lockfile, adapter, CSP, and database-compatible code deployable. Roll back application artifacts before considering data repair. Because source revisions are immutable and lazy-normalized, rollback must not require destructive scene downgrade.
