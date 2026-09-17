import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// TLS remains end-to-end. Only the official validation host is reachable;
// production credentials never enter this isolated stack.
export function allowedConnect(target) { return target === 'challenges.cloudflare.com:443'; }
export function startTurnstileProxy() {
  const server = http.createServer((_, response) => response.writeHead(403).end());
  server.on('connect', (request, client, head) => {
    if (!allowedConnect(request.url)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect({ host: 'challenges.cloudflare.com', port: 443, timeout: 12_000 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  server.listen(3128, '0.0.0.0');
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startTurnstileProxy();
