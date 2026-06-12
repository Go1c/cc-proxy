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
CC_PERMISSION_MODE=acceptEdits
```

`CC_PERMISSION_MODE=acceptEdits` is required when `/v1/messages` should allow Claude Code to create or edit files in the session workspace. Without it, read-only validation can still work, but write/edit requests may be denied or silently skipped by Claude Code permissions.

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

The proxy supports Anthropic-style Server-Sent Events for clients that require streaming. The underlying Claude Code turn is still executed as a real Claude Code request; the proxy currently sends the resulting assistant text as a buffered SSE response rather than token-by-token live streaming.

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
  |     - converts messages into a Claude Code prompt
  |     - maps Claude Code result into Anthropic message JSON
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
        - sends stream-json user turns
        - parses result, usage, cache and cost metadata
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
  - returns `type: "message"`, assistant text content, stop reason and usage,
  - supports `stream: true` using Anthropic-style buffered SSE events,
  - returns cache and cost metadata from Claude Code in `usage`,
  - supports temporary one-shot sessions and optional persistent sessions.
- Optional model override via `CC_CLAUDE_MODEL`.
- Optional permission-mode override via `CC_PERMISSION_MODE`.

## Not Implemented Yet

- Token-by-token live streaming is not implemented. `stream: true` clients receive Anthropic-style SSE events after the Claude Code turn completes.
- Full Anthropic tool-use protocol is not implemented. Client-supplied `tools` are included as prompt context, but the proxy does not return `tool_use` blocks or execute client function tools.
- Multimodal content is not natively handled. Non-text content blocks are serialized into prompt text.
- `/v1/messages` does not currently pass the request `model` field through to Claude Code. The response echoes the requested model for SDK compatibility; the actual Claude Code model is selected by Claude Code or `CC_CLAUDE_MODEL`.
- Official Anthropic response headers and every edge-case error shape are not fully reproduced.
- There is no rate limiting beyond `CC_MAX_SESSIONS`.
- There is no per-user key management; `CC_PROXY_API_KEY` is a single shared proxy key.
- The hook currently intercepts `Read`; writes happen in the Claude Code session workspace and are not mirrored back into `DOWNSTREAM_ROOT`.

## Verification

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
