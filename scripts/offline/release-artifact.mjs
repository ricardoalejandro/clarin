#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerName = 'Clarin-Offline-Setup.exe';
export const requiredWindowsChecks = Object.freeze([
  'install_service_acl', 'loopback_origin_proof', 'ten_users_isolation',
  'same_user_two_accounts', 'same_account_two_users', 'stale_tab_switch',
  'browser_close_offline_reopen', 'windows_reboot_offline_unlock',
  'background_sealed_sync_after_reboot', 'cloudflare_failure_choice',
  'reconnect_preserves_identity_drafts', 'expired_lease_clock_rollback',
  'password_throttle_restart', 'revocation_scopes', 'tamper_replay_wrong_grant',
  'lost_ack_no_duplicate_task', 'read_only_modules', 'cache_no_private_data',
  'quota_disk_full_recovery', 'service_update_preserves_outbox',
]);

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Evidence is a release-process gate, not a cryptographic attestation of the
// Windows host. A green Linux build or mocked service cannot satisfy it.
export function assertPilotEvidence(report, sha256, now = Date.now()) {
  if (report?.schema_version !== 1 || report.protocol_version !== 3 || report.installer_sha256 !== sha256) throw new Error('QA does not match the v3 installer');
  const observed = Date.parse(report.completed_at);
  if (!Number.isFinite(observed) || observed > now + 30000 || now - observed > 7 * 86400000) throw new Error('QA evidence missing or stale');
  if (report.environment?.os !== 'Windows 11' || report.environment.arch !== 'x64' || report.environment.real_service !== true) throw new Error('Real Windows 11 x64 service evidence required');
  for (const channel of ['chrome', 'msedge']) {
    const browser = report.browsers?.find(item => item.channel === channel);
    if (!browser || !/^\d+\.\d+\.\d+\.\d+$/.test(browser.version)) throw new Error(`Missing ${channel} browser version`);
    for (const id of requiredWindowsChecks) {
      const check = browser.checks?.find(item => item.id === id);
      if (check?.status !== 'passed' || check.simulated === true || typeof check.evidence_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(check.evidence_sha256)) throw new Error(`Unverified ${channel} gate: ${id}`);
    }
  }
}

export async function verifyArtifact(directory, { pilot = false, now } = {}) {
  const path = join(resolve(directory), installerName);
  const info = await stat(path);
  if (!info.isFile() || info.size < 1024 || info.size > 512 * 1024 * 1024) throw new Error('Installer absent or invalid size');
  const declared = (await readFile(`${path}.sha256`, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(declared)) throw new Error('Invalid installer checksum');
  const actual = await sha256File(path);
  if (actual !== declared) throw new Error('Installer checksum mismatch');
  if (pilot) {
    const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
    if (manifest.protocol_version !== 3 || manifest.installer_sha256 !== actual) throw new Error('Release manifest does not match v3 installer');
    const report = JSON.parse(await readFile(join(directory, 'windows-qa-report.json'), 'utf8'));
    assertPilotEvidence(report, actual, now);
  }
  return { path, sha256: actual };
}

export async function freezeArtifact(directory, releaseRoot, options = {}) {
  const artifact = await verifyArtifact(directory, options);
  const target = join(resolve(releaseRoot), artifact.sha256);
  await mkdir(target, { recursive: true, mode: 0o755 });
  const frozen = join(target, installerName);
  try { await copyFile(artifact.path, frozen, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Recheck copied bytes rather than trusting the source before a long deploy.
  if (await sha256File(frozen) !== artifact.sha256) throw new Error('Frozen artifact changed; refusing deployment');
  await chmod(frozen, 0o444);
  const checksum = `${frozen}.sha256`;
  try { await writeFile(checksum, `${artifact.sha256}\n`, { flag: 'wx', mode: 0o444 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if ((await readFile(checksum, 'utf8')).trim() !== artifact.sha256) throw new Error('Frozen checksum changed');
  if (options.pilot) {
    for (const filename of ['release-manifest.json', 'windows-qa-report.json']) {
      await copyFile(join(directory, filename), join(target, filename));
    }
    // Also catch changed evidence between checking the source and freezing it.
    await verifyArtifact(target, options);
  }
  return { ...artifact, path: frozen, directory: target };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const [command = 'verify', input = join(root, '.runtime/offline/artifacts'), output = join(root, '.runtime/offline/releases')] = process.argv.slice(2);
  const options = { pilot: process.env.OFFLINE_V3_ENABLED === 'true' };
  try {
    if (!['verify', 'freeze'].includes(command)) throw new Error('Expected verify or freeze');
    const artifact = command === 'freeze' ? await freezeArtifact(input, output, options) : await verifyArtifact(input, options);
    process.stdout.write(command === 'freeze' ? `${artifact.directory}\n` : `${artifact.sha256}\n`);
  } catch (error) {
    process.stderr.write(`Offline release blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}
