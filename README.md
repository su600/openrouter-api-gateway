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

Only these API paths are permitted. The service cannot be used as an arbitrary HTTP proxy. The production upstream is pinned to the exact `https://openrouter.ai` origin; arbitrary upstream hosts are rejected.

## Security model

- `OPENROUTER_BASE_URL` defaults to `https://openrouter.ai`; production rejects alternate hosts so the server-side key cannot be redirected to an arbitrary endpoint.
- `OPENROUTER_API_KEY` is read only by the gateway container on the server.
- Clients authenticate with one or more separate random `CLIENT_API_KEYS`. Claude-style `x-api-key` and OpenAI-style `Authorization: Bearer` are both accepted.
- Client keys are compared using fixed-length SHA-256 digests and constant-time comparison. A key must be at least 32 characters.
- The app listens on container port 5000. By default Compose binds it to host `127.0.0.1:5000`; Caddy is the public API entry point on 80/443. Binding port 5000 to `0.0.0.0` is available only as an explicit temporary HTTP testing option and exposes client keys/prompts in plaintext; do not use it in production.
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

In the Tencent Cloud security group and Ubuntu firewall, allow SSH from trusted addresses where possible, plus TCP 80/443 for certificate issuance and HTTPS. UDP 443 is optional (HTTP/3). Keep TCP 5000 closed to the Internet in production. For a temporary plain-HTTP test only, see the warning below.

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
- `OPENROUTER_BASE_URL`: `https://openrouter.ai` (the production gateway rejects other hosts).
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

#### Temporary HTTP test mode (not for production)

If HTTPS certificate issuance is not ready and you explicitly need a short test, set `GATEWAY_BIND_ADDRESS=0.0.0.0` in `.env`, allow **TCP 5000** from your test client in the cloud security group (prefer the PC's current public IP as a `/32` source instead of `0.0.0.0/0`), and recreate only the gateway:

```bash
docker compose up -d --force-recreate gateway
```

The temporary client URL is `http://YOUR_DOMAIN:5000` (Claude Code base URL without `/v1`; Codex base URL with `/v1`). **HTTP does not encrypt either the client key or prompts**; use a disposable client key and test data only. After testing, change the bind address back to `127.0.0.1`, close the TCP 5000 cloud rule, recreate the gateway, and switch clients to `https://YOUR_DOMAIN` through Caddy.

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

## Windows 上通过 CC Switch 使用（Claude Code / Codex）

下列配置适用于已经部署并能从 Windows 访问的网关。CC Switch 不同版本的按钮名称可能略有差异，但协议和 URL 必须按本节填写。

### 1. 先准备域名和客户端 Key

1. 确认服务器 `.env` 中配置了 `OPENROUTER_API_KEY` 和至少一个 `CLIENT_API_KEYS`。客户端只使用 `CLIENT_API_KEYS`，**不要把 OpenRouter Key 填入 CC Switch**。
2. 建议 Claude Code 和 Codex 分别使用不同的客户端 Key。服务器上可运行两次 `openssl rand -hex 32` 生成 64 位十六进制 Key，并把它们写入 `.env` 的 `CLIENT_API_KEYS`，例如以逗号分隔：

   ```dotenv
   CLIENT_API_KEYS=Claude专用随机Key,Codex专用随机Key
   ```

   这只是格式示意，不能直接照抄示例文字。Key 至少 32 个字符；不要提交 `.env` 或把 Key 发到聊天、截图、日志中。
3. 确认域名 HTTPS 正常：在 Windows 浏览器打开 `https://YOUR_DOMAIN/healthz`，应返回 `status: ok`。客户端访问的是 HTTPS 域名的 `443` 端口，不是 VPS 的 `5000` 端口。
4. 从 OpenRouter 模型目录复制所需模型的**完整 Model ID**。Claude Code 使用的模型需支持 Anthropic Messages 接口；Codex 选择的模型需支持 OpenRouter 的 Responses API。

如果刚修改服务器 Key，需在服务器项目目录运行 `docker compose up -d --force-recreate gateway`，让新 Key 生效。

### 2. 添加 Claude Code 供应商

1. 打开 CC Switch，进入 **Claude Code** 区域/标签页。
2. 选择“添加供应商 / Add Provider”，类型选择 **自定义 Anthropic 兼容供应商**（或同义选项）。
3. 按下表填写：

   | CC Switch 字段 | 填写内容 |
   | --- | --- |
   | 名称 / Name | `OpenRouter 日本网关 - Claude`（可自定义） |
   | API Base URL / API 地址 | `https://YOUR_DOMAIN` |
   | API Key / 密钥 | `.env` 中为 Claude Code 准备的客户端 Key |
   | Model / 模型 | OpenRouter 上的完整 Claude 模型 ID |

4. 保存并**启用/切换到**刚添加的供应商，再新开一个终端启动 `claude`。
5. 确认请求路径是 `POST https://YOUR_DOMAIN/v1/messages`。Anthropic 客户端可能用 `x-api-key`，也可能用 Bearer 认证；网关两种都接受。通常 Base URL 填域名根地址，不要加 `/v1`，也不要加 `/api`。

如 CC Switch 展示 Opus、Sonnet、Haiku 等多个模型映射栏，给每个启用的栏填写 OpenRouter 上有效的完整模型 ID；若只使用一个模型，就填写主模型栏即可。

### 3. 添加 Codex 供应商

1. 在 CC Switch 中进入 **Codex** 区域/标签页。
2. 添加自定义供应商。若能选择协议，选择 **OpenAI-compatible / Responses API**；不要选仅支持 Chat Completions 的配置。
3. 填写：

   | CC Switch 字段 | 填写内容 |
   | --- | --- |
   | 名称 / Name | `OpenRouter 日本网关 - Codex`（可自定义） |
   | Base URL / API 地址 | `https://YOUR_DOMAIN/v1` |
   | API Key / 密钥 | `.env` 中为 Codex 准备的客户端 Key |
   | Wire API / API 协议 | `Responses` / `responses` |
   | Model / 模型 | OpenRouter 上支持 Responses API 的完整模型 ID，例如 `openai/gpt-6-sol`（请以账户当前可用模型为准） |

   若 CC Switch 提示该供应商不支持自动获取模型列表，通常可以在 Model 栏手动填写完整 ID；这不等同于 API 请求不受支持。

4. 保存并**启用/切换到**该供应商。检查用户级 `%USERPROFILE%/.codex/config.toml`：Codex 配置必须有顶层 `model_provider = "openrouter-gateway"`，并且 `base_url`、`wire_api` 和供应商 Key 必须放在 `[model_providers.openrouter-gateway]` 表内，不能作为 TOML 顶层字段。示例见下方“直接配置 CLI”。
5. 关闭旧 Codex 进程后重新打开。请求路径应为 `POST https://YOUR_DOMAIN/v1/responses`；`wire_api` 必须是 `responses`，Base URL 不要加 `/api`。

### 4. Windows 连通性和认证测试

PowerShell 中使用 `curl.exe`（不是 PowerShell 的 `curl` 别名）。健康检查不需要 Key：

```powershell
curl.exe -i https://YOUR_DOMAIN/healthz
```

模型列表接口需要客户端 Key。可在本机临时测试；把占位文本替换成客户端 Key，**不要把命令或输出截图公开**：

```powershell
curl.exe -i https://YOUR_DOMAIN/v1/models `
  -H "Authorization: Bearer YOUR_CLIENT_API_KEY"
```

预期结果：无 Key 时 `/v1/models` 返回 `401`；有效 Key 时请求被转发到 OpenRouter。Anthropic 风格 Key 头也可测试：

```powershell
curl.exe -i https://YOUR_DOMAIN/v1/models `
  -H "x-api-key: YOUR_CLIENT_API_KEY"
```

模型列表正常后，在 CC Switch 启用供应商并分别启动 Claude Code 或 Codex 发起一个简单请求。`/healthz` 成功只证明 HTTPS 网关在线，不代表 Key、模型或 OpenRouter 额度一定有效。

### 5. 直接配置 CLI（不经过 CC Switch 时）

Claude Code 当前 PowerShell 会话：

```powershell
$env:ANTHROPIC_BASE_URL = "https://YOUR_DOMAIN"
$env:ANTHROPIC_AUTH_TOKEN = "YOUR_CLIENT_API_KEY"
$env:ANTHROPIC_MODEL = "YOUR_OPENROUTER_MODEL_ID"
claude
```

Codex 可在 `%USERPROFILE%\.codex\config.toml` 中添加自定义 Responses 供应商：

```toml
# These selector/model fields are top-level:
model_provider = "openrouter-gateway"
model = "YOUR_OPENROUTER_MODEL_ID" # e.g. openai/gpt-6-sol
model_reasoning_effort = "high"

# Connection/auth fields belong inside this provider table:
[model_providers.openrouter-gateway]
name = "OpenRouter Gateway"
base_url = "https://YOUR_DOMAIN/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

如果 CC Switch 将 Key 直接写入 Codex 配置而不是环境变量，可在同一个供应商表内用 `experimental_bearer_token = "YOUR_CLIENT_API_KEY"` 替换 `env_key`。

不要把 `base_url`、`wire_api` 或 `experimental_bearer_token` 放在 TOML 顶层；顶层的 `model_provider` 必须选择名称相同的供应商表。

然后在 PowerShell 设置客户端 Key 并新开终端：

```powershell
setx OPENAI_API_KEY "YOUR_CLIENT_API_KEY"
```

### 6. 常见问题

- **401 Unauthorized**：Key 不匹配、填了 OpenRouter Key，或服务器修改 `.env` 后没有重建 gateway 容器。检查 Key 前后是否有空格。
- **404 Not Found**：检查最终路径。Claude Code 应请求 `/v1/messages`；Codex 应请求 `/v1/responses`。不要在 Base URL 中额外加 `/api`；Claude Code 通常也不应重复加 `/v1`。
- **429 Too Many Requests**：超过 `RATE_LIMIT_PER_MINUTE`；默认是每个有效客户端 Key 每分钟 120 次。
- **模型不支持 / model not found**：使用 OpenRouter 显示的完整模型 ID（含命名空间，如 `openai/gpt-6-sol`），并确认该模型可用于相应协议；Codex 必须走 Responses API。
- **Codex 提示连接失败，但网关健康检查成功**：检查用户级 `config.toml` 是否由顶层 `model_provider` 选择了自定义供应商，且 `base_url`、`wire_api`、Key 都嵌套在对应的 `[model_providers.<id>]` 表中；不要把它们误放在 TOML 顶层。
- **502/504 或 TLS 错误**：检查域名 DNS、Caddy 证书、服务器到 OpenRouter 的出站网络；服务器端可查看 `docker compose logs --tail=100 gateway caddy`。日志不包含请求正文或 API Key。
- **外网连不上 5000**：这是预期行为。网关 5000 仅绑定 VPS 的 `127.0.0.1`；客户端必须用 HTTPS 域名访问。

### 7. 更换或撤销客户端 Key

每个客户端使用独立 Key。若某个 Key 泄漏，从服务器 `.env` 的 `CLIENT_API_KEYS` 中移除该 Key，再运行：

```bash
docker compose up -d --force-recreate gateway
```

随后在对应 CC Switch 配置中更新或删除旧 Key。切勿为方便而把 OpenRouter Key 配到 Windows 客户端。

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOMAIN` | required by Compose | Public TLS hostname used by Caddy |
| `GATEWAY_BIND_ADDRESS` | `127.0.0.1` | Host bind address for port 5000; use `0.0.0.0` only for temporary plaintext testing |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai` | Pinned official upstream origin; no path or alternate host |
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

The tests use a local mock upstream and verify client-key authentication, server-side key replacement, protocol headers, route mapping, and live SSE forwarding. Production traffic is pinned to `https://openrouter.ai`; plain HTTP upstreams are allowed only on loopback in tests.
