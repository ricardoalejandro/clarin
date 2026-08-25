#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = "@excalidraw/excalidraw";
const GENERATOR_VERSION = "2";

function usage() {
  console.log(`Usage:
  generate-supply-chain-sbom.mjs [options]

Options:
  --manifest FILE       Clarin package.json (default: frontend/package.json)
  --lockfile FILE       npm lockfile v2/v3 (default: frontend/package-lock.json)
  --root PACKAGE        Runtime root (default: @excalidraw/excalidraw)
  --baseline FILE       Curated baseline with exact identity, advisories and digest
  --artifact-root DIR   Installed material root for license evidence (default: lockfile directory)
  --output FILE         Write deterministic CycloneDX JSON instead of stdout
  --verify FILE         Require byte-for-byte equality with an archived SBOM
  --help                Show this help

The output deliberately has no timestamp or random serial number. Exit status is
2 for supply-chain drift and 1 for invalid input.`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = {
    manifest: "frontend/package.json",
    lockfile: "frontend/package-lock.json",
    root: DEFAULT_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--manifest") args.manifest = requiredValue(argv, ++index, token);
    else if (token === "--lockfile") args.lockfile = requiredValue(argv, ++index, token);
    else if (token === "--root") args.root = requiredValue(argv, ++index, token);
    else if (token === "--baseline") args.baseline = requiredValue(argv, ++index, token);
    else if (token === "--artifact-root") args.artifactRoot = requiredValue(argv, ++index, token);
    else if (token === "--output") args.output = requiredValue(argv, ++index, token);
    else if (token === "--verify") args.verify = requiredValue(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${path}: ${error.message}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function directorySha256(root) {
  const hash = createHash("sha256");
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (
        name === ".git" ||
        name === "node_modules" ||
        /(?:^|\/)packages\/excalidraw\/dist\/(?:dev|prod)(?:\/|$)/.test(relativePath)
      ) {
        continue;
      }
      const path = resolve(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Vendored source contains a symbolic link: ${relativePath}`);
      if (info.isDirectory()) walk(path, relativePath);
      else if (info.isFile()) {
        hash.update(`${relativePath}\0${info.mode & 0o111 ? "x" : "-"}\0`);
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`Vendored source directory not found: ${root}`);
  walk(root);
  return hash.digest("hex");
}

function exactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function packageNameFromLockPath(lockPath) {
  const match = lockPath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  return match?.[1] ?? null;
}

function resolveDependency(packages, fromPath, dependencyName) {
  let directory = fromPath;
  while (true) {
    const candidate = posix.normalize(posix.join(directory, "node_modules", dependencyName));
    if (packages[candidate]) return candidate;
    const parent = posix.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function parseIntegrity(value, context) {
  const match = String(value ?? "").match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error(`${context} has no exact sha512 npm integrity`);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0) throw new Error(`${context} has an empty sha512 npm integrity`);
  return { sri: value, hex: bytes.toString("hex").toUpperCase() };
}

function purlFor(name, version) {
  const encodedName = name.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function componentDigest(name, entry) {
  if (entry.clarinSourceSha256) {
    if (!/^[0-9a-f]{64}$/.test(entry.clarinSourceSha256)) throw new Error(`${name}@${entry.version} has an invalid vendored source sha256`);
    return { alg: "SHA-256", content: entry.clarinSourceSha256.toUpperCase(), identity: `sha256-${entry.clarinSourceSha256}` };
  }
  const integrity = parseIntegrity(entry.integrity, `${name}@${entry.version}`);
  return { alg: "SHA-512", content: integrity.hex, identity: integrity.sri };
}

function componentIdentity(name, entry) {
  const digest = componentDigest(name, entry);
  return `${name}\u0000${entry.version}\u0000${digest.identity}`;
}

function componentRef(name, entry) {
  const digest = componentDigest(name, entry);
  return `npm:${name}@${entry.version}:${digest.content.slice(0, 16).toLowerCase()}`;
}

function dependencyNames(entry) {
  const required = new Set(Object.keys(entry.dependencies ?? {}));
  const optional = new Set(Object.keys(entry.optionalDependencies ?? {}));
  const peer = new Set(Object.keys(entry.peerDependencies ?? {}));
  return [...new Set([...required, ...optional, ...peer])].sort().map((name) => ({
    name,
    optional: optional.has(name) || entry.peerDependenciesMeta?.[name]?.optional === true,
  }));
}

function validateBaseline(baseline) {
  if (!baseline || baseline.schemaVersion !== 1) throw new Error("Supply-chain baseline schemaVersion must be 1");
  if (!baseline.root || typeof baseline.root !== "object") throw new Error("Supply-chain baseline has no root identity");
  const source = baseline.root.source;
  if (source) {
    if (source.type !== "vendored") throw new Error("Supply-chain baseline root source type must be vendored");
    for (const field of ["manifestSpec", "lockPath", "treePath", "upstreamTag", "upstreamCommit"]) {
      if (typeof source[field] !== "string" || !source[field]) throw new Error(`Vendored root source has no ${field}`);
    }
    if (!source.manifestSpec.startsWith("file:") || source.lockPath.startsWith("/") || source.lockPath.includes("..") || source.treePath.startsWith("/") || source.treePath.includes("..")) {
      throw new Error("Vendored root source paths are unsafe");
    }
    if (!/^[0-9a-f]{40}$/.test(source.upstreamCommit)) throw new Error("Vendored root source has no exact upstream commit");
    if (!/^[0-9a-f]{64}$/.test(source.sha256)) throw new Error("Vendored root source has no sha256 evidence");
  } else if (typeof baseline.root.integrity !== "string") {
    throw new Error("Supply-chain baseline root has neither npm integrity nor vendored source evidence");
  }
  if (!Array.isArray(baseline.advisories)) throw new Error("Supply-chain baseline advisories must be an array");
  if (!Array.isArray(baseline.licenseOverrides ?? [])) throw new Error("Supply-chain baseline licenseOverrides must be an array");
  const licenseKeys = new Set();
  for (const override of baseline.licenseOverrides ?? []) {
    const key = `${override.name}\u0000${override.version}`;
    if (!override.name || !exactVersion(override.version)) throw new Error("A license override has no exact package identity");
    if (licenseKeys.has(key)) throw new Error(`Duplicate license override for ${override.name}@${override.version}`);
    licenseKeys.add(key);
    if (typeof override.expression !== "string" || override.expression.length === 0) throw new Error(`License override ${override.name}@${override.version} has no expression`);
    if (typeof override.lockPath !== "string" || !override.lockPath.startsWith("node_modules/")) throw new Error(`License override ${override.name}@${override.version} has no lockPath`);
    if (typeof override.licenseFile !== "string" || override.licenseFile.includes("..") || override.licenseFile.startsWith("/")) {
      throw new Error(`License override ${override.name}@${override.version} has an unsafe licenseFile`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(override.sha256 ?? ""))) throw new Error(`License override ${override.name}@${override.version} has no sha256 evidence`);
  }
  const ids = new Set();
  for (const advisory of baseline.advisories) {
    if (!/^GHSA-[0-9a-z-]+$/i.test(String(advisory.id ?? ""))) throw new Error(`Invalid advisory id: ${advisory.id ?? "missing"}`);
    if (ids.has(advisory.id)) throw new Error(`Duplicate advisory id: ${advisory.id}`);
    ids.add(advisory.id);
    if (!/^https:\/\/github\.com\/advisories\/GHSA-/i.test(String(advisory.url ?? ""))) {
      throw new Error(`Advisory ${advisory.id} must use its GitHub Advisory Database URL`);
    }
    if (!["low", "medium", "high", "critical", "unknown"].includes(advisory.severity)) {
      throw new Error(`Advisory ${advisory.id} has invalid severity ${advisory.severity}`);
    }
    if (!Array.isArray(advisory.affects) || advisory.affects.length === 0) {
      throw new Error(`Advisory ${advisory.id} has no affected components`);
    }
    if (!["in_triage", "not_affected", "resolved", "resolved_with_pedigree", "exploitable", "false_positive"].includes(advisory.analysisState)) {
      throw new Error(`Advisory ${advisory.id} has invalid analysisState ${advisory.analysisState}`);
    }
    if (typeof advisory.detail !== "string" || advisory.detail.trim().length < 20) {
      throw new Error(`Advisory ${advisory.id} needs an explicit mitigation/risk detail`);
    }
  }
}

function cyclonedxVulnerabilities(advisories, refsByNameVersion) {
  return advisories
    .map((advisory) => {
      const affected = [];
      for (const item of advisory.affects) {
        for (const version of [...new Set(item.versions ?? [])].sort()) {
          const refs = refsByNameVersion.get(`${item.name}\u0000${version}`) ?? [];
          if (refs.length === 0) throw new Error(`${advisory.id} names absent component ${item.name}@${version}`);
          for (const ref of refs) {
            affected.push({ ref, versions: [{ status: "affected", version }] });
          }
        }
      }
      return {
        "bom-ref": `vulnerability:${advisory.id}`,
        id: advisory.id,
        source: { name: "GitHub Advisory Database", url: advisory.url },
        ratings: [{ severity: advisory.severity, source: { name: "npm audit" } }],
        affects: affected.sort((left, right) => left.ref.localeCompare(right.ref)),
        analysis: {
          state: advisory.analysisState,
          ...(advisory.justification ? { justification: advisory.justification } : {}),
          detail: advisory.detail,
        },
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildSbom({ manifest, lockfile, rootName = DEFAULT_ROOT, baseline = null }) {
  if (!lockfile || ![2, 3].includes(lockfile.lockfileVersion)) throw new Error("Only npm lockfileVersion 2 or 3 is supported");
  const rootPath = `node_modules/${rootName}`;
  const manifestSpec = manifest?.dependencies?.[rootName];
  const rootLockEntry = lockfile.packages?.[rootPath];
  if (!rootLockEntry) throw new Error(`${rootName} is absent from the lockfile packages map`);
  const linkedRoot = rootLockEntry.link === true;
  let rootPackagePath = rootPath;
  let rootEntry = rootLockEntry;
  if (linkedRoot) {
    if (!baseline) throw new Error(`${rootName} vendored link requires a curated baseline`);
    validateBaseline(baseline);
    const source = baseline.root.source;
    if (!source) throw new Error(`${rootName} vendored link has no baseline source evidence`);
    if (rootLockEntry.resolved !== source.lockPath) throw new Error("Vendored root lock path does not match the baseline");
    if (manifestSpec !== source.manifestSpec) throw new Error("Vendored root manifest spec does not match the baseline");
    rootPackagePath = source.lockPath;
    const sourceEntry = lockfile.packages?.[rootPackagePath];
    if (!sourceEntry) throw new Error(`Vendored root package is absent at ${rootPackagePath}`);
    rootEntry = { ...sourceEntry, clarinSourceSha256: source.sha256, clarinSource: source };
  } else {
    if (!exactVersion(manifestSpec)) throw new Error(`${rootName} must be an exact production dependency in package.json`);
    if (!exactVersion(rootEntry.version)) throw new Error(`${rootName} lock entry has no exact semantic version`);
    parseIntegrity(rootEntry.integrity, `${rootName}@${rootEntry.version}`);
    if (manifestSpec !== rootEntry.version) throw new Error(`Manifest pins ${manifestSpec} but lockfile resolves ${rootEntry.version}`);
  }
  if (!exactVersion(rootEntry.version)) throw new Error(`${rootName} lock entry has no exact semantic version`);

  if (baseline) {
    validateBaseline(baseline);
    if (baseline.root.name !== rootName) throw new Error(`Baseline root ${baseline.root.name} does not match ${rootName}`);
    if (baseline.root.version !== rootEntry.version) throw new Error(`Baseline version ${baseline.root.version} does not match ${rootEntry.version}`);
    if (!linkedRoot && baseline.root.integrity !== rootEntry.integrity) throw new Error("Baseline npm integrity does not match the lockfile");
  }

  const packages = lockfile.packages;
  const queued = [rootPackagePath];
  const visited = new Set();
  const edgesByPath = new Map();
  while (queued.length > 0) {
    const lockPath = queued.shift();
    if (visited.has(lockPath)) continue;
    visited.add(lockPath);
    const entry = packages[lockPath];
    const name = lockPath === rootPackagePath ? rootName : packageNameFromLockPath(lockPath);
    if (!entry || !name) throw new Error(`Invalid package lock path ${lockPath}`);
    if (!exactVersion(entry.version)) throw new Error(`${name} at ${lockPath} has no exact semantic version`);
    if (lockPath !== rootPackagePath || !linkedRoot) parseIntegrity(entry.integrity, `${name}@${entry.version}`);
    const resolvedDependencies = [];
    for (const dependency of dependencyNames(entry)) {
      const dependencyPath = resolveDependency(packages, lockPath, dependency.name);
      if (!dependencyPath) {
        if (dependency.optional) continue;
        throw new Error(`${name}@${entry.version} cannot resolve required runtime dependency ${dependency.name}`);
      }
      resolvedDependencies.push(dependencyPath);
      if (!visited.has(dependencyPath)) queued.push(dependencyPath);
    }
    edgesByPath.set(lockPath, [...new Set(resolvedDependencies)].sort());
  }

  const recordsByIdentity = new Map();
  const identityByPath = new Map();
  for (const lockPath of [...visited].sort()) {
    const entry = packages[lockPath];
    const name = lockPath === rootPackagePath ? rootName : packageNameFromLockPath(lockPath);
    const effectiveEntry = lockPath === rootPackagePath ? rootEntry : entry;
    const identity = componentIdentity(name, effectiveEntry);
    identityByPath.set(lockPath, identity);
    const existing = recordsByIdentity.get(identity);
    if (existing) existing.lockPaths.push(lockPath);
    else recordsByIdentity.set(identity, { name, entry: effectiveEntry, lockPaths: [lockPath] });
  }

  const refByIdentity = new Map();
  const refsByNameVersion = new Map();
  for (const [identity, record] of recordsByIdentity) {
    const ref = componentRef(record.name, record.entry);
    refByIdentity.set(identity, ref);
    const key = `${record.name}\u0000${record.entry.version}`;
    const refs = refsByNameVersion.get(key) ?? [];
    refs.push(ref);
    refsByNameVersion.set(key, [...new Set(refs)].sort());
  }

  const licenseOverrides = new Map((baseline?.licenseOverrides ?? []).map((item) => [`${item.name}\u0000${item.version}`, item]));
  const usedLicenseOverrides = new Set();
  const licenseFor = (name, entry) => {
    if (entry.license) return String(entry.license);
    const key = `${name}\u0000${entry.version}`;
    const override = licenseOverrides.get(key);
    if (!override) throw new Error(`${name}@${entry.version} has no lockfile license and no audited license override`);
    usedLicenseOverrides.add(key);
    return override.expression;
  };

  const components = [...recordsByIdentity.entries()]
    .filter(([identity]) => identity !== identityByPath.get(rootPackagePath))
    .map(([identity, record]) => {
      const integrity = parseIntegrity(record.entry.integrity, `${record.name}@${record.entry.version}`);
      return {
        type: "library",
        "bom-ref": refByIdentity.get(identity),
        name: record.name,
        version: record.entry.version,
        scope: "required",
        hashes: [{ alg: "SHA-512", content: integrity.hex }],
        licenses: [{ expression: licenseFor(record.name, record.entry) }],
        purl: purlFor(record.name, record.entry.version),
        ...(record.entry.resolved ? { externalReferences: [{ type: "distribution", url: record.entry.resolved }] } : {}),
        properties: [
          { name: "clarin:npm:integrity", value: integrity.sri },
          { name: "clarin:npm:lock-paths", value: record.lockPaths.sort().join(",") },
        ],
      };
    })
    .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

  const dependencyRefs = new Map();
  for (const lockPath of [...visited].sort()) {
    const ref = refByIdentity.get(identityByPath.get(lockPath));
    const children = (edgesByPath.get(lockPath) ?? []).map((childPath) => refByIdentity.get(identityByPath.get(childPath)));
    const current = dependencyRefs.get(ref) ?? new Set();
    for (const child of children) current.add(child);
    dependencyRefs.set(ref, current);
  }
  const dependencies = [...dependencyRefs.entries()]
    .map(([ref, children]) => ({ ref, dependsOn: [...children].sort() }))
    .sort((left, right) => left.ref.localeCompare(right.ref));

  const rootDigest = componentDigest(rootName, rootEntry);
  const rootIdentity = identityByPath.get(rootPackagePath);
  const rootLicense = licenseFor(rootName, rootEntry);
  const unusedLicenseOverrides = [...licenseOverrides.keys()].filter((key) => !usedLicenseOverrides.has(key));
  if (unusedLicenseOverrides.length > 0) {
    throw new Error(`Unused license override(s): ${unusedLicenseOverrides.map((key) => key.replace("\u0000", "@")).join(", ")}`);
  }
  const audit = baseline?.audit ?? null;
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "library",
        "bom-ref": refByIdentity.get(rootIdentity),
        name: rootName,
        version: rootEntry.version,
        hashes: [{ alg: rootDigest.alg, content: rootDigest.content }],
        licenses: [{ expression: rootLicense }],
        purl: purlFor(rootName, rootEntry.version),
        ...(!linkedRoot && rootEntry.resolved ? { externalReferences: [{ type: "distribution", url: rootEntry.resolved }] } : {}),
        properties: [
          ...(linkedRoot ? [
            { name: "clarin:source:path", value: rootEntry.clarinSource.treePath },
            { name: "clarin:source:sha256", value: rootEntry.clarinSourceSha256 },
            { name: "clarin:upstream:tag", value: rootEntry.clarinSource.upstreamTag },
            { name: "clarin:upstream:commit", value: rootEntry.clarinSource.upstreamCommit },
          ] : [{ name: "clarin:npm:integrity", value: rootEntry.integrity }]),
          { name: "clarin:npm:lock-path", value: rootPackagePath },
        ],
      },
      properties: [
        { name: "clarin:generator", value: `generate-supply-chain-sbom.mjs@${GENERATOR_VERSION}` },
        { name: "clarin:lockfile-version", value: String(lockfile.lockfileVersion) },
        { name: "clarin:manifest-spec", value: manifestSpec },
        ...(audit ? [
          { name: "clarin:advisory-observed-at", value: audit.observedAt },
          { name: "clarin:advisory-command", value: audit.command },
          { name: "clarin:frontend-audit-summary", value: JSON.stringify(audit.frontendSummary) },
        ] : []),
      ],
    },
    components,
    dependencies,
    ...(baseline?.advisories?.length ? { vulnerabilities: cyclonedxVulnerabilities(baseline.advisories, refsByNameVersion) } : {}),
  };
  return document;
}

export function renderSbom(options) {
  return canonicalJson(buildSbom(options));
}

function writeText(path, text) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text, "utf8");
}

function verifyLicenseEvidence({ baseline, lockfile, artifactRoot }) {
  for (const override of baseline?.licenseOverrides ?? []) {
    const entry = lockfile.packages?.[override.lockPath];
    const actualName = packageNameFromLockPath(override.lockPath);
    if (!entry || actualName !== override.name || entry.version !== override.version) {
      throw new Error(`License evidence lock path does not resolve ${override.name}@${override.version}: ${override.lockPath}`);
    }
    const licensePath = resolve(artifactRoot, override.lockPath, override.licenseFile);
    if (!existsSync(licensePath)) throw new Error(`License evidence file not found: ${licensePath}`);
    const actual = fileSha256(licensePath);
    if (actual !== override.sha256) {
      throw new Error(`License evidence sha256 mismatch for ${override.name}@${override.version}: ${actual}`);
    }
  }
}

function verifyVendoredSourceEvidence({ baseline, artifactRoot }) {
  const source = baseline?.root?.source;
  if (!source) return;
  const sourceRoot = resolve(artifactRoot, source.treePath);
  const actual = directorySha256(sourceRoot);
  if (actual !== source.sha256) {
    throw new Error(`Vendored source sha256 mismatch for ${source.treePath}: ${actual}`);
  }
}

export function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  const manifestPath = resolve(args.manifest);
  const lockfilePath = resolve(args.lockfile);
  if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
  if (!existsSync(lockfilePath)) throw new Error(`Lockfile not found: ${lockfilePath}`);
  const baselinePath = args.baseline ? resolve(args.baseline) : null;
  if (baselinePath && !existsSync(baselinePath)) throw new Error(`Baseline not found: ${baselinePath}`);
  const baseline = baselinePath ? readJson(baselinePath) : null;
  if (baseline) validateBaseline(baseline);
  const manifest = readJson(manifestPath);
  const lockfile = readJson(lockfilePath);
  const artifactRoot = resolve(args.artifactRoot ?? dirname(lockfilePath));
  verifyLicenseEvidence({ baseline, lockfile, artifactRoot });
  verifyVendoredSourceEvidence({ baseline, artifactRoot });
  const document = buildSbom({
    manifest,
    lockfile,
    rootName: args.root,
    baseline,
  });
  const rendered = canonicalJson(document);
  const digest = sha256(rendered);
  const componentCount = document.components.length + 1;
  const blockers = [];
  if (baseline?.root?.expectedComponentCount != null && baseline.root.expectedComponentCount !== componentCount) {
    blockers.push(`Component count ${componentCount} does not match baseline ${baseline.root.expectedComponentCount}`);
  }
  if (baseline?.root?.expectedSbomSha256 && baseline.root.expectedSbomSha256 !== "PENDING" && baseline.root.expectedSbomSha256 !== digest) {
    blockers.push(`SBOM sha256 ${digest} does not match baseline ${baseline.root.expectedSbomSha256}`);
  }
  if (args.verify) {
    const expectedPath = resolve(args.verify);
    if (!existsSync(expectedPath)) blockers.push(`Archived SBOM not found: ${expectedPath}`);
    else {
      const expected = readFileSync(expectedPath, "utf8");
      if (expected !== rendered) blockers.push(`Archived SBOM differs (expected sha256 ${sha256(expected)}, actual ${digest})`);
    }
  }
  if (args.output) writeText(args.output, rendered);
  else process.stdout.write(rendered);
  const summary = `SBOM ${args.root}@${document.metadata.component.version}: ${componentCount} components, sha256 ${digest}`;
  console.error(summary);
  for (const blocker of blockers) console.error(`BLOCKER: ${blocker}`);
  return blockers.length > 0 ? 2 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    usage();
    process.exitCode = 1;
  }
}
