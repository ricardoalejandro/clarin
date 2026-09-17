# Third-Party Notices

This file indexes notices that must accompany third-party software distributed by Clarin. It contains no credentials or runtime configuration.

## `@excalidraw/excalidraw`

- Distributed version: `0.18.1-clarin.7`
- Vendored source SHA-256: `da5a8d51ecf03dda77fa668954710ee994c8c43d8ba3703fdfbc684df372797a`
- Upstream source: tag `v0.18.1`, commit `a2ec2889babf7d2295469c6d90ebe77fae57df84`
- Editor license: MIT, Copyright (c) 2020 Excalidraw
- Canonical component notice and current advisory record: [`frontend/THIRD_PARTY_EXCALIDRAW.md`](frontend/THIRD_PARTY_EXCALIDRAW.md)

The frontend build serves the audited editor assets from `frontend/public/vendor/whiteboards-editor/0.18.1-clarin.7/`. The selector exposes 32 local families: 7 official selectable families plus 25 Clarin-catalog families represented by 49 independently hashed WOFF2 files. The upstream asset set also contains these licensed families:

| Family | Recorded upstream license |
| --- | --- |
| Assistant | SIL Open Font License 1.1 |
| Cascadia | SIL Open Font License 1.1 |
| ComicShanns | MIT |
| Excalifont | SIL Open Font License 1.1 |
| Liberation Sans | SIL Open Font License 1.1 |
| Lilita | SIL Open Font License 1.1 |
| Nunito | SIL Open Font License 1.1 |
| Virgil | SIL Open Font License 1.1 |
| Xiaolai | SIL Open Font License 1.1 |

The upstream `0.18.1` package does not place separate notices beside every font. Clarin therefore distributes the reconciled upstream notices in [`frontend/third_party/excalidraw/FONT-NOTICES.md`](frontend/third_party/excalidraw/FONT-NOTICES.md), together with the complete [`OFL-1.1.txt`](frontend/third_party/excalidraw/OFL-1.1.txt) and [`COMIC-SHANNS-MIT.txt`](frontend/third_party/excalidraw/COMIC-SHANNS-MIT.txt) texts. Every additional catalog family records its SPDX license, source and file hash in [`frontend/third_party/whiteboard-fonts/catalog.json`](frontend/third_party/whiteboard-fonts/catalog.json), with its exact license text under `frontend/third_party/whiteboard-fonts/licenses/`. The preparation step copies the applicable notices beside the versioned runtime assets.

This notice covers the public MIT-licensed Excalidraw project only. It grants no rights to Excalidraw Plus, proprietary source or services, trademarks, or assets absent from the public license.

## Reproducible Excalidraw dependency inventory

The exact runtime/optional/peer closure rooted at `@excalidraw/excalidraw@0.18.1-clarin.7` is defined by `frontend/package-lock.json` and the [current candidate baseline](frontend/third_party/excalidraw/supply-chain-2026-09-14.json). The [archived CycloneDX 1.6 SBOM](frontend/third_party/excalidraw/excalidraw-0.18.1-clarin.7.cdx.json) contains 248 components and has SHA-256 `f0bc6879b5d913e8f1f7e250c448edb17f1a72d0af491cf0982c28225aebdef2`. It binds the vendored source to the exact upstream tag/commit plus the documented Clarin patches, including the `.7` Mermaid capability boundary and dependency fixes.

Generate and verify it without contacting a third-party service:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline frontend/third_party/excalidraw/supply-chain-2026-09-14.json \
  --verify frontend/third_party/excalidraw/excalidraw-0.18.1-clarin.7.cdx.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

The [fresh audit](docs/security-dependency-audit-after-2026-09-14.json) covers all exact public versions in the final frontend lock, including development dependencies. npm reports zero findings in both scopes; OSV's two SheetJS matches and GitHub's withdrawn esbuild record are preserved and individually explained. The engine closure has no active matched advisory. This is supply-chain evidence, not browser, deployment or runtime approval: production remains **NO-GO pending the final release gates** recorded in the candidate baseline.

The npm lock omits license fields for `fuzzy@0.1.3` and `khroma@2.1.0`; the baseline records their MIT license-file paths and verified SHA-256 hashes. The SBOM does not replace the applicable copyright/license texts.

The [.codex baseline dated 2026-08-29](.codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json) is retained as historical evidence only. Its `0.18.1-clarin.6` identity, 251-component inventory, SHA-256 `ca6a0ae4e12ecc94cd4778a2bae94b5b431c9030756cbd43b9a0966bada8c302` and advisory list do not describe the current candidate. The component notice preserves that historical inventory while explicitly correcting the old assumption that a hidden Mermaid/AI UI prevented clipboard parser execution.

## `@excalidraw/laser-pointer`

- Distributed version: `1.3.1`
- npm integrity: `sha512-psA1z1N2qeAfsORdXc9JmD2y4CmDwmuMRxnNdJHZexIcPwaNEyIpNcelw+QkL9rz9tosaN9krXuKaRqYpRAR6g==`
- License: MIT, Copyright (c) 2023 Excalidraw
- Complete license text: [`frontend/third_party/excalidraw/LASER-POINTER-MIT.txt`](frontend/third_party/excalidraw/LASER-POINTER-MIT.txt)

Clarin uses this exact local package only to generate the outline geometry of
constant-width freehand strokes. It introduces no service integration or
network destination.

## `fractional-indexing`

- Distributed version: `3.2.0`
- npm integrity: `sha512-PcOxmqwYCW7O2ovKRU8OoQQj2yqTfEB/yeTYk4gPid6dN5ODRfU1hXd9tTVZzax/0NkO7AxpHykvZnT1aYp/BQ==`
- Upstream source: <https://github.com/rocicorp/fractional-indexing/tree/v3.2.0>
- License: CC0 1.0 Universal (`CC0-1.0`; no rights reserved)

Excalidraw `0.18.1-clarin.7` uses this exact package to generate fractional ordering keys. Clarin's backend ports the same key-generation rules for canonical scene reconciliation, and the differential golden generator imports the exact installed `3.2.0` source after verifying its SHA-256. CC0 applies to that fractional-indexing implementation; Excalidraw's surrounding reconciliation and index-grouping code remains under the Excalidraw MIT notice above.

## Fabric compatibility adapter

Clarin uses `fabric@7.4.0`. The narrow legacy-gradient adapter derives from Fabric's MIT-licensed `extensions/data_updaters/gradient`; exact provenance, artifact integrity and the complete license are preserved in [frontend/THIRD_PARTY_FABRIC.md](frontend/THIRD_PARTY_FABRIC.md).

## SheetJS Community Edition

Clarin uses the unchanged official `xlsx@0.20.3` tarball, not the obsolete npm-registry release. Its Apache-2.0 license remains inside the vendored distribution. [Provenance and immutable SHA-256](frontend/vendor/sheetjs/README.md) identify the official CDN artifact; `frontend/package-lock.json` additionally fixes its SHA-512 integrity.
