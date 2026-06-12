import fs from "fs";
import path from "path";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "crypto";

export interface RuntimeConfig {
  max_cli_windows: number;
  cli_idle_timeout_ms: number;
  cli_turn_timeout_ms: number;
  quota_cooldown_ms: number;
  claude_command: string;
  claude_model: string;
  claude_permission_mode: string;
  claude_effort: string;
  claude_setting_sources: string;
  claude_auth_login_args: string;
  claude_auth_status_args: string;
  client_tool_timeout_ms: number;
}

export interface AdminUser {
  username: string;
  password_hash: string;
  password_salt: string;
  created_at: string;
}

export interface StoredApiKey {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  created_at: string;
  enabled: boolean;
}

interface ControlPlaneState {
  admin: AdminUser | null;
  config: RuntimeConfig;
  api_keys: StoredApiKey[];
}

const DEFAULT_CLAUDE_AUTH_LOGIN_ARGS = "setup-token";

export interface CreatedApiKey {
  id: string;
  name: string;
  value: string;
  prefix: string;
  created_at: string;
  enabled: boolean;
}

export type PublicApiKey = Omit<StoredApiKey, "key_hash">;

export class ControlPlane {
  private state: ControlPlaneState;
  private readonly adminTokens = new Map<string, { username: string; expiresAt: number }>();

  constructor(
    private readonly filePath: string,
    defaults: Partial<RuntimeConfig> = {}
  ) {
    this.state = this.load(defaults);
    this.save();
  }

  get configured(): boolean {
    return !!this.state.admin;
  }

  setupAdmin(username: string, password: string): { token: string; username: string } {
    if (this.state.admin) {
      throw new Error("admin already configured");
    }
    const cleanUsername = normalizeUsername(username);
    validatePassword(password);
    const salt = randomBytes(16).toString("hex");
    this.state.admin = {
      username: cleanUsername,
      password_hash: hashSecret(password, salt),
      password_salt: salt,
      created_at: new Date().toISOString(),
    };
    this.save();
    return { token: this.issueAdminToken(cleanUsername), username: cleanUsername };
  }

  login(username: string, password: string): { token: string; username: string } | null {
    const admin = this.state.admin;
    if (!admin || normalizeUsername(username) !== admin.username) return null;
    if (!verifySecret(password, admin.password_salt, admin.password_hash)) return null;
    return { token: this.issueAdminToken(admin.username), username: admin.username };
  }

  verifyAdminToken(token: string): boolean {
    const record = this.adminTokens.get(token);
    if (!record) return false;
    if (Date.now() >= record.expiresAt) {
      this.adminTokens.delete(token);
      return false;
    }
    return true;
  }

  getConfig(): RuntimeConfig {
    return { ...this.state.config };
  }

  updateConfig(next: Partial<RuntimeConfig>): RuntimeConfig {
    const config = normalizeRuntimeConfig({ ...this.state.config, ...next });
    this.state.config = config;
    this.save();
    return this.getConfig();
  }

  createApiKey(name: string): CreatedApiKey {
    const cleanName = normalizeApiKeyName(name);
    const value = `ccp_${randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    const stored: StoredApiKey = {
      id: randomUUID(),
      name: cleanName,
      key_hash: hashApiKey(value),
      prefix: value.slice(0, 12),
      created_at: now,
      enabled: true,
    };
    this.state.api_keys.push(stored);
    this.save();
    return {
      id: stored.id,
      name: stored.name,
      value,
      prefix: stored.prefix,
      created_at: stored.created_at,
      enabled: stored.enabled,
    };
  }

  listApiKeys(): PublicApiKey[] {
    return this.state.api_keys.map(({ key_hash: _keyHash, ...key }) => ({ ...key }));
  }

  updateApiKey(id: string, patch: { name?: string; enabled?: boolean }): PublicApiKey | null {
    const key = this.state.api_keys.find((entry) => entry.id === id);
    if (!key) return null;
    if (patch.name !== undefined) {
      key.name = normalizeApiKeyName(patch.name);
    }
    if (patch.enabled !== undefined) {
      key.enabled = !!patch.enabled;
    }
    this.save();
    const { key_hash: _keyHash, ...publicKey } = key;
    return { ...publicKey };
  }

  deleteApiKey(id: string): PublicApiKey | null {
    const index = this.state.api_keys.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [removed] = this.state.api_keys.splice(index, 1);
    this.save();
    const { key_hash: _keyHash, ...publicKey } = removed;
    return { ...publicKey };
  }

  verifyApiKey(value: string): boolean {
    if (!value) return false;
    const hash = hashApiKey(value);
    return this.state.api_keys.some((key) => key.enabled && key.key_hash === hash);
  }

  private issueAdminToken(username: string): string {
    const token = `adm_${randomBytes(24).toString("base64url")}`;
    this.adminTokens.set(token, {
      username,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return token;
  }

  private load(defaults: Partial<RuntimeConfig>): ControlPlaneState {
    const defaultState: ControlPlaneState = {
      admin: null,
      config: normalizeRuntimeConfig({ ...defaultRuntimeConfig(), ...defaults }),
      api_keys: [],
    };
    try {
      if (!fs.existsSync(this.filePath)) return defaultState;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return {
        admin: isAdminUser(parsed.admin) ? parsed.admin : null,
        config: normalizeRuntimeConfig({
          ...defaultState.config,
          ...(parsed.config && typeof parsed.config === "object" ? parsed.config : {}),
        }),
        api_keys: Array.isArray(parsed.api_keys)
          ? parsed.api_keys.filter(isStoredApiKey)
          : [],
      };
    } catch {
      return defaultState;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    max_cli_windows: parsePositiveInt(process.env.CC_MAX_SESSIONS, 10),
    cli_idle_timeout_ms: parsePositiveInt(process.env.CC_IDLE_TIMEOUT_MS, 600_000),
    cli_turn_timeout_ms: parsePositiveInt(process.env.CC_TURN_TIMEOUT_MS, 120_000),
    quota_cooldown_ms: 5 * 60 * 60 * 1000,
    claude_command: normalizeOptionalString(process.env.CLAUDE_COMMAND, 500),
    claude_model: normalizeOptionalString(process.env.CC_CLAUDE_MODEL, 120),
    claude_permission_mode: normalizeOptionalString(process.env.CC_PERMISSION_MODE, 80),
    claude_effort: normalizeOptionalString(process.env.CC_CLAUDE_EFFORT, 40),
    claude_setting_sources: normalizeOptionalString(process.env.CC_CLAUDE_SETTING_SOURCES, 160),
    claude_auth_login_args: normalizeClaudeAuthLoginArgs(process.env.CC_CLAUDE_AUTH_LOGIN_ARGS),
    claude_auth_status_args: normalizeOptionalString(process.env.CC_CLAUDE_AUTH_STATUS_ARGS || "--version", 200),
    client_tool_timeout_ms: parsePositiveInt(process.env.CC_CLIENT_TOOL_TIMEOUT_MS, 300_000),
  };
}

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRuntimeConfig(value: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    max_cli_windows: boundedInt(value.max_cli_windows, 1, 100, 10),
    cli_idle_timeout_ms: boundedInt(value.cli_idle_timeout_ms, 1_000, 24 * 60 * 60 * 1000, 600_000),
    cli_turn_timeout_ms: boundedInt(value.cli_turn_timeout_ms, 1_000, 24 * 60 * 60 * 1000, 120_000),
    quota_cooldown_ms: boundedInt(value.quota_cooldown_ms, 0, 30 * 24 * 60 * 60 * 1000, 5 * 60 * 60 * 1000),
    claude_command: normalizeOptionalString(value.claude_command, 500),
    claude_model: normalizeOptionalString(value.claude_model, 120),
    claude_permission_mode: normalizeOptionalString(value.claude_permission_mode, 80),
    claude_effort: normalizeOptionalString(value.claude_effort, 40),
    claude_setting_sources: normalizeOptionalString(value.claude_setting_sources, 160),
    claude_auth_login_args: normalizeClaudeAuthLoginArgs(value.claude_auth_login_args),
    claude_auth_status_args: normalizeOptionalString(value.claude_auth_status_args, 200),
    client_tool_timeout_ms: boundedInt(value.client_tool_timeout_ms, 1_000, 24 * 60 * 60 * 1000, 300_000),
  };
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeOptionalString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeClaudeAuthLoginArgs(value: unknown): string {
  const normalized = normalizeOptionalString(value, 200);
  if (!normalized || normalized === "login") return DEFAULT_CLAUDE_AUTH_LOGIN_ARGS;
  return normalized;
}

function normalizeUsername(username: string): string {
  const value = String(username || "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(value)) {
    throw new Error("username must be 3-64 characters and contain only letters, numbers, dot, dash, or underscore");
  }
  return value;
}

function normalizeApiKeyName(name: string): string {
  const value = String(name || "").trim();
  if (!value || value.length > 120) {
    throw new Error("API key name must be 1-120 characters");
  }
  return value;
}

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
}

function hashSecret(secret: string, salt: string): string {
  return scryptSync(secret, salt, 32).toString("hex");
}

function verifySecret(secret: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAdminUser(value: unknown): value is AdminUser {
  if (!value || typeof value !== "object") return false;
  const admin = value as Partial<AdminUser>;
  return (
    typeof admin.username === "string" &&
    typeof admin.password_hash === "string" &&
    typeof admin.password_salt === "string" &&
    typeof admin.created_at === "string"
  );
}

function isStoredApiKey(value: unknown): value is StoredApiKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<StoredApiKey>;
  return (
    typeof key.id === "string" &&
    typeof key.name === "string" &&
    typeof key.key_hash === "string" &&
    typeof key.prefix === "string" &&
    typeof key.created_at === "string" &&
    typeof key.enabled === "boolean"
  );
}
