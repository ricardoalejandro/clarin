#!/usr/bin/env node

// Differential oracle for the pure reconciliation subset used by Clarin.
//
// reconcileElements/orderByFractionalIndex/syncInvalidIndices are a minimal
// line-for-line JavaScript extraction from Excalidraw v0.18.1 (MIT). Index
// generation is imported from the exact fractional-indexing 3.2.0 package
// (CC0-1.0). Excalidraw's volatile random nonce and wall-clock timestamp are
// injected deterministically in both this oracle and the Go golden test.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXCALIDRAW_VERSION = "0.18.1";
const FRACTIONAL_INDEXING_VERSION = "3.2.0";
const FRACTIONAL_INDEXING_SOURCE_SHA256 =
  "4166ec4320aa4c0233598c9a9b27b204090540c41c9ab1075a04f5957390a2a4";
const EXPECTED_SOURCE_HASHES = Object.freeze({
  "packages/excalidraw/data/reconcile.ts":
    "5968b33ad454dbf1a656b2fa69ae9d022428ecbc6bd9d01f43fc7115a1dc756d",
  "packages/excalidraw/fractionalIndex.ts":
    "951adbbd8bbfa96b61df8854a5fb90a4e2355e1d59268b653dd48cd8a2fd5eab",
  "packages/excalidraw/tests/data/reconcile.test.ts":
    "e85837923cfda1ed67b844bd7fe153c77e3ddcb811d7c14e473a87043675de84",
});
const DEFAULT_GOLDEN =
  "backend/internal/whiteboard/testdata/reconcile_v0.18.1_golden.json";
const ORACLE_NONCE_START = 1_000_000_000;
const ORACLE_UPDATED = 1;

function usage() {
  console.log(`Usage:
  verify-reconcile-goldens.mjs [options]

Options:
  --golden FILE          Golden corpus (default: ${DEFAULT_GOLDEN})
  --upstream-root DIR    Exact Excalidraw v0.18.1 checkout; verifies source
                        hashes and imports every upstream reconcile order case
  --write                Regenerate the corpus (requires --upstream-root)
  --help                 Show this help

Without --write the script recomputes every committed output through the JS
oracle and fails on drift. With --upstream-root it additionally proves that the
recorded upstream sources and test corpus are the exact audited v0.18.1 files.`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = { golden: DEFAULT_GOLDEN, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--golden") {
      args.golden = requiredValue(argv, ++index, token);
    } else if (token === "--upstream-root") {
      args.upstreamRoot = requiredValue(argv, ++index, token);
    } else if (token === "--write") args.write = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (args.write && !args.upstreamRoot) {
    throw new Error("--write requires --upstream-root");
  }
  return args;
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function stableString(value) {
  return JSON.stringify(stable(value));
}

function verifyUpstream(root) {
  const upstreamRoot = resolve(root);
  for (const [relativePath, expected] of Object.entries(
    EXPECTED_SOURCE_HASHES,
  )) {
    const path = resolve(upstreamRoot, relativePath);
    if (!existsSync(path)) throw new Error(`Upstream source missing: ${path}`);
    const actual = sha256(path);
    if (actual !== expected) {
      throw new Error(
        `Unexpected ${relativePath} SHA-256 ${actual}; expected ${expected}`,
      );
    }
  }
  return upstreamRoot;
}

function findMatchingParen(source, opening) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  throw new Error("Unbalanced upstream test() call");
}

function extractUpstreamOrderCases(upstreamRoot) {
  const path = resolve(
    upstreamRoot,
    "packages/excalidraw/tests/data/reconcile.test.ts",
  );
  const source = readFileSync(path, "utf8");
  const start = source.indexOf('it("reconcileElements()"');
  const end = source.indexOf('it("test identical elements reconciliation"');
  if (start < 0 || end <= start) {
    throw new Error("Cannot locate upstream reconcileElements() test block");
  }
  const block = source.slice(start, end);
  const cases = [];
  const pattern = /\btest\s*\(/g;
  for (let match = pattern.exec(block); match; match = pattern.exec(block)) {
    const opening = block.indexOf("(", match.index);
    const closing = findMatchingParen(block, opening);
    const argumentsSource = block.slice(opening + 1, closing);
    // The audited block contains only arrays of string literals. Evaluating
    // this bounded, hash-verified official source avoids a lossy TS parser.
    const values = Function(`"use strict"; return [${argumentsSource}];`)();
    if (
      values.length !== 3 ||
      !values.every((value) => Array.isArray(value))
    ) {
      throw new Error(`Unexpected upstream test shape at case ${cases.length + 1}`);
    }
    cases.push({
      name: `upstream-order-${String(cases.length + 1).padStart(2, "0")}`,
      localTokens: values[0],
      remoteTokens: values[1],
      expectedIDs: values[2].map((value) => value.split(":")[0]),
      upstream: true,
      assertConvergent: true,
    });
    pattern.lastIndex = closing + 1;
  }
  if (cases.length !== 54) {
    throw new Error(`Expected 54 upstream order cases, found ${cases.length}`);
  }
  return cases;
}

function makeMutation(start = ORACLE_NONCE_START) {
  let nonce = start;
  return () => ({ versionNonce: nonce++, updated: ORACLE_UPDATED });
}

function isValidFractionalIndex(index, predecessor, successor) {
  if (!index) return false;
  if (predecessor && successor) return predecessor < index && index < successor;
  if (!predecessor && successor) return index < successor;
  if (predecessor && !successor) return predecessor < index;
  return !!index;
}

function getInvalidIndicesGroups(elements) {
  const indicesGroups = [];
  let lowerBound;
  let upperBound;
  let lowerBoundIndex = -1;
  let upperBoundIndex = 0;

  const getLowerBound = (index) => {
    const cached = elements[lowerBoundIndex]
      ? elements[lowerBoundIndex].index
      : undefined;
    const candidate = elements[index - 1]?.index;
    if ((!cached && candidate) || (cached && candidate && candidate > cached)) {
      return [candidate, index - 1];
    }
    return [cached, lowerBoundIndex];
  };

  const getUpperBound = (index) => {
    const cached = elements[upperBoundIndex]
      ? elements[upperBoundIndex].index
      : undefined;
    if (cached && index < upperBoundIndex) return [cached, upperBoundIndex];
    let cursor = upperBoundIndex;
    while (++cursor < elements.length) {
      const candidate = elements[cursor]?.index;
      if ((!cached && candidate) || (cached && candidate && candidate > cached)) {
        return [candidate, cursor];
      }
    }
    return [undefined, cursor];
  };

  let index = 0;
  while (index < elements.length) {
    [lowerBound, lowerBoundIndex] = getLowerBound(index);
    [upperBound, upperBoundIndex] = getUpperBound(index);
    if (!isValidFractionalIndex(elements[index].index, lowerBound, upperBound)) {
      const indicesGroup = [lowerBoundIndex, index];
      while (++index < elements.length) {
        const current = elements[index].index;
        const [nextLowerBound, nextLowerBoundIndex] = getLowerBound(index);
        const [nextUpperBound, nextUpperBoundIndex] = getUpperBound(index);
        if (
          isValidFractionalIndex(
            current,
            nextLowerBound,
            nextUpperBound,
          )
        ) {
          break;
        }
        [lowerBound, lowerBoundIndex] = [nextLowerBound, nextLowerBoundIndex];
        [upperBound, upperBoundIndex] = [nextUpperBound, nextUpperBoundIndex];
        indicesGroup.push(index);
      }
      indicesGroup.push(upperBoundIndex);
      indicesGroups.push(indicesGroup);
    } else index += 1;
  }
  return indicesGroups;
}

let generateNKeysBetween;

function syncInvalidIndices(elements, mutation) {
  for (const originalGroup of getInvalidIndicesGroups(elements)) {
    const indices = [...originalGroup];
    const lowerBoundIndex = indices.shift();
    const upperBoundIndex = indices.pop();
    const fractionalIndices = generateNKeysBetween(
      elements[lowerBoundIndex]?.index,
      elements[upperBoundIndex]?.index,
      indices.length,
    );
    for (let index = 0; index < indices.length; index += 1) {
      const element = elements[indices[index]];
      const nextIndex = fractionalIndices[index];
      if (element.index === nextIndex) continue;
      element.index = nextIndex;
      element.version += 1;
      const volatile = mutation();
      element.versionNonce = volatile.versionNonce;
      element.updated = volatile.updated;
    }
  }
  return elements;
}

function orderByFractionalIndex(elements) {
  return elements.sort((left, right) => {
    if (left.index && right.index) {
      if (left.index < right.index) return -1;
      if (left.index > right.index) return 1;
      return left.id < right.id ? -1 : 1;
    }
    return 1;
  });
}

function reconcileElements(localElements, remoteElements, mutation) {
  const localElementsMap = new Map(
    localElements.map((element) => [element.id, element]),
  );
  const reconciledElements = [];
  const added = new Set();
  for (const remoteElement of remoteElements) {
    if (!added.has(remoteElement.id)) {
      const localElement = localElementsMap.get(remoteElement.id);
      const discardRemoteElement =
        localElement &&
        (localElement.version > remoteElement.version ||
          (localElement.version === remoteElement.version &&
            localElement.versionNonce < remoteElement.versionNonce));
      reconciledElements.push(
        localElement && discardRemoteElement ? localElement : remoteElement,
      );
      added.add(remoteElement.id);
    }
  }
  for (const localElement of localElements) {
    if (!added.has(localElement.id)) {
      reconciledElements.push(localElement);
      added.add(localElement.id);
    }
  }
  const orderedElements = orderByFractionalIndex(reconciledElements);
  syncInvalidIndices(orderedElements, mutation);
  return orderedElements;
}

function tokenDetails(token) {
  const match = token.match(/^(\w+)(?::(\d+))?$/);
  if (!match) throw new Error(`Invalid upstream token: ${token}`);
  return {
    uid: match[2] ? `${match[1]}:${Number(match[2])}` : match[1],
    id: match[1],
    version: match[2] ? Number(match[2]) : 0,
  };
}

function initialNonce(uid) {
  const digest = createHash("sha256").update(uid).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

function idsToElements(tokens, cache, mutationStart) {
  const elements = tokens.map((token) => {
    const details = tokenDetails(token);
    const element = {
      id: details.id,
      version: details.version,
      versionNonce: initialNonce(details.uid),
      customData: { differentialFixture: details.uid },
      ...(cache.get(details.uid) ?? {}),
    };
    cache.set(details.uid, element);
    return element;
  });
  return syncInvalidIndices(elements, makeMutation(mutationStart));
}

function materializeUpstreamCase(sourceCase, ordinal) {
  const cache = new Map();
  const inputNonceBase = 100_000 + ordinal * 10_000;
  return {
    name: sourceCase.name,
    origin: "excalidraw-v0.18.1-reconcile.test.ts",
    assertConvergent: true,
    expectedIDs: sourceCase.expectedIDs,
    local: idsToElements(sourceCase.localTokens, cache, inputNonceBase),
    remote: idsToElements(sourceCase.remoteTokens, cache, inputNonceBase + 5_000),
  };
}

function handcraftedCases() {
  return [
    {
      name: "version-and-nonce-conflicts-preserve-unknown-properties",
      origin: "clarin-differential-edge",
      assertConvergent: true,
      local: [
        {
          id: "A",
          index: "a0",
          version: 4,
          versionNonce: 40,
          type: "rectangle",
          future: { owner: "local", nested: [1, { survives: true }] },
        },
        { id: "B", index: "a1", version: 8, versionNonce: 12 },
      ],
      remote: [
        {
          id: "A",
          index: "a0",
          version: 4,
          versionNonce: 11,
          type: "rectangle",
          future: { owner: "remote", nested: [2, { survives: true }] },
        },
        { id: "B", index: "a1", version: 7, versionNonce: 1 },
        {
          id: "C",
          index: "a2",
          version: 1,
          versionNonce: 9,
          customExtension: { alpha: "β", nullable: null },
        },
      ],
    },
    {
      name: "missing-indices-are-generated-and-versioned-once",
      origin: "excalidraw-v0.18.1-fractionalIndex.test.ts",
      assertConvergent: false,
      local: [
        { id: "A", version: 3, versionNonce: 30, unknown: "first" },
        { id: "B", version: 5, versionNonce: 50, unknown: "second" },
      ],
      remote: [],
    },
    {
      name: "duplicated-indices-keep-first-and-repair-followers",
      origin: "excalidraw-v0.18.1-fractionalIndex.test.ts",
      assertConvergent: false,
      local: [
        { id: "A", index: "a1", version: 1, versionNonce: 1 },
        { id: "B", index: "a1", version: 1, versionNonce: 2 },
        { id: "C", index: "a2", version: 1, versionNonce: 3 },
      ],
      remote: [],
    },
    {
      name: "mixed-missing-duplicate-and-out-of-order-indices",
      origin: "excalidraw-v0.18.1-fractionalIndex.test.ts",
      assertConvergent: false,
      local: [
        { id: "A", version: 10, versionNonce: 1 },
        { id: "B", version: 10, versionNonce: 2 },
        { id: "C", index: "a0", version: 10, versionNonce: 3 },
        { id: "D", index: "a2", version: 10, versionNonce: 4 },
        { id: "E", version: 10, versionNonce: 5 },
        { id: "F", index: "a3", version: 10, versionNonce: 6 },
        { id: "G", version: 10, versionNonce: 7 },
        { id: "H", index: "a1", version: 10, versionNonce: 8 },
        { id: "I", index: "a2", version: 10, versionNonce: 9 },
        { id: "J", version: 10, versionNonce: 10 },
      ],
      remote: [],
    },
    {
      name: "legacy-index-barriers-match-javascript-sort",
      origin: "clarin-differential-edge",
      // Legacy index-less elements are repaired after ordering. As upstream,
      // this compatibility path is deterministic per direction but does not
      // promise the convergence invariant of already ordered live elements.
      assertConvergent: false,
      local: [
        { id: "Z", index: "a9", version: 2, versionNonce: 1 },
        { id: "legacy-local", version: 2, versionNonce: 2 },
      ],
      remote: [
        { id: "A", index: "a0", version: 2, versionNonce: 3 },
        { id: "legacy-remote", version: 2, versionNonce: 4 },
      ],
    },
    {
      name: "deleted-elements-and-extension-data-survive",
      origin: "clarin-differential-edge",
      assertConvergent: true,
      local: [],
      remote: [
        {
          id: "deleted",
          index: "a0",
          version: 6,
          versionNonce: 7,
          isDeleted: true,
          customData: { plugin: { payload: ["uno", "dos"] } },
          nextFormatField: { enabled: true },
        },
      ],
    },
  ];
}

function finalizeCase(input) {
  const local = clone(input.local);
  const remote = clone(input.remote);
  const expected = reconcileElements(
    clone(local),
    clone(remote),
    makeMutation(),
  );
  const expectedReverse = reconcileElements(
    clone(remote),
    clone(local),
    makeMutation(),
  );
  const expectedRemoteRereconcile = reconcileElements(
    clone(remote),
    clone(expected),
    makeMutation(),
  );
  const expectedIDs = expected.map((element) => element.id);
  if (input.expectedIDs && stableString(input.expectedIDs) !== stableString(expectedIDs)) {
    throw new Error(
      `${input.name}: oracle IDs ${expectedIDs} differ from upstream ${input.expectedIDs}`,
    );
  }
  if (input.assertConvergent) {
    const reverseIDs = expectedReverse.map((element) => element.id);
    const rereconciledIDs = expectedRemoteRereconcile.map((element) => element.id);
    if (
      stableString(expectedIDs) !== stableString(reverseIDs) ||
      stableString(expectedIDs) !== stableString(rereconciledIDs)
    ) {
      throw new Error(`${input.name}: bidirectional convergence failed`);
    }
  }
  return {
    name: input.name,
    origin: input.origin,
    assertConvergent: input.assertConvergent,
    local,
    remote,
    expected,
    expectedReverse,
    expectedRemoteRereconcile,
  };
}

function buildFractionalCases() {
  const minimumInteger = `A${"0".repeat(25)}9`;
  const maximumInteger = `z${"z".repeat(26)}`;
  const definitions = [
    ["empty-request", null, null, 0],
    ["initial-key", null, null, 1],
    ["initial-sequence", null, null, 8],
    ["prepend-one", null, "a0", 1],
    ["prepend-many", null, "a0", 7],
    ["append-many", "a0", null, 7],
    ["between-adjacent-integers", "a0", "a1", 1],
    ["between-adjacent-integers-many", "a0", "a1", 8],
    ["between-fractions", "a0V", "a0W", 5],
    ["between-prefix-fractions", "a0V", "a0V1", 4],
    ["cross-uppercase-lowercase-boundary", "Zz", "a0", 5],
    ["before-near-minimum-integer", null, minimumInteger, 3],
    ["after-maximum-integer", maximumInteger, null, 3],
    ["long-common-prefix", "a0VVVVVVV", "a0VVVVVVW", 6],
  ];
  return definitions.map(([name, lower, upper, count]) => ({
    name,
    lower,
    upper,
    count,
    expected: generateNKeysBetween(lower, upper, count),
  }));
}

function buildFractionalErrorCases() {
  const definitions = [
    ["equal-bounds", "a0", "a0", 1],
    ["reversed-bounds", "a1", "a0", 1],
    ["trailing-zero-fraction-lower", "a00", null, 1],
    ["trailing-zero-fraction-upper", null, "a00", 1],
    ["invalid-head", "00", null, 1],
    ["truncated-integer", "b0", null, 1],
  ];
  return definitions.map(([name, lower, upper, count]) => {
    let error = null;
    try {
      generateNKeysBetween(lower, upper, count);
    } catch (cause) {
      error = String(cause.message);
    }
    if (!error) throw new Error(`${name}: fractional-indexing did not reject input`);
    return { name, lower, upper, count, error };
  });
}

function buildCorpus(inputs) {
  const cases = inputs.map(finalizeCase);
	const fractionalCases = buildFractionalCases();
	const fractionalErrorCases = buildFractionalErrorCases();
  return {
    metadata: {
      excalidrawVersion: EXCALIDRAW_VERSION,
      reconcileSourceSHA256:
        EXPECTED_SOURCE_HASHES["packages/excalidraw/data/reconcile.ts"],
      fractionalIndexSourceSHA256:
        EXPECTED_SOURCE_HASHES["packages/excalidraw/fractionalIndex.ts"],
      reconcileTestSourceSHA256:
        EXPECTED_SOURCE_HASHES[
          "packages/excalidraw/tests/data/reconcile.test.ts"
        ],
      fractionalIndexingVersion: FRACTIONAL_INDEXING_VERSION,
      fractionalIndexingLicense: "CC0-1.0",
      fractionalIndexingSourceSHA256: FRACTIONAL_INDEXING_SOURCE_SHA256,
      deterministicMutation: {
        versionNonceStart: ORACLE_NONCE_START,
        updated: ORACLE_UPDATED,
      },
      upstreamOrderCases: cases.filter((item) =>
        item.name.startsWith("upstream-order-"),
      ).length,
      totalCases: cases.length,
      fractionalCases: fractionalCases.length,
      fractionalErrorCases: fractionalErrorCases.length,
    },
    cases,
    fractionalCases,
    fractionalErrorCases,
  };
}

async function loadFractionalIndexing() {
  const packageRoot = resolve("frontend/node_modules/fractional-indexing");
  const manifestPath = resolve(packageRoot, "package.json");
  const sourcePath = resolve(packageRoot, "src/index.js");
  if (!existsSync(manifestPath) || !existsSync(sourcePath)) {
    throw new Error(
      "fractional-indexing is not installed; run npm install in frontend",
    );
  }
  const manifest = readJSON(manifestPath);
  if (
    manifest.version !== FRACTIONAL_INDEXING_VERSION ||
    manifest.license !== "CC0-1.0"
  ) {
    throw new Error(
      `Expected fractional-indexing ${FRACTIONAL_INDEXING_VERSION} CC0-1.0, got ${manifest.version} ${manifest.license}`,
    );
  }
  const actualSourceHash = sha256(sourcePath);
  if (actualSourceHash !== FRACTIONAL_INDEXING_SOURCE_SHA256) {
    throw new Error(
      `Unexpected fractional-indexing source SHA-256 ${actualSourceHash}; expected ${FRACTIONAL_INDEXING_SOURCE_SHA256}`,
    );
  }
  const module = await import(pathToFileURL(sourcePath).href);
  if (typeof module.generateNKeysBetween !== "function") {
    throw new Error("fractional-indexing does not export generateNKeysBetween");
  }
  generateNKeysBetween = module.generateNKeysBetween;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  await loadFractionalIndexing();
  const goldenPath = resolve(args.golden);

  if (args.write) {
    const upstreamRoot = verifyUpstream(args.upstreamRoot);
    const upstreamCases = extractUpstreamOrderCases(upstreamRoot).map(
      materializeUpstreamCase,
    );
    const corpus = buildCorpus([...upstreamCases, ...handcraftedCases()]);
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
    console.log(`WROTE: ${goldenPath}`);
    console.log(
      `Cases: ${corpus.metadata.upstreamOrderCases} upstream, ${corpus.metadata.totalCases} total`,
    );
    console.log(
      `Keys:  ${corpus.metadata.fractionalCases} exact, ${corpus.metadata.fractionalErrorCases} rejection`,
    );
    process.exit(0);
  }

  if (!existsSync(goldenPath)) throw new Error(`Golden file missing: ${goldenPath}`);
  const committed = readJSON(goldenPath);
  if (args.upstreamRoot) {
    const upstreamRoot = verifyUpstream(args.upstreamRoot);
    const sourceCases = extractUpstreamOrderCases(upstreamRoot).map(
      materializeUpstreamCase,
    );
    if (sourceCases.length !== committed.metadata.upstreamOrderCases) {
      throw new Error("Committed corpus does not cover every upstream order case");
    }
    for (let index = 0; index < sourceCases.length; index += 1) {
      const recorded = committed.cases[index];
      const source = sourceCases[index];
      if (
        recorded?.name !== source.name ||
        stableString(recorded.local) !== stableString(source.local) ||
        stableString(recorded.remote) !== stableString(source.remote)
      ) {
        throw new Error(
          `Committed corpus input ${index + 1} no longer matches the exact upstream test`,
        );
      }
    }
  }
  const regenerated = buildCorpus(
    committed.cases.map(({ expected: _expected, expectedReverse: _reverse,
      expectedRemoteRereconcile: _rereconcile, ...input }) => input),
  );
  if (stableString(committed) !== stableString(regenerated)) {
    throw new Error(
      `Golden drift detected in ${goldenPath}; regenerate from exact upstream with --write`,
    );
  }
  console.log("Decision: PASS");
  console.log(`Golden:   ${goldenPath}`);
  console.log(
    `Cases:    ${committed.metadata.upstreamOrderCases} upstream, ${committed.metadata.totalCases} total`,
  );
  console.log(
    `Keys:     ${committed.metadata.fractionalCases} exact, ${committed.metadata.fractionalErrorCases} rejection`,
  );
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  usage();
  process.exit(1);
}
