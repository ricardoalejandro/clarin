import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredWindowsChecks, sha256File } from './release-artifact.mjs';

export function windowsQATemplate(installerHash) {
  if (!/^[a-f0-9]{64}$/.test(installerHash)) throw new Error('Invalid candidate hash');
  return {
    schema_version: 1, protocol_version: 3, installer_sha256: installerHash, completed_at: null,
    environment: { os: 'not_run', arch: 'not_run', real_service: false },
    browsers: ['chrome', 'msedge'].map(channel => ({ channel, version: '', checks: requiredWindowsChecks.map(id => ({ id, status: 'not_run', simulated: false, evidence_sha256: '' })) })),
  };
}

export function assertNativeWindowsBinary(bytes) {
  if (bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Missing PE executable');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 26 || bytes.readUInt32LE(offset) !== 0x00004550 || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b) throw new Error('Windows x64 PE32+ required');
}

export async function writeCandidateManifest(directory, version, binaryDirectory) {
  if (version !== '3.0.0') throw new Error('Unsupported v3 release version');
  const installer = join(directory, 'Clarin-Offline-Setup.exe');
  const hash = await sha256File(installer);
  const binaries = [];
  for (const name of ['clarin-offline-service.exe', 'clarin-offline-principal.exe']) {
    const bytes = await readFile(join(binaryDirectory, name));
    assertNativeWindowsBinary(bytes);
    binaries.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  const manifest = { schema_version: 1, protocol_version: 3, version, candidate: true, installer_sha256: hash, generated_at: new Date().toISOString(), platform: 'Windows 11 x64', service_account: 'NT AUTHORITY\\LocalService', service_name: 'ClarinOfflineV3', binaries, windows_validation: 'not_run' };
  await writeFile(`${installer}.sha256`, `${hash}\n`);
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Never manufacture or replace a real Windows evidence report.
  await writeFile(join(directory, 'windows-qa-template.json'), JSON.stringify(windowsQATemplate(hash), null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, binaryDirectory] = process.argv.slice(2);
  try { const manifest = await writeCandidateManifest(directory, version, binaryDirectory); process.stdout.write(`${manifest.installer_sha256}\n`); }
  catch (error) { process.stderr.write(`Candidate rejected: ${error.message}\n`); process.exitCode = 1; }
}
