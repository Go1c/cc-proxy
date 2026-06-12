# CC Proxy Usage and Architecture

> Current admin-based deployment guide: [ZEABUR_DEPLOYMENT.md](ZEABUR_DEPLOYMENT.md).
> The older deployment notes below predate the admin control plane and may mention
> environment-variable keys or ConfigMap-only `dist` mounts. For the current
> commercial-style deployment, use the admin backend, Dockerfile, `public/`, and
> persistent `CC_PROXY_DATA_DIR` flow in the Zeabur guide.
>
> Current model: one server runs one `cc-proxy` service for one Claude account.
> Admin users, downstream API Keys, runtime config, logs, Claude auth state, and
> account usage are managed from `/admin` and persisted under `/data/cc-proxy`
> on Zeabur. The old `CC_PROXY_API_KEY` style below is legacy-only.

## Current Deployment

Public base URL:

```text
https://cc-proxy.zeabur.app
```

Client API key:

```text
CC_PROXY_API_KEY=<shared out of band>
```

Do not commit the real key. Configure it in Zeabur as an environment variable and use it locally as either `ANTHROPIC_API_KEY` or an `Authorization` header.

Runtime environment variables:

```text
CLAUDE_CODE_OAUTH_TOKEN=<Claude Code OAuth token>
CC_PROXY_API_KEY=<shared proxy API key>
CLAUDE_COMMAND=/src/node_modules/@anthropic-ai/claude-code-linux-x64/claude
CC_CLAUDE_MODEL=claude-sonnet-4-6
CC_PERMISSION_MODE=acceptEdits
CC_MAX_SESSIONS=10
```

`CC_PERMISSION_MODE=acceptEdits` is required when `/v1/messages` should allow Claude Code to create or edit files in the session workspace. Without it, read-only validation can still work, but write/edit requests may be denied or silently skipped by Claude Code permissions.

Optional isolation variable:

```text
CC_CLAUDE_SETTING_SOURCES=project,local
```

This forwards Claude Code's `--setting-sources` flag. Use it only when a machine has user-level Claude Code settings that should not affect the proxy runtime. Do not set it unless you have confirmed the runtime still has a valid `CLAUDE_CODE_OAUTH_TOKEN`; setting sources can change which local configuration files Claude Code reads, but it does not create authentication.

Do not configure `CC_ANTHROPIC_API_KEY`, `CC_ANTHROPIC_BASE_URL`, `CC_ANTHROPIC_AUTH_HEADER`, `CC_ANTHROPIC_BETA`, or `CC_ANTHROPIC_VERSION` for this deployment. The goal is to use Claude Code OAuth/subscription quota through the real Claude Code CLI, not Anthropic API usage credits.

## Zeabur Claude Code OAuth Flow

The OAuth login must be initiated from the server or Pod that will run Claude Code. A browser success page only proves the browser side succeeded; the CLI must receive the returned `code#state` and save credentials in the same runtime context.

Fast path for the current Zeabur node:

```bash
ssh ubuntu@43.128.89.221

NS=environment-6a2ad5e305a35017ba9066bb
DEPLOY=service-6a2ad5ee16481d6693b3f1f5
POD=$(sudo kubectl get pods -n "$NS" -o name | sed -n 's#pod/##p' | head -n 1)

sudo kubectl exec -it -n "$NS" "$POD" -- sh -lc '
  rm -rf /tmp/cc-oauth
  mkdir -p /tmp/cc-oauth
  chmod 700 /tmp/cc-oauth
  HOME=/tmp/cc-oauth \
    env -u CLAUDE_CODE_OAUTH_TOKEN \
        -u ANTHROPIC_BASE_URL \
        -u ANTHROPIC_AUTH_TOKEN \
        -u ANTHROPIC_API_KEY \
        -u ANTHROPIC_AUTH_HEADER \
    /src/node_modules/@anthropic-ai/claude-code-linux-x64/claude auth login --claudeai
'
```

Open the printed `https://claude.com/cai/oauth/authorize?...` URL in a local browser. If the browser shows a `code#state` value, paste it back into the waiting server terminal. After login succeeds, confirm the Pod account is using Claude subscription auth:

```bash
sudo kubectl exec -n "$NS" "$POD" -- sh -lc '
  HOME=/tmp/cc-oauth \
    env -u CLAUDE_CODE_OAUTH_TOKEN \
        -u ANTHROPIC_BASE_URL \
        -u ANTHROPIC_AUTH_TOKEN \
        -u ANTHROPIC_API_KEY \
        -u ANTHROPIC_AUTH_HEADER \
    /src/node_modules/@anthropic-ai/claude-code-linux-x64/claude auth status --json
'
```

Expected shape:

```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "subscriptionType": "pro"
}
```

Then generate the long-lived token:

```bash
sudo kubectl exec -it -n "$NS" "$POD" -- sh -lc '
  HOME=/tmp/cc-oauth \
    env -u CLAUDE_CODE_OAUTH_TOKEN \
        -u ANTHROPIC_BASE_URL \
        -u ANTHROPIC_AUTH_TOKEN \
        -u ANTHROPIC_API_KEY \
        -u ANTHROPIC_AUTH_HEADER \
    /src/node_modules/@anthropic-ai/claude-code-linux-x64/claude setup-token
'
```

`setup-token` may print a second browser OAuth URL. Complete that authorization too. The value to keep is the final long-lived token printed by `setup-token`, not the short `code#state` browser callback value.

To make the token survive Zeabur rebuilds/redeploys, configure it in Zeabur service variables:

```text
CLAUDE_CODE_OAUTH_TOKEN=<long-lived token from claude setup-token>
```

Also keep these service variables in Zeabur:

```text
CLAUDE_COMMAND=/src/node_modules/@anthropic-ai/claude-code-linux-x64/claude
CC_CLAUDE_MODEL=claude-sonnet-4-6
CC_PERMISSION_MODE=acceptEdits
CC_MAX_SESSIONS=10
CC_PROXY_API_KEY=<shared proxy API key>
```

Do not put browser `code#state` values into Zeabur variables. They are one-time OAuth callback codes, not runtime credentials.

For a one-off live Kubernetes patch after setting the Zeabur variable:

```bash
sudo kubectl set env -n "$NS" deploy/"$DEPLOY" \
  CLAUDE_CODE_OAUTH_TOKEN='<long-lived token>' \
  CLAUDE_COMMAND=/src/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
  CC_CLAUDE_MODEL=claude-sonnet-4-6 \
  CC_PERMISSION_MODE=acceptEdits \
  CC_MAX_SESSIONS=10 \
  CC_ANTHROPIC_BETA- CC_ANTHROPIC_BASE_URL- CC_ANTHROPIC_API_KEY- CC_ANTHROPIC_AUTH_HEADER- CC_ANTHROPIC_VERSION-

sudo kubectl rollout status -n "$NS" deploy/"$DEPLOY" --timeout=180s
```

Current Zeabur runtime patch:

```text
cc-proxy-dist ConfigMap -> /src/dist
```

Mount the full compiled `dist` directory. Do not mount only `/src/dist/server.js`; `server.js`, `runner.js`, `session-manager.js`, and `types.js` must come from the same build.

## How To Use

### Anthropic-compatible clients

Use the root URL as the base URL:

```text
ANTHROPIC_BASE_URL=https://cc-proxy.zeabur.app
ANTHROPIC_API_KEY=<your proxy key>
```

If the client asks for a full endpoint instead of a base URL, use:

```text
https://cc-proxy.zeabur.app/v1/messages
```

The proxy accepts both auth styles:

```http
x-api-key: <your proxy key>
```

```http
Authorization: Bearer <your proxy key>
```

Minimal request:

```bash
curl -sS https://cc-proxy.zeabur.app/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: <your proxy key>' \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 512,
    "messages": [
      {
        "role": "user",
        "content": "Read demo.txt and reply with only its unique marker, nothing else."
      }
    ]
  }'
```

Expected text content for the bundled validation project:

```text
ALPHA-BRAVO-CHARLIE-7742
```

Streaming clients:

```text
stream: true
```

The proxy supports Anthropic-style Server-Sent Events for clients that require streaming. For real Claude Code partial output, the runner starts Claude Code with `--include-partial-messages` and forwards Claude Code `stream_event` objects as SSE events as soon as they arrive. If a Claude Code version does not emit partial events for a turn, the proxy falls back to buffered Anthropic-style SSE events after the turn completes.

Client-supplied Anthropic function tools:

```json
{
  "tools": [{ "name": "example_tool", "input_schema": { "type": "object" } }]
}
```

These are supported through a real per-request MCP bridge, not prompt emulation. For a new `/v1/messages` request with `tools`, the proxy starts Claude Code with:

```text
--mcp-config <dynamic config>
--strict-mcp-config
--allowedTools mcp__cc_client_tools__<tool name>
```

The dynamic MCP server exposes the client-provided tool specs to Claude Code. When Claude Code calls the MCP tool, the first `/v1/messages` response returns Anthropic-style `tool_use` with `stop_reason: "tool_use"`. The client must then send the conversation back with the assistant `tool_use` block and a user `tool_result` block with the same `tool_use_id`.

First request:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 512,
  "tools": [
    {
      "name": "lookup_frame_budget",
      "description": "Look up frame-budget guidance for a game platform.",
      "input_schema": {
        "type": "object",
        "properties": {
          "platform": { "type": "string" }
        },
        "required": ["platform"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check."
    }
  ]
}
```

Expected first response shape:

```json
{
  "type": "message",
  "role": "assistant",
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_...",
      "name": "lookup_frame_budget",
      "input": { "platform": "switch" }
    }
  ]
}
```

Follow-up request:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 512,
  "messages": [
    {
      "role": "user",
      "content": "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check."
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_...",
          "name": "lookup_frame_budget",
          "input": { "platform": "switch" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_...",
          "content": "Switch handheld budget: keep simulation plus render under 16.67ms."
        }
      ]
    }
  ]
}
```

`stream: true` is supported for both the initial `tool_use` turn and the resumed `tool_result` answer. Client-supplied tools currently require a new one-shot Claude Code session because MCP configuration is attached when the process starts. Passing `tools` with an existing `x-cc-session-id` returns `400 invalid_request_error`; passing `x-cc-keep-session: true` with `tools` is ignored and no `x-cc-session-id` is returned.

Thinking requests:

```json
{
  "thinking": { "type": "enabled", "budget_tokens": 32000 }
}
```

For new `/v1/messages` sessions, `thinking.budget_tokens` is mapped approximately to Claude Code `--effort`: `low`, `medium`, `high`, `xhigh`, or `max`. This is not the same as Anthropic's exact thinking-token budget API; it is the closest stable Claude Code CLI control exposed here.

Request `model`:

```json
{
  "model": "claude-sonnet-4-6"
}
```

For new `/v1/messages` sessions, the request `model` is passed to Claude Code as `--model`. Existing persistent sessions cannot change model or effort mid-process; create a new proxy session when changing either value.

### Persistent cache sessions

By default, `/v1/messages` creates a temporary Claude Code session for one request and closes it after the turn.

To keep a session alive for prompt-cache reuse, send:

```http
x-cc-keep-session: true
```

The response includes:

```http
x-cc-session-id: <proxy session id>
x-cc-cli-session-id: <claude code session id>
```

Send the next request with:

```http
x-cc-session-id: <proxy session id>
```

Close the session when done:

```bash
curl -sS -X DELETE https://cc-proxy.zeabur.app/sessions/<proxy session id> \
  -H 'Authorization: Bearer <your proxy key>'
```

### Native session API

The lower-level API is still available:

```text
GET    /health
POST   /sessions
GET    /sessions
POST   /sessions/{id}/turn
GET    /sessions/{id}
DELETE /sessions/{id}
```

`/sessions` endpoints require the proxy key when `CC_PROXY_API_KEY` is configured.

## Architecture

```text
Client / SDK
  |
  | POST /v1/messages or /sessions/{id}/turn
  v
Zeabur public route
  |
  v
Node HTTP server (dist/server.js)
  |
  +-- Auth gate (CC_PROXY_API_KEY)
  |
  +-- Anthropic compatibility adapter
  |     - validates /v1/messages JSON
  |     - converts user/assistant messages into Claude Code stream-json events
  |     - preserves native content blocks where Claude Code supports them
  |     - forwards Claude Code partial stream_event objects as Anthropic SSE
  |     - maps Claude Code assistant/result events into Anthropic message JSON
  |     - maps client-supplied tools to a per-request MCP bridge
  |
  +-- ClientToolBridge
  |     - exposes client tool specs through /internal/tool-bridge/{id}/tools
  |     - waits for client tool_result through /internal/tool-bridge/{id}/call
  |     - emits Anthropic tool_use and resumes the original Claude Code turn
  |
  +-- client-tool-mcp-server.js
  |     - stdio JSON-RPC MCP server launched by Claude Code
  |     - implements initialize, tools/list, and tools/call
  |
  +-- SessionManager
        - creates and tracks Claude Code sessions
        - enforces CC_MAX_SESSIONS
        - reaps idle sessions
        - shuts down CLI processes on server exit
        |
        v
      ClaudeRunner
        - starts bundled @anthropic-ai/claude-code native binary
        - sends stream-json user/assistant turns
        - parses stream_event, assistant content blocks, result, usage, cache and cost metadata
        |
        v
      Claude Code CLI in /src/test-workspace
        |
        +-- Dynamic MCP client-tool server when request tools are supplied
        |
        +-- .claude/settings.json PreToolUse hook
              |
              v
            hook-forwarder.cjs
              |
              v
            POST /hooks/pre-tool-use
              |
              v
            Read interception
              - maps reads from session workspace to DOWNSTREAM_ROOT
              - writes downstream content to /tmp/cc-proxy
              - returns updatedInput.file_path to Claude Code
```

## Implemented Features

- Zeabur-compatible runtime on `PORT`.
- Bundled Claude Code CLI resolution for macOS and Linux native optional packages.
- Claude OAuth token support through `CLAUDE_CODE_OAUTH_TOKEN`.
- Public health endpoint: `GET /health`.
- Persistent session API with max-session enforcement.
- Idle session cleanup with `CC_IDLE_TIMEOUT_MS` and `CC_REAP_INTERVAL_MS`.
- Graceful shutdown that kills managed Claude Code processes.
- PreToolUse Read interception:
  - reads requested files from `DOWNSTREAM_ROOT`,
  - writes safe temp files,
  - prevents path traversal out of downstream root,
  - preserves downstream bytes/content for billing-relevant reads.
- Claude Code built-in tool execution, including `Read` and `Write`.
- Optional Claude Code permission mode via `CC_PERMISSION_MODE`, including `acceptEdits` for write/edit validation.
- Anthropic-style `POST /v1/messages`:
  - accepts `x-api-key` and `Authorization: Bearer`,
  - emits `request-id` response headers and `request_id` on Anthropic-shaped errors,
  - returns `type: "message"`, assistant content blocks, stop reason and usage,
  - supports `stream: true` using live Claude Code partial `stream_event` forwarding, with buffered SSE fallback,
  - passes supported content blocks to Claude Code as native stream-json blocks, including text, image, document, tool_result, and assistant history blocks,
  - preserves Claude Code assistant blocks such as `thinking` with `signature` when Claude Code emits them,
  - returns cache and cost metadata from Claude Code in `usage`,
  - maps request `model` to Claude Code `--model` for new sessions,
  - maps request `thinking.budget_tokens` approximately to Claude Code `--effort` for new sessions,
  - supports client-supplied Anthropic `tools` through a real one-shot Claude Code MCP bridge,
  - emits `tool_use` and accepts follow-up `tool_result` to resume the original Claude Code turn,
  - supports temporary one-shot sessions and optional persistent sessions.
- Optional model override via `CC_CLAUDE_MODEL`.
- Optional permission-mode override via `CC_PERMISSION_MODE`.
- Production deployment with `cc-proxy-dist` mounted over `/src/dist`, so all runtime modules match the local build.

## Completed Work

- Reverted the Anthropic API upstream backend so requests no longer use API credits.
- Restored `/v1/messages` to route through the real Claude Code CLI using OAuth/subscription quota.
- Added Anthropic-compatible `POST /v1/messages` auth through `x-api-key` and `Authorization: Bearer`.
- Added `request-id` headers and Anthropic-shaped `request_id` error bodies.
- Added live `stream: true` SSE forwarding from Claude Code partial `stream_event` output.
- Preserved Claude Code stream-json assistant blocks, including `thinking` and `signature`.
- Preserved native input blocks passed to Claude Code, including text, image, document, tool_result, and assistant history blocks.
- Passed `/v1/messages` request `model` through to Claude Code `--model` for new sessions.
- Mapped `/v1/messages` `thinking.budget_tokens` to Claude Code `--effort` for new sessions.
- Replaced prompt-emulated client-supplied `tools` with a real per-request MCP bridge.
- Added Anthropic-style `tool_use` / `tool_result` continuation support.
- Added live SSE forwarding for the first `tool_use` turn and for the resumed `tool_result` answer.
- Filtered Claude Code internal tool discovery events such as `ToolSearch` out of the client-supplied tool bridge, so only tool names declared by the Anthropic client are exposed back as Anthropic `tool_use` blocks.
- Added `CC_CLAUDE_MODEL=claude-sonnet-4-6` CLI model override.
- Added `CC_PERMISSION_MODE=acceptEdits` CLI permission override.
- Set production `CC_MAX_SESSIONS=10`.
- Removed production `CC_ANTHROPIC_*` environment variables.
- Fixed the Zeabur deployment mismatch where only `server.js` was mounted and the old image `runner.js` was still used.
- Added local fake-Claude coverage for live stream chunks, multimodal native blocks, assistant history preservation, request model/effort args, cache metadata, request-id headers, client-supplied MCP tools, and tool edge cases.
- Verified production text, stream, image, long-context game-development prompts, Read hook markers, persistent sessions, and cache metadata.

## Not Implemented Yet

- Exact Anthropic `tool_choice` semantics are not fully implemented or verified.
- Client-supplied `tools` cannot be added to an already-running persistent `x-cc-session-id`, and `x-cc-keep-session` is ignored for tool requests; they require a one-shot Claude Code process so the dynamic MCP config can be attached and safely torn down after the follow-up `tool_result`.
- `thinking.budget_tokens` uses an approximate Claude Code `--effort` mapping, not exact Anthropic thinking-token budget semantics.
- Existing persistent sessions cannot change model, effort, or MCP tool configuration after the Claude Code process starts.
- Official Anthropic response headers and every edge-case error shape are not fully reproduced beyond the implemented `request-id` and `request_id` fields.
- There is no rate limiting beyond `CC_MAX_SESSIONS`.
- There is no per-user key management; `CC_PROXY_API_KEY` is a single shared proxy key.
- The hook currently intercepts `Read`; writes happen in the Claude Code session workspace and are not mirrored back into `DOWNSTREAM_ROOT`.

## TODO

- Verify exact `tool_choice` behavior against real Claude Code MCP calls and decide which Anthropic modes can be safely mapped.
- Re-test client-supplied tools in production after Claude subscription quota resets. The latest run proved the proxy no longer leaks Claude Code internal `ToolSearch` as a client tool, but full tool execution/resume could not be completed because Claude Code returned a five-hour session-limit 429.
- Add broader production integration coverage for multi-tool and tool error cases.
- Improve Anthropic-compatible response headers and edge-case error shapes beyond request IDs.
- Add per-user or per-client API keys instead of one shared `CC_PROXY_API_KEY`.
- Add explicit production rate limiting beyond `CC_MAX_SESSIONS`.
- Decide how write/edit results should sync back to a real downstream workspace in a remote-agent architecture.
- Add a repeatable production deployment script for the `cc-proxy-dist` ConfigMap patch.
- Add live production integration coverage for request-id headers, live streaming timing, model/effort args, and client-supplied MCP tools.

## Known Edge Cases

- Very small image inputs can be rejected by the underlying Claude Code/API image processor. A normal 64x64 PNG image passed through `/v1/messages` and returned `Red` in production.
- Claude Code reports high token counts because each Claude Code CLI request includes its own tool/runtime/system context. This is expected for the Claude Code OAuth path and is not the same as a minimal Anthropic API request.
- Claude Code `usage.input_tokens` can look deceptively small while `cache_creation_input_tokens` and `cache_read_input_tokens` are large. For example, a real production tool validation turn reported `input_tokens=3`, `cache_creation_input_tokens=5818`, and `cache_read_input_tokens=17125`. Token auditing must include the cache fields, not just `input_tokens`.
- `usage.total_cost_usd` is surfaced from Claude Code result events for visibility, but this deployment is authenticated by `CLAUDE_CODE_OAUTH_TOKEN`; do not add Anthropic API upstream credentials unless the billing model intentionally changes.
- If local validation unexpectedly calls a remote proxy or custom Anthropic base URL, check user-level Claude Code settings and rerun with `CC_CLAUDE_SETTING_SOURCES=project,local` plus a valid `CLAUDE_CODE_OAUTH_TOKEN`.

## Zeabur Deployment Notes

Build locally before updating the runtime ConfigMap:

```bash
npm run build
```

Upload the full `dist` directory as a ConfigMap and mount it over `/src/dist`:

```bash
tar -czf /tmp/cc-proxy-dist.tgz -C . dist
scp /tmp/cc-proxy-dist.tgz ubuntu@43.128.89.221:/tmp/cc-proxy-dist.tgz
```

On the Zeabur host:

```bash
NS=environment-6a2ad5e305a35017ba9066bb
DEPLOY=service-6a2ad5ee16481d6693b3f1f5

rm -rf /tmp/cc-proxy-dist-upload
mkdir -p /tmp/cc-proxy-dist-upload
tar -xzf /tmp/cc-proxy-dist.tgz -C /tmp/cc-proxy-dist-upload
find /tmp/cc-proxy-dist-upload/dist -name '._*' -delete

sudo kubectl create configmap cc-proxy-dist -n "$NS" \
  --from-file=/tmp/cc-proxy-dist-upload/dist \
  -o yaml --dry-run=client | sudo kubectl apply -f -

sudo kubectl patch deploy -n "$NS" "$DEPLOY" --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/volumeMounts/1","value":{"name":"cc-proxy-dist","mountPath":"/src/dist","readOnly":true}},
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"cc-proxy-dist","configMap":{"name":"cc-proxy-dist"}}}
]'

sudo kubectl rollout restart -n "$NS" deploy/"$DEPLOY"
sudo kubectl rollout status -n "$NS" deploy/"$DEPLOY" --timeout=150s
```

After rollout, verify the key runtime hashes:

```bash
POD=$(sudo kubectl get pods -n "$NS" \
  -l zeabur_service_id=6a2ad5ee16481d6693b3f1f5 \
  -o jsonpath='{.items[0].metadata.name}')

sudo kubectl exec -n "$NS" "$POD" -- sh -lc \
  'sha256sum /src/dist/server.js /src/dist/runner.js /src/dist/session-manager.js /src/dist/client-tool-bridge.js /src/dist/client-tool-mcp-server.js /src/dist/types.js'
```

## Verification

Current production status as of 2026-06-12:

```text
GET /health -> 200, max_sessions=10
CLAUDE_CODE_OAUTH_TOKEN -> refreshed with a 1-year Claude Code OAuth token; latest Pod reads token length 108 and prefix sk-ant-oat
POST /v1/messages text -> 200, request-id and x-cc-cli-session-id present, LIVE_TEXT_OK returned
POST /v1/messages stream:true -> 200, text/event-stream, request-id present, live content_block_delta events present, STREAM_REAL_OK returned
POST /v1/messages long game-development context -> 200, LONG_GAME_CONTEXT_OK returned
POST /v1/messages client-supplied tool first turn -> partially verified after internal ToolSearch filter deploy; current remaining verification is blocked by Claude Code five-hour session-limit 429 until reset
```

Current local real-Claude validation status as of 2026-06-12:

```text
Isolated local server with real Claude Code CLI starts and serves /health
POST /v1/messages invalid messages -> 400, request-id header matches body request_id
POST /v1/messages inference -> depends on local CLAUDE_CODE_OAUTH_TOKEN and Claude subscription session quota
```

Previous verified production run on 2026-06-12 before the token refresh issue:

```text
GET /health -> 200, max_sessions=10
POST /v1/messages invalid messages -> 400, request-id header matches body request_id
POST /v1/messages client-supplied tools -> pending current deployment verification
POST /v1/messages text -> 200, request-id and x-cc-cli-session-id present, DEPLOY_NORMAL_OK present
POST /v1/messages stream:true game-development prompt -> 200, text/event-stream, request-id and x-cc-cli-session-id present, content_block_delta present, STREAM_LIVE_DEPLOY_OK present
POST /v1/messages text Read hook -> 200, marker ALPHA-BRAVO-CHARLIE-7742 present
POST /v1/messages stream:true -> 200, Anthropic SSE events present, STREAM_COMPAT_OK present
POST /v1/messages image 64x64 PNG -> 200, Red
POST /v1/messages long game-development prompt -> 200, marker ALPHA-BRAVO-CHARLIE-7742 present
POST /v1/messages persistent second turn -> 200, marker DELTA-ECHO-FOXTROT-3355 present
Persistent second turn cache_read_input_tokens -> 48460
```

Local non-paid test suite:

```bash
npm test
```

Latest local result:

```text
tests 74
pass 74
fail 0
```

Local coverage includes fake-Claude HTTP tests for request-id headers, live stream chunks, multimodal native blocks, assistant history preservation, cache metadata, client-supplied MCP tools, tool edge cases, long game-development context passthrough, and Claude CLI setting-source argument forwarding.

Real paid integration test:

```bash
npm run test:integration
```

Production smoke test:

```bash
curl -sS https://cc-proxy.zeabur.app/health
```

Production `/v1/messages` test:

```bash
curl -sS https://cc-proxy.zeabur.app/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <your proxy key>' \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 512,
    "messages": [
      {
        "role": "user",
        "content": "Read demo.txt and reply with only its unique marker, nothing else."
      }
    ]
  }'
```

Successful response should contain:

```text
ALPHA-BRAVO-CHARLIE-7742
```

Long game-development validation prompt:

```bash
curl -sS https://cc-proxy.zeabur.app/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <your proxy key>' \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1600,
    "messages": [
      {
        "role": "user",
        "content": "You are validating a game development assistant proxy. Read demo.txt and sub/nested.txt from the project. Then write a concise but non-trivial technical review for a small action RPG prototype: combat loop, entity-component design, save/load schema, asset pipeline, performance budget, and automated test plan. Include the exact markers you read from both files, and explain how each marker proves the read hook used downstream project content. Keep the answer grounded in implementation details, not marketing copy."
      }
    ]
  }'
```
