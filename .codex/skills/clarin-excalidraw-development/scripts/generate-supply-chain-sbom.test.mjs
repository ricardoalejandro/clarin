import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSbom, canonicalJson, renderSbom, run } from "./generate-supply-chain-sbom.mjs";

function integrity(seed) {
  return `sha512-${createHash("sha512").update(seed).digest("base64")}`;
}

function fixture() {
  const manifest = { dependencies: { "@excalidraw/excalidraw": "0.18.1" } };
  const lockfile = {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/@excalidraw/excalidraw": {
        version: "0.18.1",
        resolved: "https://registry.npmjs.org/@excalidraw/excalidraw/-/excalidraw-0.18.1.tgz",
        integrity: integrity("editor"),
        license: "MIT",
        dependencies: { foo: "1.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
      "node_modules/@excalidraw/excalidraw/node_modules/foo": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",
        integrity: integrity("nested-foo"),
        license: "MIT",
        optionalDependencies: { absent: "1.0.0" },
      },
      "node_modules/foo": {
        version: "9.0.0",
        resolved: "https://registry.npmjs.org/foo/-/foo-9.0.0.tgz",
        integrity: integrity("wrong-foo"),
        license: "MIT",
      },
      "node_modules/react": {
        version: "18.3.1",
        resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
        integrity: integrity("react"),
        license: "MIT",
        dependencies: { "loose-envify": "^1.1.0" },
      },
      "node_modules/loose-envify": {
        version: "1.4.0",
        resolved: "https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz",
        integrity: integrity("loose-envify"),
        license: "MIT",
      },
    },
  };
  return { manifest, lockfile };
}

function baseline(rootIntegrity, advisories = []) {
  return {
    schemaVersion: 1,
    root: {
      name: "@excalidraw/excalidraw",
      version: "0.18.1",
      integrity: rootIntegrity,
    },
    audit: {
      observedAt: "2026-08-09",
      command: "npm audit --omit=dev --json",
      frontendSummary: { total: advisories.length },
    },
    advisories,
  };
}

test("builds the exact npm runtime/optional/peer closure and prefers the nearest lock path", () => {
  const { manifest, lockfile } = fixture();
  const document = buildSbom({ manifest, lockfile });
  assert.equal(document.metadata.component.name, "@excalidraw/excalidraw");
  assert.deepEqual(
    document.components.map(({ name, version }) => `${name}@${version}`).sort(),
    ["foo@1.0.0", "loose-envify@1.4.0", "react@18.3.1"],
  );
  assert.ok(!document.components.some(({ name, version }) => name === "foo" && version === "9.0.0"));
  assert.equal(document.metadata.properties.some(({ name }) => name === "clarin:generated-at"), false);
});

test("binds a vendored fork to its file spec, source hash and upstream commit", () => {
  const { manifest, lockfile } = fixture();
  const npmRoot = lockfile.packages["node_modules/@excalidraw/excalidraw"];
  manifest.dependencies["@excalidraw/excalidraw"] = "file:vendor/excalidraw";
  lockfile.packages["node_modules/@excalidraw/excalidraw"] = {
    resolved: "vendor/excalidraw",
    link: true,
  };
  lockfile.packages["vendor/excalidraw"] = {
    ...npmRoot,
    version: "0.18.1-clarin.1",
    resolved: undefined,
    integrity: undefined,
  };
  const sourceSha256 = "b".repeat(64);
  const vendoredBaseline = {
    ...baseline(npmRoot.integrity),
    root: {
      name: "@excalidraw/excalidraw",
      version: "0.18.1-clarin.1",
      source: {
        type: "vendored",
        manifestSpec: "file:vendor/excalidraw",
        lockPath: "vendor/excalidraw",
        treePath: "vendor/excalidraw",
        sha256: sourceSha256,
        upstreamTag: "v0.18.1",
        upstreamCommit: "a".repeat(40),
      },
    },
  };
  const document = buildSbom({ manifest, lockfile, baseline: vendoredBaseline });
  assert.equal(document.metadata.component.version, "0.18.1-clarin.1");
  assert.deepEqual(document.metadata.component.hashes, [{ alg: "SHA-256", content: sourceSha256.toUpperCase() }]);
  assert.equal(document.metadata.component.properties.find(({ name }) => name === "clarin:upstream:commit").value, "a".repeat(40));
  assert.throws(
    () => buildSbom({
      manifest: { dependencies: { "@excalidraw/excalidraw": "file:vendor/other" } },
      lockfile,
      baseline: vendoredBaseline,
    }),
    /manifest spec does not match/,
  );
});

test("is byte-for-byte deterministic when lockfile object order changes", () => {
  const { manifest, lockfile } = fixture();
  const reordered = {
    ...lockfile,
    packages: Object.fromEntries(Object.entries(lockfile.packages).reverse()),
  };
  assert.equal(renderSbom({ manifest, lockfile }), renderSbom({ manifest, lockfile: reordered }));
});

test("embeds curated advisories and rejects an affected component absent from the closure", () => {
  const { manifest, lockfile } = fixture();
  const rootIntegrity = lockfile.packages["node_modules/@excalidraw/excalidraw"].integrity;
  const advisory = {
    id: "GHSA-aaaa-bbbb-cccc",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    severity: "high",
    affects: [{ name: "foo", versions: ["1.0.0"] }],
    analysisState: "not_affected",
    justification: "code_not_reachable",
    detail: "The vulnerable entry point is disabled and covered by a runtime reachability gate.",
  };
  const document = buildSbom({ manifest, lockfile, baseline: baseline(rootIntegrity, [advisory]) });
  assert.equal(document.vulnerabilities[0].id, advisory.id);
  assert.match(document.vulnerabilities[0].affects[0].ref, /^npm:foo@1\.0\.0:/);

  const missing = { ...advisory, affects: [{ name: "foo", versions: ["9.0.0"] }] };
  assert.throws(
    () => buildSbom({ manifest, lockfile, baseline: baseline(rootIntegrity, [missing]) }),
    /names absent component foo@9\.0\.0/,
  );
});

test("rejects a floating editor manifest spec", () => {
  const { lockfile } = fixture();
  assert.throws(
    () => buildSbom({ manifest: { dependencies: { "@excalidraw/excalidraw": "^0.18.1" } }, lockfile }),
    /must be an exact production dependency/,
  );
});

test("requires hashed license evidence when npm lock metadata omits a license", () => {
  const { manifest, lockfile } = fixture();
  delete lockfile.packages["node_modules/@excalidraw/excalidraw/node_modules/foo"].license;
  assert.throws(() => buildSbom({ manifest, lockfile }), /foo@1\.0\.0 has no lockfile license/);

  const rootIntegrity = lockfile.packages["node_modules/@excalidraw/excalidraw"].integrity;
  const withOverride = baseline(rootIntegrity);
  withOverride.licenseOverrides = [{
    name: "foo",
    version: "1.0.0",
    expression: "MIT",
    lockPath: "node_modules/@excalidraw/excalidraw/node_modules/foo",
    licenseFile: "LICENSE",
    sha256: "a".repeat(64),
  }];
  const document = buildSbom({ manifest, lockfile, baseline: withOverride });
  assert.equal(document.components.find(({ name }) => name === "foo").licenses[0].expression, "MIT");
});

test("CLI contract verifies an archived SBOM byte-for-byte and fails closed on drift", () => {
  const directory = mkdtempSync(join(tmpdir(), "clarin-excalidraw-sbom-"));
  const { manifest, lockfile } = fixture();
  const manifestPath = join(directory, "package.json");
  const lockfilePath = join(directory, "package-lock.json");
  const sbomPath = join(directory, "engine.cdx.json");
  writeFileSync(manifestPath, canonicalJson(manifest));
  writeFileSync(lockfilePath, canonicalJson(lockfile));

  assert.equal(run(["--manifest", manifestPath, "--lockfile", lockfilePath, "--output", sbomPath]), 0);
  assert.equal(run(["--manifest", manifestPath, "--lockfile", lockfilePath, "--verify", sbomPath, "--output", join(directory, "verified.json")]), 0);

  writeFileSync(sbomPath, `${readFileSync(sbomPath, "utf8")} `);
  assert.equal(run(["--manifest", manifestPath, "--lockfile", lockfilePath, "--verify", sbomPath, "--output", join(directory, "drifted.json")]), 2);
});
