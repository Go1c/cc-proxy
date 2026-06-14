import http from "http";
import fs from "fs";

const BRIDGE_URL = process.env.CC_PROXY_CLIENT_TOOL_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.CC_PROXY_CLIENT_TOOL_BRIDGE_TOKEN || "";
const LOG_PATH = process.env.CC_PROXY_CLIENT_TOOL_BRIDGE_LOG || "";
let outputFormat: "content-length" | "json-line" = "content-length";

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (true) {
    const jsonLine = readJsonLineMessage();
    if (jsonLine === undefined) return;
    if (jsonLine) {
      void handleMessage(jsonLine);
      continue;
    }

    const crlfSeparator = inputBuffer.indexOf("\r\n\r\n");
    const lfSeparator = inputBuffer.indexOf("\n\n");
    const separator =
      crlfSeparator >= 0 && (lfSeparator < 0 || crlfSeparator <= lfSeparator)
        ? crlfSeparator
        : lfSeparator;
    if (separator < 0) return;
    const separatorLength = separator === crlfSeparator ? 4 : 2;

    const header = inputBuffer.slice(0, separator).toString("utf-8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) {
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const length = Number(match[1]);
    const bodyStart = separator + separatorLength;
    const bodyEnd = bodyStart + length;
    if (inputBuffer.length < bodyEnd) return;

    const raw = inputBuffer.slice(bodyStart, bodyEnd).toString("utf-8");
    inputBuffer = inputBuffer.slice(bodyEnd);
    outputFormat = "content-length";
    void handleMessage(JSON.parse(raw));
  }
});

function readJsonLineMessage(): JsonRpcMessage | null | undefined {
  const firstNonWhitespace = inputBuffer.findIndex((byte) => {
    return byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a;
  });
  if (firstNonWhitespace < 0) {
    inputBuffer = Buffer.alloc(0);
    return undefined;
  }
  if (firstNonWhitespace > 0) {
    inputBuffer = inputBuffer.slice(firstNonWhitespace);
  }
  if (inputBuffer[0] !== 0x7b) return null;

  const lineEnd = inputBuffer.indexOf("\n");
  if (lineEnd < 0) return undefined;

  const raw = inputBuffer.slice(0, lineEnd).toString("utf-8").trim();
  inputBuffer = inputBuffer.slice(lineEnd + 1);
  if (!raw) return null;
  outputFormat = "json-line";
  return JSON.parse(raw);
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  if (!message.method) return;
  if (!("id" in message)) {
    debugLog("notification", { method: message.method });
    return;
  }

  try {
    debugLog("request", { id: message.id, method: message.method });
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cc-proxy-client-tools", version: "0.1.0" },
        },
      });
      return;
    }

    if (message.method === "tools/list") {
      const tools = await bridgeRequest("GET", "/tools");
      debugLog("tools/list", {
        count: Array.isArray(tools) ? tools.length : null,
        names: Array.isArray(tools) ? tools.map((tool: any) => tool.name) : null,
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: tools.map((tool: any) => ({
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.input_schema || { type: "object" },
          })),
        },
      });
      return;
    }

    if (message.method === "tools/call") {
      debugLog("tools/call", {
        name: message.params?.name,
        input: message.params?.arguments || message.params?.input || {},
      });
      const result = await bridgeRequest("POST", "/call", {
        name: message.params?.name,
        input: message.params?.arguments || message.params?.input || {},
      });
      send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  } catch (err: any) {
    debugLog("error", {
      id: message.id,
      method: message.method,
      message: err.message || "MCP server error",
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: err.message || "MCP server error" },
    });
  }
}

function debugLog(event: string, data: unknown): void {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ time: new Date().toISOString(), event, data })}\n`
    );
  } catch {
    // Logging must never corrupt MCP stdio.
  }
}

function send(message: JsonRpcMessage): void {
  const body = JSON.stringify(message);
  if (outputFormat === "json-line") {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function bridgeRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return Promise.reject(new Error("Missing client tool bridge environment"));
  }

  return new Promise((resolve, reject) => {
    const url = new URL(`${BRIDGE_URL.replace(/\/$/, "")}${path}`);
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(text || `Bridge request failed: ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (err: any) {
            reject(new Error(`Invalid bridge JSON: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
