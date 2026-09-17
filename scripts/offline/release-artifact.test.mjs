import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPilotEvidence, freezeArtifact, requiredWindowsChecks, sha256File, verifyArtifact } from './release-artifact.mjs';

const checksum = 'a'.repeat(64);
const now = Date.parse('2026-09-14T12:00:00Z');
function report() {
  return { schema_version: 1, protocol_version: 3, installer_sha256: checksum, completed_at: new Date(now).toISOString(), environment: { os: 'Windows 11', arch: 'x64', real_service: true }, browsers: ['chrome', 'msedge'].map(channel => ({ channel, version: '140.0.7339.186', checks: requiredWindowsChecks.map(id => ({ id, status: 'passed', evidence_sha256: 'b'.repeat(64) })) })) };
}

test('pilot requires exact bytes and every real Windows gate in both browsers', () => {
  assert.doesNotThrow(() => assertPilotEvidence(report(), checksum, now));
  for (const mutate of [r => { r.installer_sha256 = 'c'.repeat(64); }, r => { r.environment.os = 'Windows Server 2025'; }, r => { r.environment.real_service = false; }, r => { r.browsers.pop(); }, r => { r.browsers[0].checks.pop(); }, r => { r.browsers[1].checks[0].status = 'skipped'; }, r => { r.browsers[0].checks[0].simulated = true; }, r => { r.completed_at = '2020-01-01'; }, r => { r.browsers[0].checks[0].evidence_sha256 = ''; }]) {
    const candidate = report(); mutate(candidate);
    assert.throws(() => assertPilotEvidence(candidate, checksum, now));
  }
});

test('freeze pins bytes independent of a subsequent installer build', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clarin-offline-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  const path = join(source, 'Clarin-Offline-Setup.exe'); await writeFile(path, Buffer.alloc(4096, 0x5a));
  const hash = await sha256File(path); await writeFile(`${path}.sha256`, `${hash}\n`);
  const frozen = await freezeArtifact(source, join(root, 'releases'));
  assert.equal(frozen.sha256, hash); assert.equal(await sha256File(frozen.path), hash);
  assert.deepEqual(await freezeArtifact(source, join(root, 'releases')), frozen);
  await writeFile(path, Buffer.alloc(4096, 0x01));
  assert.equal((await readFile(frozen.path))[0], 0x5a);
  await assert.rejects(verifyArtifact(source), /checksum mismatch/);
  await assert.rejects(verifyArtifact(frozen.directory, { pilot: true }), /ENOENT/);
});
