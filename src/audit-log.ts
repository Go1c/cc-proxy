import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export interface AuditLogEntry {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  data?: unknown;
}

export class AuditLog {
  private readonly entries: AuditLogEntry[] = [];

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 1000
  ) {
    this.load();
  }

  record(
    level: AuditLogEntry["level"],
    event: string,
    message: string,
    data?: unknown
  ): AuditLogEntry {
    const entry: AuditLogEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      level,
      event,
      message,
      ...(data === undefined ? {} : { data }),
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    this.save();
    return entry;
  }

  list(limit = 100): AuditLogEntry[] {
    const bounded = Math.max(1, Math.min(limit, this.maxEntries));
    return this.entries.slice(0, bounded).map((entry) => ({ ...entry }));
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(parsed)) return;
      this.entries.splice(
        0,
        this.entries.length,
        ...parsed.filter(isAuditLogEntry).slice(0, this.maxEntries)
      );
    } catch {
      this.entries.length = 0;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8");
  }
}

function isAuditLogEntry(value: unknown): value is AuditLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AuditLogEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.at === "string" &&
    (entry.level === "info" || entry.level === "warn" || entry.level === "error") &&
    typeof entry.event === "string" &&
    typeof entry.message === "string"
  );
}
