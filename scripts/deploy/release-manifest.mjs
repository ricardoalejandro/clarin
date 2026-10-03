#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const imageNames = ['backend', 'frontend', 'offline-signer', 'codex-bridge'];
const containers = {
  backend: 'clarin-backend',
  frontend: 'clarin-frontend',
  'offline-signer': 'clarin-offline-signer',
  'codex-bridge': 'clarin-codex-bridge',
  'task-preview-worker': 'clarin-task-preview-worker',
};
const imageForService = service => service === 'task-preview-worker' ? 'backend' : service;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value, expected) => object(value) && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
const reject = message => { throw new Error(message); };

export function validateManifest(input, expectedSha) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha || '')) reject('Expected commit must be a full lowercase SHA.');
  if (!keysEqual(input, ['format', 'commit', 'version', 'platform', 'archiveSha256', 'images'])) reject('Invalid release manifest fields.');
  if (input.format !== 1 || input.commit !== expectedSha) reject('Release manifest does not match the requested commit.');
  if (input.platform !== 'linux/amd64') reject('Release platform must be linux/amd64.');
  if (typeof input.version !== 'string' || !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]*-[0-9]{6,20}-[0-9a-f]{12}$/.test(input.version) || !input.version.endsWith(`-${expectedSha.slice(0, 12)}`)) reject('Release version does not identify the requested commit.');
  if (!/^[0-9a-f]{64}$/.test(input.archiveSha256 || '')) reject('Invalid image archive checksum.');
  if (!keysEqual(input.images, imageNames)) reject('Release must contain exactly the four application images.');
  for (const name of imageNames) {
    const image = input.images[name];
    if (!keysEqual(image, ['tag', 'id']) || image.tag !== `clarin-release/${name}:${expectedSha}` || !/^sha256:[0-9a-f]{64}$/.test(image.id || '')) reject(`Invalid release image: ${name}.`);
  }
  return input;
}

export function composeOverride(manifest) {
  validateManifest(manifest, manifest.commit);
  return {
    services: Object.fromEntries(Object.keys(containers).map(service => [service, {
      // Local image IDs are immutable and remain valid after docker save/load.
      image: manifest.images[imageForService(service)].id,
      pull_policy: 'never',
    }])),
  };
}

export function verifyImageInspections(manifest, inspections) {
  validateManifest(manifest, manifest.commit);
  if (!Array.isArray(inspections) || inspections.length !== imageNames.length) reject('Docker did not return all release images.');
  for (const [index, name] of imageNames.entries()) {
    const inspected = inspections[index];
    if (inspected?.Id !== manifest.images[name].id || inspected?.Config?.Labels?.['org.opencontainers.image.revision'] !== manifest.commit || inspected?.Config?.Labels?.['org.opencontainers.image.version'] !== manifest.version || inspected?.Os !== 'linux' || inspected?.Architecture !== 'amd64') reject(`Release image identity or platform mismatch: ${name}.`);
  }
}

export function verifyRunningInspections(manifest, inspections) {
  validateManifest(manifest, manifest.commit);
  if (!Array.isArray(inspections) || inspections.length !== Object.keys(containers).length) reject('Docker did not return all application containers.');
  const byName = new Map(inspections.map(inspected => [inspected?.Name?.replace(/^\//, ''), inspected]));
  for (const [service, name] of Object.entries(containers)) {
    const inspected = byName.get(name);
    if (inspected?.State?.Running !== true || inspected?.Image !== manifest.images[imageForService(service)].id) reject(`Container is stopped or serving a different image: ${name}.`);
  }
}

function inspect(arguments_) {
  const result = spawnSync('docker', arguments_, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) reject('Unable to inspect the required Docker images or containers.');
  return JSON.parse(result.stdout);
}

function main(arguments_) {
  const [command, path, sha, extra] = arguments_;
  if (extra || !path || !['validate', 'compose', 'check-images', 'check-running'].includes(command)) reject('Usage: release-manifest.mjs validate|compose|check-images|check-running <manifest.json> <commit-sha>');
  const manifest = validateManifest(JSON.parse(readFileSync(path, 'utf8')), sha);
  if (command === 'compose') process.stdout.write(`${JSON.stringify(composeOverride(manifest), null, 2)}\n`);
  if (command === 'check-images') verifyImageInspections(manifest, inspect(['image', 'inspect', ...imageNames.map(name => manifest.images[name].tag)]));
  if (command === 'check-running') verifyRunningInspections(manifest, inspect(['container', 'inspect', ...Object.values(containers)]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
