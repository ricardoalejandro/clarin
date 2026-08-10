# Third-Party Notices

This file indexes notices that must accompany third-party software distributed by Clarin. It contains no credentials or runtime configuration.

## `@excalidraw/excalidraw`

- Distributed version: `0.18.1`
- npm integrity: `sha512-6i5Gt7IDTOH//qa0Z315Ly5iVRhjWpu2whrlQFqkuwrkKUWgRsMk0P5qdE7bpyDpai7jeLeWYkyj1eVAfni1lw==`
- Upstream source: <https://github.com/excalidraw/excalidraw/tree/v0.18.1>
- Editor license: MIT, Copyright (c) 2020 Excalidraw
- Canonical component notice and current advisory record: [`frontend/THIRD_PARTY_EXCALIDRAW.md`](frontend/THIRD_PARTY_EXCALIDRAW.md)

The frontend build copies 234 WOFF2 files, approximately 14 MB, without modification from the exact npm artifact into `frontend/public/vendor/whiteboards-editor/0.18.1/fonts`. It distributes these families:

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

The `0.18.1` npm tarball packages those fonts without separate font notice files. Clarin therefore distributes the reconciled per-family copyright and Reserved Font Name notices in [`frontend/third_party/excalidraw/FONT-NOTICES.md`](frontend/third_party/excalidraw/FONT-NOTICES.md), together with the complete [`OFL-1.1.txt`](frontend/third_party/excalidraw/OFL-1.1.txt) and [`COMIC-SHANNS-MIT.txt`](frontend/third_party/excalidraw/COMIC-SHANNS-MIT.txt) license texts. The preparation step copies those files beside the versioned runtime assets. Preserve the upstream font files unmodified and keep these notices in every distributed artifact.

This notice covers the public MIT-licensed Excalidraw project only. It grants no rights to Excalidraw Plus, proprietary source or services, trademarks, or assets absent from the public license.

## Reproducible Excalidraw dependency inventory

The exact runtime/optional/peer closure rooted at `@excalidraw/excalidraw@0.18.1` is defined by `frontend/package-lock.json` and audited through [the machine-readable supply-chain baseline](.codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json). The deterministic CycloneDX 1.6 inventory contains 251 components and has SHA-256 `ccaff4aa10097781f229b8c5f87f187a81e5198d01d20249abdeb6f60c3fc9e6`.

Generate and verify it without contacting a third-party service:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline .codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

The npm lock omits license fields for `fuzzy@0.1.3` and `khroma@2.1.0`; the baseline records their MIT license-file locations and SHA-256 evidence, which the generator checks against installed material. The SBOM is an inventory and does not replace copyright/license texts that must accompany distributed components. The current advisory status and production decision are recorded in [`frontend/THIRD_PARTY_EXCALIDRAW.md`](frontend/THIRD_PARTY_EXCALIDRAW.md) and [the supply-chain gate](.codex/skills/clarin-excalidraw-development/references/supply-chain.md).

## `fractional-indexing`

- Distributed version: `3.2.0`
- npm integrity: `sha512-PcOxmqwYCW7O2ovKRU8OoQQj2yqTfEB/yeTYk4gPid6dN5ODRfU1hXd9tTVZzax/0NkO7AxpHykvZnT1aYp/BQ==`
- Upstream source: <https://github.com/rocicorp/fractional-indexing/tree/v3.2.0>
- License: CC0 1.0 Universal (`CC0-1.0`; no rights reserved)

Excalidraw `0.18.1` uses this exact package to generate fractional ordering keys. Clarin's backend ports the same key-generation rules for canonical scene reconciliation, and the differential golden generator imports the exact installed `3.2.0` source after verifying its SHA-256. CC0 applies to that fractional-indexing implementation; Excalidraw's surrounding reconciliation and index-grouping code remains under the Excalidraw MIT notice above.
