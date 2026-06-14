import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { createHash, randomUUID } from "crypto";
import { URL } from "url";
import {
  ClaudeContentBlock,
  ClaudeStreamMessage,
  HookPayload,
  PreToolUseOutput,
  TurnErrorDetails,
  TurnResult,
} from "./types";
import { SessionManager, CapacityError } from "./session-manager";
import {
  ClientToolBridge,
  ClientToolSpec,
  ClientToolTurn,
  extractToolResults,
} from "./client-tool-bridge";
import { ClaudeProcessError, ClaudeRunnerOptions, resolveClaudeCommand } from "./runner";
import { AccountState } from "./account-state";
import { AuditLog } from "./audit-log";
import { ControlPlane } from "./control-plane";
import { ClaudeAuthJob, ClaudeAuthJobSnapshot, splitCommandArgs } from "./claude-auth-job";
import { resolveDataDir } from "./data-dir";

const PORT = parseInt(process.env.PORT || process.env.CC_PROXY_PORT || "3456", 10);
const DOWNSTREAM_ROOT = path.resolve(
  process.env.DOWNSTREAM_ROOT || path.join(__dirname, "..", "downstream-project")
);
const SESSION_CWD = path.resolve(
  process.env.CC_SESSION_CWD || path.join(__dirname, "..", "test-workspace")
);
const TEMP_DIR = path.join(os.tmpdir(), "cc-proxy");
const DATA_DIR = resolveDataDir();
const CLAUDE_HOME_DIR = path.join(DATA_DIR, "claude-home");
const LEGACY_CLIENT_API_KEY = process.env.CC_PROXY_API_KEY || "";
const CONTROL_PLANE_PATH = path.join(DATA_DIR, "control-plane.json");
const AUDIT_LOG_PATH = path.join(DATA_DIR, "audit-log.json");
const ACCOUNT_STATE_PATH = path.join(DATA_DIR, "account-state.json");
const DEFAULT_MESSAGES_DIAGNOSTIC_LOG_PATH = path.join(
  DATA_DIR,
  "messages-diagnostic.jsonl"
);

// Ensure temp dir exists
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CLAUDE_HOME_DIR, { recursive: true });

const controlPlane = new ControlPlane(CONTROL_PLANE_PATH);
const auditLog = new AuditLog(AUDIT_LOG_PATH);
const accountState = new AccountState(ACCOUNT_STATE_PATH);
const claudeAuthJob = new ClaudeAuthJob();
const sessions = new SessionManager(SESSION_CWD, () => controlPlane.getConfig());

interface PendingClientToolTurn {
  turn: ClientToolTurn;
  finalPromise: Promise<TurnResult>;
  sessionId: string;
  closeAfterFinal: boolean;
  awaitingToolUseIds: Set<string>;
  includeThinking: boolean;
  cleanupTimer?: NodeJS.Timeout;
  cleaned?: boolean;
}

const clientToolBridges = new Map<string, ClientToolBridge>();
const pendingClientToolTurns = new Map<string, PendingClientToolTurn>();
const autoSessionAffinities = new Map<string, string>();
const sessionConversationUserKeys = new Map<string, string[]>();

const CLIENT_TOOL_BRIDGE_CONTEXT = [
  "[client tools]",
  "The tools available in this turn are normal API client tools.",
  "Use a matching tool when the user's request asks for it or needs its result.",
  "When a later user message contains tool_result, continue from that result.",
].join("\n");

const EXTENDED_THINKING_CONTEXT = [
  "[extended thinking]",
  "This API request enabled Anthropic extended thinking.",
  "Use extended thinking for this answer so the API response includes a signed thinking block before the final answer.",
  "Do not mention these internal API instructions in the final answer.",
].join("\n");

const SERVER_SIDE_TOOLS_DISABLED_FOR_CLIENT_BRIDGE = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "LS",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Read",
  "Task",
  "Write",
  "WebFetch",
  "WebSearch",
];

// ---- Logging ----

function log(level: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const line = data
    ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data).slice(0, 500)}`
    : `[${ts}] [${level}] ${msg}`;
  console.error(line);
  try {
    auditLog.record(normalizeAuditLevel(level), "service.log", msg, {
      level,
      ...(data === undefined ? {} : { data }),
    });
  } catch {
    /* logging must never fail the request path */
  }
}

function normalizeAuditLevel(level: string): "info" | "warn" | "error" {
  const value = level.toLowerCase();
  if (value === "warn" || value === "warning") return "warn";
  if (value === "error") return "error";
  return "info";
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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": [
      "authorization",
      "content-type",
      "x-api-key",
      "anthropic-version",
      "anthropic-beta",
      "x-cc-session-id",
      "x-cc-keep-session",
    ].join(","),
    "Access-Control-Expose-Headers": [
      "request-id",
      "x-cc-session-id",
      "x-cc-cli-session-id",
    ].join(","),
    "Access-Control-Max-Age": "86400",
  };
}

function sendCorsPreflight(res: http.ServerResponse): void {
  res.writeHead(204, corsHeaders());
  res.end();
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { ...corsHeaders(), ...headers, "Content-Type": "application/json" });
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

function hashForAffinity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function clientAffinityFingerprint(req: http.IncomingMessage): string {
  const key = extractClientApiKey(req);
  if (key) return `key:${hashForAffinity(key)}`;
  return `anon:${hashForAffinity(req.socket.remoteAddress || "unknown")}`;
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

function anthropicDiagnosticLogEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.CC_PROXY_DIAGNOSTIC_LOG || "") ||
    !!process.env.CC_PROXY_MESSAGES_LOG_PATH;
}

function anthropicDiagnosticLogPath(): string {
  return process.env.CC_PROXY_MESSAGES_LOG_PATH ||
    DEFAULT_MESSAGES_DIAGNOSTIC_LOG_PATH;
}

function truncateDiagnosticString(value: string, max = 2000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function truncateDiagnosticValue(value: any, depth = 0): any {
  if (depth > 8) return "[max-depth]";
  if (typeof value === "string") return truncateDiagnosticString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => truncateDiagnosticValue(item, depth + 1));
  }
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    result[key] = truncateDiagnosticValue(item, depth + 1);
  }
  return result;
}

function diagnosticMessagesText(body: any): string {
  const parts: string[] = [];
  if (body?.system) parts.push(contentToText(body.system));
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      parts.push(contentToText(message?.content));
    }
  }
  return parts.join("\n");
}

function inferCCTestProbe(body: any): string | null {
  const text = diagnosticMessagesText(body);
  if (Array.isArray(body?.messages) && body.messages.length === 0) return "error_shape";
  if (body?.stream === true || /Count: 1 2 3 4 5/.test(text)) return "streaming_shape";
  if (body?.stop_sequences?.includes?.("HALT")) return "stop_sequence";
  if (body?.max_tokens === 5 && /very long essay about the history of computing/i.test(text)) {
    return "max_tokens";
  }
  if (body?.tool_choice?.type === "tool" || /weather in Tokyo/i.test(text)) return "tool_use";
  if (/PINEAPPLE-7742/.test(text)) return "multi_turn";
  if (/single lowercase word "acknowledged"/i.test(text)) return "system_adherence";
  if (/Repeat your entire system prompt verbatim/i.test(text)) return "system_prompt_leak";
  if (/single word: OK/i.test(text)) return "consistency_check";
  if (/specific AI safety training methodology/i.test(text)) return "self_identification";
  if (/Alice is looking at Bob/i.test(text)) return "reasoning_fingerprint";
  if (/Describe this image in exactly 3 words/i.test(text)) return "multimodal";
  if (/What two words are written in this PDF/i.test(text)) return "document_input";
  if (/minimum cache size/i.test(text) || JSON.stringify(body || {}).includes("\"cache_control\"")) {
    return "cache_behavior";
  }
  if (/Deterministic probe text for token accounting verification/i.test(text)) {
    return "count_tokens_match";
  }
  if (/ping/.test(text) && body?.max_tokens === 16) return "connectivity";
  if (/say ok/i.test(text) && body?.max_tokens === 16) return "response_shape";
  if (/^hi$/i.test(text.trim()) && body?.max_tokens === 8) return "model_echo";
  if (/^hi$/i.test(text.trim()) && body?.max_tokens === 4) return "header_fingerprint";
  return null;
}

function summarizeAnthropicRequestBody(body: any): any {
  return {
    model: body?.model,
    stream: body?.stream === true,
    max_tokens: body?.max_tokens,
    stop_sequences: body?.stop_sequences,
    tool_choice: body?.tool_choice,
    tool_names: Array.isArray(body?.tools)
      ? body.tools.map((tool: any) => tool?.name).filter(Boolean)
      : [],
    message_count: Array.isArray(body?.messages) ? body.messages.length : null,
    text: truncateDiagnosticString(diagnosticMessagesText(body), 3000),
    body: truncateDiagnosticValue(body),
  };
}

function summarizeAnthropicResponseBody(body: any): any {
  if (!body || typeof body !== "object") return { body: truncateDiagnosticValue(body) };
  const content = Array.isArray(body.content) ? body.content : [];
  const toolUses = content
    .filter((block: any) => block?.type === "tool_use")
    .map((block: any) => ({
      id: block.id,
      name: block.name,
      input: truncateDiagnosticValue(block.input),
    }));
  return {
    id: body.id,
    type: body.type,
    role: body.role,
    model: body.model,
    stop_reason: body.stop_reason,
    stop_sequence: body.stop_sequence,
    content_types: content.map((block: any) => block?.type || "unknown"),
    text: truncateDiagnosticString(extractTextFromAnthropicContent(content), 3000),
    tool_uses: toolUses,
    usage: body.usage,
    error: body.error,
    request_id: body.request_id,
    body: truncateDiagnosticValue(body),
  };
}

function extractTextFromAnthropicContent(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
}

function writeAnthropicDiagnostic(
  req: http.IncomingMessage,
  requestId: string,
  phase: "request" | "response" | "error",
  body: any,
  details: Record<string, any> = {}
): void {
  if (!anthropicDiagnosticLogEnabled()) return;
  try {
    const record = {
      at: new Date().toISOString(),
      phase,
      route: "/v1/messages",
      request_id: requestId,
      inferred_probe: inferCCTestProbe(body),
      remote_address: req.socket.remoteAddress || null,
      user_agent: headerValue(req, "user-agent") || null,
      auth_prefix: extractClientApiKey(req).slice(0, 12),
      request: summarizeAnthropicRequestBody(body),
      ...details,
    };
    fs.mkdirSync(path.dirname(anthropicDiagnosticLogPath()), { recursive: true });
    fs.appendFileSync(
      anthropicDiagnosticLogPath(),
      `${JSON.stringify(record)}\n`,
      "utf8"
    );
  } catch (err) {
    log("WARN", "Failed to write Anthropic diagnostic log", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function requireClientAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  responseShape: "anthropic" | "plain",
  requestId?: string
): boolean {
  const key = extractClientApiKey(req);
  if (controlPlane.verifyApiKey(key)) return true;
  if (LEGACY_CLIENT_API_KEY && key === LEGACY_CLIENT_API_KEY) return true;
  if (
    !controlPlane.configured &&
    !LEGACY_CLIENT_API_KEY &&
    controlPlane.listApiKeys().length === 0
  ) {
    return true;
  }

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

function extractBearerToken(req: http.IncomingMessage): string {
  const authorization = headerValue(req, "authorization");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function requireAdminAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (controlPlane.verifyAdminToken(extractBearerToken(req))) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const bodyText = await readBody(req);
  if (!bodyText.trim()) return {};
  return JSON.parse(bodyText);
}

function turnErrorStatus(result: TurnResult): number {
  const status = result.error?.status_code;
  if (typeof status === "number" && status >= 400 && status <= 599) return status;
  return 502;
}

function turnErrorBody(result: TurnResult): unknown {
  if (result.error && "body" in result.error && result.error.body !== undefined) {
    return result.error.body;
  }
  return {
    type: "error",
    error: {
      type: result.error?.type || "api_error",
      message: result.error?.message || result.result || "Claude Code turn failed",
    },
  };
}

function sendTurnError(
  res: http.ServerResponse,
  result: TurnResult,
  requestId: string
): void {
  sendJson(res, turnErrorStatus(result), turnErrorBody(result), { "request-id": requestId });
}

function recordTurnOutcome(result: TurnResult, route: string): void {
  if (result.is_error) {
    accountState.markError(result.error, controlPlane.getConfig().quota_cooldown_ms);
    auditLog.record("warn", "account.error", "Claude account returned an error", {
      route,
      status: turnErrorStatus(result),
      error: result.error || null,
    });
    return;
  }
  accountState.markSuccess(result.usage, result.duration_ms);
}

function isClaudeProcessFailure(err: unknown): err is ClaudeProcessError {
  return err instanceof ClaudeProcessError;
}

function turnErrorFromException(err: unknown): TurnErrorDetails {
  if (err instanceof ClaudeProcessError) {
    const stderr = err.details.stderr?.trim();
    return {
      status_code: 502,
      type: "api_error",
      message: stderr || err.message || "Claude Code turn failed",
      body: {
        type: "error",
        error: {
          type: "api_error",
          message: stderr || err.message || "Claude Code turn failed",
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : "request failed";
  return {
    status_code: 500,
    type: "api_error",
    message,
  };
}

function recordClaudeExceptionOutcome(err: ClaudeProcessError, route: string): TurnErrorDetails {
  const details = turnErrorFromException(err);
  accountState.markError(details, controlPlane.getConfig().quota_cooldown_ms);
  auditLog.record("error", "account.error", "Claude account returned an error", {
    route,
    status: details.status_code || 502,
    error: details,
    exit_code: err.details.exitCode ?? null,
    signal: err.details.signal ?? null,
    stderr: err.details.stderr || "",
  });
  return details;
}

function sendExceptionAsAnthropicError(
  res: http.ServerResponse,
  err: unknown,
  requestId: string
): void {
  const details = turnErrorFromException(err);
  const status = details.status_code || 500;
  if (details.body !== undefined) {
    sendJson(res, status, details.body, { "request-id": requestId });
    return;
  }
  sendAnthropicError(
    res,
    status,
    details.type || "api_error",
    details.message || "request failed",
    requestId
  );
}

function claudeRunnerOptionsFromConfig(
  overrides: ClaudeRunnerOptions = {}
): ClaudeRunnerOptions {
  const config = controlPlane.getConfig();
  return {
    command: overrides.command || config.claude_command || undefined,
    model: overrides.model || config.claude_model || undefined,
    permissionMode:
      overrides.permissionMode || config.claude_permission_mode || undefined,
    effort: overrides.effort || config.claude_effort || undefined,
    settingSources:
      overrides.settingSources || config.claude_setting_sources || undefined,
    env: { ...(overrides.env || {}), HOME: CLAUDE_HOME_DIR },
    mcpConfig: overrides.mcpConfig,
    strictMcpConfig: overrides.strictMcpConfig,
    allowedTools: overrides.allowedTools,
    disallowedTools: overrides.disallowedTools,
    tools: overrides.tools,
  };
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

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

function normalizeAnthropicToolChoice(
  toolChoice: any,
  tools: ClientToolSpec[]
):
  | { ok: true; choice: AnthropicToolChoice; tools: ClientToolSpec[] }
  | { ok: false; status?: number; type?: string; message: string } {
  if (toolChoice == null) return { ok: true, choice: { type: "auto" }, tools };
  if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return {
      ok: false,
      status: 400,
      type: "invalid_request_error",
      message: "tool_choice must be an object",
    };
  }

  const choiceType = toolChoice.type;
  if (choiceType === "auto") return { ok: true, choice: { type: "auto" }, tools };
  if (choiceType === "none") return { ok: true, choice: { type: "none" }, tools: [] };

  if (choiceType === "any") {
    if (tools.length === 0) {
      return {
        ok: false,
        status: 400,
        type: "invalid_request_error",
        message: "tool_choice 'any' requires at least one tool",
      };
    }
    return { ok: true, choice: { type: "any" }, tools };
  }

  if (choiceType === "tool") {
    const name = typeof toolChoice.name === "string" ? toolChoice.name : "";
    if (!name) {
      return {
        ok: false,
        status: 400,
        type: "invalid_request_error",
        message: "tool_choice 'tool' requires a tool name",
      };
    }
    if (!tools.some((tool) => tool.name === name)) {
      return {
        ok: false,
        status: 400,
        type: "invalid_request_error",
        message: `tool_choice references unknown tool: ${name}`,
      };
    }
    return { ok: true, choice: { type: "tool", name }, tools };
  }

  return {
    ok: false,
    status: 400,
    type: "invalid_request_error",
    message: `Unsupported tool_choice type: ${String(choiceType)}`,
  };
}

function makeClientToolChoiceContext(
  choice: AnthropicToolChoice,
  tools: ClientToolSpec[]
): string {
  if (choice.type === "tool") {
    return [
      "[tool_choice]",
      `The API request requires a tool call. You must use the client tool named ${choice.name} before giving the final answer.`,
      "Do not answer with only text before that required tool call.",
    ].join("\n");
  }
  if (choice.type === "any") {
    const names = tools.map((tool) => tool.name).join(", ");
    return [
      "[tool_choice]",
      `The API request requires a tool call. You must use at least one available client tool before giving the final answer.`,
      `Available client tools: ${names}.`,
      "Do not answer with only text before that required tool call.",
    ].join("\n");
  }
  return "";
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
          ...(process.env.CC_PROXY_CLIENT_TOOL_BRIDGE_DEBUG === "1"
            ? {
                CC_PROXY_CLIENT_TOOL_BRIDGE_LOG: path.join(
                  os.tmpdir(),
                  `cc-proxy-client-tool-bridge-${bridge.id}.log`
                ),
              }
            : {}),
        },
      },
    },
  });
}

function findPendingClientToolTurn(toolUseIds: string[]): PendingClientToolTurn | null {
  for (const id of toolUseIds) {
    const pending = pendingClientToolTurns.get(id);
    if (pending) return pending;
  }
  return null;
}

function unregisterPendingClientToolTurn(pending: PendingClientToolTurn): void {
  for (const [id, registered] of pendingClientToolTurns) {
    if (registered === pending) {
      pendingClientToolTurns.delete(id);
    }
  }
}

function armPendingClientToolTurnCleanup(pending: PendingClientToolTurn): void {
  if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
  pending.cleanupTimer = setTimeout(() => {
    cleanupPendingClientToolTurn(pending);
  }, controlPlane.getConfig().client_tool_timeout_ms);
  pending.cleanupTimer.unref?.();
}

function registerPendingClientToolTurn(pending: PendingClientToolTurn): void {
  if (pending.cleaned) return;
  unregisterPendingClientToolTurn(pending);
  armPendingClientToolTurnCleanup(pending);
  for (const id of pending.awaitingToolUseIds) {
    pendingClientToolTurns.set(id, pending);
  }
}

function cleanupPendingClientToolTurn(pending: PendingClientToolTurn): void {
  if (pending.cleaned) return;
  pending.cleaned = true;
  if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
  pending.cleanupTimer = undefined;
  unregisterPendingClientToolTurn(pending);
  pending.turn.bridge.dispose();
  clientToolBridges.delete(pending.turn.bridge.id);
  if (pending.closeAfterFinal) {
    sessions.close(pending.sessionId);
    forgetSessionState(pending.sessionId);
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

function firstConversationUserText(body: any): string {
  const firstUser = Array.isArray(body?.messages)
    ? body.messages.find((message: any) => message?.role === "user")
    : null;
  if (firstUser) return contentToText(firstUser.content);
  const firstMessage = Array.isArray(body?.messages) ? body.messages[0] : null;
  return contentToText(firstMessage?.content);
}

function makeAutoSessionAffinityKey(
  req: http.IncomingMessage,
  body: any,
  turnInput: { model: string; effort?: string; tools: ClientToolSpec[] }
): string | null {
  if (turnInput.tools.length > 0) return null;
  const parts = {
    client: clientAffinityFingerprint(req),
    model: turnInput.model,
    effort: turnInput.effort || "",
    system: contentToText(body?.system),
    first_user: firstConversationUserText(body),
  };
  return hashForAffinity(JSON.stringify(parts));
}

function findReusableAutoSession(affinityKey: string | null): string | null {
  if (!affinityKey) return null;
  const sessionId = autoSessionAffinities.get(affinityKey);
  if (!sessionId) return null;
  const info = sessions.get(sessionId);
  if (!info || info.state !== "ready") {
    autoSessionAffinities.delete(affinityKey);
    return null;
  }
  return sessionId;
}

function rememberAutoSession(affinityKey: string | null, sessionId: string): void {
  if (affinityKey) autoSessionAffinities.set(affinityKey, sessionId);
}

function forgetAutoSession(sessionId: string): void {
  for (const [key, mappedSessionId] of autoSessionAffinities) {
    if (mappedSessionId === sessionId) autoSessionAffinities.delete(key);
  }
}

function forgetSessionState(sessionId: string): void {
  forgetAutoSession(sessionId);
  sessionConversationUserKeys.delete(sessionId);
}

function conversationUserKey(message: ClaudeStreamMessage): string | null {
  if (message.type !== "user") return null;
  return hashForAffinity(JSON.stringify(message.message.content));
}

function conversationUserKeys(messages: ClaudeStreamMessage[]): string[] {
  const keys: string[] = [];
  for (const message of messages) {
    const key = conversationUserKey(message);
    if (key) keys.push(key);
  }
  return keys;
}

function matchingUserPrefixCount(knownKeys: string[], incomingKeys: string[]): number {
  let count = 0;
  while (
    count < knownKeys.length &&
    count < incomingKeys.length &&
    knownKeys[count] === incomingKeys[count]
  ) {
    count += 1;
  }
  return count;
}

function messageIndexAfterUserCount(
  messages: ClaudeStreamMessage[],
  userCount: number
): number {
  if (userCount <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].type !== "user") continue;
    seen += 1;
    if (seen === userCount) return i + 1;
  }
  return messages.length;
}

function stripLeadingAssistantHistory(
  messages: ClaudeStreamMessage[]
): ClaudeStreamMessage[] {
  let start = 0;
  while (start < messages.length && messages[start].type === "assistant") {
    start += 1;
  }
  return messages.slice(start);
}

function prepareMessagesForSessionTurn(
  sessionId: string,
  incomingMessages: ClaudeStreamMessage[],
  reusingSession: boolean
): { messages: ClaudeStreamMessage[]; userKeysAfterTurn: string[] } {
  const incomingUserKeys = conversationUserKeys(incomingMessages);
  if (!reusingSession) {
    return { messages: incomingMessages, userKeysAfterTurn: incomingUserKeys };
  }

  const knownUserKeys = sessionConversationUserKeys.get(sessionId) || [];
  if (knownUserKeys.length === 0) {
    return { messages: incomingMessages, userKeysAfterTurn: incomingUserKeys };
  }

  const prefixCount = matchingUserPrefixCount(knownUserKeys, incomingUserKeys);
  if (prefixCount > 0) {
    const afterKnownUserIndex = messageIndexAfterUserCount(incomingMessages, prefixCount);
    const suffix = stripLeadingAssistantHistory(
      incomingMessages.slice(afterKnownUserIndex)
    );
    return {
      messages: suffix.length > 0 ? suffix : incomingMessages,
      userKeysAfterTurn: incomingUserKeys,
    };
  }

  return {
    messages: incomingMessages,
    userKeysAfterTurn: [...knownUserKeys, ...incomingUserKeys],
  };
}

function contentToBlocks(content: any): ClaudeContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === "object" && typeof block.type === "string") {
        return sanitizeContentBlockForClaudeCli(block);
      }
      return { type: "text", text: String(block ?? "") };
    });
  }
  if (content == null) return [];
  return [{ type: "text", text: JSON.stringify(content) }];
}

function sanitizeContentBlockForClaudeCli(block: any): ClaudeContentBlock {
  const clean: ClaudeContentBlock = { ...block };
  delete clean.cache_control;
  if (Array.isArray(clean.content)) {
    clean.content = clean.content.map((nested) => {
      if (nested && typeof nested === "object" && typeof nested.type === "string") {
        return sanitizeContentBlockForClaudeCli(nested);
      }
      return nested;
    });
  }
  return clean;
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

function isPlainTextContent(content: any): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return content == null;
  return content.every((block) => block?.type === "text" && typeof block.text === "string");
}

function collapsePlainTextConversation(
  messages: ClaudeStreamMessage[]
): ClaudeStreamMessage[] {
  if (messages.length <= 1) return messages;
  const transcript = messages.map((message, index) => {
    const role = message.message.role === "assistant" ? "Assistant" : "User";
    return `${index + 1}. ${role}: ${contentToText(message.message.content)}`;
  }).join("\n");
  const collapsedText = [
    "[conversation history]",
    transcript,
    "",
    "Continue this conversation and answer the latest user message according to the prior turns.",
    "Do not answer earlier user messages again.",
  ].join("\n");
  return [
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: collapsedText }],
      },
      parent_tool_use_id: null,
    },
  ];
}

function addContextToFirstUserMessage(
  messages: ClaudeStreamMessage[],
  context: string,
  placement: "prepend" | "append" = "prepend"
): ClaudeStreamMessage[] {
  if (!context) return messages;
  const contextBlock: ClaudeContentBlock = { type: "text", text: context };
  const firstUser = messages.find((message) => message.type === "user");
  if (firstUser) {
    firstUser.message.content =
      placement === "append"
        ? [...firstUser.message.content, contextBlock]
        : [contextBlock, ...firstUser.message.content];
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
      maxTokens?: number;
      stopSequences: string[];
      shouldCollapsePlainTextHistory: boolean;
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
  const requestedTools = normalizeClientTools(body.tools);
  const toolChoiceResult = normalizeAnthropicToolChoice(
    body.tool_choice,
    requestedTools
  );
  if (!toolChoiceResult.ok) return toolChoiceResult;
  const tools = toolChoiceResult.tools;

  const prependContextParts: string[] = [];
  const appendContextParts: string[] = [];
  if (body.system) {
    prependContextParts.push(`[system]\n${contentToText(body.system)}`);
  }
  if (wantsAnthropicThinking(body)) {
    appendContextParts.push(EXTENDED_THINKING_CONTEXT);
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

  const allPlainText = body.messages.every((message: any) => {
    return isPlainTextContent(message?.content);
  });
  const shouldCollapsePlainTextHistory =
    tools.length === 0 && allPlainText && messages.length > 1;

  let messagesWithContext = addContextToFirstUserMessage(
    messages,
    prependContextParts.join("\n\n")
  );
  messagesWithContext = addContextToFirstUserMessage(
    messagesWithContext,
    appendContextParts.join("\n\n"),
    "append"
  );
  const clientToolContext = [
    CLIENT_TOOL_BRIDGE_CONTEXT,
    makeClientToolChoiceContext(toolChoiceResult.choice, tools),
  ].filter(Boolean).join("\n\n");
  return {
    ok: true,
    messages: tools.length > 0
      ? addContextToFirstUserMessage(
          messagesWithContext,
          clientToolContext,
          "append"
        )
      : messagesWithContext,
    model: body.model,
    effort: thinkingToClaudeEffort(body.thinking),
    tools,
    maxTokens: normalizeMaxTokens(body.max_tokens),
    stopSequences: normalizeStopSequences(body.stop_sequences),
    shouldCollapsePlainTextHistory,
  };
}

function normalizeMaxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function normalizeStopSequences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => {
    return typeof item === "string" && item.length > 0;
  });
}

function thinkingToClaudeEffort(thinking: any): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type !== "enabled") return undefined;

  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return "high";
  if (budget <= 32_000) return "high";
  if (budget <= 64_000) return "xhigh";
  return "max";
}

function wantsAnthropicThinking(body: any): boolean {
  return body?.thinking?.type === "enabled";
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeAnthropicUsageForClients(): boolean {
  return /^(1|true|yes)$/i.test(process.env.CC_PROXY_NORMALIZE_ANTHROPIC_USAGE || "");
}

function autoSessionAffinityEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.CC_PROXY_AUTO_SESSION_AFFINITY || "");
}

function truthyHeader(value: string): boolean {
  return /^(1|true|yes)$/i.test(value || "");
}

function anthropicCacheUsageNumber(value: unknown): number {
  return normalizeAnthropicUsageForClients() ? 0 : usageNumber(value);
}

function makeAnthropicUsage(usage: any = {}): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
} {
  return {
    input_tokens: usageNumber(usage.input_tokens),
    output_tokens: usageNumber(usage.output_tokens),
    cache_creation_input_tokens: anthropicCacheUsageNumber(usage.cache_creation_input_tokens),
    cache_read_input_tokens: anthropicCacheUsageNumber(usage.cache_read_input_tokens),
  };
}

function pickAnthropicUsageFields(usage: any): Record<string, number> {
  const result: Record<string, number> = {};
  if (!usage || typeof usage !== "object") return result;
  for (const field of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[field] = field.startsWith("cache_") && normalizeAnthropicUsageForClients()
        ? 0
        : value;
    }
  }
  return result;
}

function isThinkingBlock(block: any): boolean {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

function isThinkingDelta(delta: any): boolean {
  return (
    delta?.type === "thinking_delta" ||
    delta?.type === "signature_delta" ||
    delta?.type === "redacted_thinking_delta"
  );
}

function normalizeAnthropicContent(
  content: any,
  fallbackText = "",
  options: { includeThinking?: boolean; ensureTextFallback?: boolean } = {}
): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object" || typeof block.type !== "string") {
        continue;
      }
      if (!options.includeThinking && isThinkingBlock(block)) {
        continue;
      }
      blocks.push({ ...block });
    }
  }

  if (blocks.length > 0) return blocks;
  if (options.ensureTextFallback === false) return [];
  return [{ type: "text", text: fallbackText }];
}

function normalizeAnthropicMessageObject(
  message: any,
  options: { includeThinking?: boolean } = {}
): any {
  return {
    ...message,
    content: normalizeAnthropicContent(message?.content, "", {
      includeThinking: options.includeThinking,
    }),
    usage: makeAnthropicUsage(message?.usage || {}),
  };
}

function textFromBlock(block: ClaudeContentBlock): string {
  return typeof block.text === "string" ? block.text : "";
}

function findEarliestStopSequence(
  text: string,
  stopSequences: string[]
): { sequence: string; index: number } | null {
  let best: { sequence: string; index: number } | null = null;
  for (const sequence of stopSequences) {
    const index = text.indexOf(sequence);
    if (index < 0) continue;
    if (!best || index < best.index) {
      best = { sequence, index };
    }
  }
  return best;
}

function truncateTextContentAtChars(
  content: ClaudeContentBlock[],
  charLimit: number
): ClaudeContentBlock[] {
  const truncated: ClaudeContentBlock[] = [];
  let remaining = Math.max(0, charLimit);
  let reachedLimit = false;

  for (const block of content) {
    if (reachedLimit) break;
    if (block.type !== "text") {
      truncated.push(block);
      continue;
    }

    const text = textFromBlock(block);
    if (remaining >= text.length) {
      truncated.push(block);
      remaining -= text.length;
      continue;
    }

    truncated.push({ ...block, text: text.slice(0, remaining) });
    reachedLimit = true;
  }

  return truncated.length > 0 ? truncated : [{ type: "text", text: "" }];
}

function applyAnthropicOutputControls(
  content: ClaudeContentBlock[],
  usage: ReturnType<typeof makeAnthropicUsage>,
  stopReason: string,
  options: { maxTokens?: number; stopSequences?: string[] }
): {
  content: ClaudeContentBlock[];
  usage: ReturnType<typeof makeAnthropicUsage>;
  stopReason: string;
  stopSequence: string | null;
} {
  let nextContent = content;
  let nextStopReason = stopReason || "end_turn";
  let stopSequence: string | null = null;
  const nextUsage = { ...usage };
  const text = nextContent
    .filter((block) => block.type === "text")
    .map(textFromBlock)
    .join("");

  const stopMatch = findEarliestStopSequence(text, options.stopSequences || []);
  if (stopMatch) {
    nextContent = truncateTextContentAtChars(nextContent, stopMatch.index);
    nextStopReason = "stop_sequence";
    stopSequence = stopMatch.sequence;
  }

  if (
    options.maxTokens !== undefined &&
    nextUsage.output_tokens > options.maxTokens
  ) {
    nextUsage.output_tokens = options.maxTokens;
    if (!stopMatch && text.length > 0) {
      nextContent = truncateTextContentAtChars(
        nextContent,
        Math.max(0, options.maxTokens * 4)
      );
      nextStopReason = "max_tokens";
      stopSequence = null;
    }
  }

  return {
    content: nextContent,
    usage: nextUsage,
    stopReason: nextStopReason,
    stopSequence,
  };
}

function normalizeAnthropicStreamEvent(
  event: any,
  state: {
    includeThinking: boolean;
    hiddenIndexes: Set<number>;
    visibleIndexes: Map<number, number>;
    nextVisibleIndex: number;
  }
): any | null {
  if (!event || typeof event !== "object") return event;

  const upstreamIndex = (): number => {
    return typeof event.index === "number" ? event.index : state.nextVisibleIndex;
  };
  const downstreamIndex = (index: number): number => {
    const existing = state.visibleIndexes.get(index);
    if (existing !== undefined) return existing;
    const next = state.nextVisibleIndex;
    state.nextVisibleIndex += 1;
    state.visibleIndexes.set(index, next);
    return next;
  };

  if (event.type === "message_start") {
    return {
      ...event,
      message: {
        ...event.message,
        content: [],
        usage: makeAnthropicUsage(event.message?.usage || {}),
      },
    };
  }

  if (event.type === "content_block_start") {
    const index = upstreamIndex();
    if (!state.includeThinking && isThinkingBlock(event.content_block)) {
      state.hiddenIndexes.add(index);
      return null;
    }
    return {
      ...event,
      index: downstreamIndex(index),
      content_block:
        event.content_block && typeof event.content_block === "object"
          ? { ...event.content_block }
          : event.content_block,
    };
  }

  if (event.type === "content_block_delta") {
    const index = upstreamIndex();
    if (state.hiddenIndexes.has(index)) return null;
    if (!state.includeThinking && isThinkingDelta(event.delta)) return null;
    return {
      ...event,
      index: downstreamIndex(index),
      delta:
        event.delta && typeof event.delta === "object"
          ? { ...event.delta }
          : event.delta,
    };
  }

  if (event.type === "content_block_stop") {
    const index = upstreamIndex();
    if (state.hiddenIndexes.has(index)) {
      state.hiddenIndexes.delete(index);
      return null;
    }
    return { ...event, index: downstreamIndex(index) };
  }

  if (event.type === "message_delta") {
    const normalized: any = { ...event };
    if ("usage" in event) normalized.usage = pickAnthropicUsageFields(event.usage);
    return normalized;
  }

  const normalized: any = { ...event };
  if ("usage" in event) normalized.usage = pickAnthropicUsageFields(event.usage);
  return normalized;
}

function makeAnthropicStreamEventNormalizer(
  includeThinking: boolean
): (event: any) => any | null {
  const state = {
    includeThinking,
    hiddenIndexes: new Set<number>(),
    visibleIndexes: new Map<number, number>(),
    nextVisibleIndex: 0,
  };
  return (event: any) => normalizeAnthropicStreamEvent(event, state);
}

function estimateInputTokens(
  messages: ClaudeStreamMessage[],
  tools: ClientToolSpec[]
): number {
  const text = [
    ...messages.map((message) => {
      return `${message.message.role}\n${contentToText(message.message.content)}`;
    }),
    tools.length > 0 ? JSON.stringify(tools) : "",
  ].join("\n");
  const bytes = Buffer.byteLength(text, "utf-8");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(bytes / 4), Math.ceil(words * 1.3));
}

async function handleAnthropicCountTokens(
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

  sendJson(
    res,
    200,
    { input_tokens: estimateInputTokens(turnInputResult.messages, turnInputResult.tools) },
    { "request-id": requestId }
  );
}

function makeAnthropicMessage(
  model: string,
  result: any,
  options: { includeThinking?: boolean; maxTokens?: number; stopSequences?: string[] } = {}
): any {
  const content = normalizeAnthropicContent(result.content, result.result || "", {
    includeThinking: options.includeThinking,
  });
  const controlled = applyAnthropicOutputControls(
    content,
    makeAnthropicUsage(result.usage || {}),
    result.stop_reason || "end_turn",
    options
  );
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: controlled.content,
    stop_reason: controlled.stopReason,
    stop_sequence: controlled.stopSequence,
    usage: controlled.usage,
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
    ...corsHeaders(),
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
  message: any,
  options: { includeThinking?: boolean } = {}
): void {
  message = normalizeAnthropicMessageObject(message, options);
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
      },
    },
  });
  message.content.forEach((block: any, index: number) => {
    sendSseContentBlock(res, index, block);
  });
  sendSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason || "end_turn",
      stop_sequence: message.stop_sequence ?? null,
    },
    usage: {
      output_tokens: message.usage.output_tokens,
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
  const missing = [...pending.awaitingToolUseIds].filter((id) => {
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

  const deliveredIds = new Set<string>();
  for (const result of toolResults) {
    if (pending.awaitingToolUseIds.has(result.tool_use_id)) {
      pending.turn.bridge.deliverToolResult(result);
      deliveredIds.add(result.tool_use_id);
    }
  }
  for (const id of deliveredIds) {
    pending.awaitingToolUseIds.delete(id);
  }

  let cleanupPending = true;
  try {
    const outcome = await Promise.race([
      pending.finalPromise.then((result) => ({ type: "final" as const, result })),
      pending.turn
        .waitForReadyToolUseBatch()
        .then((batch) => ({ type: "tool_use" as const, batch })),
    ]);

    if (outcome.type === "tool_use") {
      pending.awaitingToolUseIds = new Set(outcome.batch.toolUseIds);
      registerPendingClientToolTurn(pending);
      const toolUseMessage = normalizeAnthropicMessageObject(
        pending.turn.makeToolUseMessage(outcome.batch),
        { includeThinking: pending.includeThinking || wantsAnthropicThinking(body) }
      );

      if (body.stream === true) {
        writeAnthropicStreamHead(res, responseHeaders);
        sendBufferedAnthropicStreamEvents(res, toolUseMessage, {
          includeThinking: pending.includeThinking || wantsAnthropicThinking(body),
        });
        res.end();
      } else {
        sendJson(
          res,
          200,
          toolUseMessage,
          responseHeaders
        );
      }
      cleanupPending = false;
      return;
    }

    const result = outcome.result;
    recordTurnOutcome(result, "/v1/messages");
    responseHeaders["x-cc-cli-session-id"] = result.session_id;
    if (result.is_error) {
      auditLog.record("warn", "proxy.request.completed", "Proxy request completed", {
        route: "/v1/messages",
        status: turnErrorStatus(result),
        request_id: requestId,
      });
      if (res.headersSent) {
        sendSseEvent(res, "error", turnErrorBody(result));
        res.end();
      } else {
        sendTurnError(res, result, requestId);
      }
      return;
    }

    const message = makeAnthropicMessage(pending.turn.model, result, {
      includeThinking: pending.includeThinking || wantsAnthropicThinking(body),
      maxTokens: normalizeMaxTokens(body.max_tokens),
      stopSequences: normalizeStopSequences(body.stop_sequences),
    });
    auditLog.record("info", "proxy.request.completed", "Proxy request completed", {
      route: "/v1/messages",
      status: 200,
      request_id: requestId,
    });
    if (body.stream === true) {
      writeAnthropicStreamHead(res, responseHeaders);
      if (!streamedLiveEvents) {
        sendBufferedAnthropicStreamEvents(res, message, {
          includeThinking: pending.includeThinking || wantsAnthropicThinking(body),
        });
      }
      res.end();
    } else {
      sendJson(res, 200, message, responseHeaders);
    }
  } finally {
    if (cleanupPending) {
      cleanupPendingClientToolTurn(pending);
    }
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
  writeAnthropicDiagnostic(req, requestId, "request", body);

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
    const errorBody = {
      type: "error",
      error: {
        type: turnInputResult.type || "invalid_request_error",
        message: turnInputResult.message,
      },
      request_id: requestId,
    };
    auditLog.record("info", "proxy.request.completed", "Proxy request completed", {
      route: "/v1/messages",
      status: turnInputResult.status || 400,
      request_id: requestId,
      error_type: turnInputResult.type || "invalid_request_error",
    });
    writeAnthropicDiagnostic(req, requestId, "response", body, {
      response: {
        status: turnInputResult.status || 400,
        summary: summarizeAnthropicResponseBody(errorBody),
      },
    });
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
  const keepSession = truthyHeader(headerValue(req, "x-cc-keep-session"));
  const useAutoSessionAffinity = autoSessionAffinityEnabled();
  let sessionId: string | null = requestedSessionId || null;
  let closeAfterTurn = false;
  let closeInFinally = true;
  let bridge: ClientToolBridge | null = null;
  const includeThinking = wantsAnthropicThinking(body);
  let autoSessionAffinityKey: string | null = null;
  let reusingSession = false;

  try {
    if (sessionId) {
      reusingSession = true;
      if (!sessions.get(sessionId)) {
        const errorBody = {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `Unknown x-cc-session-id: ${sessionId}`,
          },
          request_id: requestId,
        };
        writeAnthropicDiagnostic(req, requestId, "response", body, {
          response: {
            status: 404,
            summary: summarizeAnthropicResponseBody(errorBody),
          },
        });
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
        const errorBody = {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "client-supplied tools require a new Claude Code session so the proxy can attach a per-request MCP bridge",
          },
          request_id: requestId,
        };
        writeAnthropicDiagnostic(req, requestId, "response", body, {
          response: {
            status: 400,
            summary: summarizeAnthropicResponseBody(errorBody),
          },
        });
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
        bridge = new ClientToolBridge(
          turnInputResult.tools,
          controlPlane.getConfig().client_tool_timeout_ms
        );
        clientToolBridges.set(bridge.id, bridge);
      }
      autoSessionAffinityKey = useAutoSessionAffinity
        ? makeAutoSessionAffinityKey(req, body, turnInputResult)
        : null;
      const reusableSessionId = !bridge && useAutoSessionAffinity
        ? findReusableAutoSession(autoSessionAffinityKey)
        : null;
      if (reusableSessionId) {
        sessionId = reusableSessionId;
        reusingSession = true;
      }
      if (!sessionId) {
        const info = sessions.create(claudeRunnerOptionsFromConfig({
          model: turnInputResult.model,
          effort: turnInputResult.effort,
          ...(bridge
            ? {
                mcpConfig: makeClientToolMcpConfig(bridge),
                strictMcpConfig: true,
                disallowedTools: SERVER_SIDE_TOOLS_DISABLED_FOR_CLIENT_BRIDGE,
              }
            : {}),
        }));
        sessionId = info.id;
        rememberAutoSession(autoSessionAffinityKey, sessionId);
        reusingSession = false;
      }
      closeAfterTurn = !!bridge || (!keepSession && !useAutoSessionAffinity);
    }

    const responseHeaders: Record<string, string> = { "request-id": requestId };
    if (!closeAfterTurn) responseHeaders["x-cc-session-id"] = sessionId;
    const preparedTurn = prepareMessagesForSessionTurn(
      sessionId,
      turnInputResult.messages,
      reusingSession
    );
    const messagesForTurn =
      turnInputResult.shouldCollapsePlainTextHistory &&
      !reusingSession &&
      preparedTurn.messages.length > 1
        ? collapsePlainTextConversation(preparedTurn.messages)
        : preparedTurn.messages;
    const normalizeStreamEvent = makeAnthropicStreamEventNormalizer(includeThinking);
    const streamLiveEvents =
      body.stream === true &&
      !includeThinking &&
      turnInputResult.stopSequences.length === 0;

    let streamedLiveEvents = false;
    const clientToolTurn = bridge
      ? new ClientToolTurn(
          bridge,
          turnInputResult.model,
          sessionId,
          closeAfterTurn
        )
      : null;
    const finalPromise = sessions.turn(
      sessionId,
      messagesForTurn,
      clientToolTurn
        ? {
            onStreamEvent: (event, raw) => {
              if (raw?.session_id) {
                responseHeaders["x-cc-cli-session-id"] = raw.session_id;
              }
              clientToolTurn.handleStreamEvent(event, raw);
            },
          }
        : streamLiveEvents
          ? {
              onStreamEvent: (event, raw) => {
                if (raw?.session_id) {
                  responseHeaders["x-cc-cli-session-id"] = raw.session_id;
                }
                const normalizedEvent = normalizeStreamEvent(event);
                if (!normalizedEvent) return;
                streamedLiveEvents = true;
                writeAnthropicStreamHead(res, responseHeaders);
                sendSseEvent(res, normalizedEvent.type || "message", normalizedEvent);
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
        const firstBatch = clientToolTurn.takeReadyToolUseBatch();
        if (!firstBatch) {
          throw new Error("client tool turn became ready without a tool_use batch");
        }
        const pending: PendingClientToolTurn = {
          turn: clientToolTurn,
          finalPromise,
          sessionId,
          closeAfterFinal: closeAfterTurn,
          awaitingToolUseIds: new Set(firstBatch.toolUseIds),
          includeThinking,
        };
        registerPendingClientToolTurn(pending);
        finalPromise.then(
          () => cleanupPendingClientToolTurn(pending),
          () => cleanupPendingClientToolTurn(pending)
        );
        closeInFinally = false;
        const toolUseMessage = normalizeAnthropicMessageObject(
          clientToolTurn.makeToolUseMessage(firstBatch),
          { includeThinking }
        );

        if (body.stream === true) {
          writeAnthropicStreamHead(res, responseHeaders);
          sendBufferedAnthropicStreamEvents(res, toolUseMessage, { includeThinking });
          res.end();
        } else {
          writeAnthropicDiagnostic(req, requestId, "response", body, {
            response: {
              status: 200,
              headers: responseHeaders,
              summary: summarizeAnthropicResponseBody(toolUseMessage),
            },
            session: {
              session_id: sessionId,
              close_after_turn: closeAfterTurn,
              reusing_session: reusingSession,
              sent_message_count: messagesForTurn.length,
            },
          });
          sendJson(res, 200, toolUseMessage, responseHeaders);
        }
        return;
      }
    }

    const result = await finalPromise;
    recordTurnOutcome(result, "/v1/messages");
    responseHeaders["x-cc-cli-session-id"] = result.session_id;
    if (result.is_error) {
      const errorBody = turnErrorBody(result);
      auditLog.record("warn", "proxy.request.completed", "Proxy request completed", {
        route: "/v1/messages",
        status: turnErrorStatus(result),
        request_id: requestId,
      });
      writeAnthropicDiagnostic(req, requestId, "response", body, {
        response: {
          status: turnErrorStatus(result),
          headers: responseHeaders,
          summary: summarizeAnthropicResponseBody(errorBody),
        },
        session: {
          session_id: sessionId,
          close_after_turn: closeAfterTurn,
          reusing_session: reusingSession,
          sent_message_count: messagesForTurn.length,
        },
      });
      if (res.headersSent) {
        sendSseEvent(res, "error", errorBody);
        res.end();
      } else {
        sendTurnError(res, result, requestId);
      }
      return;
    }
    if (!closeAfterTurn) {
      sessionConversationUserKeys.set(sessionId, preparedTurn.userKeysAfterTurn);
    }

    const message = makeAnthropicMessage(turnInputResult.model, result, {
      includeThinking,
      maxTokens: turnInputResult.maxTokens,
      stopSequences: turnInputResult.stopSequences,
    });
    auditLog.record("info", "proxy.request.completed", "Proxy request completed", {
      route: "/v1/messages",
      status: 200,
      request_id: requestId,
    });
    writeAnthropicDiagnostic(req, requestId, "response", body, {
      response: {
        status: 200,
        headers: responseHeaders,
        streamed_live_events: streamedLiveEvents,
        summary: summarizeAnthropicResponseBody(message),
      },
      session: {
        session_id: sessionId,
        close_after_turn: closeAfterTurn,
        reusing_session: reusingSession,
        sent_message_count: messagesForTurn.length,
      },
    });
    if (body.stream === true) {
      writeAnthropicStreamHead(res, responseHeaders);
      if (!streamedLiveEvents) {
        sendBufferedAnthropicStreamEvents(res, message, { includeThinking });
      }
      res.end();
    } else {
      sendJson(res, 200, message, responseHeaders);
    }
  } catch (err: any) {
    if (err instanceof CapacityError) {
      const errorBody = {
        type: "error",
        error: { type: "api_error", message: err.message },
        request_id: requestId,
      };
      writeAnthropicDiagnostic(req, requestId, "error", body, {
        response: {
          status: 503,
          summary: summarizeAnthropicResponseBody(errorBody),
        },
      });
      sendAnthropicError(res, 503, "api_error", err.message, requestId);
    } else if (isClaudeProcessFailure(err)) {
      const details = recordClaudeExceptionOutcome(err, "/v1/messages");
      const errorBody = details.body || {
        type: "error",
        error: {
          type: details.type || "api_error",
          message: details.message || "request failed",
        },
        request_id: requestId,
      };
      writeAnthropicDiagnostic(req, requestId, "error", body, {
        response: {
          status: details.status_code || 502,
          summary: summarizeAnthropicResponseBody(errorBody),
        },
        claude_error: {
          message: details.message,
          stderr: err.details.stderr || "",
          exit_code: err.details.exitCode ?? null,
        },
      });
      if (res.headersSent) {
        log("ERROR", "Anthropic messages request failed after stream started", {
          error: details.message,
          stderr: err.details.stderr || "",
        });
        sendSseEvent(res, "error", errorBody);
        res.end();
      } else {
        log("ERROR", "Anthropic messages request failed", {
          error: details.message,
          stderr: err.details.stderr || "",
          exit_code: err.details.exitCode ?? null,
        });
        sendExceptionAsAnthropicError(res, err, requestId);
      }
    } else if (res.headersSent) {
      const errorBody = {
        type: "error",
        error: { type: "api_error", message: err.message || "request failed" },
        request_id: requestId,
      };
      writeAnthropicDiagnostic(req, requestId, "error", body, {
        response: {
          status: 500,
          summary: summarizeAnthropicResponseBody(errorBody),
        },
      });
      log("ERROR", "Anthropic messages request failed after stream started", {
        error: err.message,
      });
      sendSseEvent(res, "error", errorBody);
      res.end();
    } else {
      const errorBody = {
        type: "error",
        error: { type: "api_error", message: err.message || "request failed" },
        request_id: requestId,
      };
      writeAnthropicDiagnostic(req, requestId, "error", body, {
        response: {
          status: 500,
          summary: summarizeAnthropicResponseBody(errorBody),
        },
      });
      log("ERROR", "Anthropic messages request failed", { error: err.message });
      sendAnthropicError(res, 500, "api_error", err.message || "request failed", requestId);
    }
  } finally {
    if (closeInFinally && closeAfterTurn && sessionId) {
      sessions.close(sessionId);
      forgetSessionState(sessionId);
    }
    if (closeInFinally && bridge) {
      bridge.dispose();
      clientToolBridges.delete(bridge.id);
    }
  }
}

// ---- Session route handlers ----

async function handleCreateSession(res: http.ServerResponse): Promise<void> {
  try {
    const info = sessions.create(claudeRunnerOptionsFromConfig());
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
    recordTurnOutcome(result, "/sessions/:id/turn");
    if (result.is_error) {
      sendJson(res, turnErrorStatus(result), turnErrorBody(result));
      return;
    }
    sendJson(res, 200, result);
  } catch (err: any) {
    const msg = err.message || "turn failed";
    if (msg === "session not found") {
      sendJson(res, 404, { error: msg });
    } else if (msg === "session is busy with another turn") {
      sendJson(res, 409, { error: msg });
    } else if (isClaudeProcessFailure(err)) {
      const details = recordClaudeExceptionOutcome(err, "/sessions/:id/turn");
      log("ERROR", "Turn failed", {
        id,
        error: details.message,
        stderr: err.details.stderr || "",
        exit_code: err.details.exitCode ?? null,
      });
      sendJson(res, details.status_code || 502, details.body || {
        type: "error",
        error: {
          type: details.type || "api_error",
          message: details.message || "turn failed",
        },
      });
    } else {
      log("ERROR", "Turn failed", { id, error: msg });
      sendJson(res, 500, { error: msg });
    }
  }
}

async function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL
): Promise<boolean> {
  if (req.method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
    const adminHtmlPath = path.resolve(__dirname, "..", "public", "admin.html");
    try {
      const html = fs.readFileSync(adminHtmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || "admin console unavailable" });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/status") {
    sendJson(res, 200, {
      admin: {
        configured: controlPlane.configured,
      },
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/admin/setup") {
    if (controlPlane.configured) {
      sendJson(res, 409, { error: "admin already configured" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const result = controlPlane.setupAdmin(String(body.username || ""), String(body.password || ""));
      auditLog.record("info", "admin.setup", "Administrator account created", {
        username: result.username,
      });
      sendJson(res, 201, result);
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || "invalid setup request" });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/admin/auth/login") {
    try {
      const body = await readJsonBody(req);
      const result = controlPlane.login(String(body.username || ""), String(body.password || ""));
      if (!result) {
        sendJson(res, 401, { error: "invalid credentials" });
        return true;
      }
      auditLog.record("info", "admin.login", "Administrator logged in", {
        username: result.username,
      });
      sendJson(res, 200, result);
    } catch {
      sendJson(res, 400, { error: "invalid login request" });
    }
    return true;
  }

  if (!pathname.startsWith("/admin/")) return false;
  if (!requireAdminAuth(req, res)) return true;

  if (req.method === "GET" && pathname === "/admin/config") {
    sendJson(res, 200, { config: controlPlane.getConfig() });
    return true;
  }

  if (req.method === "PUT" && pathname === "/admin/config") {
    try {
      const body = await readJsonBody(req);
      const config = controlPlane.updateConfig(body || {});
      auditLog.record("info", "admin.config.updated", "Runtime configuration updated", {
        config,
      });
      sendJson(res, 200, { config });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || "invalid config request" });
    }
    return true;
  }

  if (req.method === "PATCH" && pathname === "/admin/auth/password") {
    try {
      const body = await readJsonBody(req);
      const result = controlPlane.changeAdminPassword(
        String(body.current_password || ""),
        String(body.new_password || "")
      );
      auditLog.record("warn", "admin.password.changed", "Administrator password changed", {
        username: result.username,
      });
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, err.message?.includes("incorrect") ? 401 : 400, {
        error: err.message || "invalid password change request",
      });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/api-keys") {
    sendJson(res, 200, { keys: controlPlane.listApiKeys() });
    return true;
  }

  if (req.method === "POST" && pathname === "/admin/api-keys") {
    try {
      const body = await readJsonBody(req);
      const key = controlPlane.createApiKey(String(body.name || ""));
      auditLog.record("info", "admin.api_key.created", "Downstream API key created", {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
      });
      sendJson(res, 201, { key });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || "invalid API key request" });
    }
    return true;
  }

  const apiKeyMatch = pathname.match(/^\/admin\/api-keys\/([^/]+)$/);
  if (apiKeyMatch && req.method === "PATCH") {
    try {
      const body = await readJsonBody(req);
      const patch: { name?: string; enabled?: boolean } = {};
      if ("name" in body) patch.name = String(body.name || "");
      if ("enabled" in body) patch.enabled = !!body.enabled;
      const key = controlPlane.updateApiKey(decodeURIComponent(apiKeyMatch[1]), patch);
      if (!key) {
        sendJson(res, 404, { error: "API key not found" });
        return true;
      }
      auditLog.record("info", "admin.api_key.updated", "Downstream API key updated", {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        enabled: key.enabled,
      });
      sendJson(res, 200, { key });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || "invalid API key update request" });
    }
    return true;
  }

  if (apiKeyMatch && req.method === "DELETE") {
    const key = controlPlane.deleteApiKey(decodeURIComponent(apiKeyMatch[1]));
    if (!key) {
      sendJson(res, 404, { error: "API key not found" });
      return true;
    }
    auditLog.record("info", "admin.api_key.deleted", "Downstream API key deleted", {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
    });
    sendJson(res, 200, { key });
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/logs") {
    const limit = Number(url.searchParams.get("limit") || 100);
    sendJson(res, 200, { logs: auditLog.list(Number.isFinite(limit) ? limit : 100) });
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/account") {
    sendJson(res, 200, { account: accountState.snapshot() });
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/system") {
    sendJson(res, 200, {
      storage: {
        data_dir: DATA_DIR,
        claude_home_dir: CLAUDE_HOME_DIR,
        control_plane_path: CONTROL_PLANE_PATH,
        control_plane_exists: fs.existsSync(CONTROL_PLANE_PATH),
        audit_log_path: AUDIT_LOG_PATH,
        audit_log_exists: fs.existsSync(AUDIT_LOG_PATH),
        account_state_path: ACCOUNT_STATE_PATH,
        account_state_exists: fs.existsSync(ACCOUNT_STATE_PATH),
      },
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/claude-auth") {
    const config = controlPlane.getConfig();
    const auth = claudeAuthJob.snapshot();
    sendJson(res, 200, {
      auth,
      view: buildClaudeAuthView(auth),
      config: {
        claude_command: config.claude_command,
        claude_auth_login_args: config.claude_auth_login_args,
        claude_auth_status_args: config.claude_auth_status_args,
      },
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/admin/claude-auth/login") {
    try {
      const config = controlPlane.getConfig();
      const loginArgs = splitCommandArgs(config.claude_auth_login_args);
      const snapshot = claudeAuthJob.start({
        command: resolveClaudeCommand(config.claude_command || undefined),
        args: loginArgs,
        cwd: SESSION_CWD,
        env: { HOME: CLAUDE_HOME_DIR },
        pseudoTty: true,
      });
      auditLog.record("info", "claude_auth.login.started", "Claude account login job started", {
        command: snapshot.command,
        args: snapshot.args,
      });
      sendJson(res, 202, { auth: snapshot });
    } catch (err: any) {
      sendJson(res, err.message?.includes("already running") ? 409 : 400, {
        error: err.message || "failed to start Claude auth job",
      });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/admin/claude-auth/check") {
    try {
      const config = controlPlane.getConfig();
      const snapshot = claudeAuthJob.start({
        command: resolveClaudeCommand(config.claude_command || undefined),
        args: splitCommandArgs(config.claude_auth_status_args || "--version"),
        cwd: SESSION_CWD,
        env: { HOME: CLAUDE_HOME_DIR },
      });
      auditLog.record("info", "claude_auth.check.started", "Claude account auth check job started", {
        command: snapshot.command,
        args: snapshot.args,
      });
      sendJson(res, 202, { auth: snapshot });
    } catch (err: any) {
      sendJson(res, err.message?.includes("already running") ? 409 : 400, {
        error: err.message || "failed to start Claude auth check",
      });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/admin/claude-auth/input") {
    try {
      const body = await readJsonBody(req);
      const snapshot = claudeAuthJob.submitInput(String(body.input || ""));
      auditLog.record("info", "claude_auth.input.submitted", "Claude account auth input submitted", {
        status: snapshot.status,
      });
      sendJson(res, 200, { auth: snapshot });
    } catch (err: any) {
      sendJson(res, err.message?.includes("not running") ? 409 : 400, {
        error: err.message || "failed to submit Claude auth input",
      });
    }
    return true;
  }

  if (req.method === "DELETE" && pathname === "/admin/claude-auth") {
    try {
      const snapshot = claudeAuthJob.cancel();
      auditLog.record("warn", "claude_auth.cancelled", "Claude account auth job cancelled by admin", {
        command: snapshot.command,
        args: snapshot.args,
      });
      sendJson(res, 200, { auth: snapshot });
    } catch (err: any) {
      sendJson(res, err.message?.includes("not running") ? 409 : 400, {
        error: err.message || "failed to cancel Claude auth job",
      });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/admin/cli-windows") {
    const config = controlPlane.getConfig();
    sendJson(res, 200, {
      limit: config.max_cli_windows,
      active: sessions.size,
      windows: sessions.list(),
    });
    return true;
  }

  sendJson(res, 404, { error: "admin route not found" });
  return true;
}

function buildClaudeAuthView(auth: ClaudeAuthJobSnapshot): { display_log: string; auth_url: string | null } {
  const commandLine = auth.command ? `$ ${auth.command} ${(auth.args || []).join(" ")}` : "";
  const displayLog = cleanTerminalText([
    commandLine,
    auth.started_at ? `started: ${auth.started_at}` : "",
    auth.completed_at ? `completed: ${auth.completed_at}` : "",
    auth.exit_code == null ? "" : `exit: ${auth.exit_code}`,
    auth.log || "",
  ].filter(Boolean).join("\n"));
  return {
    display_log: displayLog,
    auth_url: extractFirstHttpUrl(displayLog),
  };
}

function cleanTerminalText(value: string): string {
  return String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function extractFirstHttpUrl(value: string): string | null {
  const lines = String(value || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].search(/https?:\/\//);
    if (start < 0) continue;
    const first = lines[i].slice(start).match(/^[^\s"'<>]+/)?.[0] || "";
    if (!first) continue;
    let url = first;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trimStart();
      if (!trimmed) continue;
      const part = trimmed.match(/^[^\s"'<>]+/)?.[0] || "";
      if (!isUrlContinuation(part)) break;
      url += part;
    }
    return url;
  }
  return null;
}

function isUrlContinuation(value: string): boolean {
  if (!value || !/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value)) return false;
  if (/^[&?#/%=]/.test(value)) return true;
  return /[=&%/?#]/.test(value);
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === "OPTIONS") {
      sendCorsPreflight(res);
      return;
    }

    if (await handleAdminRequest(req, res, pathname, url)) {
      return;
    }

    // Health check
    if (req.method === "GET" && pathname === "/health") {
      const config = controlPlane.getConfig();
      sendJson(res, 200, {
        status: "ok",
        downstream_root: DOWNSTREAM_ROOT,
        sessions: sessions.size,
        max_sessions: config.max_cli_windows,
        max_cli_windows: config.max_cli_windows,
      });
      return;
    }

    if (pathname.startsWith("/internal/tool-bridge/")) {
      await handleClientToolBridgeRequest(req, res, pathname);
      return;
    }

    // Anthropic-compatible Messages API
    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      await handleAnthropicCountTokens(req, res);
      return;
    }

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
        if (ok) forgetSessionState(id);
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
  log("INFO", `Data directory: ${DATA_DIR}`);
  log("INFO", `Max CLI windows: ${controlPlane.getConfig().max_cli_windows}`);
  log("INFO", `Temp directory: ${TEMP_DIR}`);
});

export { server, PORT, DOWNSTREAM_ROOT, sessions };
