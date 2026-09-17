import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const originHost = 'clarin.naperu.cloud';
export function routeRequest(host, path) {
  if (host !== originHost || !path.startsWith('/') || path.startsWith('//')) return null;
  if (/^\/(api|ws|health)(\/|\?|$)/.test(path)) return { hostname: 'backend', port: 8080 };
  return { hostname: 'frontend', port: 3000 };
}

export function startGateway(directory) {
  const marker = JSON.parse(readFileSync(`${directory}/lab.json`, 'utf8'));
  const server = https.createServer({
    key: readFileSync(`${directory}/tls/server.key`), cert: readFileSync(`${directory}/tls/server.crt`),
    minVersion: 'TLSv1.2', requestTimeout: 60_000, headersTimeout: 15_000,
  }, (request, response) => {
    const target = routeRequest(request.headers.host, request.url ?? '');
    if (!target) { response.writeHead(421).end(); return; }
    if (request.url === '/__offline-v3-qa') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Clarin-QA': marker.run_id });
      response.end(JSON.stringify({ kind: 'isolated-offline-v3-lab', run_id: marker.run_id, installer_sha256: marker.installer_sha256, origin: marker.origin }));
      return;
    }
    const upstream = http.request({ ...target, method: request.method, path: request.url, headers: {
      ...request.headers, host: originHost, 'x-forwarded-proto': 'https', 'x-forwarded-host': originHost,
      'x-forwarded-for': request.socket.remoteAddress,
    }, timeout: 55_000 }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    const target = routeRequest(request.headers.host, request.url ?? '');
    if (!target || target.hostname !== 'backend' || !request.url.startsWith('/ws')) { socket.destroy(); return; }
    const upstream = http.request({ ...target, method: request.method, path: request.url, headers: { ...request.headers, 'x-forwarded-proto': 'https' }, timeout: 15_000 });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      remote.setTimeout(0);
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.on('timeout', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); upstream.end();
  });
  server.listen(8443, '0.0.0.0');
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'healthcheck') {
    const request = https.get({ hostname: '127.0.0.1', port: 8443, servername: originHost, path: '/__offline-v3-qa', ca: readFileSync('/lab/tls/ca.crt'), headers: { Host: originHost }, timeout: 3000 }, response => {
      response.resume(); response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
    });
    request.on('error', () => process.exit(1)); request.on('timeout', () => { request.destroy(); process.exit(1); });
  } else startGateway('/lab');
}
