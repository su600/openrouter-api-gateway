'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { Transform } = require('node:stream');

const VERSION = '1.0.0';
const DEFAULT_UPSTREAM = 'https://openrouter.ai';
const ALLOWED_PATHS = [
  /^\/v1\/messages$/,
  /^\/v1\/messages\/count_tokens$/,
  /^\/v1\/responses$/,
  /^\/v1\/chat\/completions$/,
  /^\/v1\/embeddings$/,
  /^\/v1\/models(?:\/[^/]+)?$/,
];
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'content-length',
  'content-encoding',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
  'openai-version',
  'user-agent',
  'x-request-id',
];
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function readClientCredentials(req) {
  const values = [];
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) values.push(match[1].trim());
  }
  if (typeof req.headers['x-api-key'] === 'string') {
    values.push(req.headers['x-api-key'].trim());
  }
  return values.filter(Boolean);
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function createGateway(options = {}) {
  const upstreamBaseUrl = options.upstreamBaseUrl || DEFAULT_UPSTREAM;
  const upstreamOrigin = new URL(upstreamBaseUrl);
  if (!['https:', 'http:'].includes(upstreamOrigin.protocol)) {
    throw new Error('OPENROUTER_BASE_URL must use HTTPS (HTTP is only suitable for localhost tests).');
  }
  if (upstreamOrigin.pathname !== '/' || upstreamOrigin.search || upstreamOrigin.hash) {
    throw new Error('OPENROUTER_BASE_URL must be an origin without a path, query, or fragment.');
  }
  if (upstreamOrigin.protocol === 'http:' && !options.allowHttpUpstream) {
    throw new Error('The upstream must use HTTPS. HTTP is only enabled by the test harness.');
  }

  const upstreamApiKey = options.upstreamApiKey;
  const clientApiKeys = (options.clientApiKeys || []).filter((key) => typeof key === 'string' && key.length > 0);
  if (!upstreamApiKey) throw new Error('OPENROUTER_API_KEY is required.');
  if (clientApiKeys.length === 0) throw new Error('At least one CLIENT_API_KEYS value is required.');

  const credentials = clientApiKeys.map((key, index) => ({ id: `key-${index + 1}`, digest: sha256(key) }));
  const maxBodyBytes = options.maxBodyBytes ?? 20 * 1024 * 1024;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? 120;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 10 * 60 * 1000;
  const rateWindows = new Map();
  const openRouterReferer = options.openRouterReferer || '';
  const openRouterAppTitle = options.openRouterAppTitle || 'OpenRouter Client Gateway';
  const requestFunction = upstreamOrigin.protocol === 'https:' ? https.request : http.request;

  function authenticate(req) {
    const candidates = readClientCredentials(req).map(sha256);
    for (const candidate of candidates) {
      for (const configured of credentials) {
        if (crypto.timingSafeEqual(candidate, configured.digest)) return configured.id;
      }
    }
    return null;
  }

  function rateLimited(keyId) {
    if (rateLimitPerMinute <= 0) return false;
    const now = Date.now();
    const current = rateWindows.get(keyId);
    if (!current || now - current.start >= 60_000) {
      rateWindows.set(keyId, { start: now, count: 1 });
      return false;
    }
    current.count += 1;
    return current.count > rateLimitPerMinute;
  }

  function handle(req, res) {
    const startedAt = Date.now();
    let requestId = req.headers['x-request-id'];
    if (typeof requestId !== 'string' || !/^[\w.-]{1,128}$/.test(requestId)) {
      requestId = crypto.randomUUID();
    }

    let requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://gateway.invalid');
    } catch {
      sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'Invalid request URL.' } });
      req.resume();
      return;
    }

    if (requestUrl.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { status: 'ok', version: VERSION }, { 'x-request-id': requestId });
      return;
    }

    if (!ALLOWED_PATHS.some((pattern) => pattern.test(requestUrl.pathname))) {
      sendJson(res, 404, { error: { type: 'not_found_error', message: 'API route not supported.' } });
      req.resume();
      return;
    }

    const isModelsPath = requestUrl.pathname.startsWith('/v1/models');
    if (isModelsPath ? !['GET', 'HEAD'].includes(req.method) : req.method !== 'POST') {
      sendJson(res, 405, { error: { type: 'invalid_request_error', message: 'Method not allowed.' } }, { allow: isModelsPath ? 'GET, HEAD' : 'POST' });
      req.resume();
      return;
    }

    const keyId = authenticate(req);
    if (!keyId) {
      sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid client API key.' } }, { 'www-authenticate': 'Bearer' });
      req.resume();
      return;
    }
    if (rateLimited(keyId)) {
      sendJson(res, 429, { error: { type: 'rate_limit_error', message: 'Gateway request rate limit exceeded.' } }, { 'retry-after': '60' });
      req.resume();
      return;
    }

    const declaredLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      sendJson(res, 413, { error: { type: 'invalid_request_error', message: 'Request body exceeds the configured limit.' } });
      req.resume();
      return;
    }

    const targetPath = `/api${requestUrl.pathname}${requestUrl.search}`;
    const headers = {
      authorization: `Bearer ${upstreamApiKey}`,
      'x-title': openRouterAppTitle,
    };
    if (openRouterReferer) headers['http-referer'] = openRouterReferer;
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }

    const upstreamReq = requestFunction({
      protocol: upstreamOrigin.protocol,
      hostname: upstreamOrigin.hostname,
      port: upstreamOrigin.port || undefined,
      method: req.method,
      path: targetPath,
      headers,
    });

    upstreamReq.setTimeout(upstreamTimeoutMs, () => {
      const error = new Error('Upstream request timed out.');
      error.code = 'ETIMEDOUT';
      upstreamReq.destroy(error);
    });

    upstreamReq.on('response', (upstreamRes) => {
      const connectionTokens = String(upstreamRes.headers.connection || '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      const excludedHeaders = new Set([...HOP_BY_HOP_HEADERS, ...connectionTokens]);
      const responseHeaders = { 'x-request-id': requestId };
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !excludedHeaders.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      // Flush headers immediately: event-stream responses must not be buffered.
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
      res.on('finish', () => {
        console.log(JSON.stringify({
          event: 'request_complete',
          requestId,
          method: req.method,
          path: requestUrl.pathname,
          status: upstreamRes.statusCode || 502,
          durationMs: Date.now() - startedAt,
        }));
      });
    });

    upstreamReq.on('error', (error) => {
      console.error(JSON.stringify({
        event: 'upstream_error',
        requestId,
        code: error.code || 'UPSTREAM_ERROR',
      }));
      if (res.headersSent || res.destroyed || res.writableEnded) {
        if (!res.writableEnded && !res.destroyed) res.destroy();
        return;
      }
      sendJson(res, error.code === 'ETIMEDOUT' ? 504 : 502, {
        error: { type: 'api_error', message: error.code === 'ETIMEDOUT' ? 'Upstream request timed out.' : 'Unable to reach the upstream API.' },
      }, { 'x-request-id': requestId });
    });

    req.on('aborted', () => upstreamReq.destroy());
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });

    let receivedBytes = 0;
    const bodyLimiter = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBodyBytes) {
          const error = new Error('Request body exceeds the configured limit.');
          error.code = 'BODY_TOO_LARGE';
          callback(error);
          return;
        }
        callback(null, chunk);
      },
    });
    bodyLimiter.on('error', (error) => {
      upstreamReq.destroy();
      if (error.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: { type: 'invalid_request_error', message: 'Request body exceeds the configured limit.' } });
      } else {
        res.destroy();
      }
    });
    req.pipe(bodyLimiter).pipe(upstreamReq);
  }

  const server = http.createServer(handle);
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 65 * 1000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function parsePositiveInteger(value, fallback, allowZero = false) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`Expected an integer ${allowZero ? 'greater than or equal to 0' : 'greater than 0'}, got ${value}.`);
  }
  return parsed;
}

if (require.main === module) {
  const clientApiKeys = (process.env.CLIENT_API_KEYS || '')
    .split(/[\n,]/).map((key) => key.trim()).filter(Boolean);
  if (clientApiKeys.some((key) => key.length < 32)) {
    throw new Error('Each CLIENT_API_KEYS entry must be at least 32 characters. Generate one with: openssl rand -hex 32');
  }

  const server = createGateway({
    upstreamApiKey: process.env.OPENROUTER_API_KEY,
    clientApiKeys,
    maxBodyBytes: parsePositiveInteger(process.env.MAX_BODY_BYTES, 20 * 1024 * 1024),
    rateLimitPerMinute: parsePositiveInteger(process.env.RATE_LIMIT_PER_MINUTE, 120, true),
    upstreamTimeoutMs: parsePositiveInteger(process.env.UPSTREAM_TIMEOUT_MS, 10 * 60 * 1000),
    openRouterReferer: process.env.OPENROUTER_HTTP_REFERER,
    openRouterAppTitle: process.env.OPENROUTER_APP_TITLE || 'OpenRouter Client Gateway',
  });
  const port = parsePositiveInteger(process.env.PORT, 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'gateway_started', port, upstream: DEFAULT_UPSTREAM, version: VERSION }));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { createGateway };
