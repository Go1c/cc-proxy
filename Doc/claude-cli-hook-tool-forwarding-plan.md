# Claude CLI Hook Tool Forwarding Plan

## Goal

Build a system where the upstream model requests are made by a real Claude CLI running on the server, while every meaningful tool action is executed by an API downstream, usually a user-local agent.

The server Claude CLI should keep ownership of the model loop, system prompt, tool-call decisions, message structure, and network fingerprint. It should not read, write, edit, or run shell commands against real project state on the server.

## Core Architecture

```text
User client
  -> API Server
  -> server Claude CLI session
  -> Claude upstream

Claude CLI tool call
  -> Claude Code hook
  -> Tool Forwarder
  -> downstream agent API
  -> user-local project/tool execution
  -> Tool Forwarder
  -> hook result returned to Claude CLI
  -> Claude CLI continues the model loop
```

The hard requirement is that Claude upstream traffic comes from the real server Claude CLI. The API server must not construct upstream `/v1/messages` calls.

## Design Principle

Do not spoof the Claude Code harness. Use the real harness.

Do not spoof TLS or HTTP/2. Use the real Claude CLI runtime.

Do not let the server Claude CLI perform real project mutations. Intercept tool calls and send them to the downstream executor.

## Why This Beats Full Spoofing

Full spoofing requires copying and maintaining several moving targets:

- Claude Code system prompt and hidden harness behavior.
- Built-in tool names, schemas, ordering, and metadata.
- Message structure and session metadata.
- `count_tokens` and background housekeeping behavior.
- TLS, JA3/JA4, HTTP/2, and runtime network fingerprints.

The hook-forwarding design keeps those parts inside real Claude CLI. The custom code only owns the lower layer: tool execution routing.

## First Validation Target

The first milestone is not a full product. It is a proof that one tool can be intercepted, executed downstream, and returned to Claude CLI without server-side real execution.

Target tool:

```text
Read
```

Success criteria:

- Claude CLI runs on the server.
- Claude tries to read a file.
- The hook intercepts the tool call.
- The server does not read the target file from real project state.
- The tool request is sent to a downstream agent.
- The downstream agent reads the file.
- The result is returned to Claude CLI.
- Claude continues reasoning using the downstream file content.

## Planned Components

### API Server

Responsibilities:

- Validate the fixed company API key.
- Create and track Claude CLI sessions.
- Start Claude CLI in a controlled server workspace.
- Stream Claude CLI output back to the user.
- Receive hook events from Claude CLI.
- Forward tool requests to the correct downstream agent.

### Session Manager

Responsibilities:

- Map `session_id` to one Claude CLI process.
- Map `session_id` to one downstream agent connection.
- Track session state: starting, ready, running, waiting_for_tool, failed, closed.
- Clean up idle sessions.

### Claude CLI Runner

Responsibilities:

- Start real `claude` process.
- Set session-specific environment variables for hooks.
- Run in a safe server workspace.
- Read stdout and stderr.
- Send user prompts into the CLI.
- Stop the process on session close.

### Hook Bridge

Responsibilities:

- Receive Claude Code hook payloads.
- Normalize hook events into internal tool request objects.
- Decide whether the server may execute a tool.
- For protected tools, route execution to the downstream agent.
- Return the hook decision to Claude CLI.

### Downstream Agent

Responsibilities:

- Run on the user's local machine or controlled downstream environment.
- Receive tool execution requests.
- Execute allowed tools against the user's real project.
- Return stdout, stderr, file content, patch result, exit code, and errors.

First version downstream tools:

```text
Read
```

Later tools:

```text
LS
Glob
Grep
Edit
Write
Bash
```

## Hook Strategy Options

### Option A: PreToolUse blocks and defers execution

The hook intercepts the tool call before server execution and returns a decision that prevents the real server-side tool from running. The API server forwards the tool call to downstream and resumes Claude with the downstream result.

This is the cleanest model if Claude CLI supports the needed defer/resume flow for the target usage mode.

Risk:

- The exact resume flow must be validated with the installed Claude CLI version.

### Option B: PreToolUse rewrites to safe no-op, PostToolUse replaces output

The hook intercepts the real tool input, sends it downstream, rewrites the server-side tool call into a safe no-op action, then uses the post-tool hook to replace what Claude sees with the downstream result.

This keeps the Claude CLI loop moving even if native defer/resume is awkward.

Risk:

- Some tools may not have an obvious safe no-op.
- Post-tool output replacement must be proven reliable.
- The server still technically runs a placeholder tool.

### Recommended validation path

Start with Option A for `Read`.

If Option A cannot return a remote result cleanly, try Option B with a safe no-op `Read` against a controlled dummy file.

## Safe Server Workspace

The server Claude CLI should not run in a real project directory during validation.

Use a controlled workspace:

```text
workspaces/
  sess_abc123/
    .server-placeholder/
```

The real project exists only downstream.

For validation, place a dummy file on the server with different content than the downstream file. Ask Claude to read the file. Success means Claude sees downstream content, not server content.

## Tool Request Shape

Internal normalized request:

```json
{
  "session_id": "sess_abc123",
  "request_id": "toolreq_001",
  "tool_name": "Read",
  "tool_input": {
    "file_path": "src/example.ts"
  },
  "cwd": "/project",
  "timeout_ms": 30000
}
```

Internal normalized response:

```json
{
  "session_id": "sess_abc123",
  "request_id": "toolreq_001",
  "ok": true,
  "output": "file content here",
  "metadata": {
    "bytes": 1234,
    "source": "downstream-agent"
  }
}
```

Error response:

```json
{
  "session_id": "sess_abc123",
  "request_id": "toolreq_001",
  "ok": false,
  "error": {
    "type": "not_found",
    "message": "src/example.ts does not exist"
  }
}
```

## Validation Steps

### Phase 1: Hook observation

- Install a minimal Claude Code hook on the server.
- Log every hook payload to a session log file.
- Trigger a simple prompt that causes a `Read`.
- Confirm the hook payload includes tool name, tool input, session information, and enough context to route the request.

Expected output:

```text
hook event received: PreToolUse Read
tool input includes file path
session id is available or can be injected through env
```

### Phase 2: Block server-side Read

- Configure the hook to stop or defer `Read`.
- Ask Claude to read a file that exists only on the server.
- Confirm the server file is not read by Claude.

Expected output:

```text
server-side Read blocked
Claude does not receive server file content
```

### Phase 3: Downstream Read

- Create a tiny downstream agent with one endpoint: `POST /tools/read`.
- Send the normalized `Read` request to the downstream agent.
- Return file content to the hook bridge.

Expected output:

```text
downstream read ok
result contains downstream file content
```

### Phase 4: Return downstream result to Claude

- Feed the downstream result back into Claude CLI through the hook-supported mechanism.
- Ask Claude to summarize the file.
- Confirm the summary matches downstream content.

Expected output:

```text
Claude summary uses downstream content
Claude does not use server placeholder content
```

### Phase 5: Expand to harmless directory tools

After `Read` works, add:

```text
LS
Glob
Grep
```

These tools are read-only and easier to validate than mutation tools.

### Phase 6: Validate mutation tools

Add:

```text
Edit
Write
```

Success criteria:

- Claude requests an edit.
- Server does not mutate real project state.
- Downstream agent applies the edit locally.
- Claude sees the downstream edit result.

### Phase 7: Validate Bash last

Add:

```text
Bash
```

Bash is highest risk because it can mutate files, install packages, run long commands, and expose local secrets.

First Bash policy:

- Require explicit allowlist.
- Set timeout.
- Capture stdout and stderr.
- Return exit code.
- Reject interactive commands.
- Reject commands outside the project directory.

## Security Boundaries

Downstream agent must enforce:

- Workspace root restriction.
- Path normalization.
- No access outside the configured project directory.
- Command timeout.
- Maximum output size.
- Tool allowlist.
- Request authentication from API server.

The server should enforce:

- One fixed downstream API key for users in version 1.
- Session-to-agent binding.
- Tool request idempotency by `request_id`.
- Logs for every intercepted tool call.

## Validation Results (claude CLI 2.1.150, 2026-06-11)

All findings below come from running the real `claude` CLI, not mocks.

### Read hook interception — PASSED

- `type: "http"` PreToolUse hooks fire against the real CLI. The hook bridge rewrites `file_path` via `updatedInput` to a temp file holding downstream content.
- Real CLI read `demo.txt` and reported the downstream marker `ALPHA-BRAVO-CHARLIE-7742`, never the server placeholder. Server log confirmed the hook fired with the CLI's real `session_id`.
- This clears the Decision Gate: `Read` can be intercepted and returned cleanly.

### Persistent multi-turn process — PASSED

- One persistent process via `claude -p --input-format stream-json --output-format stream-json --verbose`, fed NDJSON user turns on stdin, handles many turns in one CLI session (`session_id` stable across turns).
- The PreToolUse hook fires on every turn; downstream content returned correctly each turn.

### Prompt cache + billing — PASSED, with a critical cost finding

- Billing/usage is fully observable via `--output-format json` / `stream-json` result events: `total_cost_usd`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `modelUsage`.
- **Independent `claude -p` processes never share cache** (`cache_read = 0` each call) — full price every time (~$0.59/call observed).
- **A persistent process reuses cache across turns**: turn 1 `cache_read = 0` / `cache_creation ≈ 60k`, turn 2 `cache_read ≈ 60k`, cost dropping ~6x ($0.59 → ~$0.10). This is the core economic reason the architecture must keep one persistent CLI process per user session.
- Note: Anthropic ephemeral cache TTL is 5 minutes; the process idle timeout (10 min) is for resource reclaim. A live process past 5 min idle still pays cold cache on the next turn.

### Memory / capacity — MEASURED

- One idle persistent CLI process: WorkingSet ≈ 331 MB, committed (Private) ≈ 586 MB; ~340–410 MB WorkingSet under active load.
- The orchestrator language is not the memory bottleneck — each session spawns a real CLI child of a few hundred MB. The memory lever is a hard concurrency cap, not the orchestrator.
- `MAX_SESSIONS` defaults to 10 (sized for an 8 GB host: ~6 GB usable / ~586 MB). Set 4 for a 4 GB host. Over the limit, session creation is rejected with HTTP 503.

## Open Technical Questions

Resolved:

- ~~Can `PreToolUse` return a remote result directly, or only allow/block/ask/defer?~~ → It returns `allow` with `updatedInput` rewriting `file_path` to a temp file holding downstream content. No `defer` needed.
- ~~Does the flow work in interactive/server-managed mode, or only `claude -p`?~~ → Works with a persistent `claude -p --input-format stream-json` process; hooks fire every turn and cache is reused.
- ~~What hook payload fields are stable enough for session routing?~~ → `session_id`, `cwd`, `tool_name`, `tool_input` are present and used; `cwd` resolves absolute paths back to relative.

Still open:

- Can `PostToolUse` reliably replace tool output for built-in tools? (PostToolUse endpoint exists but only logs; not yet used to replace output.)
- Can built-in `Edit`, `Write`, and `Bash` all be safely intercepted/rewritten? (Only `Read` is wired up.)

## Decision Gate

Continue with this architecture only if `Read` can pass the validation target.

If `Read` cannot be intercepted and returned cleanly, stop and reassess. The fallback options are:

- Accept server-side tool execution with mounted workspaces.
- Use custom MCP tools instead of built-in tools.
- Return to an API-level compatibility proxy and accept fingerprint mismatch.

## First Implementation Checklist

- [ ] Create a minimal API server with fixed API key auth. *(server exists; API key auth not yet added)*
- [x] Add session creation and process tracking. *(`SessionManager` in `src/session-manager.ts`)*
- [x] Start real Claude CLI in a controlled workspace. *(`ClaudeRunner` in `src/runner.ts`, persistent stream-json process)*
- [x] Add hook configuration for the session. *(`test-workspace/.claude/settings.local.json`)*
- [x] Log raw hook payloads.
- [x] Implement normalized `Read` request shape.
- [x] Implement tiny downstream `Read` agent. *(in-process `readFromDownstream` in `src/server.ts`)*
- [x] Route `Read` from hook to downstream.
- [x] Return downstream content to Claude.
- [x] Verify Claude uses downstream content, not server content. *(integration test, 23/23 pass)*

## Implemented Components (as of 2026-06-11)

- `src/runner.ts` — `ClaudeRunner`: one persistent `claude` stream-json process, NDJSON line parsing, per-turn promise with timeout, exit/crash handling.
- `src/session-manager.ts` — `SessionManager`: `session_id` → runner map, `MAX_SESSIONS` cap (default 10) with 503 on overflow, idle reaper (default 10 min), graceful `shutdown()` that kills all runners.
- `src/server.ts` — HTTP API: `POST/GET /sessions`, `POST /sessions/:id/turn`, `GET/DELETE /sessions/:id`, `GET /health` (reports `sessions`/`max_sessions`), plus the existing `/hooks/*` endpoints. SIGINT/SIGTERM trigger graceful shutdown.

Config via env: `CC_PROXY_PORT`, `CC_MAX_SESSIONS`, `CC_IDLE_TIMEOUT_MS`, `CC_REAP_INTERVAL_MS`, `CC_TURN_TIMEOUT_MS`, `CC_SESSION_CWD`, `DOWNSTREAM_ROOT`.

### Test coverage

- `src/test.ts` (`npm test`) — 53 unit tests for the hook bridge (mocked payloads, real server + files).
- `src/integration-test.ts` (`npm run test:integration`) — 23 checks against a live server with real `claude` processes: cache reuse across turns, capacity 503, idle reaping, graceful shutdown with no leaked processes. Only the cache test runs paid turns.

### Not yet built

- Fixed API-key auth on the API server.
- `session_id` → downstream-agent binding (downstream read is currently in-process, not a remote agent).
- Tools beyond `Read` (`LS`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`).
- `PostToolUse` output replacement (endpoint logs only).

## Summary

The best path is not full spoofing and not normal proxying. The best path is real Claude CLI on the server plus remote tool execution through hooks.

This keeps the parts that are hard to spoof inside real Claude CLI and moves the controllable part, tool execution, into our own downstream API layer.
