import { randomUUID } from "crypto";
import { ClaudeRunner } from "./runner";
import { ClaudeTurnInput, SessionInfo, SessionState, TurnResult } from "./types";

const MAX_SESSIONS = parseInt(process.env.CC_MAX_SESSIONS || "10", 10);
const IDLE_TIMEOUT_MS = parseInt(
  process.env.CC_IDLE_TIMEOUT_MS || "600000",
  10
);
const REAP_INTERVAL_MS = parseInt(
  process.env.CC_REAP_INTERVAL_MS || "60000",
  10
);

export class CapacityError extends Error {
  constructor(public readonly limit: number) {
    super(`session capacity reached (max ${limit})`);
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
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private reaper: NodeJS.Timeout;

  constructor(private readonly cwd: string) {
    this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  create(): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new CapacityError(MAX_SESSIONS);
    }
    const id = randomUUID();
    const runner = new ClaudeRunner(this.cwd);
    const now = Date.now();
    const session: Session = {
      id,
      runner,
      state: "starting",
      createdAt: now,
      lastActiveAt: now,
      turns: 0,
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

  async turn(id: string, input: ClaudeTurnInput): Promise<TurnResult> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("session not found");
    if (!session.runner.isAlive) throw new Error("session not alive");
    if (session.state === "running") {
      throw new Error("session is busy with another turn");
    }
    session.state = "running";
    session.lastActiveAt = Date.now();
    try {
      const result = await session.runner.send(input);
      session.turns++;
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
    for (const [id, session] of this.sessions) {
      if (
        session.state !== "running" &&
        now - session.lastActiveAt > IDLE_TIMEOUT_MS
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
    };
  }
}

export { MAX_SESSIONS, IDLE_TIMEOUT_MS };
