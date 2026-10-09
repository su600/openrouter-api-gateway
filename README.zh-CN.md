# OpenRouter API 中转网关：让 Claude Code 与 Codex 通过你的服务器调用 OpenRouter

> **一句话说明：**在自己的服务器上运行这个网关，让 Claude Code 通过 Anthropic Messages API、Codex 通过 OpenAI Responses API 接入 OpenRouter；OpenRouter Key 留在服务器，客户端只使用单独生成的访问 Key。
>
> 构建信息：使用 **Pi Coding Agent**，模型为 OpenRouter 的 **`openai/gpt-6-luna`**。这是开发本项目时使用的模型，不是网关运行时指定的模型。
>
> **核心前提：必须先有一台中国大陆网络能够直连的海外云服务器。**满足此前提后，中国 IP 的电脑可以不在本机挂 VPN，通过自己的海外服务器访问 OpenRouter，从而调用账号和额度允许使用的顶级模型。链路是“中国电脑 → 海外服务器 → OpenRouter”，不是中国电脑直接连接 OpenRouter。HTTPS 强烈推荐，但不是必需；也可选择直接 HTTP，不过客户端到服务器的连接不加密。能否使用具体模型仍取决于账号权限、额度、DNS、运营商路由和服务商政策；不保证所有地区网络或所有模型都可用。请遵守适用法律、云服务商条款及 OpenRouter 使用政策。
>
> [English README](README.md)

## 工作方式

```text
Claude Code / Codex / CC Switch
            │ HTTPS（推荐）或 HTTP（不加密）
            ▼
       本项目 API 网关
            │ Authorization: Bearer <服务器端 OpenRouter Key>
            ▼
     https://openrouter.ai
```

客户端请求体和 SSE 流式响应由网关直接转发；网关只验证客户端 Key 并替换上游认证，不保存对话内容。

| 客户端 | 客户端请求路径 | 上游 OpenRouter 路径 | 流式响应 |
| --- | --- | --- | --- |
| Claude Code / Anthropic Messages | `POST /v1/messages` | `POST /api/v1/messages` | 支持 SSE 透传 |
| Anthropic token counting | `POST /v1/messages/count_tokens` | 透传到 OpenRouter | 取决于上游支持情况 |
| Codex / OpenAI Responses | `POST /v1/responses` | `POST /api/v1/responses` | 支持 SSE 透传 |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `POST /api/v1/chat/completions` | 支持 SSE 透传 |
| 模型列表 | `GET /v1/models[/{id}]` | `GET /api/v1/models[/{id}]` | — |

模型、账号额度和计费仍由 OpenRouter 决定。Codex 选择的模型必须支持 Responses API。网关会透传 `/v1/messages/count_tokens`，但 OpenRouter 当前对相应上游路径可能返回 404；Claude Code 的主要消息调用是 `/v1/messages`，token 计数接口兼容性不保证。

## 两种 Key：位置和用途

项目使用两种不同的 Key，**不要混用**：

### 1. OpenRouter API Key（上游 Key）

- 存放在服务器项目目录的 `.env` 文件中的 `OPENROUTER_API_KEY`。
- 文件位于服务器上的项目根目录：`.env`。
- Docker Compose 通过 `env_file: .env` 在**容器运行时**注入它；Dockerfile 不包含它，镜像中也不会烘焙它。
- **只留在服务器上。绝不能填入 CC Switch、Codex 或 Claude Code。**

### 2. 独立客户端 API Key（下游 Key）

- 存放在同一个 `.env` 文件的 `CLIENT_API_KEYS` 中。
- 填入 CC Switch 的 Key/API Key 栏；网关用它识别和授权客户端，再以服务器上的 OpenRouter Key 调用上游。
- 建议每个应用或设备使用不同 Key。泄露时可单独撤销。
- 不要把 Key 放进 URL、截图、公开日志或 Git 仓库。

`.env` 已被 `.gitignore` 排除，建议权限设为仅服务器管理员可读写：

```bash
chmod 600 .env
```

拥有服务器 root 权限或 Docker 管理权限的人仍可能读取容器环境变量，因此也要保护 Docker 权限和服务器账号。

## Ubuntu + Docker Compose 部署

### 1. 准备工作

- Ubuntu 服务器，已安装 Docker Engine 和 Docker Compose v2。
- 若使用推荐的 HTTPS 方式，需要一个指向服务器公网 IPv4 的域名；Caddy 自动配置证书。若选择 HTTP，可直接使用服务器 IP 或域名。
- 一个 OpenRouter API Key。

推荐的 HTTPS 方式需在安全组允许受限 SSH 及 TCP `80/443`；UDP `443` 可选。若选择直接 HTTP，还需开放 TCP `5000`，并尽量将来源限制为可信客户端 IP。

### 2. 配置 `.env` 与 Key

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

至少填写：

```dotenv
DOMAIN=api.example.com
OPENROUTER_BASE_URL=https://openrouter.ai
OPENROUTER_API_KEY=粘贴你的OpenRouter上游Key
CLIENT_API_KEYS=
```

`DOMAIN` 换成自己的域名；`OPENROUTER_API_KEY` 只写在服务器 `.env` 中。保存后，在项目目录运行客户端 Key 生成脚本：

```bash
./scripts/create-client-key.sh
```

脚本会生成一个 32 字节随机数（64 位十六进制字符），追加到 `.env` 的 `CLIENT_API_KEYS`，保持文件权限为 `600`，并在终端**打印新 Key 一次**。请立即复制保存到密码管理器，稍后填进 CC Switch。新增 Key 后重建网关，使新环境变量生效：

```bash
docker compose up -d --force-recreate gateway
```

脚本会将新 Key 加入已有列表，不会自动删除旧 Key。要撤销旧 Key，请编辑 `.env`，从 `CLIENT_API_KEYS` 中删掉相应值，再运行上面的重建命令。

如果之后需要在服务器上重新查看当前配置的 Key 列表：

```bash
grep '^CLIENT_API_KEYS=' .env
```

该命令会显示机密内容；不要把输出发给他人或贴到聊天中。**上游 OpenRouter Key 不会由这个命令显示。**

### 3. 启动和检查

```bash
docker compose up -d --build
docker compose ps
```

容器中应用默认监听 `5000`；Compose 默认只将其绑定到服务器本机 `127.0.0.1:5000`。公网请求通过 Caddy 的 `80/443` 入口代理，证书会自动申请和续期。

健康检查不需要 Key：

```bash
curl --fail http://127.0.0.1:5000/healthz
curl --fail https://YOUR_DOMAIN/healthz
```

带客户端 Key 测试模型列表（不调用模型生成）：

```bash
curl --fail https://YOUR_DOMAIN/v1/models \
  -H 'Authorization: Bearer YOUR_CLIENT_API_KEY'
```

无效或缺少 Key 的 API 请求会返回 `401`。`/healthz` 是公开的，但只返回服务状态和版本。

### OpenRouter 应用归因（不等于账单/API Key 隔离）

网关按协议路径设置 OpenRouter 应用归因：`/v1/messages` 和 `/v1/messages/count_tokens` 标记为 Claude Code，`/v1/responses` 标记为 CodeX，使用 `HTTP-Referer` 与 `X-OpenRouter-Title`。Codex 的 Referer 设为 `https://openai.com/codex`，Codex 请求不显式发送标题，以便 OpenRouter 根据 URL 匹配应用。网关会附带 `X-OpenRouter-App-Visibility: hidden`，使新建归因条目不公开展示。OpenRouter 文档将这些 Header 用于应用分析/排名。**实测结论：**使用 `https://openai.com/codex/` 时，OpenRouter 将地址归一到 `openai.com` 根域名并丢失显式标题；更换其他主机名后自定义标题可正常识别，但 Logo 显示为 WordPress。之后用户测试 `http://codex.openai.com`，OpenRouter 将其识别为 Codex CLI 并显示官方 Logo，说明 OpenRouter 可能依据 URL 匹配已知应用并使用其规范标题和 Logo。当前 URL-only 的 `https://openai.com/codex` 配置用于验证不显式传标题后，OpenRouter 是否仍会按根域名归并；需用新请求确认。归因 Header 不会创建独立的 OpenRouter API Key 或账单账户；OpenRouter Logs 文档也未保证请求行包含 app/title 或能逐条区分客户端。分类依赖请求路径，其他协议路径不会被这两种标签识别。

## Windows 上通过 CC Switch 配置

以下均使用**客户端 Key**，不是 OpenRouter Key。CC Switch 各版本的按钮文字可能不同，请以协议、URL 和配置文件结构为准。

### Claude Code

1. 在 CC Switch 的 **Claude Code** 区域添加自定义 Anthropic-compatible 供应商。
2. 配置：

   | 字段 | 值 |
   | --- | --- |
   | API Base URL | `https://YOUR_DOMAIN`（域名根地址，不加 `/v1`） |
   | API Key | 服务器 `.env` 中为该客户端生成的 Key |
   | Model | OpenRouter 上的完整 Claude 模型 ID |

3. 保存并启用供应商。最终请求应为 `POST https://YOUR_DOMAIN/v1/messages`。

### Codex

1. 在 CC Switch 的 **Codex** 区域添加自定义供应商，协议选 **OpenAI-compatible / Responses API**，不要选 Chat Completions。
2. 填写：

   | 字段 | 值 |
   | --- | --- |
   | Base URL | `https://YOUR_DOMAIN/v1` |
   | API Key | 服务器 `.env` 中为 Codex 生成的客户端 Key |
   | Wire API | `responses` / Responses API |
   | Model | OpenRouter 支持 Responses API 的完整模型 ID，例如 `openai/gpt-6-sol`（以当前模型目录为准） |

3. 保存并在 CC Switch 中启用该供应商，完全退出并重启 Codex。
4. 如果 CC Switch 提示“该供应商不支持获取模型列表”，通常只是不能自动发现模型；可以手动填写完整模型 ID。网关自身提供 `GET /v1/models`。

### Codex 配置文件的关键结构

Codex 的用户配置位于 `%USERPROFILE%\.codex\config.toml`。顶层 `model_provider` 负责选择供应商；连接和认证设置必须放在对应的 `[model_providers.<id>]` 表里。参考结构：

```toml
# 顶层：选择供应商和模型
model_provider = "openrouter-gateway"
model = "openai/gpt-6-sol"
model_reasoning_effort = "high"

# 连接和认证字段必须在供应商表内
[model_providers.openrouter-gateway]
name = "OpenRouter Gateway"
base_url = "https://YOUR_DOMAIN/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

如果 CC Switch 将客户端 Key 直接写入 Codex 配置，可以在同一张供应商表内用：

```toml
experimental_bearer_token = "YOUR_CLIENT_API_KEY"
```

它应当替换 `env_key`，并且必须位于 `[model_providers.openrouter-gateway]` 之后、下一个 TOML 表头之前。**不要把 `base_url`、`wire_api` 或 `experimental_bearer_token` 放在 TOML 顶层。**顶层 `model_provider` 的 ID 必须与 `[model_providers.<id>]` 一致。

如果选择 `env_key` 方式，在 Windows 设置环境变量后新开终端：

```powershell
setx OPENAI_API_KEY "YOUR_CLIENT_API_KEY"
```

使用 CC Switch 管理供应商时，优先让 CC Switch 写配置；上面的 TOML 用于核对结构，避免手工设置被 CC Switch 覆盖。

## 可选的直接 HTTP 方式（推荐使用 HTTPS）

如果选择不配置 HTTPS，可在服务器 `.env` 中设置：

```dotenv
GATEWAY_BIND_ADDRESS=0.0.0.0
```

在腾讯云安全组允许入站 TCP `5000`。尽量将来源限制为客户端当前公网 IP `/32`，不要对所有 IP 开放。重建网关：

```bash
docker compose up -d --force-recreate gateway
```

客户端 URL：

- Claude Code：`http://YOUR_DOMAIN:5000`（不加 `/v1`）
- Codex：`http://YOUR_DOMAIN:5000/v1`

也可暂时使用服务器 IP，例如 `http://YOUR_SERVER_IP:5000/v1`。如果你的域名有 DNS/DNSSEC 问题，IP 可用于区分域名解析问题。

> **HTTP 不会加密客户端 Key 和对话内容。HTTPS 强烈推荐，但并非技术上的硬性要求。**若选择继续使用 HTTP，请使用可信网络并限制安全组来源；如果改回 HTTPS，将 `GATEWAY_BIND_ADDRESS` 设为 `127.0.0.1`，关闭公网 TCP 5000，重建网关，并通过 Caddy 使用 `https://YOUR_DOMAIN`。若客户端 Key 在截图或聊天中暴露，请从 `CLIENT_API_KEYS` 撤销旧值并生成新值。

## 排障

- **401**：客户端 Key 不匹配，或修改 `.env` 后忘了重建 gateway。不要把上游 OpenRouter Key 当客户端 Key。
- **域名解析失败，但公网 IP 可访问**：检查 DNS/DNSSEC；确认 A 记录指向服务器。临时测试可使用 IP。
- **404**：检查最终路径；Claude Code 应为 `/v1/messages`，Codex 应为 `/v1/responses`。Base URL 不要带 `/api`。
- **Codex 连接失败但 `/healthz` 正常**：检查 `model_provider` 是否选中自定义供应商，并确认 `base_url`、`wire_api`、Key 都在 `[model_providers.<id>]` 表内，而非 TOML 顶层。
- **模型不支持**：使用 OpenRouter 当前模型目录中的完整 ID（包括 `openai/` 等命名空间），并确认模型适用于 Responses API。
- **429**：超过每个有效客户端 Key 默认每分钟 120 次请求。限流不是账单额度上限。
- **502/504**：查看服务器日志：

  ```bash
  docker compose logs --tail=100 gateway caddy
  ```

  日志不包含 Key、请求正文、响应正文或 URL 查询参数。

## Docker 与密钥

仓库已有 `Dockerfile`，基于 Node.js 22 Alpine，以非 root 用户运行，根文件系统只读，并提供健康检查。Docker Compose 负责 HTTPS 和运行时环境变量注入。**不要将 API Key 写入 Dockerfile、镜像构建参数、Git、客户端代码或日志。**

## 配置参考

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENROUTER_HTTP_REFERER` | 可选 | 其他端点的默认 OpenRouter 应用归因 Referer |
| `OPENROUTER_APP_TITLE` | `OpenRouter Client Gateway` | 其他端点的默认应用归因名称（`X-OpenRouter-Title`） |
| `OPENROUTER_CLAUDE_HTTP_REFERER` | `https://claude.ai/code` | Claude Messages 专用 Referer |
| `OPENROUTER_CLAUDE_APP_TITLE` | `Claude Code` | Claude Messages 专用应用名称 |
| `OPENROUTER_CODEX_HTTP_REFERER` | `https://openai.com/codex` | Codex Responses 专用 Referer；不显式发送 Codex 标题，让 OpenRouter 按 URL 匹配应用 |

修改 `.env` 后需运行 `docker compose up -d --force-recreate gateway` 使配置生效。

## 开发与测试

需要 Node.js 22 或更新版本；运行时没有第三方 npm 依赖：

```bash
npm test
node --check server.js
```

测试覆盖 Claude Messages 和 Codex Responses 的认证、路由、上游 Key 替换与 SSE 流式转发。生产上游固定为 `https://openrouter.ai`；仅测试代码允许连接 loopback HTTP mock 服务。
