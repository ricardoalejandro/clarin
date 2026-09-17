import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBrowserProxy } from './install-browser-proxy.mjs';
const template = new URL('../../infra/offline/traefik-browser-v4.yml', import.meta.url);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clarin-v4-proxy-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const directory = join(dir, 'dynamic');
  mkdirSync(directory);
  const source = join(dir, 'template.yml');
  copyFileSync(template, source);
  return { directory, source, backupRoot: join(dir, 'backups') };
}

test('installs only the feature-owned route atomically and repeats without changes', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'other.yml'), 'preserve unrelated routes');
  assert.equal(installBrowserProxy(f).changed, true);
  assert.equal(installBrowserProxy(f).changed, false);
  assert.equal(readFileSync(join(f.directory, 'other.yml'), 'utf8'), 'preserve unrelated routes');
  assert.deepEqual(readdirSync(f.directory).sort(), ['clarin-offline-v4.yml', 'other.yml']);
});

test('backs up the old owned route before replacing it', t => {
  const f = fixture(t);
  installBrowserProxy(f);
  const old = readFileSync(f.source, 'utf8');
  writeFileSync(f.source, old + '\n# updated template\n');
  assert.equal(installBrowserProxy(f).changed, true);
  const backups = readdirSync(f.backupRoot);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.backupRoot, backups[0], 'clarin-offline-v4.yml'), 'utf8'), old);
});

test('does not overwrite an unrelated file or follow a target symlink', t => {
  const f = fixture(t), target = join(f.directory, 'clarin-offline-v4.yml');
  writeFileSync(target, 'user configuration');
  assert.throws(() => installBrowserProxy(f), /not_owned/);
  assert.equal(readFileSync(target, 'utf8'), 'user configuration');
  rmSync(target);
  symlinkSync(f.source, target);
  assert.throws(() => installBrowserProxy(f), /unsafe_proxy_target/);
});

test('leaves a host without the Dokploy file provider unchanged', t => {
  const f = fixture(t);
  assert.deepEqual(installBrowserProxy({ ...f, directory: join(f.directory, 'absent') }), { installed: false, reason: 'dokploy_file_provider_not_present' });
});

test('file provider routes cover browser v4 and v5 APIs case-insensitively with bounded bodies', () => {
  const yaml = readFileSync(template, 'utf8');
  assert.ok(yaml.includes('Path(`/{offline:(?i:api/(?:offline/v4|admin/offline-v4)(?:/.*)?)}`)'));
  assert.ok(yaml.includes('PathRegexp(`(?i)^/api/(offline/v5|admin/offline-v5)(/.*)?$`)'));
  assert.match(yaml, /priority: 270/);
  assert.match(yaml, /priority: 271/);
  assert.equal((yaml.match(/maxRequestBodyBytes: 2097152/g) || []).length, 2);
  assert.equal((yaml.match(/memRequestBodyBytes: 65536/g) || []).length, 2);
  assert.match(yaml, /url: http:\/\/clarin-backend:8080/);
});
