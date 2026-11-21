import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOpcApp } from './opc/index.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4318);
const app = createOpcApp({ autoStart: true });

const server = createServer(async (request, response) => {
  const stop = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) stop.abort();
  });
  try {
    const origin = 'http://' + (request.headers.host || host + ':' + port);
    const url = new URL(request.url, origin);
    if (url.pathname === '/') {
      response.writeHead(302, { Location: '/opc' }).end();
      return;
    }
    const options = { method: request.method, headers: request.headers, signal: stop.signal };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      options.body = request;
      options.duplex = 'half';
    }
    const result = await app.handle(new Request(url, options));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) {
      await pipeline(Readable.fromWeb(result.body), response);
    } else {
      response.end();
    }
  } catch (error) {
    if (stop.signal.aborted) return;
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('服务暂时不可用');
    console.error(error.message);
  }
});

server.once('close', () => app.close());
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
server.listen(port, host, () => console.log('http://' + host + ':' + server.address().port + '/opc'));
