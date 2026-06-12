import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import {
  ClaudeContentBlock,
  ClaudeStreamMessage,
  ClaudeTurnInput,
  TurnResult,
  TurnUsage,
} from "./types";

const DEFAULT_TURN_TIMEOUT_MS = parseInt(
  process.env.CC_TURN_TIMEOUT_MS || "120000",
  10
);

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  thinkingBlocks: ClaudeContentBlock[];
  lastAssistantContent: ClaudeContentBlock[];
  onStreamEvent?: (event: any, raw: any) => void;
}

export interface ClaudeRunnerOptions {
  model?: string;
  permissionMode?: string;
  effort?: string;
}

export interface TurnCallbacks {
  onStreamEvent?: (event: any, raw: any) => void;
}

export function resolveClaudeCommand(): string {
  if (process.env.CLAUDE_COMMAND) return process.env.CLAUDE_COMMAND;

  const packageRoot = path.resolve(__dirname, "..", "node_modules", "@anthropic-ai");
  const nativePackages: string[] = [];
  if (process.platform === "darwin") {
    nativePackages.push(
      process.arch === "arm64"
        ? "claude-code-darwin-arm64"
        : "claude-code-darwin-x64"
    );
  } else if (process.platform === "linux") {
    if (process.arch === "arm64") {
      nativePackages.push("claude-code-linux-arm64", "claude-code-linux-arm64-musl");
    } else {
      nativePackages.push("claude-code-linux-x64", "claude-code-linux-x64-musl");
    }
  } else if (process.platform === "win32") {
    nativePackages.push(
      process.arch === "arm64"
        ? "claude-code-win32-arm64"
        : "claude-code-win32-x64"
    );
  }

  for (const packageName of nativePackages) {
    const nativeBin = path.join(packageRoot, packageName, process.platform === "win32" ? "claude.exe" : "claude");
    if (fs.existsSync(nativeBin)) return nativeBin;
  }

  const binName = process.platform === "win32" ? "claude.cmd" : "claude";
  const localBin = path.resolve(__dirname, "..", "node_modules", ".bin", binName);
  if (fs.existsSync(localBin)) return localBin;

  return "claude";
}

export function resolveClaudeArgs(options: ClaudeRunnerOptions = {}): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  const model = options.model || process.env.CC_CLAUDE_MODEL;
  if (model) {
    args.push("--model", model);
  }
  const permissionMode = options.permissionMode || process.env.CC_PERMISSION_MODE;
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  const effort = options.effort || process.env.CC_CLAUDE_EFFORT;
  if (effort) {
    args.push("--effort", effort);
  }
  return args;
}

/**
 * Wraps one persistent `claude` process driven over stream-json stdin/stdout.
 * One process serves many turns so prompt cache is reused across turns.
 */
export class ClaudeRunner extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private pending: PendingTurn | null = null;
  private cliSessionId: string | null = null;
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly options: ClaudeRunnerOptions = {}
  ) {
    super();
  }

  start(): void {
    if (this.proc) return;
    this.proc = spawn(
      resolveClaudeCommand(),
      resolveClaudeArgs(this.options),
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] }
    );

    this.proc.stdout.on("data", (c: Buffer) => this.onStdout(c));
    this.proc.stderr.on("data", () => {
      /* swallow CLI stderr; surfaced via exit if fatal */
    });
    this.proc.on("exit", (code) => this.onExit(code));
    this.proc.on("error", (err) => this.fail(err));
  }

  get sessionId(): string | null {
    return this.cliSessionId;
  }

  get isAlive(): boolean {
    return !!this.proc && !this.closed;
  }

  /** Send one turn; resolves with the result for that turn. */
  send(
    input: ClaudeTurnInput,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    callbacks: TurnCallbacks = {}
  ): Promise<TurnResult> {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error("runner not running"));
    }
    if (this.pending) {
      return Promise.reject(new Error("a turn is already in flight"));
    }
    const messages = normalizeTurnInput(input);
    if (messages.length === 0) {
      return Promise.reject(new Error("turn input must contain at least one message"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = {
        resolve,
        reject,
        timer,
        thinkingBlocks: [],
        lastAssistantContent: [],
        onStreamEvent: callbacks.onStreamEvent,
      };

      for (const msg of messages) {
        this.proc!.stdin.write(JSON.stringify(msg) + "\n");
      }
    });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("runner stopped"));
      this.pending = null;
    }
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.session_id && !this.cliSessionId) {
      this.cliSessionId = obj.session_id;
    }
    if (obj.type === "stream_event" && obj.event) {
      this.pending?.onStreamEvent?.(obj.event, obj);
    }
    if (obj.type === "assistant") {
      this.onAssistant(obj);
    }
    if (obj.type === "result") {
      this.onResult(obj);
    }
  }

  private onAssistant(obj: any): void {
    if (!this.pending) return;
    const content = normalizeContentBlocks(obj.message?.content);
    if (content.length === 0) return;
    this.pending.lastAssistantContent = content;
    for (const block of content) {
      if (block.type === "thinking") {
        this.pending.thinkingBlocks.push(block);
      }
    }
  }

  private onResult(obj: any): void {
    if (!this.pending) return;
    const { resolve, timer, thinkingBlocks, lastAssistantContent } = this.pending;
    clearTimeout(timer);
    this.pending = null;

    const u = obj.usage || {};
    const usage: TurnUsage = {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
      total_cost_usd: obj.total_cost_usd || 0,
    };
    const resultText = typeof obj.result === "string" ? obj.result : "";
    const finalContent =
      lastAssistantContent.length > 0
        ? mergeThinkingBlocks(thinkingBlocks, lastAssistantContent)
        : [{ type: "text", text: resultText }];
    resolve({
      result: resultText,
      content: finalContent,
      session_id: obj.session_id || this.cliSessionId || "",
      usage,
      duration_ms: obj.duration_ms || 0,
      num_turns: obj.num_turns || 0,
      is_error: !!obj.is_error,
      stop_reason: obj.stop_reason || null,
    });
  }

  private onExit(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.proc = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(`claude process exited (code ${code})`));
      this.pending = null;
    }
    this.emit("exit", code);
  }

  private fail(err: Error): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
    this.emit("error", err);
  }
}

function normalizeTurnInput(input: ClaudeTurnInput): ClaudeStreamMessage[] {
  if (typeof input === "string") {
    return [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: input }],
        },
        parent_tool_use_id: null,
      },
    ];
  }
  return input.map((message) => ({
    type: message.type,
    message: {
      role: message.message.role,
      content: normalizeContentBlocks(message.message.content),
    },
    parent_tool_use_id: message.parent_tool_use_id ?? null,
  }));
}

function normalizeContentBlocks(content: unknown): ClaudeContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is ClaudeContentBlock => {
      return !!block && typeof block === "object" && typeof (block as any).type === "string";
    })
    .map((block) => ({ ...block }));
}

function mergeThinkingBlocks(
  thinkingBlocks: ClaudeContentBlock[],
  finalContent: ClaudeContentBlock[]
): ClaudeContentBlock[] {
  if (finalContent.some((block) => block.type === "thinking")) {
    return finalContent;
  }
  return [...thinkingBlocks, ...finalContent];
}
