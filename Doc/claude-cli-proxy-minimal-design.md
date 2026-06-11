# Claude CLI Server-Side Harness Minimal Technical Plan

## 1. Goal

Build a minimal API server that lets users call a company URL with one fixed API key, while the real Claude CLI runs on the overseas server.

The important design point is this: the API server should not simply forward requests to Claude, and it should not try to fully imitate Claude CLI with a custom Go or Node HTTP client. The upstream Claude requests should be made by the real Claude CLI process installed and logged in on the server.

This makes the upstream side look like server-side Claude CLI traffic because it actually is server-side Claude CLI traffic.

## 2. Request Flow

```text
User local client
  -> URL + fixed company API key
  -> Proxy API Server
  -> Session Manager
  -> real Claude CLI process on the server
  -> Claude upstream
  -> real Claude CLI process on the server
  -> Proxy API Server
  -> User local client
```

The user's local project can still be synchronized to the server with the existing project mount tool. Claude CLI reads and writes the server-side mounted workspace. File changes are then synced back to the user's local project.

## 3. Why This Is Not A Simple Proxy

A simple proxy only forwards HTTP requests. That is not enough for this design.

Claude CLI traffic has multiple observable layers:

- Application HTTP headers: `User-Agent`, `x-app`, `x-stainless-*`, `anthropic-beta`, `anthropic-version`.
- Request body and harness behavior: Claude Code system prompts, tool definitions, session shape, and message structure.
- Network stack fingerprint: TLS ClientHello, JA3/JA4, HTTP/2 settings, frame order, and runtime-specific behavior.

If the API server uses a normal Go, Node, or Python HTTP client to call Claude upstream, the third layer belongs to that HTTP client, not to Claude CLI. Header rewriting alone cannot fix that.

Therefore the target design is:

```text
Do not imitate Claude CLI upstream traffic.
Run the real Claude CLI and let it make the upstream traffic.
```

## 4. First Version Scope

The first version supports one fixed downstream API key and one server-side Claude login.

Supported API surface:

```text
GET  /healthz
POST /v1/sessions
POST /v1/sessions/{session_id}/messages
DELETE /v1/sessions/{session_id}
```

Authentication:

```text
Authorization: Bearer <fixed-company-api-key>
```

Configuration:

```text
CC_PROXY_API_KEY=downstream key used by all clients
CLAUDE_COMMAND=claude
WORKSPACE_ROOT=/opt/cc-proxy/workspaces
PORT=8317
```

The server machine must already have Claude CLI installed and logged in.

## 5. Core Components

### API Server

Receives local client requests, checks the fixed company API key, and routes requests to the right server-side Claude CLI session.

### Auth Middleware

Reads `Authorization: Bearer ...` and compares it with `CC_PROXY_API_KEY`.

Invalid or missing keys return `401 Unauthorized`.

### Session Manager

Creates and tracks Claude CLI sessions.

Each session maps to:

```text
session_id
workspace_path
claude_cli_process
created_at
last_active_at
status
```

### Workspace Manager

Assigns a server-side working directory for each session.

Example:

```text
/opt/cc-proxy/workspaces/sess_abc123/
```

For the first version, the workspace can be created directly on the server or point to a mounted project directory.

### Claude CLI Runner

Starts a real Claude CLI process in the session workspace.

The API server communicates with the process through a PTY or subprocess stdin/stdout:

```text
cd /opt/cc-proxy/workspaces/sess_abc123
claude
```

The runner sends user messages to Claude CLI, reads CLI output, and streams that output back to the API caller.

## 6. Tool Calling

Tool execution happens inside the real Claude CLI session on the server.

That means:

- File reads happen in the server-side workspace.
- File writes happen in the server-side workspace.
- Shell commands run on the server.
- Project changes sync back to the user's local machine through the mount tool.

This matches the original mounted-project workflow:

```text
User local project
  <-> mount/sync tool
  <-> server workspace
  <-> server Claude CLI tools
```

## 7. Fingerprint Handling

The first version should not implement browser-style fingerprint spoofing or custom TLS impersonation.

Instead, it avoids the problem by using the real server-side Claude CLI for upstream calls:

- HTTP headers come from Claude CLI.
- Claude Code system prompt and tool protocol come from Claude CLI.
- TLS and HTTP/2 behavior come from the Claude CLI runtime.

The API server only wraps local user access. It should not construct upstream Claude `/v1/messages` requests by itself.

## 8. Non-Goals

The first version will not implement:

- Multiple downstream API keys
- Multiple Claude accounts
- Account rotation
- OpenAI, Gemini, or other protocol conversion
- Admin dashboard
- Usage billing
- Custom TLS fingerprint simulation
- Browser automation
- Full Claude API compatibility

## 9. Error Handling

Recommended behavior:

- `401`: missing or invalid downstream API key.
- `404`: unknown session id.
- `409`: session exists but Claude CLI process is not ready.
- `502`: Claude CLI process failed or exited unexpectedly.
- `504`: Claude CLI did not produce output before timeout.

The API server should log the session id, workspace path, process status, and last CLI stderr line for debugging.

## 10. First Implementation Milestone

Milestone 1 should deliver:

- A small HTTP server.
- Fixed API key authentication from environment variables.
- `/healthz`.
- Session creation.
- One Claude CLI process per session.
- Message sending through PTY or subprocess stdin/stdout.
- Streaming output back to the caller.
- Workspace directory assignment.
- Basic process cleanup on session delete or timeout.

After this works with one user and one mounted workspace, later milestones can add multi-user workspace mapping, queueing, session persistence, usage logging, and operational controls.
