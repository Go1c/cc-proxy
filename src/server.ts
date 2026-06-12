import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { URL } from "url";
import { HookPayload, PreToolUseOutput } from "./types";
import { SessionManager, CapacityError, MAX_SESSIONS } from "./session-manager";

const PORT = parseInt(process.env.PORT || process.env.CC_PROXY_PORT || "3456", 10);
const DOWNSTREAM_ROOT = path.resolve(
  process.env.DOWNSTREAM_ROOT || path.join(__dirname, "..", "downstream-project")
);
const SESSION_CWD = path.resolve(
  process.env.CC_SESSION_CWD || path.join(__dirname, "..", "test-workspace")
);
const TEMP_DIR = path.join(os.tmpdir(), "cc-proxy");
const CLIENT_API_KEY = process.env.CC_PROXY_API_KEY || "";
const MESSAGES_BACKEND = process.env.CC_MESSAGES_BACKEND || "claude-code";
const ANTHROPIC_UPSTREAM_BASE_URL = (
  process.env.CC_ANTHROPIC_BASE_URL || "https://api.anthropic.com"
).replace(/\/+$/, "");
const ANTHROPIC_UPSTREAM_API_KEY = process.env.CC_ANTHROPIC_API_KEY || "";
const ANTHROPIC_UPSTREAM_VERSION =
  process.env.CC_ANTHROPIC_VERSION || "2023-06-01";
const ANTHROPIC_UPSTREAM_BETA = process.env.CC_ANTHROPIC_BETA || "";
const ANTHROPIC_UPSTREAM_AUTH_HEADER =
  process.env.CC_ANTHROPIC_AUTH_HEADER || "";

// Ensure temp dir exists
fs.mkdirSync(TEMP_DIR, { recursive: true });

const sessions = new SessionManager(SESSION_CWD);

// ---- Logging ----

function log(level: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const line = data
    ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data).slice(0, 500)}`
    : `[${ts}] [${level}] ${msg}`;
  console.error(line);
}

// ---- Downstream file reader ----

function readFromDownstream(
  relativePath: string
): { ok: true; content: string } | { ok: false; error: string } {
  const downstreamPath = path.resolve(DOWNSTREAM_ROOT, relativePath);
  // Security: ensure resolved path is within downstream root
  if (!downstreamPath.startsWith(path.resolve(DOWNSTREAM_ROOT))) {
    return { ok: false, error: `Path escape detected: ${relativePath}` };
  }
  try {
    const content = fs.readFileSync(downstreamPath, "utf-8");
    return { ok: true, content };
  } catch (err: any) {
    return { ok: false, error: `${relativePath} not found in downstream: ${err.message}` };
  }
}

// ---- Hook handlers ----

function handlePreToolUse(payload: HookPayload): PreToolUseOutput {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  const cwd = payload.cwd;

  log("INFO", `PreToolUse hook fired`, { tool: toolName, input: toolInput, cwd });

  if (toolName === "Read") {
    const filePath = (toolInput.file_path as string) || "";
    // Compute relative path from CWD
    let relativePath: string;
    if (path.isAbsolute(filePath)) {
      relativePath = path.relative(cwd, filePath);
    } else {
      relativePath = filePath;
    }
    // Normalize separators
    relativePath = relativePath.replace(/\\/g, "/");

    log("INFO", `Intercepted Read, resolving downstream`, {
      original: filePath,
      relative: relativePath,
    });

    const result = readFromDownstream(relativePath);
    if (result.ok) {
      // Write downstream content to temp file
      const tempFile = path.join(TEMP_DIR, `read_${randomUUID()}_${path.basename(filePath)}`);
      fs.writeFileSync(tempFile, result.content, "utf-8");
      log("INFO", `Wrote downstream content to temp file`, {
        tempFile,
        bytes: result.content.length,
      });

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { file_path: tempFile },
        },
      };
    } else {
      log("WARN", `Downstream read failed, allowing original Read`, { error: result.error });
      // Fall through to allow original read
    }
  }

  // Default: allow the tool
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

// ---- HTTP helpers ----

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function makeRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function headerValue(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function extractClientApiKey(req: http.IncomingMessage): string {
  const xApiKey = headerValue(req, "x-api-key");
  if (xApiKey) return xApiKey;

  const authorization = headerValue(req, "authorization");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function sendAnthropicError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {}
): void {
  sendJson(res, status, { type: "error", error: { type, message } }, headers);
}

function requireClientAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  responseShape: "anthropic" | "plain",
  headers: Record<string, string> = {}
): boolean {
  if (!CLIENT_API_KEY) return true;
  if (extractClientApiKey(req) === CLIENT_API_KEY) return true;

  if (responseShape === "anthropic") {
    sendAnthropicError(
      res,
      401,
      "authentication_error",
      "Missing or invalid API key",
      headers
    );
  } else {
    sendJson(res, 401, { error: "unauthorized" });
  }
  return false;
}

function normalizedMessagesBackend(): "claude-code" | "anthropic" | "hybrid" {
  if (MESSAGES_BACKEND === "anthropic" || MESSAGES_BACKEND === "hybrid") {
    return MESSAGES_BACKEND;
  }
  return "claude-code";
}

function hasNativeAnthropicContent(content: any): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    return block.type === "image" || block.type === "document";
  });
}

function bodyNeedsNativeAnthropicApi(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.thinking != null) return true;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (body.tool_choice != null) return true;
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((message: any) =>
    hasNativeAnthropicContent(message?.content)
  );
}

function shouldUseAnthropicUpstream(body: any): boolean {
  const backend = normalizedMessagesBackend();
  if (backend === "anthropic") return true;
  if (backend === "hybrid") return bodyNeedsNativeAnthropicApi(body);
  return false;
}

function upstreamAuthConfig():
  | {
      ok: true;
      key: string;
      mode: "x-api-key" | "authorization-bearer";
      oauthBeta: boolean;
    }
  | { ok: false; message: string } {
  if (ANTHROPIC_UPSTREAM_API_KEY) {
    const mode =
      ANTHROPIC_UPSTREAM_AUTH_HEADER === "authorization-bearer"
        ? "authorization-bearer"
        : "x-api-key";
    return { ok: true, key: ANTHROPIC_UPSTREAM_API_KEY, mode, oauthBeta: false };
  }

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
  if (oauthToken) {
    return {
      ok: true,
      key: oauthToken,
      mode: "authorization-bearer",
      oauthBeta: true,
    };
  }

  return {
    ok: false,
    message:
      "CC_MESSAGES_BACKEND requires CC_ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for upstream Anthropic requests",
  };
}

function contentBlockToText(block: any): string {
  if (!block || typeof block !== "object") return String(block ?? "");
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "tool_result") {
    return `[tool_result ${block.tool_use_id || ""}]\n${contentToText(block.content)}`;
  }
  if (block.type === "tool_use") {
    return `[tool_use ${block.name || ""}]\n${JSON.stringify(block.input ?? {})}`;
  }
  return `[${block.type || "content"}]\n${JSON.stringify(block)}`;
}

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentBlockToText).join("\n");
  if (content == null) return "";
  return JSON.stringify(content);
}

function buildPromptFromAnthropicMessages(body: any):
  | { ok: true; prompt: string; model: string }
  | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  if (typeof body.model !== "string" || !body.model) {
    return { ok: false, message: "Missing required string field 'model'" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: "Missing non-empty 'messages' array" };
  }

  const parts: string[] = [];
  if (body.system) {
    parts.push(`[system]\n${contentToText(body.system)}`);
  }
  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      return { ok: false, message: "Each message must be an object" };
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return { ok: false, message: "Message role must be 'user' or 'assistant'" };
    }
    parts.push(`[${message.role}]\n${contentToText(message.content)}`);
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    parts.push(
      `[client_tools]\n${JSON.stringify(body.tools)}\n` +
        "If a tool result is required, explain the requested tool call in text. " +
        "This proxy executes Claude Code tools in the workspace, not client-supplied function tools."
    );
  }

  return { ok: true, prompt: parts.join("\n\n"), model: body.model };
}

function makeAnthropicMessage(model: string, result: any): any {
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: result.result }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
      total_cost_usd: result.usage.total_cost_usd,
    },
  };
}

async function forwardAnthropicMessagesToUpstream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyText: string,
  requestId: string
): Promise<void> {
  const auth = upstreamAuthConfig();
  if (!auth.ok) {
    sendAnthropicError(res, 503, "api_error", auth.message, {
      "request-id": requestId,
    });
    return;
  }

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version":
      headerValue(req, "anthropic-version") || ANTHROPIC_UPSTREAM_VERSION,
    "user-agent": "cc-proxy/0.1.0",
  };

  const clientBeta = headerValue(req, "anthropic-beta");
  const oauthBeta = auth.oauthBeta ? "oauth-2025-04-20" : "";
  const beta = clientBeta || ANTHROPIC_UPSTREAM_BETA || oauthBeta;
  if (beta) {
    upstreamHeaders["anthropic-beta"] = beta;
  }

  if (auth.mode === "authorization-bearer") {
    upstreamHeaders.authorization = `Bearer ${auth.key}`;
  } else {
    upstreamHeaders["x-api-key"] = auth.key;
  }

  const upstreamUrl = `${ANTHROPIC_UPSTREAM_BASE_URL}/v1/messages`;
  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: bodyText,
  });
  const upstreamBody = await upstreamRes.text();

  const responseHeaders: Record<string, string> = {
    "request-id": upstreamRes.headers.get("request-id") || requestId,
    "Content-Type":
      upstreamRes.headers.get("content-type") ||
      (upstreamBody.trim().startsWith("event:")
        ? "text/event-stream; charset=utf-8"
        : "application/json"),
  };

  const copyHeaders = [
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-input-tokens-limit",
    "anthropic-ratelimit-input-tokens-remaining",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-limit",
    "anthropic-ratelimit-output-tokens-remaining",
    "anthropic-ratelimit-output-tokens-reset",
  ];
  for (const header of copyHeaders) {
    const value = upstreamRes.headers.get(header);
    if (value) responseHeaders[header] = value;
  }

  res.writeHead(upstreamRes.status, responseHeaders);
  res.end(upstreamBody);
}

function sendSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStream(
  res: http.ServerResponse,
  message: any,
  headers: Record<string, string>
): void {
  res.writeHead(200, {
    ...headers,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  sendSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: message.usage.cache_read_input_tokens,
        total_cost_usd: message.usage.total_cost_usd,
      },
    },
  });
  sendSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sendSseEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: message.content[0].text },
  });
  sendSseEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  sendSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      output_tokens: message.usage.output_tokens,
      total_cost_usd: message.usage.total_cost_usd,
    },
  });
  sendSseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const requestId = makeRequestId();
  if (!requireClientAuth(req, res, "anthropic", { "request-id": requestId })) return;

  const bodyText = await readBody(req);
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body", {
      "request-id": requestId,
    });
    return;
  }

  if (shouldUseAnthropicUpstream(body)) {
    await forwardAnthropicMessagesToUpstream(req, res, bodyText, requestId);
    return;
  }

  const promptResult = buildPromptFromAnthropicMessages(body);
  if (!promptResult.ok) {
    sendAnthropicError(res, 400, "invalid_request_error", promptResult.message, {
      "request-id": requestId,
    });
    return;
  }

  const requestedSessionId = headerValue(req, "x-cc-session-id");
  const keepSession = headerValue(req, "x-cc-keep-session").toLowerCase() === "true";
  let sessionId = requestedSessionId;
  let closeAfterTurn = false;

  try {
    if (sessionId) {
      if (!sessions.get(sessionId)) {
        sendAnthropicError(
          res,
          404,
          "invalid_request_error",
          `Unknown x-cc-session-id: ${sessionId}`,
          { "request-id": requestId }
        );
        return;
      }
    } else {
      const info = sessions.create();
      sessionId = info.id;
      closeAfterTurn = !keepSession;
    }

    const result = await sessions.turn(sessionId, promptResult.prompt);
    if (result.is_error) {
      sendAnthropicError(
        res,
        502,
        "api_error",
        result.result || "Claude Code turn failed",
        { "request-id": requestId }
      );
      return;
    }

    const responseHeaders: Record<string, string> = {
      "request-id": requestId,
      "x-cc-cli-session-id": result.session_id,
    };
    if (!closeAfterTurn) responseHeaders["x-cc-session-id"] = sessionId;

    const message = makeAnthropicMessage(promptResult.model, result);
    if (body.stream === true) {
      sendAnthropicStream(res, message, responseHeaders);
    } else {
      sendJson(res, 200, message, responseHeaders);
    }
  } catch (err: any) {
    if (err instanceof CapacityError) {
      sendAnthropicError(res, 503, "api_error", err.message, {
        "request-id": requestId,
      });
    } else {
      log("ERROR", "Anthropic messages request failed", { error: err.message });
      sendAnthropicError(res, 500, "api_error", err.message || "request failed", {
        "request-id": requestId,
      });
    }
  } finally {
    if (closeAfterTurn && sessionId) sessions.close(sessionId);
  }
}

// ---- Session route handlers ----

async function handleCreateSession(res: http.ServerResponse): Promise<void> {
  try {
    const info = sessions.create();
    log("INFO", "Session created", { id: info.id, total: sessions.size });
    sendJson(res, 201, info);
  } catch (err) {
    if (err instanceof CapacityError) {
      log("WARN", "Session capacity reached", { limit: err.limit });
      sendJson(res, 503, { error: err.message, limit: err.limit });
    } else {
      throw err;
    }
  }
}

async function handleTurn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  const body = await readBody(req);
  let prompt: string;
  try {
    prompt = JSON.parse(body).prompt;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof prompt !== "string" || !prompt) {
    sendJson(res, 400, { error: "missing 'prompt' string" });
    return;
  }
  try {
    const result = await sessions.turn(id, prompt);
    sendJson(res, 200, result);
  } catch (err: any) {
    const msg = err.message || "turn failed";
    if (msg === "session not found") {
      sendJson(res, 404, { error: msg });
    } else if (msg === "session is busy with another turn") {
      sendJson(res, 409, { error: msg });
    } else {
      log("ERROR", "Turn failed", { id, error: msg });
      sendJson(res, 500, { error: msg });
    }
  }
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // Health check
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        downstream_root: DOWNSTREAM_ROOT,
        sessions: sessions.size,
        max_sessions: MAX_SESSIONS,
      });
      return;
    }

    // Anthropic-compatible Messages API
    if (req.method === "POST" && pathname === "/v1/messages") {
      await handleAnthropicMessages(req, res);
      return;
    }

    // ---- Session API ----
    if (pathname === "/sessions" || pathname.startsWith("/sessions/")) {
      if (!requireClientAuth(req, res, "plain")) return;
    }
    if (req.method === "POST" && pathname === "/sessions") {
      await handleCreateSession(res);
      return;
    }
    if (req.method === "GET" && pathname === "/sessions") {
      sendJson(res, 200, { sessions: sessions.list() });
      return;
    }
    const turnMatch = pathname.match(/^\/sessions\/([^/]+)\/turn$/);
    if (req.method === "POST" && turnMatch) {
      await handleTurn(req, res, decodeURIComponent(turnMatch[1]));
      return;
    }
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      if (req.method === "GET") {
        const info = sessions.get(id);
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: "session not found" });
        return;
      }
      if (req.method === "DELETE") {
        const ok = sessions.close(id);
        log("INFO", "Session closed", { id, found: ok });
        sendJson(res, ok ? 200 : 404, { closed: ok });
        return;
      }
    }

    // PreToolUse hook
    if (req.method === "POST" && pathname === "/hooks/pre-tool-use") {
      const body = await readBody(req);
      const payload: HookPayload = JSON.parse(body);
      log("INFO", "Hook payload received", {
        event: payload.hook_event_name,
        tool: payload.tool_name,
        session: payload.session_id,
      });
      sendJson(res, 200, handlePreToolUse(payload));
      return;
    }

    // PostToolUse hook (future use)
    if (req.method === "POST" && pathname === "/hooks/post-tool-use") {
      const body = await readBody(req);
      const payload: HookPayload = JSON.parse(body);
      log("INFO", "PostToolUse hook received", {
        tool: payload.tool_name,
        session: payload.session_id,
      });
      sendJson(res, 200, {});
      return;
    }

    // 404
    sendJson(res, 404, { error: "not found" });
  } catch (err: any) {
    log("ERROR", `Request handler error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
});

function shutdown() {
  log("INFO", "Shutting down, stopping all sessions");
  sessions.shutdown();
  server.close(() => process.exit(0));
  // Force-exit if close hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  log("INFO", `CC-Proxy server listening on port ${PORT}`);
  log("INFO", `Downstream project root: ${DOWNSTREAM_ROOT}`);
  log("INFO", `Session workspace: ${SESSION_CWD}`);
  log("INFO", `Max sessions: ${MAX_SESSIONS}`);
  log("INFO", `Temp directory: ${TEMP_DIR}`);
});

export { server, PORT, DOWNSTREAM_ROOT, sessions };
