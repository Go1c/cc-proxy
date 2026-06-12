import { spawn, ChildProcess } from "child_process";

export type ClaudeAuthJobStatus = "idle" | "running" | "succeeded" | "failed";

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
}

const MAX_LOG_CHARS = 64 * 1024;

export class ClaudeAuthJob {
  private proc: ChildProcess | null = null;
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

    const proc = spawn(command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout?.on("data", (chunk) => this.appendLog(chunk));
    proc.stderr?.on("data", (chunk) => this.appendLog(chunk));
    proc.on("error", (err) => {
      this.appendLog(`${err.message}\n`);
      this.finish("failed", null, null);
    });
    proc.on("exit", (code, signal) => {
      this.finish(code === 0 ? "succeeded" : "failed", code, signal);
    });
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
    status: Exclude<ClaudeAuthJobStatus, "idle" | "running">,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.state.status !== "running") return;
    this.state.status = status;
    this.state.completed_at = new Date().toISOString();
    this.state.exit_code = code;
    this.state.signal = signal;
    this.proc = null;
  }
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
