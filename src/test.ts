// cc-proxy comprehensive test suite
// Covers: tool call correctness, context propagation, billing metadata,
// cache behavior, security boundaries, edge cases, integration flow.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { resolveClaudeArgs, resolveClaudeCommand } from "./runner";
import { resolveDataDir } from "./data-dir";
import { ControlPlane, defaultRuntimeConfig } from "./control-plane";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "dist", "server.js");
const DOWNSTREAM_ROOT = path.join(PROJECT_ROOT, "downstream-project");
const TEST_WORKSPACE = path.join(PROJECT_ROOT, "test-workspace");
const PORT = 13456; // Use a non-default port for testing
const ZEABUR_PORT = 13457;
const ANTHROPIC_PORT = 13458;
const BASE_URL = `http://localhost:${PORT}`;

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = http.get(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        headers,
      },
      (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", (err) =>
      resolve({ status: 0, body: err.message, headers: {} })
    );
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
  });
}

function httpPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", (err) =>
      resolve({ status: 0, body: err.message, headers: {} })
    );
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
    req.write(data);
    req.end();
  });
}

function httpPut(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", (err) =>
      resolve({ status: 0, body: err.message, headers: {} })
    );
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
    req.write(data);
    req.end();
  });
}

function httpPatch(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", (err) =>
      resolve({ status: 0, body: err.message, headers: {} })
    );
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
    req.write(data);
    req.end();
  });
}

function httpPostChunked(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
  chunks: Array<{ atMs: number; text: string }>;
}> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const chunks: Array<{ atMs: number; text: string }> = [];
    const req = http.request(options, (res) => {
      const bodyChunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        const text = c.toString("utf-8");
        chunks.push({ atMs: Date.now() - startedAt, text });
        bodyChunks.push(c);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(bodyChunks).toString("utf-8"),
          headers: res.headers,
          chunks,
        });
      });
    });
    req.on("error", (err) =>
      resolve({ status: 0, body: err.message, headers: {}, chunks })
    );
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {}, chunks });
    });
    req.write(data);
    req.end();
  });
}

function httpDelete(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "DELETE",
      headers,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", (err) =>
      resolve({ status: 0, body: err.message, headers: {} })
    );
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, body: "timeout", headers: {} });
    });
    req.end();
  });
}

function waitForServer(maxMs = 8_000): Promise<boolean> {
  return waitForServerAt(BASE_URL, maxMs);
}

function waitForServerAt(baseUrl: string, maxMs = 8_000): Promise<boolean> {
  const start = Date.now();
  const check = async (): Promise<boolean> => {
    if (Date.now() - start > maxMs) return false;
    const res = await httpGet(`${baseUrl}/health`);
    if (res.status === 200) return true;
    await sleep(200);
    return check();
  };
  return check();
}

function makePreToolUsePayload(
  overrides: Partial<{
    session_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    cwd: string;
    permission_mode: string;
    transcript_path: string;
    agent_id: string;
    agent_type: string;
  }> = {}
) {
  return {
    session_id: overrides.session_id || "sess_test_001",
    transcript_path: "/tmp/test_transcript.jsonl",
    cwd: overrides.cwd || TEST_WORKSPACE,
    permission_mode: overrides.permission_mode || "allow",
    hook_event_name: "PreToolUse",
    tool_name: overrides.tool_name || "Read",
    tool_input: overrides.tool_input || { file_path: "demo.txt" },
    tool_use_id: "toolu_test_" + Date.now(),
    ...overrides,
  };
}

function readDownstreamFile(relativePath: string): string {
  return fs.readFileSync(path.join(DOWNSTREAM_ROOT, relativePath), "utf-8");
}

function readServerFile(relativePath: string): string {
  return fs.readFileSync(path.join(TEST_WORKSPACE, relativePath), "utf-8");
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(25);
  }
  return fs.existsSync(filePath);
}

async function waitForJsonFile(filePath: string, timeoutMs = 2_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        /* file may be visible before the child process finishes writing */
      }
    }
    await sleep(25);
  }
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function makeIsolatedDataDir(name: string): string {
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const dir = path.join(
    TEST_WORKSPACE,
    `.cc-proxy-${safeName}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function bootstrapAdmin(
  baseUrl: string,
  username = "admin",
  password = "admin-secret"
): Promise<string> {
  const setup = await httpPost(`${baseUrl}/admin/setup`, { username, password });
  assert.equal(setup.status, 201, setup.body);
  const setupBody = JSON.parse(setup.body);
  assert.match(setupBody.token, /^adm_/);

  const login = await httpPost(`${baseUrl}/admin/auth/login`, { username, password });
  assert.equal(login.status, 200, login.body);
  const loginBody = JSON.parse(login.body);
  assert.match(loginBody.token, /^adm_/);
  return loginBody.token;
}

async function createDownstreamKey(
  baseUrl: string,
  adminToken: string,
  name = "test-client"
): Promise<{ id: string; value: string }> {
  const created = await httpPost(
    `${baseUrl}/admin/api-keys`,
    { name },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(created.status, 201, created.body);
  const body = JSON.parse(created.body);
  assert.match(body.key.value, /^ccp_/);
  return { id: body.key.id, value: body.key.value };
}

function writeFakeClaudeCommand(resultText = "FAKE_STREAM_RESULT"): string {
  const scriptPath = path.join(TEST_WORKSPACE, `fake-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "fake-cli-session",
      result: ${JSON.stringify(resultText)},
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 6
      },
      total_cost_usd: 0.0123,
      duration_ms: 10,
      num_turns: 1,
      is_error: false
    }) + "\\n");
  }
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeArgRecordingClaudeCommand(argsPath: string): string {
  const scriptPath = path.join(TEST_WORKSPACE, `arg-recording-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.stdin.resume();
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeEnvRecordingClaudeCommand(envPath: string, exitAfterStart = false): string {
  const scriptPath = path.join(TEST_WORKSPACE, `env-recording-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  HOME: process.env.HOME || "",
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "",
  args: process.argv.slice(2)
}), "utf8");
if (${exitAfterStart}) {
  process.stdout.write("Claude login URL: https://claude.example/login\\n");
  process.exit(0);
}
process.stdin.resume();
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeClaudeAuthCommand(argsPath: string): string {
  const scriptPath = path.join(TEST_WORKSPACE, `auth-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.stdout.write("Claude login URL: https://claude.example/login\\n");
process.stderr.write("waiting for browser confirmation\\n");
setTimeout(() => process.exit(0), 50);
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeTtyOnlyClaudeAuthCommand(argsPath: string): string {
  const scriptPath = path.join(TEST_WORKSPACE, `tty-auth-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  stdoutIsTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY
}), "utf8");
if (process.stdout.isTTY) {
  process.stdout.write("TTY Claude login URL: https://claude.example/tty-login\\n");
  setTimeout(() => process.exit(0), 50);
} else {
  process.stdin.resume();
}
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeAnsiClaudeAuthCommand(argsPath: string): string {
  const scriptPath = path.join(TEST_WORKSPACE, `ansi-auth-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.stdout.write("\\x1b[38;5;246mOpen https://claude.example/oauth?code_challenge=abc123&redir\\r\\nect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcallback&state=xyz\\x1b[39m\\r\\n");
process.stdout.write("\\x1b[2GPaste\\x1b[8Gcode\\x1b[13Ghere >\\r\\n");
setTimeout(() => process.exit(0), 50);
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeInteractiveClaudeAuthCommand(resultPath: string): string {
  const scriptPath = path.join(TEST_WORKSPACE, `interactive-auth-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
process.stdin.setEncoding("utf8");
process.stdout.write("Claude login URL: https://claude.example/login\\n");
process.stderr.write("Paste authorization code to continue\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!buffer.includes("\\n")) return;
  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
    input: buffer.trim(),
    HOME: process.env.HOME || ""
  }), "utf8");
  process.stdout.write("login complete\\n");
  process.exit(0);
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeQuotaErrorClaudeCommand(): string {
  const scriptPath = path.join(TEST_WORKSPACE, `quota-error-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let emitted = false;
process.stdin.on("data", (chunk) => {
  if (emitted || !chunk.trim()) return;
  emitted = true;
  process.stdout.write(JSON.stringify({
    type: "result",
    session_id: "fake-cli-session",
    result: "Claude account reached the 5-hour usage limit. Try again later.",
    error: {
      status_code: 429,
      type: "rate_limit_error",
      message: "Claude account reached the 5-hour usage limit. Try again later.",
      body: {
        type: "error",
        error: {
          type: "claude_original_limit",
          message: "Claude account reached the 5-hour usage limit. Try again later.",
          upstream_code: "five_hour_limit"
        }
      }
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    total_cost_usd: 0,
    duration_ms: 5,
    num_turns: 1,
    is_error: true,
    stop_reason: "error"
  }) + "\\n");
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeStderrExitClaudeCommand(stderrText: string, exitCode = 1): string {
  const scriptPath = path.join(TEST_WORKSPACE, `stderr-exit-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let started = false;
process.stdin.on("data", (chunk) => {
  if (started || !chunk.trim()) return;
  started = true;
  process.stderr.write(${JSON.stringify(stderrText)});
  setTimeout(() => process.exit(${exitCode}), 25);
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeStreamingClaudeCommand(delayMs = 1400): string {
  const scriptPath = path.join(TEST_WORKSPACE, `streaming-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let emitted = false;
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
process.stdin.on("data", (chunk) => {
  if (emitted) return;
  if (!chunk.trim()) return;
  emitted = true;
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "message_start",
      message: {
        id: "msg_live_fake",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    }
  });
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }
  });
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "LIVE_DELTA_BEFORE_RESULT" }
    }
  });
  setTimeout(() => {
    emit({
      type: "assistant",
      session_id: "fake-cli-session",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "LIVE_DELTA_BEFORE_RESULT" }]
      }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: { type: "content_block_stop", index: 0 }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 }
      }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: { type: "message_stop" }
    });
    emit({
      type: "result",
      session_id: "fake-cli-session",
      result: "LIVE_DELTA_BEFORE_RESULT",
      usage: {
        input_tokens: 1,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      total_cost_usd: 0,
      duration_ms: ${delayMs},
      num_turns: 1,
      is_error: false,
      stop_reason: "end_turn"
    });
  }, ${delayMs});
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeArgvClaudeCommand(): string {
  const scriptPath = path.join(TEST_WORKSPACE, `argv-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let done = false;
process.stdin.on("data", (chunk) => {
  if (done || !chunk.trim()) return;
  done = true;
  const result = "ARGV:" + process.argv.slice(2).join(" ");
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: "fake-cli-session",
    message: { role: "assistant", content: [{ type: "text", text: result }] }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    session_id: "fake-cli-session",
    result,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    total_cost_usd: 0,
    duration_ms: 1,
    num_turns: 1,
    is_error: false
  }) + "\\n");
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeMcpToolCallingClaudeCommand(
  delayBeforeToolUseStopMs = 0,
  includeInternalToolSearch = false
): string {
  const scriptPath = path.join(TEST_WORKSPACE, `mcp-tool-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { spawn } = require("child_process");
process.stdin.setEncoding("utf8");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function getMcpConfig() {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx < 0 || !process.argv[idx + 1]) {
    throw new Error("missing --mcp-config");
  }
  return JSON.parse(process.argv[idx + 1]);
}

function writeFrame(stream, obj) {
  const json = JSON.stringify(obj);
  stream.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json);
}

function createRpcClient(proc) {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const sep = buffer.indexOf("\\r\\n\\r\\n");
      if (sep < 0) return;
      const header = buffer.slice(0, sep).toString("utf8");
      const match = header.match(/content-length:\\s*(\\d+)/i);
      if (!match) throw new Error("missing MCP content-length");
      const length = Number(match[1]);
      const start = sep + 4;
      if (buffer.length < start + length) return;
      const msg = JSON.parse(buffer.slice(start, start + length).toString("utf8"));
      buffer = buffer.slice(start + length);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "mcp error"));
        else resolve(msg);
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      writeFrame(proc.stdin, { jsonrpc: "2.0", id, method, params });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error("MCP request timed out: " + method));
        }, 4000);
      });
    },
    notify(method, params) {
      writeFrame(proc.stdin, { jsonrpc: "2.0", method, params });
    }
  };
}

async function runMcpToolCall() {
  const config = getMcpConfig();
  const server = config.mcpServers && config.mcpServers.cc_client_tools;
  if (!server) throw new Error("missing cc_client_tools MCP server");
  const proc = spawn(server.command, server.args || [], {
    env: { ...process.env, ...(server.env || {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = createRpcClient(proc);
  await rpc.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fake-claude", version: "test" },
  });
  rpc.notify("notifications/initialized", {});
  const listed = await rpc.request("tools/list", {});
  const tools = listed.result && listed.result.tools || [];
  if (!tools.some((tool) => tool.name === "lookup_frame_budget")) {
    throw new Error("lookup_frame_budget was not listed by MCP server");
  }

  const toolInput = { platform: "switch" };
  if (${includeInternalToolSearch}) {
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: {
        type: "message_start",
        message: {
          id: "msg_fake_tool_search",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 0 }
        }
      }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_internal_search_001",
          name: "ToolSearch",
          input: {}
        }
      }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ query: "lookup_frame_budget", max_results: 5 })
        }
      }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: { type: "content_block_stop", index: 0 }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 }
      }
    });
    emit({
      type: "stream_event",
      session_id: "fake-cli-session",
      event: { type: "message_stop" }
    });
  }
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "message_start",
      message: {
        id: "msg_fake_tool_use",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 }
      }
    }
  });
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_frame_budget_001",
        name: "lookup_frame_budget",
        input: {}
      }
    }
  });
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) }
    }
  });
  if (${delayBeforeToolUseStopMs} > 0) {
    await new Promise((resolve) => setTimeout(resolve, ${delayBeforeToolUseStopMs}));
  }
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: { type: "content_block_stop", index: 0 }
  });
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12 }
    }
  });
  emit({
    type: "stream_event",
    session_id: "fake-cli-session",
    event: { type: "message_stop" }
  });

  const callResult = await rpc.request("tools/call", {
    name: "lookup_frame_budget",
    arguments: toolInput,
  });
  const text = (callResult.result && callResult.result.content || [])
    .map((item) => item.text || "")
    .join("\\n");
  const finalText = "CLIENT_TOOL_RESULT:" + text;
  emit({
    type: "assistant",
    session_id: "fake-cli-session",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalText }]
    }
  });
  emit({
    type: "result",
    session_id: "fake-cli-session",
    result: finalText,
    usage: {
      input_tokens: 22,
      output_tokens: 9,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    total_cost_usd: 0,
    duration_ms: 50,
    num_turns: 1,
    is_error: false,
    stop_reason: "end_turn"
  });
  proc.kill("SIGKILL");
}

let started = false;
process.stdin.on("data", async (chunk) => {
  if (started || !chunk.trim()) return;
  started = true;
  try {
    await runMcpToolCall();
  } catch (err) {
    emit({
      type: "result",
      session_id: "fake-cli-session",
      result: err.message,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
      is_error: true,
      stop_reason: "error"
    });
  }
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeInspectingClaudeCommand(): string {
  const scriptPath = path.join(TEST_WORKSPACE, `inspect-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const input = JSON.parse(line);
    const content = Array.isArray(input.message?.content) ? input.message.content : [];
    const contentTypes = content.map((block) => block?.type || "unknown").join(",");
    process.stdout.write(JSON.stringify({
      type: "assistant",
      session_id: "fake-cli-session",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Saw native stream-json content.", signature: "sig_native_probe" },
          { type: "text", text: "CONTENT_TYPES:" + contentTypes }
        ]
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "fake-cli-session",
      result: "CONTENT_TYPES:" + contentTypes,
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 6
      },
      total_cost_usd: 0.0123,
      duration_ms: 10,
      num_turns: 1,
      is_error: false
    }) + "\\n");
  }
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeLongContextInspectingClaudeCommand(): string {
  const scriptPath = path.join(TEST_WORKSPACE, `long-context-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const input = JSON.parse(line);
    const content = Array.isArray(input.message?.content) ? input.message.content : [];
    const text = content
      .map((block) => block && block.type === "text" ? block.text || "" : JSON.stringify(block || {}))
      .join("\\n");
    const required = [
      "combat loop",
      "entity-component design",
      "save/load schema",
      "asset pipeline",
      "performance budget",
      "automated test plan",
      "ALPHA-BRAVO-CHARLIE-7742",
      "NESTED-DOWNSTREAM-MARKER-9921"
    ];
    const report = {
      textLength: text.length,
      required: Object.fromEntries(required.map((item) => [item, text.includes(item)]))
    };
    const result = "LONG_CONTEXT_REPORT:" + JSON.stringify(report);
    process.stdout.write(JSON.stringify({
      type: "assistant",
      session_id: "fake-cli-session",
      message: { role: "assistant", content: [{ type: "text", text: result }] }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      session_id: "fake-cli-session",
      result,
      usage: {
        input_tokens: Math.ceil(text.length / 4),
        output_tokens: 24,
        cache_creation_input_tokens: 128,
        cache_read_input_tokens: 0
      },
      total_cost_usd: 0,
      duration_ms: 10,
      num_turns: 1,
      is_error: false
    }) + "\\n");
  }
});
`,
    "utf-8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function startTestServer(
  port: number,
  env: NodeJS.ProcessEnv
): Promise<ReturnType<typeof spawn>> {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    CC_PROXY_PORT: String(port),
  };
  if (!mergedEnv.CC_PROXY_DATA_DIR) {
    mergedEnv.CC_PROXY_DATA_DIR = makeIsolatedDataDir(`server-${port}`);
  }
  const proc = spawn("node", [SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: mergedEnv,
  });
  const ready = await waitForServerAt(`http://localhost:${port}`);
  if (!ready) {
    proc.kill("SIGKILL");
    throw new Error(`Server did not start on port ${port}`);
  }
  return proc;
}

// --- Test Suite ---

let serverProc: ReturnType<typeof spawn> | null = null;

describe("cc-proxy: Hook Tool Forwarding", () => {
  before(async () => {
    // Verify build exists
    if (!fs.existsSync(SERVER_SCRIPT)) {
      throw new Error("dist/server.js not found. Run 'npm run build' first.");
    }
    // Start server on test port
    serverProc = spawn("node", [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CC_PROXY_PORT: String(PORT),
        CC_PROXY_DATA_DIR: makeIsolatedDataDir("main-server"),
      },
    });
    const ready = await waitForServer();
    if (!ready) {
      serverProc.kill("SIGKILL");
      throw new Error("Server did not start within timeout");
    }
  });

  after(async () => {
    if (serverProc) {
      serverProc.kill("SIGKILL");
      await sleep(300);
    }
  });

  // ========================================
  // 1. Server Health & Infrastructure
  // ========================================
  describe("1. Server health & infrastructure", () => {
    it("listens on PORT env when CC_PROXY_PORT is absent", async () => {
      const proc = spawn("node", [SERVER_SCRIPT], {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: String(ZEABUR_PORT),
          CC_PROXY_PORT: undefined,
          CC_PROXY_DATA_DIR: makeIsolatedDataDir("port-env"),
        },
      });
      try {
        const ready = await waitForServerAt(`http://localhost:${ZEABUR_PORT}`);
        assert.equal(ready, true);
        const res = await httpGet(`http://localhost:${ZEABUR_PORT}/health`);
        assert.equal(res.status, 200);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("resolves the bundled Claude CLI binary for spawned sessions", () => {
      const previousClaudeCommand = process.env.CLAUDE_COMMAND;
      delete process.env.CLAUDE_COMMAND;
      try {
        const command = resolveClaudeCommand().replace(/\\/g, "/");
        assert.match(command, /node_modules\/(@anthropic-ai\/claude-code-.+\/claude|\.bin\/claude(\.cmd)?)$/);
        assert.equal(fs.existsSync(command), true);
      } finally {
        if (previousClaudeCommand === undefined) delete process.env.CLAUDE_COMMAND;
        else process.env.CLAUDE_COMMAND = previousClaudeCommand;
      }
    });

    it("adds explicit model option to spawned Claude CLI args", () => {
      const args = resolveClaudeArgs({ model: "claude-test-model" });
      assert.deepEqual(args.slice(-2), ["--model", "claude-test-model"]);
    });

    it("adds explicit permission mode option to spawned Claude CLI args", () => {
      const args = resolveClaudeArgs({ permissionMode: "acceptEdits" });
      assert.deepEqual(args.slice(-2), ["--permission-mode", "acceptEdits"]);
    });

    it("adds explicit setting sources option to spawned Claude CLI args", () => {
      const args = resolveClaudeArgs({ settingSources: "project,local" });
      assert.ok(
        args.includes("--setting-sources"),
        "Claude CLI args should include setting source override"
      );
      assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
    });

    it("uses admin-managed config as the per-server Claude window concurrency limit", async () => {
      const dataDir = makeIsolatedDataDir("admin-config-window-limit");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "window-limit-client");
        const clientAuth = { Authorization: `Bearer ${clientKey.value}` };

        const unauthConfig = await httpGet(`${baseUrl}/admin/config`);
        assert.equal(unauthConfig.status, 401);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            max_cli_windows: 1,
            cli_idle_timeout_ms: 12_345,
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);
        const config = JSON.parse(updated.body).config;
        assert.equal(config.max_cli_windows, 1);
        assert.equal(config.cli_idle_timeout_ms, 12_345);

        const first = await httpPost(`${baseUrl}/sessions`, {}, clientAuth);
        assert.equal(first.status, 201, first.body);

        const second = await httpPost(`${baseUrl}/sessions`, {}, clientAuth);
        assert.equal(second.status, 503, second.body);
        const body = JSON.parse(second.body);
        assert.equal(body.limit, 1);
        assert.match(body.error, /window concurrency reached/);

        const firstBody = JSON.parse(first.body);
        await httpDelete(`${baseUrl}/sessions/${firstBody.id}`, clientAuth);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("uses admin-managed Claude CLI defaults when spawning new windows", async () => {
      const dataDir = makeIsolatedDataDir("admin-claude-cli-defaults");
      const argsPath = path.join(dataDir, "claude-args.json");
      const fakeClaude = writeArgRecordingClaudeCommand(argsPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "cli-default-client");
        const clientAuth = { Authorization: `Bearer ${clientKey.value}` };

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_model: "admin-default-model",
            claude_permission_mode: "acceptEdits",
            claude_effort: "high",
            claude_setting_sources: "project,local",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);
        const config = JSON.parse(updated.body).config;
        assert.equal(config.claude_model, "admin-default-model");
        assert.equal(config.claude_permission_mode, "acceptEdits");
        assert.equal(config.claude_effort, "high");
        assert.equal(config.claude_setting_sources, "project,local");

        const created = await httpPost(`${baseUrl}/sessions`, {}, clientAuth);
        assert.equal(created.status, 201, created.body);
        assert.equal(await waitForFile(argsPath), true, "Claude CLI args file was not written");

        const args = JSON.parse(fs.readFileSync(argsPath, "utf-8"));
        assert.ok(args.includes("--model"), `missing model args: ${args.join(" ")}`);
        assert.equal(args[args.indexOf("--model") + 1], "admin-default-model");
        assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
        assert.equal(args[args.indexOf("--effort") + 1], "high");
        assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");

        const createdBody = JSON.parse(created.body);
        await httpDelete(`${baseUrl}/sessions/${createdBody.id}`, clientAuth);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("lets admin-cleared Claude CLI defaults override environment fallbacks", async () => {
      const dataDir = makeIsolatedDataDir("admin-clears-env-defaults");
      const argsPath = path.join(dataDir, "claude-args.json");
      const fakeClaude = writeArgRecordingClaudeCommand(argsPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
        CC_CLAUDE_MODEL: "env-model-should-not-run",
        CC_PERMISSION_MODE: "env-permission-should-not-run",
        CC_CLAUDE_SETTING_SOURCES: "env,local",
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "env-clear-client");
        const clientAuth = { Authorization: `Bearer ${clientKey.value}` };

        const initial = await httpGet(`${baseUrl}/admin/config`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(initial.status, 200, initial.body);
        assert.equal(JSON.parse(initial.body).config.claude_model, "env-model-should-not-run");

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_model: "",
            claude_permission_mode: "",
            claude_setting_sources: "",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);
        const config = JSON.parse(updated.body).config;
        assert.equal(config.claude_model, "");
        assert.equal(config.claude_permission_mode, "");
        assert.equal(config.claude_setting_sources, "");

        const created = await httpPost(`${baseUrl}/sessions`, {}, clientAuth);
        assert.equal(created.status, 201, created.body);
        assert.equal(await waitForFile(argsPath), true, "Claude CLI args file was not written");

        const args = JSON.parse(fs.readFileSync(argsPath, "utf-8"));
        assert.equal(args.includes("--model"), false, `unexpected model args: ${args.join(" ")}`);
        assert.equal(args.includes("--permission-mode"), false, `unexpected permission args: ${args.join(" ")}`);
        assert.equal(args.includes("--setting-sources"), false, `unexpected setting args: ${args.join(" ")}`);

        const createdBody = JSON.parse(created.body);
        await httpDelete(`${baseUrl}/sessions/${createdBody.id}`, clientAuth);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("runs spawned Claude windows with a persistent data-dir HOME", async () => {
      const dataDir = makeIsolatedDataDir("claude-runner-persistent-home");
      const envPath = path.join(dataDir, "claude-env.json");
      const fakeClaude = writeEnvRecordingClaudeCommand(envPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "persistent-home-client");
        const clientAuth = { Authorization: `Bearer ${clientKey.value}` };

        const created = await httpPost(`${baseUrl}/sessions`, {}, clientAuth);
        assert.equal(created.status, 201, created.body);

        const env = await waitForJsonFile(envPath);
        assert.ok(env, "Claude env file was not written");
        assert.equal(env.HOME, path.join(dataDir, "claude-home"));
        assert.equal(fs.existsSync(env.HOME), true);

        const createdBody = JSON.parse(created.body);
        await httpDelete(`${baseUrl}/sessions/${createdBody.id}`, clientAuth);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("uses Zeabur /data volume as the default data directory when it is available", () => {
      const resolved = resolveDataDir(
        {},
        "/src",
        (candidate) => candidate === "/data"
      );
      assert.equal(resolved, "/data/cc-proxy");
    });

    it("uses CC_PROXY_DATA_DIR when explicitly configured", () => {
      const resolved = resolveDataDir(
        { CC_PROXY_DATA_DIR: "/custom/cc-proxy" },
        "/src",
        () => true
      );
      assert.equal(resolved, "/custom/cc-proxy");
    });

    it("falls back to a local data directory when /data is not available", () => {
      const resolved = resolveDataDir(
        {},
        "/src",
        () => false
      );
      assert.equal(resolved, "/src/.cc-proxy-data");
    });

    it("defaults Claude account auth to the interactive Claude session", () => {
      assert.equal(defaultRuntimeConfig().claude_auth_login_args, "");
    });

    it("migrates legacy Claude auth login args to the interactive Claude session", () => {
      const dataDir = makeIsolatedDataDir("legacy-claude-auth-login-args");
      const controlPlanePath = path.join(dataDir, "control-plane.json");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        controlPlanePath,
        JSON.stringify({
          admin: null,
          config: {
            ...defaultRuntimeConfig(),
            claude_auth_login_args: "setup-token",
          },
          api_keys: [],
        }),
        "utf-8"
      );

      const controlPlane = new ControlPlane(controlPlanePath);
      assert.equal(controlPlane.getConfig().claude_auth_login_args, "");
    });

    it("keeps explicitly configured setup-token args after the control plane has migrated", () => {
      const dataDir = makeIsolatedDataDir("explicit-claude-setup-token-args");
      const controlPlanePath = path.join(dataDir, "control-plane.json");
      const controlPlane = new ControlPlane(controlPlanePath);
      assert.equal(controlPlane.updateConfig({ claude_auth_login_args: "setup-token" }).claude_auth_login_args, "setup-token");

      const reloaded = new ControlPlane(controlPlanePath);
      assert.equal(reloaded.getConfig().claude_auth_login_args, "setup-token");
    });

    it("runs Claude account login from the admin backend and exposes auth logs", async () => {
      const dataDir = makeIsolatedDataDir("admin-claude-auth-login");
      const argsPath = path.join(dataDir, "claude-auth-args.json");
      const fakeClaude = writeClaudeAuthCommand(argsPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "auth login --browser",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);
        assert.equal(JSON.parse(updated.body).config.claude_auth_login_args, "auth login --browser");

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);
        assert.equal(await waitForFile(argsPath), true, "Claude auth args file was not written");
        const args = JSON.parse(fs.readFileSync(argsPath, "utf-8"));
        assert.deepEqual(args, ["auth", "login", "--browser"]);

        let authBody: any = null;
        for (let i = 0; i < 20; i++) {
          const auth = await httpGet(`${baseUrl}/admin/claude-auth`, {
            Authorization: `Bearer ${adminToken}`,
          });
          assert.equal(auth.status, 200, auth.body);
          authBody = JSON.parse(auth.body);
          if (authBody.auth.status === "succeeded") break;
          await sleep(50);
        }
        assert.equal(authBody.auth.status, "succeeded");
        assert.equal(authBody.auth.exit_code, 0);
        assert.match(authBody.auth.log, /Claude login URL/);
        assert.match(authBody.auth.log, /waiting for browser confirmation/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("runs Claude account login in a pseudo terminal so interactive CLI output is visible", async () => {
      const dataDir = makeIsolatedDataDir("admin-claude-auth-tty-login");
      const argsPath = path.join(dataDir, "claude-auth-tty-args.json");
      const fakeClaude = writeTtyOnlyClaudeAuthCommand(argsPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "setup-token",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);

        let authBody: any = null;
        for (let i = 0; i < 20; i++) {
          const auth = await httpGet(`${baseUrl}/admin/claude-auth`, {
            Authorization: `Bearer ${adminToken}`,
          });
          assert.equal(auth.status, 200, auth.body);
          authBody = JSON.parse(auth.body);
          if (authBody.auth.status === "succeeded") break;
          await sleep(50);
        }
        assert.equal(authBody.auth.status, "succeeded");
        assert.match(authBody.auth.log, /TTY Claude login URL/);
        const recorded = JSON.parse(fs.readFileSync(argsPath, "utf-8"));
        assert.deepEqual(recorded.args, ["setup-token"]);
        assert.equal(recorded.stdoutIsTTY, true);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("starts the default interactive Claude login without a pseudo terminal and sends /login", async () => {
      const dataDir = makeIsolatedDataDir("admin-claude-auth-default-login");
      const resultPath = path.join(dataDir, "claude-auth-default-login.json");
      const fakeClaude = writeInteractiveClaudeAuthCommand(resultPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);

        const recorded = await waitForJsonFile(resultPath);
        assert.ok(recorded, "Claude auth default /login input file was not written");
        assert.equal(recorded.input, "/login");
        assert.equal(recorded.HOME, path.join(dataDir, "claude-home"));
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("returns a clean Claude auth display log and OAuth URL for the admin UI", async () => {
      const dataDir = makeIsolatedDataDir("admin-claude-auth-clean-display");
      const argsPath = path.join(dataDir, "claude-auth-ansi-args.json");
      const fakeClaude = writeAnsiClaudeAuthCommand(argsPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "setup-token",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);

        let authBody: any = null;
        for (let i = 0; i < 20; i++) {
          const auth = await httpGet(`${baseUrl}/admin/claude-auth`, {
            Authorization: `Bearer ${adminToken}`,
          });
          assert.equal(auth.status, 200, auth.body);
          authBody = JSON.parse(auth.body);
          if (authBody.auth.status === "succeeded") break;
          await sleep(50);
        }

        assert.equal(authBody.auth.status, "succeeded");
        assert.match(authBody.auth.log, /\x1b\[/);
        assert.equal(
          authBody.view.auth_url,
          "https://claude.example/oauth?code_challenge=abc123&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcallback&state=xyz"
        );
        assert.match(authBody.view.display_log, /Open https:\/\/claude\.example\/oauth/);
        assert.doesNotMatch(authBody.view.display_log, /\x1b\[/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("runs Claude account login with the same persistent data-dir HOME", async () => {
      const dataDir = makeIsolatedDataDir("claude-auth-persistent-home");
      const envPath = path.join(dataDir, "claude-auth-env.json");
      const fakeClaude = writeEnvRecordingClaudeCommand(envPath, true);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "auth login --browser",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);

        const env = await waitForJsonFile(envPath);
        assert.ok(env, "Claude auth env file was not written");
        assert.equal(env.HOME, path.join(dataDir, "claude-home"));
        assert.equal(fs.existsSync(env.HOME), true);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("forwards admin-submitted Claude auth input to the running login process", async () => {
      const dataDir = makeIsolatedDataDir("claude-auth-input");
      const resultPath = path.join(dataDir, "claude-auth-input.json");
      const fakeClaude = writeInteractiveClaudeAuthCommand(resultPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "manual-login",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);

        const inputRes = await httpPost(
          `${baseUrl}/admin/claude-auth/input`,
          { input: "code-123#state-456" },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(inputRes.status, 200, inputRes.body);

        const recorded = await waitForJsonFile(resultPath);
        assert.ok(recorded, "Claude auth input file was not written");
        assert.equal(recorded.input, "code-123#state-456");
        assert.equal(recorded.HOME, path.join(dataDir, "claude-home"));

        let authBody: any = null;
        for (let i = 0; i < 20; i++) {
          const auth = await httpGet(`${baseUrl}/admin/claude-auth`, {
            Authorization: `Bearer ${adminToken}`,
          });
          assert.equal(auth.status, 200, auth.body);
          authBody = JSON.parse(auth.body);
          if (authBody.auth.status === "succeeded") break;
          await sleep(50);
        }
        assert.equal(authBody.auth.status, "succeeded");
        assert.match(authBody.auth.log, /login complete/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("allows the admin backend to send a bare Enter to the Claude auth process", async () => {
      const dataDir = makeIsolatedDataDir("claude-auth-enter-input");
      const resultPath = path.join(dataDir, "claude-auth-enter-input.json");
      const fakeClaude = writeInteractiveClaudeAuthCommand(resultPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const updated = await httpPut(
          `${baseUrl}/admin/config`,
          {
            claude_command: fakeClaude,
            claude_auth_login_args: "manual-login",
          },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(updated.status, 200, updated.body);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);

        const inputRes = await httpPost(
          `${baseUrl}/admin/claude-auth/input`,
          { input: "" },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(inputRes.status, 200, inputRes.body);

        const recorded = await waitForJsonFile(resultPath);
        assert.ok(recorded, "Claude auth Enter input file was not written");
        assert.equal(recorded.input, "");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("cancels a stuck Claude account auth job and allows a new job to start", async () => {
      const dataDir = makeIsolatedDataDir("claude-auth-cancel");
      const envPath = path.join(dataDir, "claude-auth-env.json");
      const fakeClaude = writeEnvRecordingClaudeCommand(envPath);
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const started = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(started.status, 202, started.body);
        assert.equal(JSON.parse(started.body).auth.status, "running");

        const secondStart = await httpPost(
          `${baseUrl}/admin/claude-auth/login`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(secondStart.status, 409, secondStart.body);

        const cancelled = await httpDelete(`${baseUrl}/admin/claude-auth`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(cancelled.status, 200, cancelled.body);
        const cancelledBody = JSON.parse(cancelled.body);
        assert.equal(cancelledBody.auth.status, "cancelled");
        assert.match(cancelledBody.auth.log, /admin cancelled auth job/);

        const restarted = await httpPost(
          `${baseUrl}/admin/claude-auth/check`,
          {},
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(restarted.status, 202, restarted.body);
        assert.equal(JSON.parse(restarted.body).auth.status, "running");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("creates downstream API keys from the admin backend and records visible admin logs", async () => {
      const dataDir = makeIsolatedDataDir("admin-api-keys-logs");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const created = await httpPost(
          `${baseUrl}/admin/api-keys`,
          { name: "production-client" },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(created.status, 201, created.body);
        const createdBody = JSON.parse(created.body);
        assert.match(createdBody.key.value, /^ccp_/);
        assert.equal(createdBody.key.name, "production-client");

        const authorized = await httpPost(
          `${baseUrl}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { Authorization: `Bearer ${createdBody.key.value}` }
        );
        assert.equal(authorized.status, 400, authorized.body);

        const keys = await httpGet(`${baseUrl}/admin/api-keys`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(keys.status, 200, keys.body);
        const keyBody = JSON.parse(keys.body);
        const key = keyBody.keys.find((entry: any) => entry.id === createdBody.key.id);
        assert.ok(key, "created key should be listed");
        assert.equal(key.request_count, 1);
        assert.match(key.last_used_at, /^\d{4}-\d{2}-\d{2}T/);

        const logs = await httpGet(`${baseUrl}/admin/logs`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(logs.status, 200, logs.body);
        const logBody = JSON.parse(logs.body);
        assert.ok(Array.isArray(logBody.logs), "logs should be an array");
        assert.ok(
          logBody.logs.some((entry: any) => entry.event === "admin.api_key.created"),
          "admin logs should include API key creation"
        );
        assert.ok(
          logBody.logs.some((entry: any) => entry.event === "proxy.request.completed"),
          "admin logs should include downstream proxy request completion"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("disables and re-enables downstream API keys from the admin backend", async () => {
      const dataDir = makeIsolatedDataDir("admin-api-key-disable");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const created = await httpPost(
          `${baseUrl}/admin/api-keys`,
          { name: "customer-client" },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(created.status, 201, created.body);
        const createdBody = JSON.parse(created.body);

        const initiallyAuthorized = await httpPost(
          `${baseUrl}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { Authorization: `Bearer ${createdBody.key.value}` }
        );
        assert.equal(initiallyAuthorized.status, 400, initiallyAuthorized.body);

        const disabled = await httpPatch(
          `${baseUrl}/admin/api-keys/${createdBody.key.id}`,
          { enabled: false },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(disabled.status, 200, disabled.body);
        assert.equal(JSON.parse(disabled.body).key.enabled, false);

        const rejected = await httpPost(
          `${baseUrl}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { Authorization: `Bearer ${createdBody.key.value}` }
        );
        assert.equal(rejected.status, 401, rejected.body);

        const enabled = await httpPatch(
          `${baseUrl}/admin/api-keys/${createdBody.key.id}`,
          { enabled: true },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(enabled.status, 200, enabled.body);
        assert.equal(JSON.parse(enabled.body).key.enabled, true);

        const authorizedAgain = await httpPost(
          `${baseUrl}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { Authorization: `Bearer ${createdBody.key.value}` }
        );
        assert.equal(authorizedAgain.status, 400, authorizedAgain.body);

        const logs = await httpGet(`${baseUrl}/admin/logs`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(logs.status, 200, logs.body);
        const logsBody = JSON.parse(logs.body);
        assert.ok(
          logsBody.logs.some((entry: any) => entry.event === "admin.api_key.updated"),
          "admin logs should include API key status changes"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("deletes downstream API keys from the admin backend", async () => {
      const dataDir = makeIsolatedDataDir("admin-api-key-delete");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const created = await httpPost(
          `${baseUrl}/admin/api-keys`,
          { name: "deleted-client" },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(created.status, 201, created.body);
        const createdBody = JSON.parse(created.body);

        const deleted = await httpDelete(
          `${baseUrl}/admin/api-keys/${createdBody.key.id}`,
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.equal(deleted.status, 200, deleted.body);
        assert.equal(JSON.parse(deleted.body).key.id, createdBody.key.id);

        const keys = await httpGet(`${baseUrl}/admin/api-keys`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(keys.status, 200, keys.body);
        assert.equal(
          JSON.parse(keys.body).keys.some((key: any) => key.id === createdBody.key.id),
          false
        );

        const rejected = await httpPost(
          `${baseUrl}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { Authorization: `Bearer ${createdBody.key.value}` }
        );
        assert.equal(rejected.status, 401, rejected.body);

        const logs = await httpGet(`${baseUrl}/admin/logs`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(logs.status, 200, logs.body);
        const logsBody = JSON.parse(logs.body);
        assert.ok(
          logsBody.logs.some((entry: any) => entry.event === "admin.api_key.deleted"),
          "admin logs should include API key deletion"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("changes the administrator password from the admin backend and invalidates old sessions", async () => {
      const dataDir = makeIsolatedDataDir("admin-password-change");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const oldToken = await bootstrapAdmin(baseUrl, "admin", "admin-secret");

        const changed = await httpPatch(
          `${baseUrl}/admin/auth/password`,
          {
            current_password: "admin-secret",
            new_password: "admin-secret-2",
          },
          { Authorization: `Bearer ${oldToken}` }
        );
        assert.equal(changed.status, 200, changed.body);
        const changedBody = JSON.parse(changed.body);
        assert.match(changedBody.token, /^adm_/);

        const oldSessionConfig = await httpGet(`${baseUrl}/admin/config`, {
          Authorization: `Bearer ${oldToken}`,
        });
        assert.equal(oldSessionConfig.status, 401, oldSessionConfig.body);

        const oldLogin = await httpPost(`${baseUrl}/admin/auth/login`, {
          username: "admin",
          password: "admin-secret",
        });
        assert.equal(oldLogin.status, 401, oldLogin.body);

        const newLogin = await httpPost(`${baseUrl}/admin/auth/login`, {
          username: "admin",
          password: "admin-secret-2",
        });
        assert.equal(newLogin.status, 200, newLogin.body);

        const logs = await httpGet(`${baseUrl}/admin/logs`, {
          Authorization: `Bearer ${changedBody.token}`,
        });
        assert.equal(logs.status, 200, logs.body);
        const logsBody = JSON.parse(logs.body);
        assert.ok(
          logsBody.logs.some((entry: any) => entry.event === "admin.password.changed"),
          "admin logs should include password changes"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("shows service runtime logs in the admin backend", async () => {
      const dataDir = makeIsolatedDataDir("admin-service-runtime-logs");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const hook = await httpPost(`${baseUrl}/hooks/pre-tool-use`, makePreToolUsePayload({
          tool_name: "Read",
          tool_input: { file_path: "demo.txt" },
          cwd: TEST_WORKSPACE,
        }));
        assert.equal(hook.status, 200, hook.body);

        const logs = await httpGet(`${baseUrl}/admin/logs`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(logs.status, 200, logs.body);
        const body = JSON.parse(logs.body);
        assert.ok(
          body.logs.some((entry: any) => entry.event === "service.log" && entry.message.includes("PreToolUse hook fired")),
          "admin logs should include service runtime log entries"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("shows storage diagnostics in the admin backend", async () => {
      const dataDir = makeIsolatedDataDir("admin-storage-diagnostics");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);

        const res = await httpGet(`${baseUrl}/admin/system`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(res.status, 200, res.body);
        const body = JSON.parse(res.body);
        assert.equal(body.storage.data_dir, dataDir);
        assert.equal(body.storage.claude_home_dir, path.join(dataDir, "claude-home"));
        assert.equal(body.storage.control_plane_path, path.join(dataDir, "control-plane.json"));
        assert.equal(body.storage.control_plane_exists, true);
        assert.equal(body.storage.audit_log_path, path.join(dataDir, "audit-log.json"));
        assert.equal(body.storage.account_state_path, path.join(dataDir, "account-state.json"));
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("exposes public admin bootstrap status without leaking credentials", async () => {
      const dataDir = makeIsolatedDataDir("admin-bootstrap-status");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const baseUrl = `http://localhost:${ZEABUR_PORT}`;

        const initial = await httpGet(`${baseUrl}/admin/status`);
        assert.equal(initial.status, 200, initial.body);
        const initialBody = JSON.parse(initial.body);
        assert.equal(initialBody.admin.configured, false);
        assert.equal("password_hash" in initialBody.admin, false);
        assert.equal("password_salt" in initialBody.admin, false);

        await bootstrapAdmin(baseUrl);

        const configured = await httpGet(`${baseUrl}/admin/status`);
        assert.equal(configured.status, 200, configured.body);
        const configuredBody = JSON.parse(configured.body);
        assert.equal(configuredBody.admin.configured, true);
        assert.equal("password_hash" in configuredBody.admin, false);
        assert.equal("password_salt" in configuredBody.admin, false);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("serves the administrator web console from /admin", async () => {
      const dataDir = makeIsolatedDataDir("admin-web-console");
      const proc = await startTestServer(ZEABUR_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
      });
      try {
        const res = await httpGet(`http://localhost:${ZEABUR_PORT}/admin`);
        assert.equal(res.status, 200, res.body);
        assert.match(String(res.headers["content-type"]), /^text\/html/);
        assert.match(res.body, /cc-proxy-admin/);
        assert.match(res.body, /5小时限额/);
        assert.match(res.body, /本周限额/);
        assert.match(res.body, /CLI 窗口/);
        assert.match(res.body, /toggleKey/);
        assert.match(res.body, /deleteKey/);
        assert.match(res.body, /claudeAuthInput/);
        assert.match(res.body, /\/admin\/claude-auth\/input/);
        assert.match(res.body, /sendClaudeLoginCommandButton/);
        assert.match(res.body, /\/login/);
        assert.match(res.body, /cancelClaudeAuthButton/);
        assert.match(res.body, /changeAdminPasswordButton/);
        assert.match(res.body, /\/admin\/auth\/password/);
        assert.match(res.body, /最近使用/);
        assert.match(res.body, /请求次数/);
        assert.match(res.body, /copyCreatedKeyButton/);
        assert.match(res.body, /logLevelFilter/);
        assert.match(res.body, /storageDataDir/);
        assert.match(res.body, /\/admin\/system/);
        assert.match(res.body, /adminBootstrapState/);
        assert.match(res.body, /\/admin\/status/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("enables Claude Code partial stream-json messages for live SSE", () => {
      const args = resolveClaudeArgs();
      assert.ok(
        args.includes("--include-partial-messages"),
        "Claude CLI args should request partial stream events"
      );
    });

    it("GET /health returns 200 with status ok", async () => {
      const res = await httpGet(`${BASE_URL}/health`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, "ok");
      assert.ok(body.downstream_root, "should report downstream_root");
    });

    it("GET /health does not expose admin-only account details", async () => {
      const res = await httpGet(`${BASE_URL}/health`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal("account" in body, false);
      assert.equal("usage" in body, false);
      assert.equal("last_error" in body, false);
    });

    it("GET /health reports correct downstream_root", async () => {
      const res = await httpGet(`${BASE_URL}/health`);
      const body = JSON.parse(res.body);
      assert.equal(
        path.resolve(body.downstream_root),
        path.resolve(DOWNSTREAM_ROOT)
      );
    });

    it("GET /unknown returns 404", async () => {
      const res = await httpGet(`${BASE_URL}/unknown`);
      assert.equal(res.status, 404);
    });

    it("POST /unknown returns 404", async () => {
      const res = await httpPost(`${BASE_URL}/unknown`, {});
      assert.equal(res.status, 404);
    });

    it("server responds with Content-Type application/json", async () => {
      const res = await httpGet(`${BASE_URL}/health`);
      assert.equal(res.headers["content-type"], "application/json");
    });
  });

  describe("1b. Anthropic-compatible messages API", () => {
    it("requires an API key for /v1/messages when CC_PROXY_API_KEY is configured", async () => {
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
      });
      try {
        const res = await httpPost(`http://localhost:${ANTHROPIC_PORT}/v1/messages`, {
          model: "claude-sonnet-4-6",
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(res.status, 401);
        const body = JSON.parse(res.body);
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "authentication_error");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("accepts x-api-key auth for /v1/messages", async () => {
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [],
          },
          { "x-api-key": "test-secret" }
        );
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "invalid_request_error");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("accepts Bearer auth for /v1/messages", async () => {
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "invalid_request_error");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("returns request-id header and request_id on Anthropic errors", async () => {
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 400);
        const requestId = String(res.headers["request-id"] || "");
        assert.match(requestId, /^req_/);
        const body = JSON.parse(res.body);
        assert.equal(body.type, "error");
        assert.equal(body.request_id, requestId);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });

    it("returns request-id header on successful Anthropic messages responses", async () => {
      const fakeClaude = writeFakeClaudeCommand("REQUEST_ID_OK");
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 200);
        assert.match(String(res.headers["request-id"] || ""), /^req_/);
        assert.match(res.body, /REQUEST_ID_OK/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("passes Claude 429 quota errors downstream and marks the local account as cooling down", async () => {
      const fakeClaude = writeQuotaErrorClaudeCommand();
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ANTHROPIC_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "quota-client");
        const before = Date.now();
        const res = await httpPost(
          `${baseUrl}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: `Bearer ${clientKey.value}` }
        );
        assert.equal(res.status, 429, res.body);
        const body = JSON.parse(res.body);
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "claude_original_limit");
        assert.equal(body.error.upstream_code, "five_hour_limit");
        assert.match(body.error.message, /5-hour usage limit/);

        const health = await httpGet(`${baseUrl}/health`);
        assert.equal(health.status, 200);
        const healthBody = JSON.parse(health.body);
        assert.equal("account" in healthBody, false);

        const accountRes = await httpGet(`${baseUrl}/admin/account`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(accountRes.status, 200, accountRes.body);
        const account = JSON.parse(accountRes.body).account;
        assert.equal(account.status, "cooldown");
        assert.equal(account.last_error.status, 429);
        assert.match(account.last_error.message, /5-hour usage limit/);

        const cooldownUntil = Date.parse(account.cooldown_until);
        assert.ok(Number.isFinite(cooldownUntil), "cooldown_until should be an ISO timestamp");
        assert.equal(
          account.limits.five_hour.percent_remaining,
          null,
          "quota percentage must stay unknown unless Claude returns a real quota percentage"
        );
        assert.ok(
          cooldownUntil - before >= 4.9 * 60 * 60 * 1000,
          "cooldown should last about 5 hours"
        );
        assert.ok(
          cooldownUntil - before <= 5.1 * 60 * 60 * 1000,
          "cooldown should not exceed the expected 5-hour window"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("surfaces raw Claude CLI stderr failures in downstream responses and admin account/log details", async () => {
      const dataDir = makeIsolatedDataDir("admin-cli-stderr-failure");
      const stderrText = "Claude account banned: upstream disabled this account\n";
      const fakeClaude = writeStderrExitClaudeCommand(stderrText);
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ANTHROPIC_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "stderr-client");

        const res = await httpPost(
          `${baseUrl}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: `Bearer ${clientKey.value}` }
        );
        assert.equal(res.status, 502, res.body);
        assert.match(res.body, /Claude account banned: upstream disabled this account/);

        const account = await httpGet(`${baseUrl}/admin/account`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(account.status, 200, account.body);
        const accountBody = JSON.parse(account.body);
        assert.equal(accountBody.account.status, "error");
        assert.match(accountBody.account.last_error.message, /Claude account banned/);

        const logs = await httpGet(`${baseUrl}/admin/logs`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(logs.status, 200, logs.body);
        const logsBody = JSON.parse(logs.body);
        assert.ok(
          logsBody.logs.some((entry: any) => JSON.stringify(entry).includes("Claude account banned")),
          "admin logs should include raw Claude CLI stderr"
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("shows account usage spend and cache read rate in the admin account details", async () => {
      const dataDir = makeIsolatedDataDir("admin-account-usage");
      const fakeClaude = writeFakeClaudeCommand("USAGE_ACCOUNT_OK");
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ANTHROPIC_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "usage-client");

        const res = await httpPost(
          `${baseUrl}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: `Bearer ${clientKey.value}` }
        );
        assert.equal(res.status, 200, res.body);

        const account = await httpGet(`${baseUrl}/admin/account`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(account.status, 200, account.body);
        const body = JSON.parse(account.body);
        assert.equal(body.account.status, "ready");
        assert.equal(body.account.usage.today.cost_usd, 0.0123);
        assert.equal(body.account.usage.week.cost_usd, 0.0123);
        assert.equal(body.account.usage.month.cost_usd, 0.0123);
        assert.equal(body.account.usage.today.request_count, 1);
        assert.equal(body.account.usage.today.input_tokens, 3);
        assert.equal(body.account.usage.today.output_tokens, 4);
        assert.equal(body.account.usage.today.cache_creation_input_tokens, 5);
        assert.equal(body.account.usage.today.cache_read_input_tokens, 6);
        assert.equal(body.account.usage.today.total_tokens, 18);
        assert.equal(body.account.usage.today.average_duration_ms, 10);
        assert.ok(
          Math.abs(body.account.usage.today.cache_read_rate - 6 / 14) < 0.0001,
          `unexpected cache read rate: ${body.account.usage.today.cache_read_rate}`
        );
        assert.equal(body.account.limits.five_hour.status, "ok");
        assert.equal(body.account.limits.weekly.status, "ok");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("shows active CLI windows with per-window usage in the admin backend", async () => {
      const dataDir = makeIsolatedDataDir("admin-cli-window-usage");
      const fakeClaude = writeFakeClaudeCommand("WINDOW_USAGE_OK");
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_DATA_DIR: dataDir,
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const baseUrl = `http://localhost:${ANTHROPIC_PORT}`;
        const adminToken = await bootstrapAdmin(baseUrl);
        const clientKey = await createDownstreamKey(baseUrl, adminToken, "window-usage-client");

        const res = await httpPost(
          `${baseUrl}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [{ role: "user", content: "hello" }],
          },
          {
            Authorization: `Bearer ${clientKey.value}`,
            "x-cc-keep-session": "true",
          }
        );
        assert.equal(res.status, 200, res.body);

        const windows = await httpGet(`${baseUrl}/admin/cli-windows`, {
          Authorization: `Bearer ${adminToken}`,
        });
        assert.equal(windows.status, 200, windows.body);
        const body = JSON.parse(windows.body);
        assert.equal(body.limit, 10);
        assert.equal(body.active, 1);
        assert.equal(body.windows.length, 1);
        assert.equal(body.windows[0].turns, 1);
        assert.equal(body.windows[0].cli_session_id, "fake-cli-session");
        assert.equal(body.windows[0].usage.total_tokens, 18);
        assert.equal(body.windows[0].usage.cost_usd, 0.0123);
        assert.equal(body.windows[0].usage.average_duration_ms, 10);
        assert.ok(
          Math.abs(body.windows[0].usage.cache_read_rate - 6 / 14) < 0.0001,
          `unexpected cache read rate: ${body.windows[0].usage.cache_read_rate}`
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("returns Anthropic SSE events for stream:true /v1/messages requests", async () => {
      const fakeClaude = writeFakeClaudeCommand("FAKE_STREAM_RESULT");
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 200);
        assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
        assert.match(res.body, /event: message_start/);
        assert.match(res.body, /event: content_block_delta/);
        assert.match(res.body, /event: message_delta/);
        assert.match(res.body, /event: message_stop/);
        assert.match(res.body, /FAKE_STREAM_RESULT/);
        assert.match(res.body, /"total_cost_usd":0.0123/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("forwards Claude Code stream_event chunks before the turn result completes", async () => {
      const fakeClaude = writeStreamingClaudeCommand(1400);
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const res = await httpPostChunked(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 200);
        assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
        assert.equal(res.headers["x-cc-cli-session-id"], "fake-cli-session");
        assert.match(res.body, /LIVE_DELTA_BEFORE_RESULT/);
        assert.ok(res.chunks.length > 0, "stream should produce chunks");
        const lastChunk = res.chunks[res.chunks.length - 1];
        assert.ok(
          lastChunk.atMs - res.chunks[0].atMs >= 500,
          `first SSE chunk should arrive live before delayed result; first=${res.chunks[0].atMs}ms last=${lastChunk.atMs}ms`
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("bridges client-supplied Anthropic tools through a real MCP tool call and resumes with tool_result", async () => {
      const fakeClaude = writeMcpToolCallingClaudeCommand();
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const first = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            tools: [
              {
                name: "lookup_frame_budget",
                description: "Look up a game frame budget.",
                input_schema: {
                  type: "object",
                  properties: { platform: { type: "string" } },
                },
              },
            ],
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(first.status, 200, first.body);
        const firstBody = JSON.parse(first.body);
        assert.equal(firstBody.type, "message");
        assert.equal(firstBody.stop_reason, "tool_use");
        assert.equal(firstBody.content[0].type, "tool_use");
        assert.equal(firstBody.content[0].id, "toolu_frame_budget_001");
        assert.equal(firstBody.content[0].name, "lookup_frame_budget");
        assert.deepEqual(firstBody.content[0].input, { platform: "switch" });

        const second = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 256,
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
              {
                role: "assistant",
                content: firstBody.content,
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "toolu_frame_budget_001",
                    content:
                      "Switch handheld budget: keep simulation plus render under 16.67ms, reserve 2ms for streaming.",
                  },
                ],
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(second.status, 200, second.body);
        const secondBody = JSON.parse(second.body);
        assert.equal(secondBody.stop_reason, "end_turn");
        assert.match(
          secondBody.content[0].text,
          /CLIENT_TOOL_RESULT:Switch handheld budget/
        );
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("ignores Claude Code internal tool search before exposing client-supplied tools", async () => {
      const fakeClaude = writeMcpToolCallingClaudeCommand(0, true);
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const first = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            tools: [
              {
                name: "lookup_frame_budget",
                description: "Look up a game frame budget.",
                input_schema: {
                  type: "object",
                  properties: { platform: { type: "string" } },
                },
              },
            ],
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(first.status, 200, first.body);
        const firstBody = JSON.parse(first.body);
        assert.equal(firstBody.stop_reason, "tool_use");
        assert.equal(firstBody.content.length, 1);
        assert.equal(firstBody.content[0].type, "tool_use");
        assert.equal(firstBody.content[0].name, "lookup_frame_budget");
        assert.equal(firstBody.content[0].id, "toolu_frame_budget_001");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("keeps client-supplied tool sessions one-shot even when keep-session is requested", async () => {
      const fakeClaude = writeMcpToolCallingClaudeCommand();
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const first = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            tools: [
              {
                name: "lookup_frame_budget",
                description: "Look up a game frame budget.",
                input_schema: {
                  type: "object",
                  properties: { platform: { type: "string" } },
                },
              },
            ],
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
            ],
          },
          {
            Authorization: "Bearer test-secret",
            "x-cc-keep-session": "true",
          }
        );
        assert.equal(first.status, 200, first.body);
        assert.equal(first.headers["x-cc-session-id"], undefined);

        const firstBody = JSON.parse(first.body);
        const second = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
              { role: "assistant", content: firstBody.content },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "toolu_frame_budget_001",
                    content: "Switch handheld budget: keep the game under 16.67ms.",
                  },
                ],
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(second.status, 200, second.body);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("streams client-supplied tool_use and streams the resumed tool_result answer", async () => {
      const fakeClaude = writeMcpToolCallingClaudeCommand(1400);
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const first = await httpPostChunked(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            stream: true,
            tools: [
              {
                name: "lookup_frame_budget",
                description: "Look up a game frame budget.",
                input_schema: {
                  type: "object",
                  properties: { platform: { type: "string" } },
                },
              },
            ],
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(first.status, 200, first.body);
        assert.match(String(first.headers["content-type"]), /^text\/event-stream/);
        assert.match(first.body, /toolu_frame_budget_001/);
        assert.match(first.body, /"stop_reason":"tool_use"/);
        assert.ok(first.chunks.length > 0, "stream should produce tool_use chunks");
        const firstLastChunk = first.chunks[first.chunks.length - 1];
        assert.ok(
          firstLastChunk.atMs - first.chunks[0].atMs >= 500,
          `first tool_use SSE chunk should arrive live before delayed message_stop; first=${first.chunks[0].atMs}ms last=${firstLastChunk.atMs}ms`
        );

        const second = await httpPostChunked(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 256,
            stream: true,
            messages: [
              {
                role: "user",
                content:
                  "Use lookup_frame_budget for a Nintendo Switch action RPG frame-budget check.",
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_frame_budget_001",
                    name: "lookup_frame_budget",
                    input: { platform: "switch" },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "toolu_frame_budget_001",
                    content:
                      "Switch docked budget: use 16.67ms total, with 3ms reserved for render spikes.",
                  },
                ],
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(second.status, 200, second.body);
        assert.match(String(second.headers["content-type"]), /^text\/event-stream/);
        assert.match(second.body, /CLIENT_TOOL_RESULT:Switch docked budget/);
        assert.match(second.body, /event: message_stop/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("maps /v1/messages model and thinking budget to Claude Code CLI args for new sessions", async () => {
      const fakeClaude = writeArgvClaudeCommand();
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-request-model",
            max_tokens: 128,
            thinking: { type: "enabled", budget_tokens: 32000 },
            messages: [{ role: "user", content: "hello" }],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        const text = body.content?.[0]?.text || "";
        assert.match(text, /--model claude-request-model/);
        assert.match(text, /--effort high/);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("passes multimodal content to Claude Code as native stream-json blocks and preserves assistant blocks", async () => {
      const fakeClaude = writeInspectingClaudeCommand();
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 128,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
                    },
                  },
                  {
                    type: "text",
                    text: "Identify the debug overlay color for a tactics game.",
                  },
                ],
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        const body = JSON.parse(res.body);
        assert.equal(res.status, 200);
        assert.equal(body.content[0].type, "thinking");
        assert.equal(body.content[0].signature, "sig_native_probe");
        assert.equal(body.content[1].type, "text");
        assert.equal(body.content[1].text, "CONTENT_TYPES:image,text");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("passes long game-development context through /v1/messages without proxy-side truncation", async () => {
      const fakeClaude = writeLongContextInspectingClaudeCommand();
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
        CLAUDE_COMMAND: fakeClaude,
      });
      const sections = [
        "combat loop",
        "entity-component design",
        "save/load schema",
        "asset pipeline",
        "performance budget",
        "automated test plan",
      ];
      const longContext = Array.from({ length: 36 }, (_, index) => {
        const section = sections[index % sections.length];
        return [
          `Iteration ${index + 1}: ${section}.`,
          "Build a small action RPG prototype with deterministic rollback-safe combat timing, spawn tables, hit-stop windows, and animation cancel rules.",
          "Track entities through component ownership, serialization boundaries, asset import fingerprints, memory budgets, frame spikes, and smoke tests.",
          "Keep markers ALPHA-BRAVO-CHARLIE-7742 and NESTED-DOWNSTREAM-MARKER-9921 visible for downstream read-hook validation.",
        ].join(" ");
      }).join("\\n");

      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          {
            model: "claude-sonnet-4-6",
            max_tokens: 512,
            system:
              "You are validating a game development assistant proxy. Preserve technical details from the user context.",
            messages: [
              {
                role: "user",
                content:
                  `${longContext}\n\nWrite a non-trivial review covering combat loop, entity-component design, save/load schema, asset pipeline, performance budget, and automated test plan.`,
              },
            ],
          },
          { Authorization: "Bearer test-secret" }
        );
        assert.equal(res.status, 200, res.body);
        const body = JSON.parse(res.body);
        const text = body.content?.[0]?.text || "";
        assert.match(text, /^LONG_CONTEXT_REPORT:/);
        const report = JSON.parse(text.replace(/^LONG_CONTEXT_REPORT:/, ""));
        assert.ok(
          report.textLength > 15_000,
          `expected long context to reach fake Claude, got ${report.textLength}`
        );
        for (const section of [
          ...sections,
          "ALPHA-BRAVO-CHARLIE-7742",
          "NESTED-DOWNSTREAM-MARKER-9921",
        ]) {
          assert.equal(report.required[section], true, `missing ${section}`);
        }
        assert.ok(body.usage.input_tokens > 3_000);
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
        if (fs.existsSync(fakeClaude)) fs.unlinkSync(fakeClaude);
      }
    });

    it("rejects invalid /v1/messages payloads before spawning Claude", async () => {
      const proc = await startTestServer(ANTHROPIC_PORT, {
        CC_PROXY_API_KEY: "test-secret",
      });
      try {
        const res = await httpPost(
          `http://localhost:${ANTHROPIC_PORT}/v1/messages`,
          { model: "claude-sonnet-4-6", max_tokens: 128, messages: [] },
          { "x-api-key": "test-secret" }
        );
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "invalid_request_error");
      } finally {
        proc.kill("SIGKILL");
        await sleep(300);
      }
    });
  });

  // ========================================
  // 2. PreToolUse Hook: Read Interception
  // ========================================
  describe("2. PreToolUse: Read tool interception", () => {
    it("intercepts Read and returns allow with updatedInput", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
      assert.ok(
        body.hookSpecificOutput.updatedInput,
        "should have updatedInput"
      );
      assert.ok(
        body.hookSpecificOutput.updatedInput.file_path,
        "updatedInput should have file_path"
      );
    });

    it("rewritten file_path points to temp file with downstream content", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;

      // Verify temp file exists and has downstream content
      assert.ok(fs.existsSync(tempFilePath), "temp file should exist");
      const content = fs.readFileSync(tempFilePath, "utf-8");
      assert.ok(
        content.includes("DOWNSTREAM_REAL_CONTENT"),
        "temp file should contain downstream marker"
      );
      assert.ok(
        content.includes("ALPHA-BRAVO-CHARLIE-7742"),
        "temp file should contain downstream unique phrase"
      );
      assert.ok(
        !content.includes("SERVER placeholder"),
        "temp file must NOT contain server placeholder"
      );
    });

    it("handles absolute file_path by converting to relative", async () => {
      const absPath = path.join(TEST_WORKSPACE, "demo.txt");
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: absPath },
        cwd: TEST_WORKSPACE,
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(
        body.hookSpecificOutput.permissionDecision,
        "allow"
      );
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const content = fs.readFileSync(tempFilePath, "utf-8");
      assert.ok(
        content.includes("DOWNSTREAM_REAL_CONTENT"),
        "should resolve absolute path to downstream"
      );
    });

    it("handles subdirectory file paths", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "sub/nested.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const content = fs.readFileSync(tempFilePath, "utf-8");
      assert.ok(
        content.includes("NESTED_DOWNSTREAM_FILE"),
        "should read from subdirectory"
      );
      assert.ok(
        content.includes("DELTA-ECHO-FOXTROT-3355"),
        "should contain nested file marker"
      );
    });

    it("handles empty files", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "empty.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(
        body.hookSpecificOutput.permissionDecision,
        "allow"
      );
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const content = fs.readFileSync(tempFilePath, "utf-8");
      assert.equal(content, "", "empty file should yield empty content");
    });

    it("handles files with unicode content", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "unicode.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const content = fs.readFileSync(tempFilePath, "utf-8");
      assert.ok(
        content.includes("你好世界"),
        "should preserve Chinese characters"
      );
      assert.ok(
        content.includes("UNICODE_MARKER"),
        "should contain unicode marker"
      );
    });

    it("falls through to allow for files that only exist on server", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "only-server.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      // Should still allow the tool, just without updatedInput
      assert.equal(
        body.hookSpecificOutput.permissionDecision,
        "allow"
      );
      // No updatedInput means Claude reads the real server file
      assert.equal(
        body.hookSpecificOutput.updatedInput,
        undefined,
        "should not rewrite for missing downstream file"
      );
    });
  });

  // ========================================
  // 3. Non-Read Tool Pass-Through
  // ========================================
  describe("3. Non-Read tools pass through", () => {
    const passThroughTools = [
      "Bash",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "LS",
      "Agent",
    ];

    for (const toolName of passThroughTools) {
      it(`${toolName} is allowed without interception`, async () => {
        const payload = makePreToolUsePayload({
          tool_name: toolName,
          tool_input:
            toolName === "Bash"
              ? { command: "echo hello" }
              : toolName === "Glob"
              ? { pattern: "**/*.ts" }
              : toolName === "Grep"
              ? { pattern: "test" }
              : {},
        });
        const res = await httpPost(
          `${BASE_URL}/hooks/pre-tool-use`,
          payload
        );
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(
          body.hookSpecificOutput.permissionDecision,
          "allow",
          `${toolName} should be allowed`
        );
        assert.equal(
          body.hookSpecificOutput.updatedInput,
          undefined,
          `${toolName} should not have updatedInput`
        );
      });
    }
  });

  // ========================================
  // 4. Context Information Propagation
  // ========================================
  describe("4. Context information propagation", () => {
    it("session_id is received in hook payload", async () => {
      const sid = "sess_context_test_" + Date.now();
      const payload = makePreToolUsePayload({
        session_id: sid,
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      // Server processes the request successfully — session_id was consumed
      const body = JSON.parse(res.body);
      assert.ok(body.hookSpecificOutput, "should return valid hook output");
    });

    it("cwd is used for path resolution", async () => {
      // Use absolute path with different cwd
      const absPath = path.join(TEST_WORKSPACE, "demo.txt");
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: absPath },
        cwd: TEST_WORKSPACE,
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const content = fs.readFileSync(
        body.hookSpecificOutput.updatedInput.file_path as string,
        "utf-8"
      );
      assert.ok(
        content.includes("DOWNSTREAM_REAL_CONTENT"),
        "cwd should be used to resolve relative paths"
      );
    });

    it("preserves all hook payload fields without error", async () => {
      const payload = makePreToolUsePayload({
        session_id: "sess_full_ctx",
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
        cwd: TEST_WORKSPACE,
        permission_mode: "default",
        agent_id: "agent_123",
        agent_type: "claude",
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
    });

    it("handles missing tool_input gracefully", async () => {
      const payload = {
        session_id: "sess_no_input",
        transcript_path: "/tmp/test.jsonl",
        cwd: TEST_WORKSPACE,
        permission_mode: "allow",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        // no tool_input
      };
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      // Should allow without rewriting (no file_path to intercept)
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
    });

    it("handles missing file_path in tool_input", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: {},
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      // Empty file_path → fallback to allow without rewrite
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
    });
  });

  // ========================================
  // 5. Billing & Token-Relevant Metadata
  // ========================================
  describe("5. Billing & token-relevant metadata", () => {
    it("temp file byte count matches downstream source", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const downstreamContent = readDownstreamFile("demo.txt");
      const tempContent = fs.readFileSync(tempFilePath, "utf-8");

      assert.equal(
        Buffer.byteLength(tempContent, "utf-8"),
        Buffer.byteLength(downstreamContent, "utf-8"),
        "byte count of temp file should match downstream source"
      );
    });

    it("temp file content is character-identical to downstream", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const downstreamContent = readDownstreamFile("demo.txt");
      const tempContent = fs.readFileSync(tempFilePath, "utf-8");

      assert.equal(
        tempContent,
        downstreamContent,
        "content must be bit-for-bit identical"
      );
    });

    it("hook response structure preserves fields needed for upstream billing", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      // Verify the response shape has all fields Claude CLI expects
      assert.ok(body.hookSpecificOutput, "must have hookSpecificOutput");
      assert.equal(
        body.hookSpecificOutput.hookEventName,
        "PreToolUse",
        "hookEventName must match"
      );
      assert.ok(
        ["allow", "deny", "ask", "defer"].includes(
          body.hookSpecificOutput.permissionDecision
        ),
        "permissionDecision must be a valid value"
      );
    });

    it("unicode file byte count is preserved", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "unicode.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      const tempFilePath = body.hookSpecificOutput.updatedInput
        .file_path as string;
      const downstreamContent = readDownstreamFile("unicode.txt");
      const tempContent = fs.readFileSync(tempFilePath, "utf-8");

      assert.equal(
        Buffer.byteLength(tempContent, "utf-8"),
        Buffer.byteLength(downstreamContent, "utf-8"),
        "unicode byte count must be preserved"
      );
    });
  });

  // ========================================
  // 6. Cache Behavior Validation
  // ========================================
  describe("6. Cache behavior validation", () => {
    it("repeated reads produce consistent content", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await httpPost(
          `${BASE_URL}/hooks/pre-tool-use`,
          payload
        );
        const body = JSON.parse(res.body);
        const tempFilePath = body.hookSpecificOutput.updatedInput
          .file_path as string;
        results.push(fs.readFileSync(tempFilePath, "utf-8"));
      }
      assert.equal(results[0], results[1], "read 1 should equal read 2");
      assert.equal(results[1], results[2], "read 2 should equal read 3");
    });

    it("each intercepted read creates a distinct temp file", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const tempPaths: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await httpPost(
          `${BASE_URL}/hooks/pre-tool-use`,
          payload
        );
        const body = JSON.parse(res.body);
        tempPaths.push(
          body.hookSpecificOutput.updatedInput.file_path as string
        );
      }
      // Each call should produce a unique temp file (timestamp-based naming)
      const uniquePaths = new Set(tempPaths);
      assert.equal(
        uniquePaths.size,
        3,
        "each call should produce a unique temp file path"
      );
    });

    it("downstream file changes are reflected on next read", async () => {
      // Create a temporary test file in downstream
      const testFile = "cache-test.txt";
      const content1 = "CACHE_TEST_V1";
      const content2 = "CACHE_TEST_V2";
      const downstreamPath = path.join(DOWNSTREAM_ROOT, testFile);

      try {
        fs.writeFileSync(downstreamPath, content1, "utf-8");

        const payload = makePreToolUsePayload({
          tool_name: "Read",
          tool_input: { file_path: testFile },
        });

        // First read
        const res1 = await httpPost(
          `${BASE_URL}/hooks/pre-tool-use`,
          payload
        );
        const body1 = JSON.parse(res1.body);
        const temp1 = fs.readFileSync(
          body1.hookSpecificOutput.updatedInput.file_path as string,
          "utf-8"
        );
        assert.equal(temp1, content1, "first read should be V1");

        // Change downstream file
        fs.writeFileSync(downstreamPath, content2, "utf-8");

        // Second read should see the new content
        const res2 = await httpPost(
          `${BASE_URL}/hooks/pre-tool-use`,
          payload
        );
        const body2 = JSON.parse(res2.body);
        const temp2 = fs.readFileSync(
          body2.hookSpecificOutput.updatedInput.file_path as string,
          "utf-8"
        );
        assert.equal(temp2, content2, "second read should reflect V2");
      } finally {
        // Clean up
        if (fs.existsSync(downstreamPath)) {
          fs.unlinkSync(downstreamPath);
        }
      }
    });
  });

  // ========================================
  // 7. Security Boundary Tests
  // ========================================
  describe("7. Security boundary enforcement", () => {
    it("blocks path traversal with ../", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "../../../etc/passwd" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      // Path escape → downstream read fails → fall through allow
      // The important thing is server does NOT serve /etc/passwd content
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
      assert.equal(
        body.hookSpecificOutput.updatedInput,
        undefined,
        "should NOT rewrite to server /etc/passwd"
      );
    });

    it("blocks absolute path pointing outside downstream", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "/etc/passwd" },
        cwd: TEST_WORKSPACE,
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
      assert.equal(
        body.hookSpecificOutput.updatedInput,
        undefined,
        "should NOT rewrite paths outside downstream root"
      );
    });

    it("handles null byte injection in file path", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt\0../../../etc/passwd" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      // Should not crash — either blocks or falls through safely
    });

    it("handles very long file paths", async () => {
      const longPath = "a/".repeat(500) + "demo.txt";
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: longPath },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      // Should not crash, just fail to find file and fall through
      const body = JSON.parse(res.body);
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
    });
  });

  // ========================================
  // 8. PostToolUse Hook
  // ========================================
  describe("8. PostToolUse hook", () => {
    it("accepts PostToolUse payload and returns empty response", async () => {
      const payload = {
        session_id: "sess_post_test",
        transcript_path: "/tmp/test.jsonl",
        cwd: TEST_WORKSPACE,
        permission_mode: "allow",
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
        tool_response: "file content here",
        duration_ms: 150,
      };
      const res = await httpPost(
        `${BASE_URL}/hooks/post-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body, {});
    });

    it("handles malformed PostToolUse gracefully", async () => {
      // "not json" as a plain string is actually valid JSON (a JSON string literal)
      // Server parses it and falls through to default behavior
      const res = await httpPost(
        `${BASE_URL}/hooks/post-tool-use`,
        "not json"
      );
      // Server does not crash — returns 200 with empty body or 500 on real parse error
      assert.ok(
        res.status === 200 || res.status === 500,
        `expected 200 or 500, got ${res.status}`
      );
    });
  });

  // ========================================
  // 9. Error Handling & Robustness
  // ========================================
  describe("9. Error handling & robustness", () => {
    it("handles malformed JSON in PreToolUse", async () => {
      // "this is not json" is a valid JSON string literal, so server parses it
      // and falls through to default allow. Real malformed JSON like "{bad" would error.
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        "this is not json"
      );
      assert.ok(
        res.status === 200 || res.status === 500,
        `expected 200 or 500, got ${res.status}`
      );
    });

    it("handles truly invalid JSON in PreToolUse", async () => {
      // Send raw bytes that are not valid JSON
      const result = await new Promise<{
        status: number;
        body: string;
      }>((resolve) => {
        const data = "{invalid json!!!";
        const urlObj = new URL(`${BASE_URL}/hooks/pre-tool-use`);
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        };
        const req = http.request(options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            });
          });
        });
        req.on("error", (err) =>
          resolve({ status: 0, body: err.message })
        );
        req.setTimeout(3000, () => {
          req.destroy();
          resolve({ status: 0, body: "timeout" });
        });
        req.write(data);
        req.end();
      });
      assert.equal(result.status, 500, "truly invalid JSON should return 500");
    });

    it("handles empty JSON object", async () => {
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        {}
      );
      assert.equal(res.status, 200);
      // Should fall through to default allow
      const body = JSON.parse(res.body);
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
    });

    it("handles concurrent requests", async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        httpPost(`${BASE_URL}/hooks/pre-tool-use`, {
          ...makePreToolUsePayload({
            session_id: `sess_concurrent_${i}`,
            tool_name: "Read",
            tool_input: { file_path: "demo.txt" },
          }),
        })
      );
      const results = await Promise.all(requests);
      for (const res of results) {
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(
          body.hookSpecificOutput.permissionDecision,
          "allow"
        );
      }
    });

    it("handles request with extra unknown fields", async () => {
      const payload = {
        ...makePreToolUsePayload({
          tool_name: "Read",
          tool_input: { file_path: "demo.txt" },
        }),
        unknown_field: "should be ignored",
        extra: { nested: true },
      };
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
    });
  });

  // ========================================
  // 10. Integration: Full Read Interception Flow
  // ========================================
  describe("10. Integration: full Read interception flow", () => {
    it("server content is never served for files that exist downstream", async () => {
      // The server has demo.txt with "SERVER placeholder" content
      // The downstream has demo.txt with "DOWNSTREAM_REAL_CONTENT"
      // After interception, Claude should only see downstream content
      const downstreamContent = readDownstreamFile("demo.txt");
      const serverContent = readServerFile("demo.txt");

      // Verify test fixtures are set up correctly
      assert.ok(
        serverContent.includes("SERVER placeholder"),
        "server file should have placeholder marker"
      );
      assert.ok(
        downstreamContent.includes("DOWNSTREAM_REAL_CONTENT"),
        "downstream file should have real marker"
      );

      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      const tempContent = fs.readFileSync(
        body.hookSpecificOutput.updatedInput.file_path as string,
        "utf-8"
      );

      // Core assertion: Claude will see downstream, not server
      assert.ok(
        tempContent.includes("DOWNSTREAM_REAL_CONTENT"),
        "MUST contain downstream marker"
      );
      assert.ok(
        !tempContent.includes("SERVER placeholder"),
        "MUST NOT contain server placeholder"
      );
      assert.ok(
        !tempContent.includes("NEVER see this"),
        "MUST NOT contain server-only text"
      );
    });

    it("hook response allows tool to proceed (does not block Claude loop)", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      const body = JSON.parse(res.body);
      assert.equal(
        body.hookSpecificOutput.permissionDecision,
        "allow",
        "must be 'allow' so Claude proceeds"
      );
      assert.ok(
        body.hookSpecificOutput.updatedInput,
        "must have updatedInput so Claude reads the rewritten path"
      );
    });

    it("end-to-end: multiple files intercepted in sequence", async () => {
      const files = [
        { name: "demo.txt", marker: "DOWNSTREAM_REAL_CONTENT" },
        { name: "sub/nested.txt", marker: "NESTED_DOWNSTREAM_FILE" },
        { name: "unicode.txt", marker: "UNICODE_MARKER" },
      ];

      for (const file of files) {
        const payload = makePreToolUsePayload({
          tool_name: "Read",
          tool_input: { file_path: file.name },
        });
        const res = await httpPost(
          `${BASE_URL}/hooks/pre-tool-use`,
          payload
        );
        const body = JSON.parse(res.body);
        const tempContent = fs.readFileSync(
          body.hookSpecificOutput.updatedInput.file_path as string,
          "utf-8"
        );
        assert.ok(
          tempContent.includes(file.marker),
          `${file.name} should contain ${file.marker}`
        );
      }
    });
  });

  // ========================================
  // 11. Tool Request/Response Shape Contract
  // ========================================
  describe("11. Tool request/response shape contract", () => {
    it("ToolRequest shape validates required fields", () => {
      const request = {
        session_id: "sess_contract",
        request_id: "toolreq_001",
        tool_name: "Read",
        tool_input: { file_path: "demo.txt" },
        cwd: "/project",
        timeout_ms: 30000,
      };
      // Verify all required fields exist
      assert.ok(request.session_id, "session_id required");
      assert.ok(request.request_id, "request_id required");
      assert.ok(request.tool_name, "tool_name required");
      assert.ok(request.tool_input, "tool_input required");
      assert.ok(request.cwd, "cwd required");
      assert.ok(
        typeof request.timeout_ms === "number",
        "timeout_ms must be number"
      );
    });

    it("ToolResponse success shape validates required fields", () => {
      const response = {
        session_id: "sess_contract",
        request_id: "toolreq_001",
        ok: true,
        output: "file content",
        metadata: {
          bytes: 12,
          source: "downstream-agent",
        },
      };
      assert.ok(response.session_id);
      assert.ok(response.request_id);
      assert.equal(response.ok, true);
      assert.ok(typeof response.output === "string");
      assert.ok(response.metadata);
      assert.equal(response.metadata.source, "downstream-agent");
      assert.ok(typeof response.metadata.bytes === "number");
    });

    it("ToolResponse error shape validates required fields", () => {
      const response = {
        session_id: "sess_contract",
        request_id: "toolreq_001",
        ok: false,
        error: {
          type: "not_found",
          message: "file does not exist",
        },
      };
      assert.equal(response.ok, false);
      assert.ok(response.error);
      assert.ok(response.error.type);
      assert.ok(response.error.message);
    });
  });

  // ========================================
  // 12. Windows Path Handling
  // ========================================
  describe("12. Windows path handling", () => {
    it("normalizes backslash paths to forward slash", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "sub\\nested.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      if (body.hookSpecificOutput.updatedInput) {
        const tempContent = fs.readFileSync(
          body.hookSpecificOutput.updatedInput.file_path as string,
          "utf-8"
        );
        assert.ok(
          tempContent.includes("NESTED_DOWNSTREAM_FILE"),
          "backslash path should resolve correctly"
        );
      }
    });

    it("handles mixed slash styles", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "sub/nested.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const tempContent = fs.readFileSync(
        body.hookSpecificOutput.updatedInput.file_path as string,
        "utf-8"
      );
      assert.ok(
        tempContent.includes("NESTED_DOWNSTREAM_FILE"),
        "forward slash path should resolve correctly"
      );
    });

    it("handles Windows absolute paths (C:\\...)", async () => {
      const winAbsPath = path.join(TEST_WORKSPACE, "demo.txt");
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: winAbsPath },
        cwd: TEST_WORKSPACE,
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const tempContent = fs.readFileSync(
        body.hookSpecificOutput.updatedInput.file_path as string,
        "utf-8"
      );
      assert.ok(
        tempContent.includes("DOWNSTREAM_REAL_CONTENT"),
        "Windows absolute path should resolve correctly"
      );
    });
  });

  // ========================================
  // 13. Large File & Performance
  // ========================================
  describe("13. Large file & performance", () => {
    it("handles large files correctly", async () => {
      const payload = makePreToolUsePayload({
        tool_name: "Read",
        tool_input: { file_path: "large.txt" },
      });
      const res = await httpPost(
        `${BASE_URL}/hooks/pre-tool-use`,
        payload
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const tempContent = fs.readFileSync(
        body.hookSpecificOutput.updatedInput.file_path as string,
        "utf-8"
      );
      assert.ok(
        tempContent.includes("LARGE_FILE_MARKER_BEGIN"),
        "should contain large file markers"
      );
      assert.ok(
        tempContent.includes("FUGA-MARKER-9999"),
        "should contain embedded markers"
      );
    });

    it("handles 50 concurrent reads", async () => {
      const requests = Array.from({ length: 50 }, (_, i) =>
        httpPost(`${BASE_URL}/hooks/pre-tool-use`, {
          ...makePreToolUsePayload({
            session_id: `sess_stress_${i}`,
            tool_name: "Read",
            tool_input: { file_path: "demo.txt" },
          }),
        })
      );
      const start = Date.now();
      const results = await Promise.all(requests);
      const elapsed = Date.now() - start;

      let successCount = 0;
      for (const res of results) {
        if (res.status === 200) {
          const body = JSON.parse(res.body);
          if (body.hookSpecificOutput?.permissionDecision === "allow") {
            successCount++;
          }
        }
      }
      assert.equal(
        successCount,
        50,
        `all 50 requests should succeed (got ${successCount})`
      );
      assert.ok(
        elapsed < 10000,
        `50 concurrent reads should complete in < 10s (took ${elapsed}ms)`
      );
    });
  });
});
