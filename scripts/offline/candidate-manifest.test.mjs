import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertNativeWindowsBinary, windowsQATemplate } from './candidate-manifest.mjs';
import { assertPilotEvidence, requiredWindowsChecks } from './release-artifact.mjs';

test('a candidate can never manufacture Windows acceptance evidence', () => {
  const hash = 'a'.repeat(64);
  const report = windowsQATemplate(hash);
  assert.equal(report.completed_at, null);
  assert.equal(report.environment.real_service, false);
  for (const browser of report.browsers) {
    assert.deepEqual(browser.checks.map(check => check.id), requiredWindowsChecks);
    assert.ok(browser.checks.every(check => check.status === 'not_run' && check.evidence_sha256 === ''));
  }
  assert.throws(() => assertPilotEvidence(report, hash));
  assert.throws(() => windowsQATemplate('../bad'));
});

test('candidate native executables must be actual x64 PE32+ files', () => {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x00004550, 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(0x20b, 152);
  assert.doesNotThrow(() => assertNativeWindowsBinary(bytes));
  for (const candidate of [Buffer.alloc(0), Buffer.alloc(512), (() => { const b = Buffer.from(bytes); b.writeUInt16LE(0x14c,132); return b; })(), (() => { const b = Buffer.from(bytes); b.writeUInt32LE(0xffffffff,0x3c); return b; })()]) {
    assert.throws(() => assertNativeWindowsBinary(candidate));
  }
});

test('candidate packaging is separate and preserves encrypted data during uninstall', async () => {
  const build = await readFile(new URL('../../infra/offline/build-v3-candidate.sh', import.meta.url), 'utf8');
  assert.ok(build.includes('/v3-candidate'));
  assert.ok(!build.includes('/offline/artifacts'));
  assert.ok(!build.includes('electron'));
  const setup = await readFile(new URL('../../infra/offline/configure-service.ps1', import.meta.url), 'utf8');
  assert.ok(setup.includes('NT AUTHORITY\\LocalService'));
  assert.ok(setup.includes('Set-PrivateDirectory $dataRoot $serviceSid $false'));
  assert.ok(!/Remove-Item[^\r\n]*\$dataRoot/.test(setup));
  const nsis = await readFile(new URL('../../infra/offline/offline-v3.nsi', import.meta.url), 'utf8');
  assert.ok(nsis.includes('RequestExecutionLevel admin'));
  assert.ok(nsis.includes('$WINDIR\\Sysnative\\WindowsPowerShell'));
});

test('elevated installer accepts only fixed, protected paths and payloads', async () => {
  const nsis = await readFile(new URL('../../infra/offline/offline-v3.nsi', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../../infra/offline/configure-service.ps1', import.meta.url), 'utf8');
  assert.ok(!nsis.includes('PLUGINSDIR'));
  assert.ok(nsis.includes('CRCCheck force'));
  assert.equal(nsis.match(/StrCmp \$INSTDIR "\$PROGRAMFILES64\\Clarin\\OfflineV3"/g)?.length, 2);
  assert.ok(nsis.includes('ole32::CoCreateGuid'));
  const stageAcl = nsis.indexOf('"$SecureStageDir" /inheritance:r');
  const stagePayload = nsis.indexOf('File "/source/configure-service.ps1"');
  assert.ok(stageAcl >= 0 && stagePayload > stageAcl);
  const uninstaller = nsis.indexOf('WriteUninstaller "$INSTDIR\\Uninstall.exe"');
  assert.ok(uninstaller >= 0 && nsis.indexOf('-Action Configure') > uninstaller);
  for (const token of ['Assert-ScriptLocation', 'Get-HardLinkCount', 'unsafe_payload_hardlink',
    "GetMethod('CreateDirectory'", '[System.Security.AccessControl.DirectorySecurity]',
    'Assert-TrustedAcl', 'Ensure-SafeAncestor $dataVendorRoot', 'Ensure-SafeAncestor $dataOfflineRoot']) {
    assert.ok(setup.includes(token), `Missing installer boundary: ${token}`);
  }
  assert.ok(!setup.includes('$identity.User.Value'));
  assert.ok(!/Remove-Item[^\r\n]*\$dataRoot/.test(setup));
});
