#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { verifyArtifact } from './release-artifact.mjs';
import { windowsQATemplate } from './candidate-manifest.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const labRoot = join(projectRoot, '.runtime/offline/v3-qa');
export const labProject = 'clarin-offline-v3-lab';
export const labOrigin = 'https://clarin.naperu.cloud';
const productionImages = { backend: 'clarin-backend', frontend: 'clarin-frontend', signer: 'clarin-offline-signer', postgres: 'clarin-postgres', redis: 'clarin-redis', minio: 'clarin-minio' };
const json = value => JSON.stringify(value, null, 2) + '\n';
const secret = () => randomBytes(32).toString('hex');
export const syntheticPassword = () => `Qa!9${secret()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const inspectImages = () => Object.fromEntries(Object.entries(productionImages).map(([key, container]) => [key, docker(['inspect', '--format', '{{.Image}}', container]).trim()]));
export function assertQAAvailability(value) {
  if (value?.enabled !== true || value.signer_ready !== true || value.task_writes_enabled !== true || value.protocol_version !== 3 || value.minimum_client_version !== '3.0.0') throw new Error('QA v3 data plane or signer is not ready');
}

export function composeDefinition(images, directory) {
  for (const name of Object.keys(productionImages)) if (!/^sha256:[a-f0-9]{64}$/.test(images[name] ?? '')) throw new Error(`Missing immutable ${name} image ID`);
  if (directory !== labRoot) throw new Error('QA root must be the dedicated repository directory');
  const hardening = { restart: 'no', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], networks: ['isolated'], labels: { 'clarin.offline-v3.qa': 'synthetic-only' }, pids_limit: 256 };
  const bind = (source, target, read_only = true) => ({ type: 'bind', source: join(directory, source), target, read_only, bind: { create_host_path: false } });
  const service = (name, extra) => ({ ...hardening, image: images[name], ...extra });
  const node = extra => service('frontend', { read_only: true, user: '65532:65532', tmpfs: ['/tmp:size=32m,mode=1777'], mem_limit: '128m', ...extra });
  return {
    name: labProject,
    services: {
      postgres: service('postgres', { cap_drop: [], mem_limit: '512m', shm_size: '128m', env_file: [join(directory, 'postgres.env')], volumes: ['postgres:/var/lib/postgresql/data'], healthcheck: { test: ['CMD', 'pg_isready', '-U', 'offlineqa', '-d', 'offlineqa'], interval: '3s', timeout: '3s', retries: 30 } }),
      redis: service('redis', { user: '999:999', mem_limit: '128m', command: ['redis-server', '--appendonly', 'yes', '--maxmemory', '80mb', '--maxmemory-policy', 'noeviction'], volumes: ['redis:/data'], healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '3s', timeout: '3s', retries: 30 } }),
      minio: service('minio', { mem_limit: '384m', command: ['server', '/data'], env_file: [join(directory, 'minio.env')], volumes: ['minio:/data'], healthcheck: { test: ['CMD', 'mc', 'ready', 'local'], interval: '3s', timeout: '3s', retries: 30 } }),
      signer: service('signer', { user: '0:65532', read_only: true, networks: { isolated: { aliases: ['clarin-offline-signer'] } }, mem_limit: '128m', environment: { OFFLINE_V3_SERVER_ORIGIN: labOrigin, OFFLINE_V3_SIGNING_KEY_VERSION: '3' }, volumes: ['signer-key:/data', 'signer-auth:/auth'], tmpfs: ['/tmp:size=16m,mode=1777'], healthcheck: { test: ['CMD', '/offline-signer', 'healthcheck'], interval: '3s', timeout: '3s', retries: 30 } }),
      backend: service('backend', { mem_limit: '1536m', env_file: [join(directory, 'backend.env')], volumes: ['sessions:/app/sessions', 'signer-auth:/run/clarin-offline-signer:ro', bind('candidate', '/run/qa-installer')], depends_on: Object.fromEntries(['postgres', 'redis', 'minio', 'signer'].map(name => [name, { condition: 'service_healthy' }])), healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/health'], interval: '5s', timeout: '5s', retries: 60 } }),
      frontend: service('frontend', { mem_limit: '512m', environment: { HOSTNAME: '0.0.0.0', NEXT_TELEMETRY_DISABLED: '1' }, healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '5s', timeout: '5s', retries: 30 } }),
      gateway: node({ user: '0:0', networks: ['isolated', 'loopback-edge'], command: ['node', '/qa/gateway.mjs'], volumes: [bind('code', '/qa'), bind('lab.json', '/lab/lab.json'), bind('tls/server.key', '/lab/tls/server.key'), bind('tls/server.crt', '/lab/tls/server.crt'), bind('tls/ca.crt', '/lab/tls/ca.crt')], ports: [{ target: 8443, published: '19443', host_ip: '127.0.0.1', protocol: 'tcp' }], healthcheck: { test: ['CMD', 'node', '/qa/gateway.mjs', 'healthcheck'], interval: '3s', timeout: '4s', retries: 20 }, depends_on: { backend: { condition: 'service_healthy' }, frontend: { condition: 'service_healthy' } } }),
      'turnstile-proxy': node({ profiles: ['turnstile-test'], networks: ['isolated', 'test-egress'], command: ['node', '/qa/turnstile-proxy.mjs'], volumes: [bind('code', '/qa')] }),
    },
    networks: { isolated: { internal: true, driver: 'bridge' }, 'loopback-edge': { internal: false, driver: 'bridge', driver_opts: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' } }, 'test-egress': { internal: false, driver: 'bridge' } },
    volumes: Object.fromEntries(['postgres', 'redis', 'minio', 'signer-key', 'signer-auth', 'sessions'].map(name => [name, {}])),
  };
}

export async function assertPrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('QA directory must be owned by the current operator and mode 0700');
  if (await realpath(path) !== resolve(path)) throw new Error('QA directory cannot traverse a symbolic link');
}

async function privateWrite(path, content) { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); }
async function initialize() {
  const artifact = await verifyArtifact(join(projectRoot, '.runtime/offline/v3-candidate'));
  const release = JSON.parse(await readFile(join(dirname(artifact.path), 'release-manifest.json'), 'utf8'));
  if (release.protocol_version !== 3 || release.installer_sha256 !== artifact.sha256) throw new Error('Exact v3 candidate manifest required');
  await mkdir(labRoot, { mode: 0o700 }); // Refuse overwrite/reset of an existing lab.
  await assertPrivateDirectory(labRoot);
  for (const directory of ['tls', 'code', 'candidate']) await mkdir(join(labRoot, directory), { mode: 0o700 });
  const images = inspectImages();
  const manifest = { schema_version: 1, kind: 'isolated-offline-v3-lab', run_id: randomUUID(), origin: labOrigin, installer_sha256: artifact.sha256, created_at: new Date().toISOString(), images, windows_validation: 'not_run', turnstile: 'official-test-keys-only' };
  await privateWrite(join(labRoot, 'lab.json'), json(manifest));
  await copyFile(artifact.path, join(labRoot, 'candidate/Clarin-Offline-Setup.exe'));
  await privateWrite(join(labRoot, 'candidate/Clarin-Offline-Setup.exe.sha256'), artifact.sha256 + '\n');
  await privateWrite(join(labRoot, 'candidate/release-manifest.json'), json(release));
  await chmod(join(labRoot, 'candidate/Clarin-Offline-Setup.exe'), 0o444);
  for (const file of ['gateway.mjs', 'turnstile-proxy.mjs']) await copyFile(join(projectRoot, 'infra/offline/qa', file), join(labRoot, 'code', file));
  // Containers need to traverse only this mount, not the enclosing private lab.
  await chmod(join(labRoot, 'code'), 0o755);
  const dbPassword = secret(), minioPassword = secret(), adminPassword = secret();
  await privateWrite(join(labRoot, 'postgres.env'), `POSTGRES_USER=offlineqa\nPOSTGRES_DB=offlineqa\nPOSTGRES_PASSWORD=${dbPassword}\n`);
  await privateWrite(join(labRoot, 'minio.env'), `MINIO_ROOT_USER=offlineqa\nMINIO_ROOT_PASSWORD=${minioPassword}\n`);
  const backend = {
    DATABASE_URL: `postgres://offlineqa:${dbPassword}@postgres:5432/offlineqa?sslmode=disable`, REDIS_URL: 'redis://redis:6379', JWT_SECRET: secret(), PORT: '8080', ENV: 'production',
    ADMIN_USER: 'offlineqa_superadmin', ADMIN_PASSWORD: adminPassword, ADMIN_EMAIL: 'offlineqa-superadmin@example.invalid', CORS_ORIGINS: labOrigin, PUBLIC_URL: labOrigin,
    MINIO_ENDPOINT: 'minio:9000', MINIO_ACCESS_KEY: 'offlineqa', MINIO_SECRET_KEY: minioPassword, MINIO_BUCKET: 'clarin-media', MINIO_USE_SSL: 'false', MINIO_PUBLIC_URL: `${labOrigin}/qa-media-unavailable`,
    EROS_ENABLED: 'false', KOMMO_OUTBOX_ENABLED: 'false', WHATSAPP_STATUS_ENABLED: 'false', WHATSAPP_STATUS_SYNC_ENABLED: 'false',
    OFFLINE_V3_ENABLED: 'true', OFFLINE_V3_TASK_WRITES_ENABLED: 'true', OFFLINE_V3_SERVER_ORIGIN: labOrigin, OFFLINE_V3_MIN_CLIENT_VERSION: '3.0.0',
    OFFLINE_TERMINALS_ENABLED: 'false', OFFLINE_CONTROL_ENABLED: 'false', OFFLINE_ENROLLMENT_ENABLED: 'false', OFFLINE_SYNC_READ_ENABLED: 'false', OFFLINE_WRITE_TASKS_ENABLED: 'false',
    OFFLINE_SIGNER_ADDRESS: 'http://clarin-offline-signer:8200', OFFLINE_SIGNER_TOKEN_FILE: '/run/clarin-offline-signer/token', OFFLINE_INSTALLER_PATH: '/run/qa-installer/Clarin-Offline-Setup.exe', OFFLINE_INSTALLER_SHA256: artifact.sha256,
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', HTTPS_PROXY: 'http://turnstile-proxy:3128', NO_PROXY: 'localhost,127.0.0.1,postgres,redis,minio,signer,clarin-offline-signer,backend,frontend',
  };
  await privateWrite(join(labRoot, 'backend.env'), Object.entries(backend).map(([key, value]) => `${key}=${value}\n`).join(''));
  await privateWrite(join(labRoot, 'credentials.json'), json({ admin: { username: backend.ADMIN_USER, password: adminPassword }, users: Array.from({ length: 10 }, (_, index) => ({ username: `offlineqa_user_${String(index + 1).padStart(2, '0')}`, password: syntheticPassword() })) }));
  await privateWrite(join(labRoot, 'compose.json'), json(composeDefinition(images, labRoot)));
  const openssl = args => execFileSync('openssl', args, { cwd: join(labRoot, 'tls'), stdio: 'ignore' });
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '14', '-subj', '/CN=Clarin Offline V3 DISPOSABLE QA ONLY', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.crt']);
  openssl(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-subj', '/CN=clarin.naperu.cloud', '-keyout', 'server.key', '-out', 'server.csr']);
  await privateWrite(join(labRoot, 'tls/server.ext'), 'subjectAltName=DNS:clarin.naperu.cloud\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '7', '-sha256', '-extfile', 'server.ext', '-out', 'server.crt']);
  await chmod(join(labRoot, 'tls/ca.key'), 0o600); await chmod(join(labRoot, 'tls/server.key'), 0o600);
  console.log(`QA aislado preparado en ${labRoot}; no iniciado, no publicado y Windows not_run.`);
}

export async function labRequest(path, { method = 'GET', body, cookie } = {}) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new Error('Only a local QA path is allowed');
  const ca = await readFile(join(labRoot, 'tls/ca.crt'));
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise((resolveResponse, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: 19443, servername: 'clarin.naperu.cloud', ca, rejectUnauthorized: true, path, method, timeout: 20_000, headers: { Host: 'clarin.naperu.cloud', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > 16 * 1024 * 1024) { response.destroy(new Error('QA response exceeds limit')); return; } chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('QA request timed out'))); request.on('error', reject); request.end(payload);
  });
}

export async function verifyLabIdentity() {
  await assertPrivateDirectory(labRoot);
  const manifest = JSON.parse(await readFile(join(labRoot, 'lab.json'), 'utf8'));
  const response = await labRequest('/__offline-v3-qa');
  const remote = JSON.parse(response.text);
  if (response.status !== 200 || manifest.kind !== 'isolated-offline-v3-lab' || remote.kind !== manifest.kind || remote.run_id !== manifest.run_id || remote.installer_sha256 !== manifest.installer_sha256 || remote.origin !== labOrigin) throw new Error('Not this exact isolated lab; refusing requests');
  const artifact = await verifyArtifact(join(labRoot, 'candidate'));
  if (artifact.sha256 !== manifest.installer_sha256) throw new Error('QA candidate changed');
  return manifest;
}

async function smoke() {
  const manifest = await verifyLabIdentity();
  const checks = [];
  for (const path of ['/health', '/api/version', '/api/public/security-config', '/api/offline/v3/runtime/availability', '/login', '/sw.js', '/offline-v3/index.html']) {
    const response = await labRequest(path);
    checks.push({ path, status: response.status, sha256: createHash('sha256').update(response.text).digest('hex') });
    if (response.status !== 200) throw new Error(`QA smoke failed: ${path} status ${response.status}`);
    if (path === '/api/public/security-config') {
      const cfg = JSON.parse(response.text);
      if (!cfg.login_enabled || !cfg.login_turnstile_required || cfg.turnstile_site_key !== '1x00000000000000000000AA') throw new Error('Turnstile test configuration is not enforced');
    }
    if (path === '/api/offline/v3/runtime/availability') assertQAAvailability(JSON.parse(response.text));
  }
  const report = { schema_version: 1, kind: 'linux-isolated-stack-smoke', run_id: manifest.run_id, installer_sha256: manifest.installer_sha256, checked_at: new Date().toISOString(), checks, windows_validation: 'not_run' };
  const output = join(labRoot, `smoke-${Date.now()}.json`); await privateWrite(output, json(report)); console.log(`QA smoke correcto: ${checks.length} rutas; evidencia ${output}. No es validación Windows.`);
}

async function exportWindowsKit() {
  const lab = await verifyLabIdentity();
  const directory = join(labRoot, `windows-kit-${lab.installer_sha256.slice(0, 12)}-${Date.now()}`);
  await mkdir(directory, { mode: 0o700 });
  for (const file of ['Clarin-Offline-Setup.exe', 'Clarin-Offline-Setup.exe.sha256', 'release-manifest.json']) await copyFile(join(labRoot, 'candidate', file), join(directory, file));
  await copyFile(join(labRoot, 'tls/ca.crt'), join(directory, 'qa-ca.crt'));
  await copyFile(join(projectRoot, 'infra/offline/Test-OfflineV3.ps1'), join(directory, 'Test-OfflineV3.ps1'));
  await copyFile(join(projectRoot, 'docs/offline-v3-qa-laboratory.md'), join(directory, 'LEER-PRIMERO.md'));
  await privateWrite(join(directory, 'lab-identity.json'), json({ kind: lab.kind, run_id: lab.run_id, origin: lab.origin, installer_sha256: lab.installer_sha256, windows_validation: 'not_run' }));
  await privateWrite(join(directory, 'windows-qa-template.json'), json(windowsQATemplate(lab.installer_sha256)));
  console.log(`Kit de laboratorio exportado en ${directory}; contiene sólo artefactos y certificado público, ninguna contraseña/clave privada.`);
}

async function refreshCapture(compose) {
  const lab = await verifyLabIdentity();
  // No in-progress Windows enrollment may silently change its tested stack.
  const dbContainer = `${labProject}-postgres-1`;
  const project = docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', dbContainer]).trim();
  if (project !== labProject) throw new Error('QA PostgreSQL container identity mismatch');
  const counts = docker(['exec', dbContainer, 'psql', '-U', 'offlineqa', '-d', 'offlineqa', '-Atc', 'SELECT (SELECT count(*) FROM offline_v3_grants) + (SELECT count(*) FROM offline_v3_enrollment_requests)']).trim();
  if (counts !== '0') throw new Error('Existing offline enrollments prevent capture refresh; use a fresh disposable laboratory');
  const artifact = await verifyArtifact(join(projectRoot, '.runtime/offline/v3-candidate'));
  const release = JSON.parse(await readFile(join(dirname(artifact.path), 'release-manifest.json'), 'utf8'));
  if (release.protocol_version !== 3 || release.installer_sha256 !== artifact.sha256) throw new Error('Current v3 candidate manifest required');
  const images = inspectImages();
  const definition = composeDefinition(images, labRoot);
  docker([...compose, '--profile', 'turnstile-test', 'stop', '--timeout', '20']);
  const archive = join(labRoot, `capture-before-${Date.now()}`); await mkdir(archive, { mode: 0o700 });
  for (const file of ['lab.json', 'compose.json']) await copyFile(join(labRoot, file), join(archive, file));
  for (const file of ['Clarin-Offline-Setup.exe', 'Clarin-Offline-Setup.exe.sha256', 'release-manifest.json']) await copyFile(join(labRoot, 'candidate', file), join(archive, file));
  const updated = { ...lab, images, installer_sha256: artifact.sha256, captured_at: new Date().toISOString(), capture_revision: (lab.capture_revision ?? 1) + 1, windows_validation: 'not_run' };
  await copyFile(artifact.path, join(labRoot, 'candidate/Clarin-Offline-Setup.exe'));
  await writeFile(join(labRoot, 'candidate/Clarin-Offline-Setup.exe.sha256'), artifact.sha256 + '\n');
  await writeFile(join(labRoot, 'candidate/release-manifest.json'), json(release));
  await writeFile(join(labRoot, 'lab.json'), json(updated));
  await writeFile(join(labRoot, 'compose.json'), json(definition));
  const backendPath = join(labRoot, 'backend.env');
  const backend = await readFile(backendPath, 'utf8');
  await writeFile(backendPath, backend.replace(/^OFFLINE_INSTALLER_SHA256=.*$/m, `OFFLINE_INSTALLER_SHA256=${artifact.sha256}`)
    .replace(/^OFFLINE_SIGNER_ADDRESS=.*$/m, 'OFFLINE_SIGNER_ADDRESS=http://clarin-offline-signer:8200')
    .replace(/^NO_PROXY=.*$/m, 'NO_PROXY=localhost,127.0.0.1,postgres,redis,minio,signer,clarin-offline-signer,backend,frontend'));
  for (const file of ['gateway.mjs', 'turnstile-proxy.mjs']) await copyFile(join(projectRoot, 'infra/offline/qa', file), join(labRoot, 'code', file));
  console.log('Captura QA actualizada y anterior conservada; laboratorio detenido. Ejecuta up y smoke antes de probar Windows. Toda evidencia anterior queda obsoleta.');
}

export async function runCommand(command, flags = []) {
  if (command === 'init') return initialize();
  await assertPrivateDirectory(labRoot);
  const compose = ['compose', '--project-name', labProject, '--env-file', '/dev/null', '--file', join(labRoot, 'compose.json')];
  if (flags.some(flag => flag !== '--turnstile-test')) throw new Error('Unsupported QA option');
  if (flags.includes('--turnstile-test')) compose.push('--profile', 'turnstile-test');
  if (command === 'up') {
    const manifest = JSON.parse(await readFile(join(labRoot, 'lab.json'), 'utf8'));
    const actual = JSON.parse(await readFile(join(labRoot, 'compose.json'), 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(composeDefinition(manifest.images, labRoot))) throw new Error('QA compose changed; refusing unreviewed services, mounts, or networks');
    docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '180', '--pull', 'never']); console.log('QA iniciado sólo en 127.0.0.1:19443. Producción no modificada.');
  }
  else if (command === 'stop') { docker([...compose, '--profile', 'turnstile-test', 'stop', '--timeout', '20']); console.log('QA detenido; datos sintéticos conservados.'); }
  else if (command === 'status') console.log(docker([...compose, 'ps']));
  else if (command === 'smoke') await smoke();
  else if (command === 'kit') await exportWindowsKit();
  else if (command === 'refresh') await refreshCapture(compose);
  else throw new Error('Expected init, up [--turnstile-test], smoke, kit, refresh, status or stop');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCommand(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(`QA detenido: ${Number.isInteger(error.status) ? `external_command_failed_${error.status}` : error.code ?? error.message}. No se imprimen credenciales ni salida privada de contenedores.`); process.exitCode = 1; }
}
