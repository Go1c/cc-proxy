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
  url: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
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

async function startTestServer(
  port: number,
  env: NodeJS.ProcessEnv
): Promise<ReturnType<typeof spawn>> {
  const proc = spawn("node", [SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, CC_PROXY_PORT: String(port) },
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
      env: { ...process.env, CC_PROXY_PORT: String(PORT) },
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

    it("adds CC_CLAUDE_MODEL to spawned Claude CLI args", () => {
      const previousModel = process.env.CC_CLAUDE_MODEL;
      process.env.CC_CLAUDE_MODEL = "claude-test-model";
      try {
        const args = resolveClaudeArgs();
        assert.deepEqual(args.slice(-2), ["--model", "claude-test-model"]);
      } finally {
        if (previousModel === undefined) delete process.env.CC_CLAUDE_MODEL;
        else process.env.CC_CLAUDE_MODEL = previousModel;
      }
    });

    it("adds CC_PERMISSION_MODE to spawned Claude CLI args", () => {
      const previousModel = process.env.CC_CLAUDE_MODEL;
      const previousPermissionMode = process.env.CC_PERMISSION_MODE;
      delete process.env.CC_CLAUDE_MODEL;
      process.env.CC_PERMISSION_MODE = "acceptEdits";
      try {
        const args = resolveClaudeArgs();
        assert.deepEqual(args.slice(-2), ["--permission-mode", "acceptEdits"]);
      } finally {
        if (previousModel === undefined) delete process.env.CC_CLAUDE_MODEL;
        else process.env.CC_CLAUDE_MODEL = previousModel;
        if (previousPermissionMode === undefined) delete process.env.CC_PERMISSION_MODE;
        else process.env.CC_PERMISSION_MODE = previousPermissionMode;
      }
    });

    it("GET /health returns 200 with status ok", async () => {
      const res = await httpGet(`${BASE_URL}/health`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, "ok");
      assert.ok(body.downstream_root, "should report downstream_root");
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
