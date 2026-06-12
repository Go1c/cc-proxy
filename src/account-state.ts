import fs from "fs";
import path from "path";
import { TurnErrorDetails, TurnUsage } from "./types";

export interface AccountLastError {
  status: number;
  type: string;
  message: string;
  at: string;
}

export interface AccountStatusSnapshot {
  status: "ready" | "cooldown" | "error";
  cooldown_until: string | null;
  limits: AccountLimits;
  usage: AccountUsageSummary;
  last_error: AccountLastError | null;
}

export interface UsageWindow {
  request_count: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  average_duration_ms: number;
  cache_read_rate: number;
}

export interface AccountUsageSummary {
  today: UsageWindow;
  week: UsageWindow;
  month: UsageWindow;
}

export interface AccountLimits {
  five_hour: LimitSnapshot;
  weekly: LimitSnapshot;
}

export interface LimitSnapshot {
  status: "ok" | "cooldown" | "limited" | "unknown";
  percent_remaining: number | null;
  reset_at: string | null;
  message: string | null;
}

interface UsageSample extends TurnUsage {
  at: number;
  duration_ms: number;
}

export class AccountState {
  private status: AccountStatusSnapshot["status"] = "ready";
  private cooldownUntilMs: number | null = null;
  private lastError: AccountLastError | null = null;
  private usageSamples: UsageSample[] = [];
  private limits: AccountLimits = {
    five_hour: { status: "ok", percent_remaining: null, reset_at: null, message: null },
    weekly: { status: "ok", percent_remaining: null, reset_at: null, message: null },
  };

  constructor(
    private readonly filePath?: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.load();
  }

  markSuccess(usage?: TurnUsage, durationMs = 0): void {
    if (usage) {
      this.usageSamples.push({ ...usage, at: this.now(), duration_ms: durationMs });
      this.pruneUsageSamples();
    }
    if (this.cooldownUntilMs !== null && this.now() < this.cooldownUntilMs) {
      if (usage) this.save();
      return;
    }
    this.status = "ready";
    this.cooldownUntilMs = null;
    this.limits.five_hour = { status: "ok", percent_remaining: null, reset_at: null, message: null };
    this.limits.weekly = { status: "ok", percent_remaining: null, reset_at: null, message: null };
    this.save();
  }

  markError(error: TurnErrorDetails | undefined, cooldownMs: number): void {
    const status = normalizeStatusCode(error?.status_code);
    const type = normalizeErrorType(error?.type);
    const message = normalizeMessage(error?.message);
    this.lastError = {
      status,
      type,
      message,
      at: new Date(this.now()).toISOString(),
    };

    if (isQuotaLikeError(status, type, message) && cooldownMs > 0) {
      this.status = "cooldown";
      this.cooldownUntilMs = this.now() + cooldownMs;
      const limit = classifyLimit(type, message);
      const snapshot: LimitSnapshot = {
        status: "cooldown",
        percent_remaining: extractPercentRemaining(error),
        reset_at: new Date(this.cooldownUntilMs).toISOString(),
        message,
      };
      if (limit === "weekly") {
        this.limits.weekly = snapshot;
      } else {
        this.limits.five_hour = snapshot;
      }
      this.save();
      return;
    }

    this.status = "error";
    this.cooldownUntilMs = null;
    this.save();
  }

  snapshot(): AccountStatusSnapshot {
    if (this.cooldownUntilMs !== null && this.now() >= this.cooldownUntilMs) {
      this.status = "ready";
      this.cooldownUntilMs = null;
      this.save();
    }
    return {
      status: this.status,
      cooldown_until:
        this.cooldownUntilMs === null
          ? null
          : new Date(this.cooldownUntilMs).toISOString(),
      limits: this.currentLimits(),
      usage: this.usageSummary(),
      last_error: this.lastError ? { ...this.lastError } : null,
    };
  }

  private currentLimits(): AccountLimits {
    return {
      five_hour: { ...this.limits.five_hour },
      weekly: { ...this.limits.weekly },
    };
  }

  private usageSummary(): AccountUsageSummary {
    const now = this.now();
    return {
      today: summarizeUsage(this.usageSamples, startOfLocalDay(now)),
      week: summarizeUsage(this.usageSamples, startOfLocalWeek(now)),
      month: summarizeUsage(this.usageSamples, startOfLocalMonth(now)),
    };
  }

  private pruneUsageSamples(): void {
    const cutoff = this.now() - 370 * 24 * 60 * 60 * 1000;
    this.usageSamples = this.usageSamples.filter((sample) => sample.at >= cutoff);
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (parsed.status === "ready" || parsed.status === "cooldown" || parsed.status === "error") {
        this.status = parsed.status;
      }
      if (typeof parsed.cooldownUntilMs === "number") {
        this.cooldownUntilMs = parsed.cooldownUntilMs;
      }
      if (parsed.lastError && typeof parsed.lastError === "object") {
        this.lastError = parsed.lastError;
      }
      if (parsed.limits && typeof parsed.limits === "object") {
        this.limits = {
          five_hour: isLimitSnapshot(parsed.limits.five_hour)
            ? parsed.limits.five_hour
            : this.limits.five_hour,
          weekly: isLimitSnapshot(parsed.limits.weekly)
            ? parsed.limits.weekly
            : this.limits.weekly,
        };
      }
      if (Array.isArray(parsed.usageSamples)) {
        this.usageSamples = parsed.usageSamples.filter(isUsageSample);
        this.pruneUsageSamples();
      }
    } catch {
      this.status = "ready";
      this.cooldownUntilMs = null;
      this.lastError = null;
      this.usageSamples = [];
    }
  }

  private save(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          status: this.status,
          cooldownUntilMs: this.cooldownUntilMs,
          lastError: this.lastError,
          limits: this.limits,
          usageSamples: this.usageSamples,
        },
        null,
        2
      ),
      "utf-8"
    );
  }
}

function normalizeStatusCode(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 502;
}

function normalizeErrorType(value: unknown): string {
  return typeof value === "string" && value ? value : "api_error";
}

function normalizeMessage(value: unknown): string {
  return typeof value === "string" && value ? value : "Claude Code turn failed";
}

function isQuotaLikeError(status: number, type: string, message: string): boolean {
  const haystack = `${type}\n${message}`.toLowerCase();
  return (
    status === 429 ||
    haystack.includes("rate_limit") ||
    haystack.includes("quota") ||
    haystack.includes("limit") ||
    haystack.includes("上限")
  );
}

function classifyLimit(type: string, message: string): "five_hour" | "weekly" {
  const haystack = `${type}\n${message}`.toLowerCase();
  if (haystack.includes("week") || haystack.includes("weekly") || haystack.includes("周")) {
    return "weekly";
  }
  return "five_hour";
}

function extractPercentRemaining(error: TurnErrorDetails | undefined): number | null {
  const body = error?.body;
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  for (const key of ["percent_remaining", "remaining_percent", "quota_percent_remaining"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1 ? value / 100 : value;
    }
  }
  const nestedError = raw.error;
  if (nestedError && typeof nestedError === "object") {
    return extractPercentRemaining({ body: nestedError });
  }
  return null;
}

function summarizeUsage(samples: UsageSample[], since: number): UsageWindow {
  const total: UsageWindow = {
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
  let durationMs = 0;
  for (const sample of samples) {
    if (sample.at < since) continue;
    total.request_count++;
    total.cost_usd += sample.total_cost_usd;
    total.input_tokens += sample.input_tokens;
    total.output_tokens += sample.output_tokens;
    total.cache_creation_input_tokens += sample.cache_creation_input_tokens;
    total.cache_read_input_tokens += sample.cache_read_input_tokens;
    durationMs += sample.duration_ms;
  }
  total.total_tokens =
    total.input_tokens +
    total.output_tokens +
    total.cache_creation_input_tokens +
    total.cache_read_input_tokens;
  const cacheDenominator =
    total.input_tokens +
    total.cache_creation_input_tokens +
    total.cache_read_input_tokens;
  total.cache_read_rate =
    cacheDenominator > 0 ? total.cache_read_input_tokens / cacheDenominator : 0;
  total.average_duration_ms =
    total.request_count > 0 ? Number((durationMs / total.request_count).toFixed(2)) : 0;
  total.cost_usd = Number(total.cost_usd.toFixed(6));
  total.cache_read_rate = Number(total.cache_read_rate.toFixed(6));
  return total;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalWeek(timestamp: number): number {
  const date = new Date(startOfLocalDay(timestamp));
  const day = date.getDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return date.getTime();
}

function startOfLocalMonth(timestamp: number): number {
  const date = new Date(timestamp);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isLimitSnapshot(value: unknown): value is LimitSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LimitSnapshot>;
  return (
    (snapshot.status === "ok" ||
      snapshot.status === "cooldown" ||
      snapshot.status === "limited" ||
      snapshot.status === "unknown") &&
    (typeof snapshot.percent_remaining === "number" || snapshot.percent_remaining === null) &&
    (typeof snapshot.reset_at === "string" || snapshot.reset_at === null) &&
    (typeof snapshot.message === "string" || snapshot.message === null)
  );
}

function isUsageSample(value: unknown): value is UsageSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<UsageSample>;
  return (
    typeof sample.at === "number" &&
    typeof sample.input_tokens === "number" &&
    typeof sample.output_tokens === "number" &&
    typeof sample.cache_creation_input_tokens === "number" &&
    typeof sample.cache_read_input_tokens === "number" &&
    typeof sample.total_cost_usd === "number" &&
    typeof sample.duration_ms === "number"
  );
}
