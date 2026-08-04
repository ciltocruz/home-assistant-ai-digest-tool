import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/chat') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        JSON.parse(body);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          message: { content: JSON.stringify({ summary: 'The logmark signature needs attention for verification.', recommendation: 'Review the MQTT integration configuration.' }) }
        }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid request"}');
      }
    });
    return;
  }
  response.writeHead(404).end();
}).listen(11434, '0.0.0.0');
