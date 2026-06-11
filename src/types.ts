// Hook payload types for Claude Code hooks

export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  effort?: { level: string };
  // PreToolUse specific
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  // PostToolUse specific
  tool_response?: unknown;
  duration_ms?: number;
  // Subagent context
  agent_id?: string;
  agent_type?: string;
}

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

export interface ToolRequest {
  session_id: string;
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
  timeout_ms: number;
}

export interface ToolResponse {
  session_id: string;
  request_id: string;
  ok: boolean;
  output?: string;
  metadata?: {
    bytes: number;
    source: string;
  };
  error?: {
    type: string;
    message: string;
  };
}

// ---- Session / Runner types ----

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
}

export interface TurnResult {
  result: string;
  session_id: string;
  usage: TurnUsage;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
}

export type SessionState =
  | "starting"
  | "ready"
  | "running"
  | "closed"
  | "failed";

export interface SessionInfo {
  id: string;
  state: SessionState;
  created_at: number;
  last_active_at: number;
  turns: number;
  cli_session_id: string | null;
}
