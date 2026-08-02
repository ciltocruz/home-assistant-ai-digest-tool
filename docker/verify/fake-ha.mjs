import { createServer } from 'node:http';

let failStates = false;

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/states') {
    if (failStates) return response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"fixture unavailable"}');
    return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
      {
        entity_id: 'sensor.verify_fixture',
        state: 'unavailable',
        last_changed: '2026-07-29T12:00:00.000Z',
        last_updated: '2026-07-29T12:00:00.000Z'
      }
    ]));
  }
  if (request.method === 'POST' && request.url === '/control/fail') {
    failStates = true;
    return response.writeHead(204).end();
  }
  return response.writeHead(404).end();
}).listen(8123, '0.0.0.0');
