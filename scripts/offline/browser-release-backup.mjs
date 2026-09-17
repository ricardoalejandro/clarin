#!/usr/bin/env node
import { mkdir, writeFile, open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export async function backupRelease() {
  const backupRoot = join(root, '.runtime/offline/v4-backups');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const target = join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(target, { mode: 0o700 });
  const images = {};
  for (const name of ['backend', 'frontend', 'offline-signer', 'task-preview-worker', 'codex-bridge']) {
    const id = docker(['inspect', '--format', '{{.Image}}', `clarin-${name}`]);
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Unexpected running image identifier');
    images[name] = id;
  }
  const dump = join(target, 'clarin-before-v4.dump');
  const output = await open(dump, 'wx', 0o600);
  try {
    await new Promise((done, reject) => {
      const process = spawn('docker', ['exec', 'clarin-postgres', 'pg_dump', '-U', 'clarin', '-d', 'clarin', '--format=custom', '--no-owner', '--no-privileges'], { stdio: ['ignore', output.fd, 'pipe'] });
      let failed = false;
      process.stderr.on('data', () => { failed = true; });
      process.on('error', reject);
      process.on('close', code => code === 0 ? done() : reject(new Error(`Database backup failed (${code}${failed ? ', see private diagnostics' : ''})`)));
    });
  } finally { await output.close(); }
  if ((await stat(dump)).size < 1024) throw new Error('Database archive is unexpectedly small');
  const input = await open(dump, 'r');
  let entries;
  try { entries = execFileSync('docker', ['exec', '-i', 'clarin-postgres', 'pg_restore', '--list'], { encoding: 'utf8', stdio: [input.fd, 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  finally { await input.close(); }
  if (!entries.includes('TABLE public accounts') || !entries.includes('TABLE public users')) throw new Error('The archive is missing required account tables');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(dump)) hash.update(chunk);
  // Keys never enter stdout, source control or a browser artifact. The private
  // parent directory remains 0700 and source key-file permissions are retained.
  docker(['cp', 'clarin-offline-signer:/data', join(target, 'signer-data')]);
  const evidence = { created_at: new Date().toISOString(), images, database_archive: 'clarin-before-v4.dump', bytes: (await stat(dump)).size, sha256: hash.digest('hex'), archive_catalog_verified: true, signer_key_backup: 'private local directory', restored: false };
  await writeFile(join(target, 'backup.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`Backup previo y catálogo verificados: ${target}. No se restauró ni modificó producción.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await backupRelease(); } catch { console.error('Backup incompleto. No desplegar hasta verificar el archivo privado y el estado de Docker.'); process.exitCode = 1; }
}
