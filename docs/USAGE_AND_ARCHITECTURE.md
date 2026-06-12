# CC Proxy Usage and Architecture

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

Do not configure `CC_ANTHROPIC_API_KEY`, `CC_ANTHROPIC_BASE_URL`, `CC_ANTHROPIC_AUTH_HEADER`, `CC_ANTHROPIC_BETA`, or `CC_ANTHROPIC_VERSION` for this deployment. The goal is to use Claude Code OAuth/subscription quota through the real Claude Code CLI, not Anthropic API usage credits.

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

The proxy supports Anthropic-style Server-Sent Events for clients that require streaming. The underlying Claude Code turn is still executed as a real Claude Code request; the proxy currently sends buffered SSE events after the Claude Code turn completes rather than token-by-token live streaming.

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
  |     - maps Claude Code assistant/result events into Anthropic message JSON
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
        - parses assistant content blocks, result, usage, cache and cost metadata
        |
        v
      Claude Code CLI in /src/test-workspace
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
  - returns `type: "message"`, assistant content blocks, stop reason and usage,
  - supports `stream: true` using Anthropic-style buffered SSE events,
  - passes supported content blocks to Claude Code as native stream-json blocks, including text, image, document, tool_result, and assistant history blocks,
  - preserves Claude Code assistant blocks such as `thinking` with `signature` when Claude Code emits them,
  - returns cache and cost metadata from Claude Code in `usage`,
  - supports temporary one-shot sessions and optional persistent sessions.
- Optional model override via `CC_CLAUDE_MODEL`.
- Optional permission-mode override via `CC_PERMISSION_MODE`.
- Production deployment with `cc-proxy-dist` mounted over `/src/dist`, so all runtime modules match the local build.

## Completed Work

- Reverted the Anthropic API upstream backend so requests no longer use API credits.
- Restored `/v1/messages` to route through the real Claude Code CLI using OAuth/subscription quota.
- Added Anthropic-compatible `POST /v1/messages` auth through `x-api-key` and `Authorization: Bearer`.
- Added buffered `stream: true` SSE compatibility.
- Preserved Claude Code stream-json assistant blocks, including `thinking` and `signature`.
- Preserved native input blocks passed to Claude Code, including text, image, document, tool_result, and assistant history blocks.
- Added `CC_CLAUDE_MODEL=claude-sonnet-4-6` CLI model override.
- Added `CC_PERMISSION_MODE=acceptEdits` CLI permission override.
- Set production `CC_MAX_SESSIONS=10`.
- Removed production `CC_ANTHROPIC_*` environment variables.
- Fixed the Zeabur deployment mismatch where only `server.js` was mounted and the old image `runner.js` was still used.
- Verified production text, stream, image, long-context game-development prompts, Read hook markers, persistent sessions, and cache metadata.

## Not Implemented Yet

- Token-by-token live streaming is not implemented. `stream: true` clients receive Anthropic-style SSE events after the Claude Code turn completes.
- Full client-supplied Anthropic tool-use protocol is not implemented. Client-supplied `tools` are included as prompt context, but the proxy does not dynamically register or execute those client function tools.
- `thinking` request options are not translated into a per-request Claude Code effort setting yet. The proxy preserves `thinking` blocks and signatures when Claude Code emits them.
- `/v1/messages` does not currently pass the request `model` field through to Claude Code. The response echoes the requested model for SDK compatibility; the actual Claude Code model is selected by Claude Code or `CC_CLAUDE_MODEL`.
- Official Anthropic response headers and every edge-case error shape are not fully reproduced.
- There is no rate limiting beyond `CC_MAX_SESSIONS`.
- There is no per-user key management; `CC_PROXY_API_KEY` is a single shared proxy key.
- The hook currently intercepts `Read`; writes happen in the Claude Code session workspace and are not mirrored back into `DOWNSTREAM_ROOT`.

## TODO

- Implement live token-by-token streaming from Claude Code events instead of buffered SSE.
- Implement real client-supplied Anthropic tool protocol support:
  - accept `tools`,
  - emit `tool_use`,
  - accept follow-up `tool_result`,
  - preserve `tool_choice` semantics where possible.
- Map Anthropic `thinking` request options to an appropriate Claude Code effort/config path if Claude Code exposes a stable interface.
- Decide whether per-request `model` should override the CLI model or remain deployment-controlled by `CC_CLAUDE_MODEL`.
- Improve Anthropic-compatible response headers and error shapes, including request IDs.
- Add per-user or per-client API keys instead of one shared `CC_PROXY_API_KEY`.
- Add explicit production rate limiting beyond `CC_MAX_SESSIONS`.
- Decide how write/edit results should sync back to a real downstream workspace in a remote-agent architecture.
- Add a repeatable production deployment script for the `cc-proxy-dist` ConfigMap patch.
- Add cctest coverage for long context, streaming, multimodal images, assistant history, cache reuse, and tool-call edge cases.

## Known Edge Cases

- Very small image inputs can be rejected by the underlying Claude Code/API image processor. A normal 64x64 PNG image passed through `/v1/messages` and returned `Red` in production.
- Claude Code reports high token counts because each Claude Code CLI request includes its own tool/runtime/system context. This is expected for the Claude Code OAuth path and is not the same as a minimal Anthropic API request.
- `usage.total_cost_usd` is surfaced from Claude Code result events for visibility, but this deployment is authenticated by `CLAUDE_CODE_OAUTH_TOKEN`; do not add Anthropic API upstream credentials unless the billing model intentionally changes.

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
  'sha256sum /src/dist/server.js /src/dist/runner.js /src/dist/session-manager.js /src/dist/types.js'
```

## Verification

Latest verified production run: 2026-06-12.

Production status:

```text
GET /health -> 200, max_sessions=10
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
