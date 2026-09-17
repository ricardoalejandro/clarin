#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marker = '# Managed by Clarin browser offline deployment. No private data.';

// Dokploy uses the Swarm provider here: labels on Compose containers are not
// consumed. Keep this single feature-owned file separate from its other routes.
export function installBrowserProxy({ directory = '/etc/dokploy/traefik/dynamic', source = join(root, 'infra/offline/traefik-browser-v4.yml'), backupRoot = join(root, '.runtime/offline/proxy-backups') } = {}) {
  if (!existsSync(directory)) return { installed: false, reason: 'dokploy_file_provider_not_present' };
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('unsafe_proxy_directory');
  const desired = readFileSync(source, 'utf8');
  if (!desired.startsWith(marker + '\n')) throw new Error('invalid_proxy_template');
  const target = join(directory, 'clarin-offline-v4.yml');
  const targetStat = lstatSync(target, { throwIfNoEntry: false });
  if (targetStat) {
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('unsafe_proxy_target');
    const current = readFileSync(target, 'utf8');
    if (!current.startsWith(marker + '\n')) throw new Error('proxy_target_not_owned_by_clarin');
    if (current === desired) return { installed: true, changed: false, target };
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const backup = mkdtempSync(join(backupRoot, 'browser-v4-'));
    copyFileSync(target, join(backup, 'clarin-offline-v4.yml'));
  }
  // Copy then rename on the destination filesystem so the watching provider
  // never reads a partially-written YAML file. No proxy restart is required.
  const temporary = mkdtempSync(join(directory, '.clarin-v4-'));
  const staged = join(temporary, 'route.tmp');
  copyFileSync(source, staged);
  renameSync(staged, target);
  rmdirSync(temporary);
  return { installed: true, changed: true, target };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(installBrowserProxy())); }
  catch (error) { console.error('Offline proxy installation failed:', error.code || error.message); process.exitCode = 1; }
}
