# SheetJS CE 0.20.3

Official release vendored for reproducible installs. The npm registry's `xlsx`
0.18.5 is obsolete and does not contain the security corrections in this release.

- Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- Installation documentation: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/
- Retrieved: 2026-09-14
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- License: Apache-2.0; the full upstream LICENSE is included inside the unchanged tarball.
- No install lifecycle scripts or runtime dependencies.

`package-lock.json` additionally pins the tarball's SHA-512 integrity. Docker copies
this directory before `npm ci`; builds never download a floating SheetJS release.
