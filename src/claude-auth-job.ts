import { spawn as spawnChild, ChildProcess } from "child_process";
import * as nodePty from "node-pty";

export type ClaudeAuthJobStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface ClaudeAuthJobSnapshot {
  status: ClaudeAuthJobStatus;
  command: string | null;
  args: string[];
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  log: string;
}

export interface StartClaudeAuthJobOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  pseudoTty?: boolean;
  initialInput?: string;
}

const MAX_LOG_CHARS = 64 * 1024;

export class ClaudeAuthJob {
  private proc: ChildProcess | nodePty.IPty | null = null;
  private procKind: "child" | "pty" | null = null;
  private state: ClaudeAuthJobSnapshot = {
    status: "idle",
    command: null,
    args: [],
    started_at: null,
    completed_at: null,
    exit_code: null,
    signal: null,
    log: "",
  };

  start(options: StartClaudeAuthJobOptions): ClaudeAuthJobSnapshot {
    if (this.proc && this.state.status === "running") {
      throw new Error("Claude auth job is already running");
    }
    const command = options.command.trim();
    if (!command) throw new Error("Claude command is empty");

    this.state = {
      status: "running",
      command,
      args: [...options.args],
      started_at: new Date().toISOString(),
      completed_at: null,
      exit_code: null,
      signal: null,
      log: "",
    };

    try {
      if (options.pseudoTty && process.platform !== "win32") {
        const proc = nodePty.spawn(command, options.args, {
          name: "xterm-256color",
          cols: 120,
          rows: 30,
          cwd: options.cwd,
          env: { ...process.env, ...(options.env || {}) },
        });
        this.proc = proc;
        this.procKind = "pty";
        proc.onData((chunk) => this.appendLog(chunk));
        proc.onExit((event) => {
          this.finish(event.exitCode === 0 ? "succeeded" : "failed", event.exitCode, null);
        });
        if (options.initialInput) {
          proc.write(ensureTrailingNewline(options.initialInput));
          this.appendLog("\n[admin input submitted]\n");
        }
      } else {
        const proc = spawnChild(command, options.args, {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...(options.env || {}) },
        });
        this.proc = proc;
        this.procKind = "child";
        proc.stdout?.on("data", (chunk) => this.appendLog(chunk));
        proc.stderr?.on("data", (chunk) => this.appendLog(chunk));
        proc.on("error", (err) => {
          this.appendLog(`${err.message}\n`);
          this.finish("failed", null, null);
        });
        proc.on("exit", (code, signal) => {
          this.finish(code === 0 ? "succeeded" : "failed", code, signal);
        });
        if (options.initialInput) {
          proc.stdin.write(ensureTrailingNewline(options.initialInput));
          this.appendLog("\n[admin input submitted]\n");
        }
      }
    } catch (err: any) {
      this.appendLog(`${err?.message || String(err)}\n`);
      this.finish("failed", null, null);
      throw err;
    }
    return this.snapshot();
  }

  submitInput(input: string): ClaudeAuthJobSnapshot {
    if (!this.proc || this.state.status !== "running") {
      throw new Error("Claude auth job is not running");
    }
    const value = String(input ?? "");
    if (this.procKind === "pty") {
      (this.proc as nodePty.IPty).write(value.endsWith("\n") ? value : `${value}\n`);
      this.appendLog("\n[admin input submitted]\n");
      return this.snapshot();
    }
    const stdin = (this.proc as ChildProcess).stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Claude auth job input is closed");
    }
    stdin.write(value.endsWith("\n") ? value : `${value}\n`);
    this.appendLog("\n[admin input submitted]\n");
    return this.snapshot();
  }

  cancel(): ClaudeAuthJobSnapshot {
    if (!this.proc || this.state.status !== "running") {
      throw new Error("Claude auth job is not running");
    }
    const proc = this.proc;
    const procKind = this.procKind;
    let exited = false;
    let exitDisposable: nodePty.IDisposable | null = null;
    if (procKind === "pty") {
      exitDisposable = (proc as nodePty.IPty).onExit(() => {
        exited = true;
        exitDisposable?.dispose();
      });
    } else {
      (proc as ChildProcess).once("exit", () => {
        exited = true;
      });
    }
    this.appendLog("\n[admin cancelled auth job]\n");
    this.state.status = "cancelled";
    this.state.completed_at = new Date().toISOString();
    this.state.exit_code = null;
    this.state.signal = "SIGTERM";
    this.proc = null;
    this.procKind = null;
    if (procKind === "pty") {
      (proc as nodePty.IPty).kill("SIGTERM");
    } else {
      (proc as ChildProcess).kill("SIGTERM");
    }
    setTimeout(() => {
      if (exited) return;
      if (procKind === "pty") {
        (proc as nodePty.IPty).kill("SIGKILL");
      } else {
        (proc as ChildProcess).kill("SIGKILL");
      }
    }, 2000).unref();
    return this.snapshot();
  }

  snapshot(): ClaudeAuthJobSnapshot {
    return {
      ...this.state,
      args: [...this.state.args],
    };
  }

  private appendLog(chunk: Buffer | string): void {
    this.state.log += chunk.toString();
    if (this.state.log.length > MAX_LOG_CHARS) {
      this.state.log = this.state.log.slice(this.state.log.length - MAX_LOG_CHARS);
    }
  }

  private finish(
    status: Exclude<ClaudeAuthJobStatus, "idle" | "running" | "cancelled">,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.state.status !== "running") return;
    this.state.status = status;
    this.state.completed_at = new Date().toISOString();
    this.state.exit_code = code;
    this.state.signal = signal;
    this.proc = null;
    this.procKind = null;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}
