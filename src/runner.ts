import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { TurnResult, TurnUsage } from "./types";

const DEFAULT_TURN_TIMEOUT_MS = parseInt(
  process.env.CC_TURN_TIMEOUT_MS || "120000",
  10
);

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
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

  constructor(private readonly cwd: string) {
    super();
  }

  start(): void {
    if (this.proc) return;
    this.proc = spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
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

  /** Send one user turn; resolves with the result for that turn. */
  send(text: string, timeoutMs = DEFAULT_TURN_TIMEOUT_MS): Promise<TurnResult> {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error("runner not running"));
    }
    if (this.pending) {
      return Promise.reject(new Error("a turn is already in flight"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };

      const msg = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      };
      this.proc!.stdin.write(JSON.stringify(msg) + "\n");
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
    if (obj.type === "result") {
      this.onResult(obj);
    }
  }

  private onResult(obj: any): void {
    if (!this.pending) return;
    const { resolve, timer } = this.pending;
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
    resolve({
      result: typeof obj.result === "string" ? obj.result : "",
      session_id: obj.session_id || this.cliSessionId || "",
      usage,
      duration_ms: obj.duration_ms || 0,
      num_turns: obj.num_turns || 0,
      is_error: !!obj.is_error,
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
