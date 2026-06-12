import { randomUUID } from "crypto";
import { ClaudeRunner, ClaudeRunnerOptions, TurnCallbacks } from "./runner";
import {
  ClaudeTurnInput,
  SessionInfo,
  SessionState,
  SessionUsageSummary,
  TurnErrorDetails,
  TurnResult,
} from "./types";
import { RuntimeConfig, defaultRuntimeConfig } from "./control-plane";

const DEFAULT_RUNTIME_CONFIG = defaultRuntimeConfig();
const MAX_SESSIONS = DEFAULT_RUNTIME_CONFIG.max_cli_windows;
const IDLE_TIMEOUT_MS = DEFAULT_RUNTIME_CONFIG.cli_idle_timeout_ms;
const REAP_INTERVAL_MS = parseInt(
  process.env.CC_REAP_INTERVAL_MS || "60000",
  10
);

export class CapacityError extends Error {
  constructor(public readonly limit: number) {
    super(`window concurrency reached (max ${limit})`);
    this.name = "CapacityError";
  }
}

interface Session {
  id: string;
  runner: ClaudeRunner;
  state: SessionState;
  createdAt: number;
  lastActiveAt: number;
  turns: number;
  usage: SessionUsageSummary;
  totalDurationMs: number;
  lastError: TurnErrorDetails | null;
}

type SessionOptions = ClaudeRunnerOptions;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private reaper: NodeJS.Timeout;

  constructor(
    private readonly cwd: string,
    private readonly getConfig: () => RuntimeConfig = () => defaultRuntimeConfig()
  ) {
    this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  create(options: SessionOptions = {}): SessionInfo {
    const limit = this.getConfig().max_cli_windows;
    if (this.sessions.size >= limit) {
      throw new CapacityError(limit);
    }
    const id = randomUUID();
    const runner = new ClaudeRunner(this.cwd, options);
    const now = Date.now();
    const session: Session = {
      id,
      runner,
      state: "starting",
      createdAt: now,
      lastActiveAt: now,
      turns: 0,
      usage: emptySessionUsage(),
      totalDurationMs: 0,
      lastError: null,
    };
    runner.on("exit", () => {
      session.state = "closed";
      this.sessions.delete(id);
    });
    runner.on("error", () => {
      session.state = "failed";
    });
    runner.start();
    session.state = "ready";
    this.sessions.set(id, session);
    return this.toInfo(session);
  }

  async turn(
    id: string,
    input: ClaudeTurnInput,
    callbacks: TurnCallbacks = {}
  ): Promise<TurnResult> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("session not found");
    if (!session.runner.isAlive) throw new Error("session not alive");
    if (session.state === "running") {
      throw new Error("session is busy with another turn");
    }
    session.state = "running";
    session.lastActiveAt = Date.now();
    try {
      const result = await session.runner.send(
        input,
        this.getConfig().cli_turn_timeout_ms,
        callbacks
      );
      session.turns++;
      recordSessionUsage(session, result);
      return result;
    } finally {
      session.lastActiveAt = Date.now();
      if (session.runner.isAlive) session.state = "ready";
    }
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.runner.stop();
    session.state = "closed";
    this.sessions.delete(id);
    return true;
  }

  get(id: string): SessionInfo | null {
    const session = this.sessions.get(id);
    return session ? this.toInfo(session) : null;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.toInfo(s));
  }

  shutdown(): void {
    clearInterval(this.reaper);
    for (const session of this.sessions.values()) {
      session.runner.stop();
    }
    this.sessions.clear();
  }

  private reapIdle(): void {
    const now = Date.now();
    const idleTimeoutMs = this.getConfig().cli_idle_timeout_ms;
    for (const [id, session] of this.sessions) {
      if (
        session.state !== "running" &&
        now - session.lastActiveAt > idleTimeoutMs
      ) {
        session.runner.stop();
        session.state = "closed";
        this.sessions.delete(id);
      }
    }
  }

  private toInfo(session: Session): SessionInfo {
    return {
      id: session.id,
      state: session.state,
      created_at: session.createdAt,
      last_active_at: session.lastActiveAt,
      turns: session.turns,
      cli_session_id: session.runner.sessionId,
      usage: { ...session.usage },
      last_error: session.lastError ? { ...session.lastError } : null,
    };
  }
}

export { MAX_SESSIONS, IDLE_TIMEOUT_MS };

function emptySessionUsage(): SessionUsageSummary {
  return {
    request_count: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    average_duration_ms: 0,
    cache_read_rate: 0,
  };
}

function recordSessionUsage(session: Session, result: TurnResult): void {
  const usage = result.usage;
  session.usage.request_count++;
  session.usage.cost_usd += usage.total_cost_usd || 0;
  session.usage.input_tokens += usage.input_tokens || 0;
  session.usage.output_tokens += usage.output_tokens || 0;
  session.usage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  session.usage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  session.usage.total_tokens =
    session.usage.input_tokens +
    session.usage.output_tokens +
    session.usage.cache_creation_input_tokens +
    session.usage.cache_read_input_tokens;

  session.totalDurationMs += result.duration_ms || 0;
  session.usage.average_duration_ms =
    session.usage.request_count > 0
      ? Number((session.totalDurationMs / session.usage.request_count).toFixed(2))
      : 0;

  const cacheDenominator =
    session.usage.input_tokens +
    session.usage.cache_creation_input_tokens +
    session.usage.cache_read_input_tokens;
  session.usage.cache_read_rate =
    cacheDenominator > 0
      ? Number((session.usage.cache_read_input_tokens / cacheDenominator).toFixed(6))
      : 0;
  session.usage.cost_usd = Number(session.usage.cost_usd.toFixed(6));
  session.lastError = result.is_error && result.error ? { ...result.error } : null;
}
