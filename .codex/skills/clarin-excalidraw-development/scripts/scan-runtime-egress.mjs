#!/usr/bin/env node

import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

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

const SCANNABLE_EXTENSIONS = new Set([
  ".css",
  ".cjs",
  ".har",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".map",
  ".mjs",
  ".scss",
  ".txt",
  ".ts",
  ".tsx",
  ".xml",
]);

function usage() {
  console.log(`Usage:
  scan-runtime-egress.mjs (--root PATH | --trace FILE)... [options]

Inputs:
  --root PATH              Production file or directory to scan (repeatable)
  --trace FILE             Browser request/WebSocket trace or HAR (repeatable)

Policy:
  --strict                 Reject every external origin not explicitly allowed
  --allow-origin ORIGIN    Exact controlled origin allowed in strict mode (repeatable)
  --forbid-host HOST       Add a forbidden host suffix (repeatable)

Output:
  --json FILE              Write a machine-readable report
  --help                   Show this help

Exit status is 2 when violations are found and 0 otherwise.`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = { roots: [], traces: [], allowOrigins: [], forbiddenHosts: [...DEFAULT_FORBIDDEN_HOSTS], strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--root") args.roots.push(requiredValue(argv, ++index, token));
    else if (token === "--trace") args.traces.push(requiredValue(argv, ++index, token));
    else if (token === "--strict") args.strict = true;
    else if (token === "--allow-origin") args.allowOrigins.push(normalizeOrigin(requiredValue(argv, ++index, token)));
    else if (token === "--forbid-host") args.forbiddenHosts.push(normalizeHost(requiredValue(argv, ++index, token)));
    else if (token === "--json") args.json = requiredValue(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  args.allowOrigins = [...new Set(args.allowOrigins)].sort();
  args.forbiddenHosts = [...new Set(args.forbiddenHosts.map(normalizeHost).filter(Boolean))].sort();
  return args;
}

function normalizeHost(value) {
  return String(value).trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error(`Unsupported origin scheme: ${value}`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`Allow an origin only, without path or credentials: ${value}`);
  return url.origin.toLowerCase();
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function listFiles(path) {
  const root = resolve(path);
  const files = [];
  function walk(current) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const base = current.split(/[\\/]/).at(-1);
      if ([".git", "node_modules"].includes(base) && current !== root) return;
      for (const entry of readdirSync(current).sort()) walk(resolve(current, entry));
      return;
    }
    if (info.isFile()) files.push(current);
  }
  walk(root);
  return { root, files };
}

function isText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function cleanUrl(value) {
  return value.replace(/\\\//g, "/").replace(/[.,;:!?]+$/, "");
}

function extractUrls(text) {
  const values = new Set();
  const normalized = String(text).replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  const pattern = /(?:https?|wss?):\/\/[^\s"'`<>\\)\]}]+/gi;
  for (const match of normalized.matchAll(pattern)) values.add(cleanUrl(match[0]));
  return [...values].sort();
}

function extractBareForbiddenHosts(text, forbiddenHosts) {
  const findings = [];
  for (const suffix of forbiddenHosts) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9.-])([a-z0-9.-]*${escaped})(?=$|[^a-z0-9.-])`, "gi");
    for (const match of text.matchAll(pattern)) {
      const host = normalizeHost(match[1]);
      if (hostMatches(host, suffix)) findings.push({ host, value: host });
    }
  }
  return findings;
}

function classifyUrl(value, args) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { value, host: null, origin: null, reason: "malformed absolute network URL" };
  }
  const host = normalizeHost(url.hostname);
  const forbidden = args.forbiddenHosts.find((suffix) => hostMatches(host, suffix));
  if (forbidden) return { value, host, origin: url.origin.toLowerCase(), reason: `forbidden host suffix ${forbidden}` };
  if (args.strict && !args.allowOrigins.includes(url.origin.toLowerCase())) {
    return { value, host, origin: url.origin.toLowerCase(), reason: "origin is not in the strict allowlist" };
  }
  return null;
}

function scanRoot(rawPath, args) {
  const { root, files } = listFiles(rawPath);
  const violations = [];
  let scannedFiles = 0;
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(extension)) continue;
    const size = statSync(file).size;
    if (size > 30 * 1024 * 1024) continue;
    const buffer = readFileSync(file);
    if (!isText(buffer)) continue;
    scannedFiles += 1;
    const text = buffer.toString("utf8");
    for (const value of extractUrls(text)) {
      const result = classifyUrl(value, args);
      if (result) violations.push({ source: "static", file: relative(root, file).replaceAll("\\", "/") || file, ...result });
    }
    for (const finding of extractBareForbiddenHosts(text, args.forbiddenHosts)) {
      violations.push({ source: "static", file: relative(root, file).replaceAll("\\", "/") || file, origin: null, reason: "bare forbidden host literal", ...finding });
    }
  }
  return { root, files: files.length, scannedFiles, violations };
}

function collectStringValues(value, output) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStringValues(item, output);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectStringValues(child, output);
}

function scanTrace(rawPath, args) {
  const path = resolve(rawPath);
  const text = readFileSync(path, "utf8");
  const strings = [];
  try {
    collectStringValues(JSON.parse(text), strings);
  } catch {
    strings.push(text);
  }
  const values = new Set();
  for (const item of strings) for (const value of extractUrls(item)) values.add(value);
  const violations = [];
  for (const value of [...values].sort()) {
    const result = classifyUrl(value, args);
    if (result) violations.push({ source: "runtime-trace", file: path, ...result });
  }
  return { path, urls: values.size, violations };
}

function dedupe(items) {
  return [...new Map(items.map((item) => [`${item.source}\0${item.file}\0${item.value}\0${item.reason}`, item])).values()]
    .sort((a, b) => `${a.source}${a.file}${a.value}`.localeCompare(`${b.source}${b.file}${b.value}`));
}

function writeJson(path, report) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (args.roots.length === 0 && args.traces.length === 0) throw new Error("Provide at least one --root or --trace");
  const roots = args.roots.map((path) => scanRoot(path, args));
  const traces = args.traces.map((path) => scanTrace(path, args));
  const violations = dedupe([...roots.flatMap((item) => item.violations), ...traces.flatMap((item) => item.violations)]);
  const report = {
    generatedAt: new Date().toISOString(),
    strict: args.strict,
    allowOrigins: args.allowOrigins,
    forbiddenHosts: args.forbiddenHosts,
    roots: roots.map(({ violations: _violations, ...item }) => item),
    traces: traces.map(({ violations: _violations, ...item }) => item),
    violations,
    decision: violations.length === 0 ? "PASS" : "FAIL",
  };
  if (args.json) writeJson(args.json, report);
  console.log(`Decision: ${report.decision}`);
  console.log(`Scanned: ${roots.reduce((sum, item) => sum + item.scannedFiles, 0)} static file(s), ${traces.reduce((sum, item) => sum + item.urls, 0)} traced URL(s)`);
  for (const item of violations) console.log(`VIOLATION: ${item.source} ${item.file} ${item.value} (${item.reason})`);
  process.exit(violations.length > 0 ? 2 : 0);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  usage();
  process.exit(1);
}
