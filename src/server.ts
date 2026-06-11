import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
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
      const tempFile = path.join(TEMP_DIR, `read_${Date.now()}_${path.basename(filePath)}`);
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

    // ---- Session API ----
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
