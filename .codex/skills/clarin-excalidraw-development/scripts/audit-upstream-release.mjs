#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const DEFAULT_FORBIDDEN_HOSTS = [
  "excalidraw.com",
  "esm.sh",
  "firebaseio.com",
  "firebaseapp.com",
  "googleapis.com",
  "gstatic.com",
  "sentry.io",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "githubusercontent.com",
];

const RUNTIME_TEXT_EXTENSIONS = new Set([
  ".css",
  ".cjs",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
]);

function usage() {
  console.log(`Usage:
  audit-upstream-release.mjs --candidate DIR [options]

Required:
  --candidate DIR          Extracted candidate package directory

Options:
  --current DIR            Extracted currently shipped package directory
  --expected-version X.Y.Z Exact candidate version expected from official metadata
  --manifest FILE          Clarin package.json whose dependency spec should be exact
  --lockfile FILE          npm package-lock.json containing the resolved artifact
  --tarball FILE           Exact npm .tgz to hash without executing lifecycle scripts
  --expected-integrity SRI Official sha512-... integrity expected for the tarball/lock
  --upstream-root DIR      Exact official Git checkout used to verify tag and commit
  --expected-tag TAG       Stable tag expected to resolve to the checkout HEAD
  --expected-commit SHA    Full 40-character commit expected for checkout/tag
  --forbid-host HOST       Add a forbidden runtime host suffix (repeatable)
  --json FILE              Write the complete machine-readable report
  --help                   Show this help

Exit status is 2 when blockers are found and 0 otherwise.`);
}

function parseArgs(argv) {
  const args = { forbiddenHosts: [...DEFAULT_FORBIDDEN_HOSTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--candidate") args.candidate = requiredValue(argv, ++index, token);
    else if (token === "--current") args.current = requiredValue(argv, ++index, token);
    else if (token === "--expected-version") args.expectedVersion = requiredValue(argv, ++index, token);
    else if (token === "--manifest") args.manifest = requiredValue(argv, ++index, token);
    else if (token === "--lockfile") args.lockfile = requiredValue(argv, ++index, token);
    else if (token === "--tarball") args.tarball = requiredValue(argv, ++index, token);
    else if (token === "--expected-integrity") args.expectedIntegrity = requiredValue(argv, ++index, token);
    else if (token === "--upstream-root") args.upstreamRoot = requiredValue(argv, ++index, token);
    else if (token === "--expected-tag") args.expectedTag = requiredValue(argv, ++index, token);
    else if (token === "--expected-commit") args.expectedCommit = requiredValue(argv, ++index, token);
    else if (token === "--json") args.json = requiredValue(argv, ++index, token);
    else if (token === "--forbid-host") args.forbiddenHosts.push(requiredValue(argv, ++index, token));
    else throw new Error(`Unknown argument: ${token}`);
  }
  args.forbiddenHosts = [...new Set(args.forbiddenHosts.map(normalizeHost).filter(Boolean))].sort();
  return args;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function normalizeHost(value) {
  return String(value).trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${path}: ${error.message}`);
  }
}

function listFiles(root) {
  const files = [];
  function walk(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const base = path.split(/[\\/]/).at(-1);
      if ([".git", "node_modules"].includes(base) && path !== root) return;
      for (const entry of readdirSync(path).sort()) walk(resolve(path, entry));
      return;
    }
    if (stat.isFile()) files.push(path);
  }
  walk(root);
  return files;
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function manifestDigest(root, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fileHash(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function isText(buffer) {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function extractHosts(text, forbiddenHosts) {
  const findings = [];
  const seen = new Set();
  const urlPattern = /(?:https?|wss?):\/\/[^\s"'`<>\\)\]}]+/gi;
  for (const match of text.matchAll(urlPattern)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(raw);
      const host = normalizeHost(url.hostname);
      for (const suffix of forbiddenHosts) {
        if (hostMatches(host, suffix)) {
          const key = `${host}\0${raw}`;
          if (!seen.has(key)) findings.push({ host, value: raw });
          seen.add(key);
        }
      }
    } catch {
      // Ignore malformed source literals; bare host scanning below still catches policy domains.
    }
  }
  for (const suffix of forbiddenHosts) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9.-])([a-z0-9.-]*${escaped})(?=$|[^a-z0-9.-])`, "gi");
    for (const match of text.matchAll(pattern)) {
      const host = normalizeHost(match[1]);
      if (!hostMatches(host, suffix)) continue;
      const key = `${host}\0${host}`;
      if (!seen.has(key)) findings.push({ host, value: host });
      seen.add(key);
    }
  }
  return findings;
}

function inspectPackage(rawPath, forbiddenHosts) {
  const root = resolve(rawPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Package directory not found: ${root}`);
  const packageJsonPath = resolve(root, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`package.json not found in ${root}`);
  const pkg = readJson(packageJsonPath);
  const files = listFiles(root);
  const licenseFiles = files
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) => /(^|\/)(licen[cs]e|copying|notice)(\.|$)/i.test(file));
  const assets = files
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) => /\.(?:eot|gif|jpg|jpeg|otf|png|svg|ttf|wasm|webp|woff|woff2)$/i.test(file));
  const networkFindings = [];
  for (const file of files) {
    // Root package metadata legitimately links to the upstream project and is
    // not bundled as an editor runtime module. Runtime JSON elsewhere remains scanned.
    if (file === packageJsonPath) continue;
    if (!RUNTIME_TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const size = statSync(file).size;
    if (size > 20 * 1024 * 1024) continue;
    const buffer = readFileSync(file);
    if (!isText(buffer)) continue;
    const content = buffer.toString("utf8");
    for (const finding of extractHosts(content, forbiddenHosts)) {
      networkFindings.push({ file: relative(root, file).replaceAll("\\", "/"), ...finding });
    }
  }
  const dedupedNetworkFindings = [...new Map(networkFindings.map((item) => [`${item.file}\0${item.host}\0${item.value}`, item])).values()]
    .sort((a, b) => `${a.file}${a.host}${a.value}`.localeCompare(`${b.file}${b.host}${b.value}`));
  return {
    root,
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    license: pkg.license ?? null,
    peerDependencies: pkg.peerDependencies ?? {},
    dependencies: pkg.dependencies ?? {},
    exports: pkg.exports ?? null,
    types: pkg.types ?? pkg.typings ?? null,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + statSync(file).size, 0),
    sha256Manifest: manifestDigest(root, files),
    licenseFiles,
    assets,
    networkFindings: dedupedNetworkFindings,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function exactDependencySpec(spec) {
  if (typeof spec !== "string") return false;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec) || /^npm:[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec);
}

function inspectManifest(path, packageName) {
  const manifestPath = resolve(path);
  const manifest = readJson(manifestPath);
  const sections = ["dependencies", "devDependencies", "optionalDependencies"];
  for (const section of sections) {
    if (manifest[section] && Object.hasOwn(manifest[section], packageName)) {
      const spec = manifest[section][packageName];
      return { path: manifestPath, section, spec, exact: exactDependencySpec(spec) };
    }
  }
  return { path: manifestPath, section: null, spec: null, exact: false };
}

function inspectLockfile(path, packageName) {
  const lockfilePath = resolve(path);
  const lockfile = readJson(lockfilePath);
  const packageEntry = lockfile.packages?.[`node_modules/${packageName}`];
  if (!packageEntry) return { path: lockfilePath, found: false, version: null, resolved: null, integrity: null };
  return {
    path: lockfilePath,
    found: true,
    version: packageEntry.version ?? null,
    resolved: packageEntry.resolved ?? null,
    integrity: packageEntry.integrity ?? null,
  };
}

function inspectTarball(path) {
  const tarballPath = resolve(path);
  if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) throw new Error(`Tarball not found: ${tarballPath}`);
  return {
    path: tarballPath,
    bytes: statSync(tarballPath).size,
    integrity: `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`,
  };
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function inspectUpstream(rawRoot, expectedTag) {
  const root = resolve(rawRoot);
  if (!existsSync(resolve(root, ".git"))) throw new Error(`Git checkout not found: ${root}`);
  const head = git(root, ["rev-parse", "HEAD"]);
  const tagCommit = expectedTag ? git(root, ["rev-list", "-n", "1", expectedTag]) : null;
  let origin = null;
  try {
    origin = git(root, ["remote", "get-url", "origin"]);
  } catch {
    // A source archive may deliberately have no remote; report it for manual review.
  }
  return { root, head, expectedTag: expectedTag ?? null, tagCommit, origin };
}

function buildReport(args) {
  const candidate = inspectPackage(args.candidate, args.forbiddenHosts);
  const current = args.current ? inspectPackage(args.current, args.forbiddenHosts) : null;
  const blockers = [];
  const warnings = [];

  if (candidate.name !== "@excalidraw/excalidraw") blockers.push(`Unexpected package name: ${candidate.name ?? "missing"}`);
  if (!candidate.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.version)) blockers.push("Candidate package has no exact semantic version");
  if (args.expectedVersion && candidate.version !== args.expectedVersion) blockers.push(`Candidate version ${candidate.version} does not match expected ${args.expectedVersion}`);
  if (String(candidate.license).toUpperCase() !== "MIT") blockers.push(`Candidate license is ${candidate.license ?? "missing"}, expected MIT`);
  if (candidate.licenseFiles.length === 0) blockers.push("Candidate package contains no license file");
  if (candidate.networkFindings.length > 0) blockers.push(`Candidate runtime files contain ${candidate.networkFindings.length} forbidden-host literal(s)`);
  if (candidate.assets.some((path) => /\.(?:otf|ttf|woff|woff2)$/i.test(path)) && candidate.licenseFiles.length < 2) {
    warnings.push("Candidate contains font assets; verify each font license independently from the package MIT license");
  }

  if (current) {
    if (current.name !== candidate.name) blockers.push(`Package name changed from ${current.name} to ${candidate.name}`);
    if (current.version === candidate.version && current.sha256Manifest !== candidate.sha256Manifest) blockers.push("Same package version has different content digest");
    if (!same(current.exports, candidate.exports)) warnings.push("Public package exports changed");
    if (!same(current.peerDependencies, candidate.peerDependencies)) warnings.push("Peer dependencies changed");
    if (!same(current.dependencies, candidate.dependencies)) warnings.push("Runtime dependencies changed");
    if (current.types !== candidate.types) warnings.push(`Type entrypoint changed from ${current.types ?? "none"} to ${candidate.types ?? "none"}`);
    if (!same(current.assets, candidate.assets)) warnings.push("Packaged asset manifest changed");
    if (!same(current.licenseFiles, candidate.licenseFiles)) warnings.push("License file manifest changed");
  }

  const manifest = args.manifest ? inspectManifest(args.manifest, candidate.name) : null;
  if (manifest && !manifest.section) blockers.push(`${candidate.name} is absent from ${manifest.path}`);
  else if (manifest && !manifest.exact) blockers.push(`Dependency spec ${manifest.spec} is not an exact version`);
  else if (manifest && manifest.spec !== candidate.version) warnings.push(`Manifest pins ${manifest.spec}, candidate is ${candidate.version}`);

  const lockfile = args.lockfile ? inspectLockfile(args.lockfile, candidate.name) : null;
  if (lockfile && !lockfile.found) blockers.push(`${candidate.name} is absent from ${lockfile.path}`);
  else if (lockfile && lockfile.version !== candidate.version) blockers.push(`Lockfile resolves ${lockfile.version}, candidate is ${candidate.version}`);
  if (lockfile && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(lockfile.integrity ?? ""))) {
    blockers.push("Lockfile has no valid sha512 npm integrity for the candidate");
  }

  const tarball = args.tarball ? inspectTarball(args.tarball) : null;
  if (args.expectedIntegrity && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(args.expectedIntegrity)) {
    blockers.push("Expected npm integrity is not a valid sha512 SRI value");
  }
  if (args.expectedIntegrity && !lockfile && !tarball) {
    blockers.push("Expected npm integrity requires --lockfile and/or --tarball evidence");
  }
  if (args.expectedIntegrity && lockfile && lockfile.integrity !== args.expectedIntegrity) {
    blockers.push(`Lockfile integrity ${lockfile?.integrity ?? "missing"} does not match official expected integrity`);
  }
  if (args.expectedIntegrity && tarball && tarball.integrity !== args.expectedIntegrity) {
    blockers.push(`Tarball integrity ${tarball?.integrity ?? "missing"} does not match official expected integrity`);
  }
  if (tarball && lockfile?.integrity && tarball.integrity !== lockfile.integrity) {
    blockers.push("Downloaded tarball integrity does not match the lockfile");
  }
  if ((args.tarball || args.lockfile) && !args.expectedIntegrity) {
    warnings.push("Artifact integrity was measured but not compared with independently resolved official npm metadata");
  }

  const upstream = args.upstreamRoot ? inspectUpstream(args.upstreamRoot, args.expectedTag) : null;
  if ((args.expectedTag || args.expectedCommit) && !upstream) blockers.push("Expected tag/commit requires --upstream-root evidence");
  if (args.expectedCommit && !/^[0-9a-f]{40}$/i.test(args.expectedCommit)) blockers.push("Expected commit must be a full 40-character SHA");
  if (args.expectedCommit && upstream?.head !== args.expectedCommit) blockers.push(`Checkout HEAD ${upstream?.head ?? "missing"} does not match expected commit ${args.expectedCommit}`);
  if (upstream?.tagCommit && upstream.tagCommit !== upstream.head) blockers.push(`Tag ${args.expectedTag} resolves to ${upstream.tagCommit}, not checkout HEAD ${upstream.head}`);
  if (args.expectedCommit && upstream?.tagCommit && upstream.tagCommit !== args.expectedCommit) blockers.push(`Tag ${args.expectedTag} does not resolve to expected commit ${args.expectedCommit}`);
  if (upstream?.origin && !/(?:^|[/:])github\.com[/:]excalidraw\/excalidraw(?:\.git)?$/i.test(upstream.origin)) {
    blockers.push(`Upstream checkout origin is not the official Excalidraw repository: ${upstream.origin}`);
  }
  if (args.upstreamRoot && !args.expectedTag) warnings.push("Upstream checkout was supplied without an expected stable tag");
  if (args.upstreamRoot && !args.expectedCommit) warnings.push("Upstream checkout was supplied without an independently resolved expected commit");

  return {
    generatedAt: new Date().toISOString(),
    decision: blockers.length === 0 ? "REVIEW" : "NO-GO",
    forbiddenHosts: args.forbiddenHosts,
    candidate,
    current,
    manifest,
    lockfile,
    tarball,
    upstream,
    blockers,
    warnings,
  };
}

function writeJson(path, report) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function printReport(report) {
  console.log(`Candidate: ${report.candidate.name}@${report.candidate.version}`);
  if (report.current) console.log(`Current:   ${report.current.name}@${report.current.version}`);
  console.log(`Digest:    sha256:${report.candidate.sha256Manifest}`);
  console.log(`Decision:  ${report.decision}`);
  for (const item of report.blockers) console.log(`BLOCKER: ${item}`);
  for (const item of report.warnings) console.log(`WARNING: ${item}`);
  if (report.blockers.length === 0 && report.warnings.length === 0) console.log("No automated blockers or warnings; manual upstream diff is still required.");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.candidate) throw new Error("--candidate is required");
  const report = buildReport(args);
  if (args.json) writeJson(args.json, report);
  printReport(report);
  process.exit(report.blockers.length > 0 ? 2 : 0);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  usage();
  process.exit(1);
}
