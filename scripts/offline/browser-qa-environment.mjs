#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, chmod, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const labRoot = join(root, '.runtime/offline/v4-qa');
export const labOrigin = 'http://localhost:19444';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const secret = () => randomBytes(32).toString('hex');
const privateWrite = (file, body) => writeFile(file, body, { mode: 0o600, flag: 'wx' });
export async function verifyLabIdentity() {
  const stat = await lstat(labRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || await realpath(labRoot) !== labRoot) throw new Error('Unsafe laboratory directory');
  const marker = JSON.parse(await readFile(join(labRoot, 'lab.json'), 'utf8'));
  const response = await labRequest('/__offline-v4-qa');
  const actual = JSON.parse(response.text);
  if (response.status !== 200 || actual.kind !== 'isolated-offline-v4-lab' || actual.run_id !== marker.run_id || actual.origin !== labOrigin) throw new Error('Not the exact isolated v4 lab');
  return marker;
}
export function labRequest(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new Error('Invalid lab path');
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveResponse, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: 19444, path, method, timeout: 60000,
      headers: { Host: 'localhost:19444', Origin: labOrigin, ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}) } }, response => {
      const parts = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > 16 * 1024 * 1024) response.destroy(new Error('QA response limit')); else parts.push(chunk); });
      response.on('error', reject); response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('QA timeout'))); request.end(raw);
  });
}
async function prepare() {
  await mkdir(labRoot, { mode: 0o700 }); // Never overwrite an existing run or its evidence.
  await mkdir(join(labRoot, 'code'), { mode: 0o755 });
  const images = Object.fromEntries(['backend', 'frontend', 'offline-signer', 'postgres', 'redis', 'minio'].map(name => [name, docker(['image', 'inspect', '--format', '{{.Id}}', name === 'backend' || name === 'frontend' || name === 'offline-signer' ? `clarin-${name}` : docker(['inspect', '--format', '{{.Image}}', `clarin-${name}`])]) ]));
  if (Object.values(images).some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw new Error('Immutable QA image IDs required');
  const marker = { schema_version: 1, kind: 'isolated-offline-v4-lab', run_id: randomUUID(), origin: labOrigin, images, created_at: new Date().toISOString() };
  await privateWrite(join(labRoot, 'lab.json'), JSON.stringify(marker, null, 2));
  const dbPassword = secret(), minioPassword = secret(), adminPassword = `Qa!9${secret()}`;
  await privateWrite(join(labRoot, 'postgres.env'), `POSTGRES_USER=offlineqa\nPOSTGRES_DB=offlineqa\nPOSTGRES_PASSWORD=${dbPassword}\n`);
  await privateWrite(join(labRoot, 'minio.env'), `MINIO_ROOT_USER=offlineqa\nMINIO_ROOT_PASSWORD=${minioPassword}\n`);
  const backend = { DATABASE_URL: `postgres://offlineqa:${dbPassword}@postgres:5432/offlineqa?sslmode=disable`, REDIS_URL: 'redis://redis:6379', JWT_SECRET: secret(), PORT: '8080', ENV: 'production',
    ADMIN_USER: 'offlineqa_superadmin', ADMIN_PASSWORD: adminPassword, ADMIN_EMAIL: 'offlineqa-superadmin@example.invalid', CORS_ORIGINS: labOrigin, PUBLIC_URL: labOrigin,
    MINIO_ENDPOINT: 'minio:9000', MINIO_ACCESS_KEY: 'offlineqa', MINIO_SECRET_KEY: minioPassword, MINIO_BUCKET: 'clarin-media', MINIO_USE_SSL: 'false', MINIO_PUBLIC_URL: `${labOrigin}/qa-media-unavailable`,
    EROS_ENABLED: 'false', KOMMO_OUTBOX_ENABLED: 'false', WHATSAPP_STATUS_ENABLED: 'false', WHATSAPP_STATUS_SYNC_ENABLED: 'false',
    OFFLINE_V4_ENABLED: 'true', OFFLINE_V4_TASK_WRITES_ENABLED: 'true', OFFLINE_V4_SERVER_ORIGIN: labOrigin, OFFLINE_V3_ENABLED: 'false', OFFLINE_V3_TASK_WRITES_ENABLED: 'false',
    OFFLINE_TERMINALS_ENABLED: 'false', OFFLINE_CONTROL_ENABLED: 'false', OFFLINE_ENROLLMENT_ENABLED: 'false', OFFLINE_SYNC_READ_ENABLED: 'false', OFFLINE_WRITE_TASKS_ENABLED: 'false',
    OFFLINE_SIGNER_ADDRESS: 'http://clarin-offline-signer:8200', OFFLINE_SIGNER_TOKEN_FILE: '/run/clarin-offline-signer/token',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', HTTPS_PROXY: 'http://turnstile-proxy:3128', NO_PROXY: 'localhost,127.0.0.1,postgres,redis,minio,signer,clarin-offline-signer,backend,frontend' };
  await privateWrite(join(labRoot, 'backend.env'), Object.entries(backend).map(([k,v]) => `${k}=${v}\n`).join(''));
  await privateWrite(join(labRoot, 'credentials.json'), JSON.stringify({ admin: { username: backend.ADMIN_USER, password: adminPassword }, users: Array.from({ length: 10 }, (_,i) => ({ username: `offlineqa_user_${String(i+1).padStart(2,'0')}`, password: `Qa!9${secret()}` })) }));
  for (const file of ['browser-gateway.mjs', 'sync-metrics.mjs', 'turnstile-proxy.mjs']) { await copyFile(join(root, 'infra/offline/qa', file), join(labRoot, 'code', file)); await chmod(join(labRoot, 'code', file), 0o644); }
  const hardening = { restart: 'no', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], networks: ['isolated'], labels: { 'clarin.offline-v4.qa': 'synthetic-only' }, pids_limit: 256 };
  const health = test => ({ test, interval: '3s', timeout: '3s', retries: 40 });
  const service = (name, extra) => ({ ...hardening, image: images[name], ...extra });
  const bind = (source,target) => ({ type: 'bind', source: join(labRoot,source), target, read_only: true, bind: { create_host_path: false } });
  const compose = { name: 'clarin-offline-v4-lab', services: {
    postgres: service('postgres',{ cap_drop: [], mem_limit: '512m', env_file: [join(labRoot,'postgres.env')], volumes: ['postgres:/var/lib/postgresql/data'], healthcheck: health(['CMD','pg_isready','-U','offlineqa','-d','offlineqa']) }),
    redis: service('redis',{ user:'999:999',mem_limit:'128m',command:['redis-server','--appendonly','yes','--maxmemory','80mb','--maxmemory-policy','noeviction'],volumes:['redis:/data'],healthcheck:health(['CMD','redis-cli','ping']) }),
    minio: service('minio',{mem_limit:'384m',command:['server','/data','--console-address',':9001'],env_file:[join(labRoot,'minio.env')],volumes:['minio:/data'],healthcheck:health(['CMD','curl','-f','http://localhost:9000/minio/health/live'])}),
    signer: service('offline-signer',{ user:'0:65532',read_only:true,mem_limit:'128m',networks:{isolated:{aliases:['clarin-offline-signer']}},environment:{OFFLINE_V4_SERVER_ORIGIN:labOrigin},volumes:['signer-key:/data','signer-auth:/auth'],tmpfs:['/tmp:size=16m,mode=1777'],healthcheck:health(['CMD','/offline-signer','healthcheck'])}),
    backend: service('backend',{mem_limit:'1536m',env_file:[join(labRoot,'backend.env')],volumes:['sessions:/app/sessions','signer-auth:/run/clarin-offline-signer:ro'],depends_on:Object.fromEntries(['postgres','redis','minio','signer'].map(n=>[n,{condition:'service_healthy'}])),healthcheck:health(['CMD','wget','-qO-','http://127.0.0.1:8080/health'])}),
    frontend: service('frontend',{mem_limit:'1024m',environment:{NODE_ENV:'production',HOSTNAME:'0.0.0.0',PORT:'3000'}}),
    gateway: service('frontend',{user:'0:0',read_only:true,mem_limit:'128m',networks:['isolated','loopback-edge'],entrypoint:['node','/qa/browser-gateway.mjs'],volumes:[bind('code','/qa'),bind('lab.json','/lab/lab.json')],ports:[{target:8080,published:'19444',host_ip:'127.0.0.1',protocol:'tcp'}]}),
    'turnstile-proxy': service('frontend',{user:'65532:65532',read_only:true,mem_limit:'128m',networks:['isolated','verification-egress'],entrypoint:['node','/qa/turnstile-proxy.mjs'],volumes:[bind('code','/qa')]})
  },volumes:Object.fromEntries(['postgres','redis','minio','signer-key','signer-auth','sessions'].map(n=>[n,{}])),networks:{isolated:{internal:true},'loopback-edge':{},'verification-egress':{}} };
  await privateWrite(join(labRoot,'compose.json'), JSON.stringify(compose,null,2));
  console.log('Laboratorio v4 preparado; datos sintéticos, solo loopback, sin instalador ni certificados de cliente.');
}
async function refreshImages() {
  const marker = await verifyLabIdentity();
  const compose = JSON.parse(await readFile(join(labRoot, 'compose.json'), 'utf8'));
  if (compose.name !== 'clarin-offline-v4-lab') throw new Error('Unexpected compose target');
  marker.image_history = [...(marker.image_history || []), { at: new Date().toISOString(), images: { ...marker.images } }];
  for (const name of ['backend', 'frontend', 'offline-signer']) {
    // Ordinary web modules have build-time API URLs. A QA-origin build prevents
    // the real browser from sending synthetic logins or mutations to production.
    const tag = name === 'frontend' ? 'clarin-frontend-offline-v4-qa'
      : name === 'backend' ? (process.env.OFFLINE_QA_BACKEND_IMAGE || 'clarin-backend') : `clarin-${name}`;
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Immutable QA image required');
    marker.images[name] = id;
  }
  compose.services.backend.image = marker.images.backend;
  compose.services.signer.image = marker.images['offline-signer'];
  for (const name of ['frontend', 'gateway', 'turnstile-proxy']) compose.services[name].image = marker.images.frontend;
  await writeFile(join(labRoot, 'compose.json'), JSON.stringify(compose, null, 2), { mode: 0o600 });
  await writeFile(join(labRoot, 'lab.json'), JSON.stringify(marker, null, 2), { mode: 0o600 });
  await copyFile(join(root, 'infra/offline/qa/browser-gateway.mjs'), join(labRoot, 'code/browser-gateway.mjs'));
  await copyFile(join(root, 'infra/offline/qa/sync-metrics.mjs'), join(labRoot, 'code/sync-metrics.mjs'));
  console.log('Referencias del laboratorio actualizadas a imágenes inmutables; ejecutar compose up para aplicarlas.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv[2] === 'prepare') await prepare(); else if (process.argv[2] === 'refresh-images') await refreshImages(); else if (process.argv[2] === 'verify') { await verifyLabIdentity(); console.log('Identidad del laboratorio v4 verificada.'); } else throw new Error('Expected prepare, refresh-images or verify'); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
