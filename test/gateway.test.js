'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { createGateway } = require('../server');

const CLIENT_KEY = 'client-key-for-tests-0123456789abcdef0123456789abcdef';
const UPSTREAM_KEY = 'server-side-openrouter-key-for-tests';
const seen = [];
let upstream;
let gateway;
let baseUrl;
let upstreamFinished = false;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.url.startsWith('/api/v1/messages')) {
        upstreamFinished = false;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => {
          upstreamFinished = true;
          res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        }, 120);
        return;
      }

      if (req.url.startsWith('/api/v1/responses')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  const upstreamPort = await listen(upstream);

  gateway = createGateway({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    allowHttpUpstream: true,
    upstreamApiKey: UPSTREAM_KEY,
    clientApiKeys: [CLIENT_KEY],
    rateLimitPerMinute: 0,
    maxBodyBytes: 1024,
    openRouterReferer: 'https://api.example.com',
    openRouterClaudeReferer: 'https://claude.ai/code',
  });
  const gatewayPort = await listen(gateway);
  baseUrl = `http://127.0.0.1:${gatewayPort}`;
});

after(async () => {
  await close(gateway);
  await close(upstream);
});

test('Claude Messages auth and SSE are relayed as a live stream', async () => {
  const body = JSON.stringify({ model: 'anthropic/example-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }] });
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': CLIENT_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'messages-2023-12-15',
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(upstreamFinished, false, 'first SSE chunk arrived before the upstream finished');
  let streamed = new TextDecoder().decode(first.value);
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    streamed += new TextDecoder().decode(part.value);
  }
  assert.equal(streamed, 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');

  const forwarded = seen.at(-1);
  assert.equal(forwarded.url, '/api/v1/messages');
  assert.equal(forwarded.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(forwarded.headers['http-referer'], 'https://claude.ai/code');
  assert.equal(forwarded.headers['x-openrouter-title'], 'Claude Code');
  assert.equal(forwarded.headers['x-openrouter-app-visibility'], 'hidden');
  assert.equal(forwarded.headers['x-api-key'], undefined);
  assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
  assert.equal(forwarded.headers['anthropic-beta'], 'messages-2023-12-15');
  assert.equal(forwarded.body, body);
});

test('Codex Responses API accepts Bearer client auth and preserves SSE', async () => {
  const body = JSON.stringify({ model: 'openai/example-codex-model', input: 'hello', stream: true });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CLIENT_KEY}`,
      'openai-beta': 'responses=experimental',
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: response.completed\ndata: {"type":"response.completed"}\n\n');

  const forwarded = seen.at(-1);
  assert.equal(forwarded.url, '/api/v1/responses');
  assert.equal(forwarded.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(forwarded.headers['http-referer'], 'https://openai.com/codex/');
  assert.equal(forwarded.headers['x-openrouter-title'], 'CodeX');
  assert.equal(forwarded.headers['x-openrouter-app-visibility'], 'hidden');
  assert.equal(forwarded.headers['openai-beta'], 'responses=experimental');
  assert.equal(forwarded.body, body);
});

test('rejects invalid client keys without contacting OpenRouter', async () => {
  const requestCount = seen.length;
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-key' },
    body: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal(seen.length, requestCount);
});

test('production upstream is restricted to the HTTPS OpenRouter origin', () => {
  assert.throws(() => createGateway({
    upstreamBaseUrl: 'https://attacker.example',
    upstreamApiKey: UPSTREAM_KEY,
    clientApiKeys: [CLIENT_KEY],
  }), /must be https:\/\/openrouter\.ai/);
  assert.throws(() => createGateway({
    upstreamBaseUrl: 'http://attacker.example',
    allowHttpUpstream: true,
    upstreamApiKey: UPSTREAM_KEY,
    clientApiKeys: [CLIENT_KEY],
  }), /only on loopback/);
});

test('health check is public and unsupported routes are rejected', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const response = await fetch(`${baseUrl}/admin`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
  assert.equal(response.status, 404);
});
