import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createSyncMetrics, isReplayRejection } from './sync-metrics.mjs';

const marker = JSON.parse(readFileSync('/lab/lab.json', 'utf8'));
if (marker.kind !== 'isolated-offline-v4-lab' || marker.origin !== 'http://localhost:19444') throw new Error('Not the browser-only QA lab');
const faults = { unavailable: false, cloudflare: false, lost_ack: false, sync_unavailable: false };
const upgradedSockets = new Set();
const syncMetrics = createSyncMetrics();
const server = http.createServer({ requestTimeout: 60000, headersTimeout: 15000 }, (request, response) => {
  if (request.headers.host !== 'localhost:19444') { response.writeHead(421).end(); return; }
  if (request.url === '/__offline-v4-qa') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ kind: marker.kind, run_id: marker.run_id, origin: marker.origin })); return;
  }
  if (request.url === '/__offline-v4-qa/sync-metrics') {
    if (request.method !== 'GET' || request.headers['x-qa-run'] !== marker.run_id) { response.writeHead(403).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ items: syncMetrics.snapshot() })); return;
  }
  if (request.url === '/__offline-v4-qa/control' && request.method === 'POST' && request.headers['x-qa-run'] === marker.run_id) {
    let raw = ''; request.on('data', chunk => { raw += chunk; if (raw.length > 2048) request.destroy(); });
    request.on('end', () => { try { const input = JSON.parse(raw); for (const key of Object.keys(faults)) if (typeof input[key] === 'boolean') faults[key] = input[key]; if (input.reset_sync_metrics === true) syncMetrics.reset(); if (faults.unavailable || faults.cloudflare) for (const socket of upgradedSockets) socket.destroy(); response.writeHead(204).end(); } catch { response.writeHead(400).end(); } }); return;
  }
  if (faults.unavailable) { request.socket.destroy(); return; }
  // Model a sync-only transport failure while online authentication remains
  // reachable: another actor must never acquire the first actor's pending queue.
  if (faults.sync_unavailable && /^\/api\/offline\/v4\/sync(?:\/challenge)?(?:\?|$)/.test(request.url || '')) { request.socket.destroy(); return; }
  if (faults.cloudflare) { response.writeHead(503, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<h1>Cloudflare QA unavailable</h1>'); return; }
  const api = /^\/(api|ws|health)(\/|\?|$)/.test(request.url || '');
  const syncMetric = request.method === 'POST' && request.url === '/api/offline/v4/sync' ? syncMetrics.start() : null;
  if (syncMetric) {
    request.on('data', chunk => { syncMetric.bytes += chunk.length; });
    request.on('end', () => { syncMetric.complete = true; });
  }
  const upstream = http.request({ hostname: api ? 'backend' : 'frontend', port: api ? 8080 : 3000, method: request.method, path: request.url,
    headers: { ...request.headers, 'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost:19444' }, timeout: 55000 }, incoming => {
    if (syncMetric) syncMetric.status = incoming.statusCode || 502;
    if (syncMetric && incoming.statusCode === 409) {
      // Only retain a boolean for the exact replay guard. Successful task
      // responses and request bodies are never inspected or retained.
      let bytes = 0; let parts = [];
      incoming.on('data', chunk => { bytes += chunk.length; if (bytes <= 4096) parts.push(chunk); else parts = []; });
      incoming.on('end', () => { syncMetric.replay_rejected = bytes <= 4096 && isReplayRejection(Buffer.concat(parts).toString('utf8')); parts = []; });
    }
    if (faults.lost_ack && request.method === 'POST' && request.url === '/api/offline/v4/sync') {
      if (syncMetric) syncMetric.lost_ack = true;
      faults.lost_ack = false; incoming.resume(); incoming.on('end', () => response.destroy()); return;
    }
    // The QA build already uses the exact lab origin. Preserve the artifact's
    // bytes and encoding, including compressed manifests requested by browsers.
    response.writeHead(incoming.statusCode || 502, incoming.headers); incoming.pipe(response);
    incoming.on('error', () => response.destroy());
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => upstream.destroy()); response.on('close', () => upstream.destroy()); request.pipe(upstream);
});
// Preserve the real online WebSocket path too; the laboratory must not replace
// realtime reconciliation with a fake successful connection.
server.on('upgrade', (request, socket, head) => {
  if (request.headers.host !== 'localhost:19444' || !/^\/ws(?:\/|\?|$)/.test(request.url || '') || faults.unavailable || faults.cloudflare) { socket.destroy(); return; }
  const upstream = net.createConnection({ host: 'backend', port: 8080 });
  upgradedSockets.add(socket); upgradedSockets.add(upstream);
  const close = () => { upgradedSockets.delete(socket); upgradedSockets.delete(upstream); socket.destroy(); upstream.destroy(); };
  socket.on('error', close); socket.on('close', close); upstream.on('error', close); upstream.on('close', close);
  upstream.setTimeout(90_000, close);
  upstream.on('connect', () => {
    const headers = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
});
server.listen(8080, '0.0.0.0');
