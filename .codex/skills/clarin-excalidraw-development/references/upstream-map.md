# Excalidraw Upstream Map

## Trust Boundary

Use only the official project and documentation as upstream truth:

- Repository: <https://github.com/excalidraw/excalidraw>
- Stable releases: <https://github.com/excalidraw/excalidraw/releases>
- Package: <https://www.npmjs.com/package/@excalidraw/excalidraw>
- Developer documentation: <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation>
- MIT license: <https://github.com/excalidraw/excalidraw/blob/master/LICENSE>
- Example collaboration relay: <https://github.com/excalidraw/excalidraw-room>

Do not use blog posts, copied tarballs, unofficial Docker images, `master`, or an npm dist-tag as an immutable release identity. Resolve a stable semantic version to its official tag, package integrity, tarball URL, and commit each time.

## Source Areas

| Upstream area | Purpose | Clarin rule |
| --- | --- | --- |
| `packages/excalidraw` | Embeddable React editor and public API | Preferred integration boundary; audit exports, types, UI options, fonts, constants, and serialization |
| `packages/excalidraw/fonts` | Font declarations and packaged assets | Self-host every required asset and audit its individual license and fallback URLs |
| `packages/excalidraw/data` | Restore, serialize, import/export, file handling | Wrap through the Clarin adapter; include in format fixtures |
| `packages/excalidraw/components` | Menus, dialogs, help, libraries, embeds, UI | Audit external links and product branding; patch only where host configuration cannot disable behavior |
| `excalidraw-app` | Public hosted application | Reference behavior only; never embed or vendor as the Clarin application |
| `excalidraw-app/collab` | Hosted app collaboration client | Study protocol behavior but replace identity, authorization, persistence, and endpoints |
| `excalidraw-app/data/firebase.ts` | Hosted persistence integration | Forbidden in Clarin runtime |
| `.env.production` | Hosted app service endpoints | Treat as an outbound-domain discovery source, never as Clarin configuration |
| `excalidraw-room` | Example Socket.IO relay | Do not deploy unmodified; it is not Clarin authorization or persistence |

## Open Source Versus Hosted Product

The MIT editor can be modified and used commercially when the copyright and license notice is retained. Excalidraw Plus features and source that are absent from the public repository are not granted by the MIT repository license. Build folders, access control, revision history, guest links, audit, and team workflows as Clarin features instead of reproducing proprietary source or assets.

## Known Upgrade Watchpoints

Inspect these on every release even when the changelog looks unrelated:

- React and React DOM peer ranges and Next.js client-only integration;
- package exports, CSS entrypoints, worker or WASM assets, and browser globals such as `EXCALIDRAW_ASSET_PATH`;
- font manifests, language fallbacks, CDN fallback behavior, and font licenses;
- `initialData`, `onChange`, `excalidrawAPI`, file APIs, library adapters, menus, collaboration callbacks, and import/export utilities;
- scene and library version constants, restore behavior, element bindings, file IDs, `customData`, frames, arrows, embeds, and Mermaid conversion;
- help links, library browse/publish endpoints, AI endpoints, analytics, error reporting, remote images, embeds, and social links;
- security advisories and fixes that landed after the current exact release.

## Fork Boundary

Prefer, in order:

1. exact upstream package plus a Clarin adapter and custom children;
2. exact private artifact from a narrow fork of `packages/excalidraw` and only required internal workspace packages;
3. a documented temporary patch while converting it into the narrow fork.

Reject a full repository copy, full app fork, floating Git dependency, submodule-dependent deployment, or patches against minified distribution files as the long-term boundary. Keep the fork history connected to upstream, one patch per reason, and an inventory that says why each patch still exists.

## Current Clarin Baseline And Patch Inventory

The implemented baseline is the exact npm artifact
`@excalidraw/excalidraw@0.18.1`, integrity
`sha512-6i5Gt7IDTOH//qa0Z315Ly5iVRhjWpu2whrlQFqkuwrkKUWgRsMk0P5qdE7bpyDpai7jeLeWYkyj1eVAfni1lw==`,
matched to official tag `v0.18.1` at commit
`a2ec2889babf7d2295469c6d90ebe77fae57df84`. Verify those values from the
lockfile, installed artifact and official tag on every audit; this paragraph is
a recorded baseline, not permission to skip verification.

Clarin currently uses an auditable build-time hardening transform instead of
shipping the hosted app or maintaining a broad source fork:

- `frontend/scripts/excalidraw-hardening.mjs` parses the exact package's
  JavaScript AST, neutralizes static external routes/configuration and rejects
  prohibited host literals or malformed network URLs;
- `frontend/scripts/prepare-excalidraw.mjs` checks the exact version, applies
  the deterministic transform, removes source contents from maps, copies local
  fonts/notices and syntax-checks/smoke-bundles the result;
- `frontend/scripts/verify-excalidraw-build.mjs` scans the transformed package,
  Next server/static output and local editor assets after a production build;
- Clarin-provided `MainMenu`, `UIOptions`, inert embed renderer, link handler,
  route CSP and whiteboard CSS replace or hide product controls that the public
  API cannot fully remove.

The scripts are the reviewable patch source; mutated `node_modules` and `.next`
files are disposable build output and must never be committed as the patch.
The transform is intentionally restricted to the exact recorded artifact and
fails closed on version drift. During an upstream upgrade, diff every AST
replacement and UI/CSS selector against the candidate source. Prefer deleting
a transform when a verified public API can enforce the same boundary. If the
transform becomes broad or brittle, move only `packages/excalidraw` and its
required internal dependencies to a narrow source-connected fork before the
upgrade can be GO.
