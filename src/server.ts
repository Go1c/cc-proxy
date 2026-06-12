import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { URL } from "url";
import {
  ClaudeContentBlock,
  ClaudeStreamMessage,
  HookPayload,
  PreToolUseOutput,
  TurnResult,
} from "./types";
import { SessionManager, CapacityError, MAX_SESSIONS } from "./session-manager";
import {
  ClientToolBridge,
  ClientToolSpec,
  ClientToolTurn,
  extractToolResults,
} from "./client-tool-bridge";

const PORT = parseInt(process.env.PORT || process.env.CC_PROXY_PORT || "3456", 10);
const DOWNSTREAM_ROOT = path.resolve(
  process.env.DOWNSTREAM_ROOT || path.join(__dirname, "..", "downstream-project")
);
const SESSION_CWD = path.resolve(
  process.env.CC_SESSION_CWD || path.join(__dirname, "..", "test-workspace")
);
const TEMP_DIR = path.join(os.tmpdir(), "cc-proxy");
const CLIENT_API_KEY = process.env.CC_PROXY_API_KEY || "";

// Ensure temp dir exists
fs.mkdirSync(TEMP_DIR, { recursive: true });

const sessions = new SessionManager(SESSION_CWD);

interface PendingClientToolTurn {
  turn: ClientToolTurn;
  finalPromise: Promise<TurnResult>;
  sessionId: string;
  closeAfterFinal: boolean;
}

const clientToolBridges = new Map<string, ClientToolBridge>();
const pendingClientToolTurns = new Map<string, PendingClientToolTurn>();

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

function makeAnthropicRequestId(): string {
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
  requestId = makeAnthropicRequestId()
): void {
  sendJson(
    res,
    status,
    { type: "error", error: { type, message }, request_id: requestId },
    { "request-id": requestId }
  );
}

function requireClientAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  responseShape: "anthropic" | "plain",
  requestId?: string
): boolean {
  if (!CLIENT_API_KEY) return true;
  if (extractClientApiKey(req) === CLIENT_API_KEY) return true;

  if (responseShape === "anthropic") {
    sendAnthropicError(
      res,
      401,
      "authentication_error",
      "Missing or invalid API key",
      requestId
    );
  } else {
    sendJson(res, 401, { error: "unauthorized" });
  }
  return false;
}

function normalizeClientTools(tools: any): ClientToolSpec[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool === "object")
    .map((tool) => ({
      name: String(tool.name || ""),
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      input_schema: tool.input_schema || { type: "object" },
    }))
    .filter((tool) => tool.name);
}

function makeClientToolMcpConfig(bridge: ClientToolBridge): string {
  return JSON.stringify({
    mcpServers: {
      cc_client_tools: {
        type: "stdio",
        command: process.execPath,
        args: [path.join(__dirname, "client-tool-mcp-server.js")],
        env: {
          CC_PROXY_CLIENT_TOOL_BRIDGE_URL: `http://127.0.0.1:${PORT}/internal/tool-bridge/${bridge.id}`,
          CC_PROXY_CLIENT_TOOL_BRIDGE_TOKEN: bridge.token,
        },
      },
    },
  });
}

function makeClientToolAllowedTools(tools: ClientToolSpec[]): string[] {
  return tools.map((tool) => `mcp__cc_client_tools__${tool.name}`);
}

function findPendingClientToolTurn(toolUseIds: string[]): PendingClientToolTurn | null {
  for (const id of toolUseIds) {
    const pending = pendingClientToolTurns.get(id);
    if (pending) return pending;
  }
  return null;
}

function registerPendingClientToolTurn(pending: PendingClientToolTurn): void {
  for (const id of pending.turn.toolUseIds) {
    pendingClientToolTurns.set(id, pending);
  }
}

function cleanupPendingClientToolTurn(pending: PendingClientToolTurn): void {
  for (const id of pending.turn.toolUseIds) {
    if (pendingClientToolTurns.get(id) === pending) {
      pendingClientToolTurns.delete(id);
    }
  }
  pending.turn.bridge.dispose();
  clientToolBridges.delete(pending.turn.bridge.id);
  if (pending.closeAfterFinal) {
    sessions.close(pending.sessionId);
  }
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

function contentToBlocks(content: any): ClaudeContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === "object" && typeof block.type === "string") {
        return block as ClaudeContentBlock;
      }
      return { type: "text", text: String(block ?? "") };
    });
  }
  if (content == null) return [];
  return [{ type: "text", text: JSON.stringify(content) }];
}

function makeClaudeStreamMessage(message: any): ClaudeStreamMessage {
  return {
    type: message.role,
    message: {
      role: message.role,
      content: contentToBlocks(message.content),
    },
    parent_tool_use_id: null,
  };
}

function addContextToFirstUserMessage(
  messages: ClaudeStreamMessage[],
  context: string
): ClaudeStreamMessage[] {
  if (!context) return messages;
  const contextBlock: ClaudeContentBlock = { type: "text", text: context };
  const firstUser = messages.find((message) => message.type === "user");
  if (firstUser) {
    firstUser.message.content = [contextBlock, ...firstUser.message.content];
    return messages;
  }
  return [
    {
      type: "user",
      message: { role: "user", content: [contextBlock] },
      parent_tool_use_id: null,
    },
    ...messages,
  ];
}

function buildTurnInputFromAnthropicMessages(body: any):
  | {
      ok: true;
      messages: ClaudeStreamMessage[];
      model: string;
      effort?: string;
      tools: ClientToolSpec[];
    }
  | { ok: false; status?: number; type?: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  if (typeof body.model !== "string" || !body.model) {
    return { ok: false, message: "Missing required string field 'model'" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: "Missing non-empty 'messages' array" };
  }
  const tools = normalizeClientTools(body.tools);

  const contextParts: string[] = [];
  if (body.system) {
    contextParts.push(`[system]\n${contentToText(body.system)}`);
  }
  const messages: ClaudeStreamMessage[] = [];
  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      return { ok: false, message: "Each message must be an object" };
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return { ok: false, message: "Message role must be 'user' or 'assistant'" };
    }
    messages.push(makeClaudeStreamMessage(message));
  }

  return {
    ok: true,
    messages: addContextToFirstUserMessage(messages, contextParts.join("\n\n")),
    model: body.model,
    effort: thinkingToClaudeEffort(body.thinking),
    tools,
  };
}

function thinkingToClaudeEffort(thinking: any): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type !== "enabled") return undefined;

  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return "medium";
  if (budget <= 4_096) return "low";
  if (budget <= 16_000) return "medium";
  if (budget <= 32_000) return "high";
  if (budget <= 64_000) return "xhigh";
  return "max";
}

function makeAnthropicMessage(model: string, result: any): any {
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content:
      Array.isArray(result.content) && result.content.length > 0
        ? result.content
        : [{ type: "text", text: result.result }],
    stop_reason: result.stop_reason || "end_turn",
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

function sendSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicStreamHead(
  res: http.ServerResponse,
  headers: Record<string, string>
): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    ...headers,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sendAnthropicStream(
  res: http.ServerResponse,
  message: any,
  headers: Record<string, string>
): void {
  writeAnthropicStreamHead(res, headers);
  sendBufferedAnthropicStreamEvents(res, message);
  res.end();
}

function sendBufferedAnthropicStreamEvents(
  res: http.ServerResponse,
  message: any
): void {
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
  message.content.forEach((block: any, index: number) => {
    sendSseContentBlock(res, index, block);
  });
  sendSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null },
    usage: {
      output_tokens: message.usage.output_tokens,
      total_cost_usd: message.usage.total_cost_usd,
    },
  });
  sendSseEvent(res, "message_stop", { type: "message_stop" });
}

function sendSseContentBlock(
  res: http.ServerResponse,
  index: number,
  block: any
): void {
  if (block?.type === "text") {
    sendSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    sendSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: block.text || "" },
    });
    sendSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
    return;
  }

  if (block?.type === "thinking") {
    sendSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });
    if (block.thinking) {
      sendSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      });
    }
    if (block.signature) {
      sendSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    }
    sendSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
    return;
  }

  if (block?.type === "tool_use") {
    sendSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    });
    sendSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input ?? {}),
      },
    });
    sendSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
    return;
  }

  sendSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: block || { type: "text", text: "" },
  });
  sendSseEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

async function handleClientToolBridgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): Promise<void> {
  const match = pathname.match(/^\/internal\/tool-bridge\/([^/]+)\/(tools|call)$/);
  if (!match) {
    sendJson(res, 404, { error: "tool bridge route not found" });
    return;
  }

  const bridge = clientToolBridges.get(match[1]);
  const authorization = headerValue(req, "authorization");
  if (!bridge || authorization !== `Bearer ${bridge.token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && match[2] === "tools") {
    sendJson(res, 200, bridge.tools);
    return;
  }

  if (req.method === "POST" && match[2] === "call") {
    const bodyText = await readBody(req);
    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    try {
      const result = await bridge.waitForCall(body.name, body.input || {});
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, 504, {
        content: [{ type: "text", text: err.message || "tool call failed" }],
        isError: true,
      });
    }
    return;
  }

  sendJson(res, 405, { error: "method not allowed" });
}

async function handleClientToolResultTurn(
  body: any,
  res: http.ServerResponse,
  requestId: string,
  pending: PendingClientToolTurn,
  toolResults: ReturnType<typeof extractToolResults>
): Promise<void> {
  const missing = [...pending.turn.toolUseIds].filter((id) => {
    return !toolResults.some((result) => result.tool_use_id === id);
  });
  if (missing.length > 0) {
    sendAnthropicError(
      res,
      400,
      "invalid_request_error",
      `Missing tool_result for tool_use_id: ${missing.join(", ")}`,
      requestId
    );
    return;
  }

  const responseHeaders: Record<string, string> = { "request-id": requestId };
  let streamedLiveEvents = false;
  if (body.stream === true) {
    pending.turn.streamSink = (event, raw) => {
      streamedLiveEvents = true;
      if (raw?.session_id) {
        responseHeaders["x-cc-cli-session-id"] = raw.session_id;
      }
      writeAnthropicStreamHead(res, responseHeaders);
      sendSseEvent(res, event.type || "message", event);
    };
  }

  for (const result of toolResults) {
    if (pending.turn.toolUseIds.has(result.tool_use_id)) {
      pending.turn.bridge.deliverToolResult(result);
    }
  }

  try {
    const result = await pending.finalPromise;
    responseHeaders["x-cc-cli-session-id"] = result.session_id;
    if (result.is_error) {
      if (res.headersSent) {
        sendSseEvent(res, "error", {
          type: "error",
          error: {
            type: "api_error",
            message: result.result || "Claude Code turn failed",
          },
        });
        res.end();
      } else {
        sendAnthropicError(
          res,
          502,
          "api_error",
          result.result || "Claude Code turn failed",
          requestId
        );
      }
      return;
    }

    const message = makeAnthropicMessage(pending.turn.model, result);
    if (body.stream === true) {
      writeAnthropicStreamHead(res, responseHeaders);
      if (!streamedLiveEvents) {
        sendBufferedAnthropicStreamEvents(res, message);
      }
      res.end();
    } else {
      sendJson(res, 200, message, responseHeaders);
    }
  } finally {
    pending.turn.streamSink = undefined;
    cleanupPendingClientToolTurn(pending);
  }
}

async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const requestId = makeAnthropicRequestId();
  if (!requireClientAuth(req, res, "anthropic", requestId)) return;

  const bodyText = await readBody(req);
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body", requestId);
    return;
  }

  const toolResults = extractToolResults(body);
  if (toolResults.length > 0) {
    const pending = findPendingClientToolTurn(
      toolResults.map((result) => result.tool_use_id)
    );
    if (pending) {
      await handleClientToolResultTurn(body, res, requestId, pending, toolResults);
      return;
    }
  }

  const turnInputResult = buildTurnInputFromAnthropicMessages(body);
  if (!turnInputResult.ok) {
    sendAnthropicError(
      res,
      turnInputResult.status || 400,
      turnInputResult.type || "invalid_request_error",
      turnInputResult.message,
      requestId
    );
    return;
  }

  const requestedSessionId = headerValue(req, "x-cc-session-id");
  const keepSession = headerValue(req, "x-cc-keep-session").toLowerCase() === "true";
  let sessionId = requestedSessionId;
  let closeAfterTurn = false;
  let closeInFinally = true;
  let bridge: ClientToolBridge | null = null;

  try {
    if (sessionId) {
      if (!sessions.get(sessionId)) {
        sendAnthropicError(
          res,
          404,
          "invalid_request_error",
          `Unknown x-cc-session-id: ${sessionId}`,
          requestId
        );
        return;
      }
      if (turnInputResult.tools.length > 0) {
        sendAnthropicError(
          res,
          400,
          "invalid_request_error",
          "client-supplied tools require a new Claude Code session so the proxy can attach a per-request MCP bridge",
          requestId
        );
        return;
      }
    } else {
      if (turnInputResult.tools.length > 0) {
        bridge = new ClientToolBridge(turnInputResult.tools);
        clientToolBridges.set(bridge.id, bridge);
      }
      const info = sessions.create({
        model: turnInputResult.model,
        effort: turnInputResult.effort,
        ...(bridge
          ? {
              mcpConfig: makeClientToolMcpConfig(bridge),
              strictMcpConfig: true,
              allowedTools: makeClientToolAllowedTools(turnInputResult.tools),
            }
          : {}),
      });
      sessionId = info.id;
      closeAfterTurn = !!bridge || !keepSession;
    }

    const responseHeaders: Record<string, string> = { "request-id": requestId };
    if (!closeAfterTurn) responseHeaders["x-cc-session-id"] = sessionId;

    let streamedLiveEvents = false;
    const clientToolTurn = bridge
      ? new ClientToolTurn(
          bridge,
          turnInputResult.model,
          sessionId,
          closeAfterTurn
        )
      : null;
    if (clientToolTurn && body.stream === true) {
      clientToolTurn.streamSink = (event, raw) => {
        streamedLiveEvents = true;
        if (raw?.session_id) {
          responseHeaders["x-cc-cli-session-id"] = raw.session_id;
        }
        writeAnthropicStreamHead(res, responseHeaders);
        sendSseEvent(res, event.type || "message", event);
      };
    }
    const finalPromise = sessions.turn(
      sessionId,
      turnInputResult.messages,
      clientToolTurn
        ? {
            onStreamEvent: (event, raw) => {
              if (raw?.session_id) {
                responseHeaders["x-cc-cli-session-id"] = raw.session_id;
              }
              clientToolTurn.handleStreamEvent(event, raw);
            },
          }
        : body.stream === true
          ? {
              onStreamEvent: (event, raw) => {
                streamedLiveEvents = true;
                if (raw?.session_id) {
                  responseHeaders["x-cc-cli-session-id"] = raw.session_id;
                }
                writeAnthropicStreamHead(res, responseHeaders);
                sendSseEvent(res, event.type || "message", event);
              },
            }
          : {}
    );
    finalPromise.catch(() => {
      /* handled by request flow or follow-up tool_result flow */
    });

    if (clientToolTurn) {
      const firstOutcome = await Promise.race([
        finalPromise.then((result) => ({ type: "final" as const, result })),
        clientToolTurn.initialReady.then(() => ({ type: "tool_use" as const })),
      ]);

      if (firstOutcome.type === "tool_use") {
        const pending: PendingClientToolTurn = {
          turn: clientToolTurn,
          finalPromise,
          sessionId,
          closeAfterFinal: closeAfterTurn,
        };
        registerPendingClientToolTurn(pending);
        closeInFinally = false;

        if (body.stream === true) {
          writeAnthropicStreamHead(res, responseHeaders);
          if (!streamedLiveEvents) {
            for (const event of clientToolTurn.bufferedEvents) {
              sendSseEvent(res, event.type || "message", event);
            }
          }
          res.end();
          clientToolTurn.streamSink = undefined;
        } else {
          sendJson(res, 200, clientToolTurn.makeInitialMessage(), responseHeaders);
        }
        return;
      }
    }

    const result = await finalPromise;
    responseHeaders["x-cc-cli-session-id"] = result.session_id;
    if (result.is_error) {
      if (res.headersSent) {
        sendSseEvent(res, "error", {
          type: "error",
          error: {
            type: "api_error",
            message: result.result || "Claude Code turn failed",
          },
        });
        res.end();
      } else {
        sendAnthropicError(
          res,
          502,
          "api_error",
          result.result || "Claude Code turn failed",
          requestId
        );
      }
      return;
    }

    const message = makeAnthropicMessage(turnInputResult.model, result);
    if (body.stream === true) {
      writeAnthropicStreamHead(res, responseHeaders);
      if (!streamedLiveEvents) {
        sendBufferedAnthropicStreamEvents(res, message);
      }
      res.end();
    } else {
      sendJson(res, 200, message, responseHeaders);
    }
  } catch (err: any) {
    if (err instanceof CapacityError) {
      sendAnthropicError(res, 503, "api_error", err.message, requestId);
    } else if (res.headersSent) {
      log("ERROR", "Anthropic messages request failed after stream started", {
        error: err.message,
      });
      sendSseEvent(res, "error", {
        type: "error",
        error: { type: "api_error", message: err.message || "request failed" },
      });
      res.end();
    } else {
      log("ERROR", "Anthropic messages request failed", { error: err.message });
      sendAnthropicError(res, 500, "api_error", err.message || "request failed", requestId);
    }
  } finally {
    if (closeInFinally && closeAfterTurn && sessionId) sessions.close(sessionId);
    if (closeInFinally && bridge) {
      bridge.dispose();
      clientToolBridges.delete(bridge.id);
    }
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

    if (pathname.startsWith("/internal/tool-bridge/")) {
      await handleClientToolBridgeRequest(req, res, pathname);
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
