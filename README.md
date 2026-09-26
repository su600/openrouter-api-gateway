# OpenRouter API Gateway

A small, self-hosted API gateway for using one server-side OpenRouter key from API-compatible clients such as **Claude Code** and **OpenAI Codex**. It is designed for deployment on a private VPS, with HTTPS supplied by Caddy.

> This gateway relays requests; it does not provide model access, credits, or spend limits. OpenRouter account access, model availability, and billing still apply.

## What it supports

| Client protocol | Client endpoint | OpenRouter endpoint | Streaming |
| --- | --- | --- | --- |
| Claude Code / Anthropic Messages | `POST /v1/messages` | `POST /api/v1/messages` | SSE body is streamed through without buffering |
| Anthropic token counting | `POST /v1/messages/count_tokens` | Passed through to OpenRouter | Upstream-dependent |
| Codex / OpenAI Responses | `POST /v1/responses` | `POST /api/v1/responses` | SSE body is streamed through without buffering |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `POST /api/v1/chat/completions` | SSE body is streamed through without buffering |
| Model discovery | `GET /v1/models[/{id}]` | `GET /api/v1/models[/{id}]` | N/A |
| OpenAI embeddings | `POST /v1/embeddings` | `POST /api/v1/embeddings` | N/A |

The gateway forwards the JSON request body and supported protocol headers, replaces client credentials with the server-side OpenRouter credential, and streams the upstream status, response headers, and body back to the client. It never parses or stores prompts. Access logs intentionally omit authorization headers, API keys, query strings, and request/response bodies.

Only these API paths are permitted. The service cannot be used as an arbitrary HTTP proxy.

## Security model

- `OPENROUTER_API_KEY` is read only by the gateway container on the server.
- Clients authenticate with one or more separate random `CLIENT_API_KEYS`. Claude-style `x-api-key` and OpenAI-style `Authorization: Bearer` are both accepted.
- Client keys are compared using fixed-length SHA-256 digests and constant-time comparison. A key must be at least 32 characters.
- The app listens on container port 5000. Compose binds it to host `127.0.0.1:5000` only; it is not reachable from the Internet. Caddy is the only public API entry point on 80/443. Never bind 5000 to `0.0.0.0` or open it in the cloud firewall.
- Containers run as non-root with a read-only root filesystem and dropped Linux capabilities.
- No prompt content or credentials are written to application logs. Protect `.env` and keep it out of Git.
- Invalid or missing client credentials are rejected with 401 before any upstream request is made. API paths and methods are allowlisted; `/healthz` is public but reveals only liveness/version.
- The default limit is 120 authenticated requests/minute per client key and 20 MiB per request. These are configurable; the rate limit is in-memory and resets on restart. This is not a billing/spend cap.

Requests and code are transmitted through the VPS and OpenRouter. Use this only if your data-handling requirements permit it. This project does not bypass OpenRouter account restrictions or guarantee that every model feature is compatible with Claude Code or Codex.

## Deploy on Ubuntu

### 1. Prerequisites

- Ubuntu server with Docker Engine and Docker Compose v2 (`docker compose`).
- A DNS name whose `A` record points to the server. Add an `AAAA` record only if IPv6 is configured correctly.
- OpenRouter API key.

For a private GitHub repository, deploy with a read-only GitHub deploy key or copy the checkout to the server. Do not put a GitHub token in this repository or Compose file.

### 2. Allow only required inbound ports

In the Tencent Cloud security group and Ubuntu firewall, allow SSH from trusted addresses where possible, plus TCP 80/443 for certificate issuance and HTTPS. UDP 443 is optional (HTTP/3). Do **not** expose TCP 5000. Compose binds that port to loopback only.

Example with UFW (ensure SSH is allowed before enabling UFW):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

### 3. Configure secrets

```bash
cp .env.example .env
openssl rand -hex 32  # generate a client key; repeat for additional clients
chmod 600 .env
```

Edit `.env` on the server:

- `DOMAIN`: your DNS name.
- `OPENROUTER_API_KEY`: the OpenRouter key (server only).
- `CLIENT_API_KEYS`: random client key(s), separated by commas or newlines.
- Keep `OPENROUTER_HTTP_REFERER` set to your domain, or remove its value if not needed.

Do not commit `.env`, send it to clients, or paste its contents into chat. Use a different client key for each device/user so a single key can be revoked by removing it from `CLIENT_API_KEYS` and recreating the container.

### 4. Start the gateway

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 gateway caddy
```

Caddy obtains and renews the TLS certificate automatically. Confirm DNS has propagated and ports 80/443 are reachable if certificate issuance fails.

Health checks (neither requires a client key):

```bash
# Local-only app port on the Ubuntu host
curl --fail http://127.0.0.1:5000/healthz

# Public HTTPS through Caddy
curl --fail https://YOUR_DOMAIN/healthz
```

Optional authenticated model-list check:

```bash
curl --fail https://YOUR_DOMAIN/v1/models \
  -H 'Authorization: Bearer YOUR_CLIENT_API_KEY'
```

## Configure clients

Use the **client key**, never the OpenRouter key, in CC Switch, Claude Code, and Codex. Use model IDs exactly as listed by OpenRouter. The selected upstream model must support the relevant API protocol; Codex requires a model/API combination that OpenRouter supports through the Responses API.

### Claude Code directly

In PowerShell for the current session:

```powershell
$env:ANTHROPIC_BASE_URL = "https://YOUR_DOMAIN"
$env:ANTHROPIC_AUTH_TOKEN = "YOUR_CLIENT_API_KEY"
$env:ANTHROPIC_MODEL = "YOUR_OPENROUTER_MODEL_ID"
claude
```

`ANTHROPIC_AUTH_TOKEN` is sent as Bearer auth. The gateway also accepts Anthropic SDK `x-api-key` authentication. In CC Switch, add an Anthropic-compatible custom provider with the same base URL, client key, and OpenRouter model ID. Set the base URL to the origin (no trailing `/v1`) when the client appends `/v1` itself; verify the generated request path is `/v1/messages`.

### Codex directly

Add a custom provider to `%USERPROFILE%\.codex\config.toml` (or `~/.codex/config.toml`):

```toml
model_provider = "openrouter-gateway"
model = "YOUR_OPENROUTER_MODEL_ID"

[model_providers.openrouter-gateway]
name = "OpenRouter Gateway"
base_url = "https://YOUR_DOMAIN/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Set the client key in the Windows environment, then start a new terminal:

```powershell
setx OPENAI_API_KEY "YOUR_CLIENT_API_KEY"
```

In CC Switch, create/select a custom Codex provider using the same `/v1` base URL, the client key, and the Responses API wire format. Field names vary by CC Switch version; verify it targets `/v1/responses`, not `/v1/chat/completions`.

### Verify the actual path

If a client reports a 404, inspect the URL path it generated (without logging or sharing authorization headers). The gateway accepts the paths in the support table and maps `/v1/...` to OpenRouter `/api/v1/...`. Do not add `/api` to the client base URL.

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOMAIN` | required by Compose | Public TLS hostname used by Caddy |
| `OPENROUTER_API_KEY` | required | Server-only upstream credential |
| `CLIENT_API_KEYS` | required | Comma/newline-separated client keys, each at least 32 characters |
| `OPENROUTER_HTTP_REFERER` | optional | OpenRouter attribution header (`HTTP-Referer`) |
| `OPENROUTER_APP_TITLE` | `OpenRouter Client Gateway` | OpenRouter attribution header (`X-Title`) |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-client fixed-window request limit; `0` disables it |
| `MAX_BODY_BYTES` | `20971520` | Maximum request body size (20 MiB) |
| `UPSTREAM_TIMEOUT_MS` | `600000` | Upstream idle socket timeout (10 minutes) |
| `PORT` | `5000` | Container listen port. If changed, update Compose port/health settings and the Caddy upstream together; never publish it publicly. |

After changing `.env`, recreate the gateway so the new values take effect:

```bash
docker compose up -d --force-recreate gateway
```

## Development and tests

Requires Node.js 22 or later; there are no runtime npm dependencies.

```bash
npm test
node --check server.js
```

The tests use a local mock upstream and verify client-key authentication, server-side key replacement, protocol headers, route mapping, and live SSE forwarding. Production traffic always targets `https://openrouter.ai`; plain HTTP upstreams are allowed only through explicit dependency injection in tests.
