import { randomUUID } from "crypto";
import { ClaudeContentBlock, TurnUsage } from "./types";

const DEFAULT_CLIENT_TOOL_TIMEOUT_MS = parseInt(
  process.env.CC_CLIENT_TOOL_TIMEOUT_MS || "300000",
  10
);

export interface ClientToolSpec {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface ClientToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClientToolCall {
  id: string;
  name: string;
  input: unknown;
  toolUseId?: string;
  timer: NodeJS.Timeout;
  resolve: (result: McpToolCallResult) => void;
  reject: (err: Error) => void;
}

interface ToolUseBlock extends ClaudeContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ActiveBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  inputJson?: string;
  raw?: any;
}

type SyntheticToolUseListener = (block: ToolUseBlock) => void;

export interface ClientToolUseBatch {
  messageId: string;
  content: ClaudeContentBlock[];
  toolUseIds: Set<string>;
  usage: TurnUsage;
}

export class ClientToolBridge {
  readonly id = randomUUID();
  readonly token = randomUUID();
  private calls: ClientToolCall[] = [];
  private toolUses: ToolUseBlock[] = [];
  private queuedResults = new Map<string, ClientToolResultBlock>();
  private syntheticToolUseIds = new Set<string>();
  private syntheticToolUseListeners: SyntheticToolUseListener[] = [];

  constructor(
    readonly tools: ClientToolSpec[],
    private readonly timeoutMs = DEFAULT_CLIENT_TOOL_TIMEOUT_MS
  ) {}

  normalizeToolUseName(name: string): string | null {
    if (this.tools.some((tool) => tool.name === name)) return name;

    const mcpPrefix = "mcp__cc_client_tools__";
    if (name.startsWith(mcpPrefix)) {
      const unprefixed = name.slice(mcpPrefix.length);
      if (this.tools.some((tool) => tool.name === unprefixed)) {
        return unprefixed;
      }
    }

    return null;
  }

  waitForCall(name: string, input: unknown): Promise<McpToolCallResult> {
    return new Promise((resolve, reject) => {
      const call: ClientToolCall = {
        id: randomUUID(),
        name,
        input,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.calls = this.calls.filter((item) => item.id !== call.id);
          reject(new Error(`Timed out waiting for client tool_result: ${name}`));
        }, this.timeoutMs),
      };
      call.timer.unref?.();
      this.calls.push(call);
      this.pairCalls();
      this.promoteUnpairedCallToSyntheticToolUse(call);
    });
  }

  registerToolUse(block: ToolUseBlock): boolean {
    if (this.toolUses.some((item) => item.id === block.id)) return false;
    if (this.matchesPromotedSyntheticToolUse(block)) return false;
    this.toolUses.push(block);
    this.pairCalls();
    return true;
  }

  deliverToolResult(result: ClientToolResultBlock): boolean {
    const call = this.calls.find((item) => item.toolUseId === result.tool_use_id);
    if (!call) {
      if (this.toolUses.some((item) => item.id === result.tool_use_id)) {
        this.queuedResults.set(result.tool_use_id, result);
        return true;
      }
      return false;
    }
    this.resolveCall(call, result);
    return true;
  }

  onSyntheticToolUse(listener: SyntheticToolUseListener): () => void {
    this.syntheticToolUseListeners.push(listener);
    return () => {
      this.syntheticToolUseListeners = this.syntheticToolUseListeners.filter((item) => item !== listener);
    };
  }

  dispose(): void {
    for (const call of this.calls) {
      clearTimeout(call.timer);
      call.reject(new Error("Client tool bridge disposed"));
    }
    this.calls = [];
    this.queuedResults.clear();
    this.syntheticToolUseListeners = [];
  }

  private pairCalls(): void {
    for (const call of this.calls) {
      if (call.toolUseId) continue;
      const toolUse = this.toolUses.find((candidate) => {
        if (this.calls.some((item) => item.toolUseId === candidate.id)) {
          return false;
        }
        if (candidate.name !== call.name) return false;
        return sameJson(candidate.input, call.input);
      }) || this.toolUses.find((candidate) => {
        return (
          candidate.name === call.name &&
          !this.calls.some((item) => item.toolUseId === candidate.id)
        );
      });
      if (!toolUse) continue;

      call.toolUseId = toolUse.id;
      const queued = this.queuedResults.get(toolUse.id);
      if (queued) {
        this.queuedResults.delete(toolUse.id);
        this.resolveCall(call, queued);
      }
    }
  }

  private promoteUnpairedCallToSyntheticToolUse(call: ClientToolCall): void {
    if (call.toolUseId) return;

    const block: ToolUseBlock = {
      type: "tool_use",
      id: makeToolUseId(),
      name: call.name,
      input: call.input ?? {},
    };
    call.toolUseId = block.id;
    this.toolUses.push(block);
    this.syntheticToolUseIds.add(block.id);
    for (const listener of this.syntheticToolUseListeners) {
      listener(block);
    }

    const queued = this.queuedResults.get(block.id);
    if (queued) {
      this.queuedResults.delete(block.id);
      this.resolveCall(call, queued);
    }
  }

  private matchesPromotedSyntheticToolUse(block: ToolUseBlock): boolean {
    return this.calls.some((call) => {
      return (
        !!call.toolUseId &&
        this.syntheticToolUseIds.has(call.toolUseId) &&
        call.name === block.name &&
        sameJson(call.input, block.input)
      );
    });
  }

  private resolveCall(call: ClientToolCall, result: ClientToolResultBlock): void {
    clearTimeout(call.timer);
    this.calls = this.calls.filter((item) => item.id !== call.id);
    call.resolve(formatMcpToolResult(result));
  }
}

export class ClientToolTurn {
  readonly bridge: ClientToolBridge;
  readonly content: ClaudeContentBlock[] = [];
  readonly bufferedEvents: any[] = [];
  readonly initialReady: Promise<void>;
  readonly toolUseIds = new Set<string>();
  messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  usage: TurnUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
  };
  stopReason: string | null = null;
  streamSink?: (event: any, raw: any) => void;
  private activeBlocks = new Map<number, ActiveBlock>();
  private currentToolUseIds = new Set<string>();
  private readyBatches: ClientToolUseBatch[] = [];
  private readyBatchWaiters: Array<(batch: ClientToolUseBatch) => void> = [];
  private resolveInitialReady!: () => void;
  private initialReadyResolved = false;

  constructor(
    bridge: ClientToolBridge,
    readonly model: string,
    readonly sessionId: string,
    readonly closeAfterFinal: boolean
  ) {
    this.bridge = bridge;
    this.initialReady = new Promise((resolve) => {
      this.resolveInitialReady = resolve;
    });
    this.bridge.onSyntheticToolUse((block) => {
      this.toolUseIds.add(block.id);
      this.enqueueReadyBatch({
        messageId: this.messageId,
        content: [{ ...block }],
        toolUseIds: new Set([block.id]),
        usage: { ...this.usage },
      });
    });
  }

  handleStreamEvent(event: any, raw: any): void {
    this.bufferedEvents.push(event);
    this.streamSink?.(event, raw);

    if (event.type === "message_start") {
      if (event.message?.id) this.messageId = event.message.id;
      this.content.length = 0;
      this.currentToolUseIds.clear();
      this.stopReason = null;
      this.usage.input_tokens = event.message?.usage?.input_tokens || 0;
      this.usage.cache_creation_input_tokens =
        event.message?.usage?.cache_creation_input_tokens || 0;
      this.usage.cache_read_input_tokens =
        event.message?.usage?.cache_read_input_tokens || 0;
      return;
    }

    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "tool_use") {
        this.activeBlocks.set(event.index, {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputJson: block.input && Object.keys(block.input).length > 0
            ? JSON.stringify(block.input)
            : "",
          raw: block,
        });
      } else if (block.type === "text") {
        this.activeBlocks.set(event.index, { type: "text", text: "" });
      } else {
        this.activeBlocks.set(event.index, { type: block.type || "content", raw: block });
      }
      return;
    }

    if (event.type === "content_block_delta") {
      const active = this.activeBlocks.get(event.index);
      if (!active) return;
      const delta = event.delta || {};
      if (delta.type === "text_delta") {
        active.text = `${active.text || ""}${delta.text || ""}`;
      } else if (delta.type === "input_json_delta") {
        active.inputJson = `${active.inputJson || ""}${delta.partial_json || ""}`;
      }
      return;
    }

    if (event.type === "content_block_stop") {
      const active = this.activeBlocks.get(event.index);
      if (!active) return;
      this.activeBlocks.delete(event.index);
      if (active.type === "tool_use" && active.id && active.name) {
        const normalizedName = this.bridge.normalizeToolUseName(active.name);
        if (!normalizedName) return;
        const block: ToolUseBlock = {
          type: "tool_use",
          id: active.id,
          name: normalizedName,
          input: parseToolInput(active.inputJson || ""),
        };
        if (this.bridge.registerToolUse(block)) {
          this.content.push(block);
          this.toolUseIds.add(block.id);
          this.currentToolUseIds.add(block.id);
        }
      } else if (active.type === "text") {
        this.content.push({ type: "text", text: active.text || "" });
      } else if (active.raw) {
        this.content.push(active.raw);
      }
      return;
    }

    if (event.type === "message_delta") {
      this.stopReason = event.delta?.stop_reason || this.stopReason;
      this.usage.output_tokens = event.usage?.output_tokens || this.usage.output_tokens;
      return;
    }

    if (
      event.type === "message_stop" &&
      this.currentToolUseIds.size > 0 &&
      this.stopReason === "tool_use" &&
      this.content.some((block) => block.type === "tool_use")
    ) {
      const batch: ClientToolUseBatch = {
        messageId: this.messageId,
        content: this.content.map((block) => ({ ...block })),
        toolUseIds: new Set(this.currentToolUseIds),
        usage: { ...this.usage },
      };
      this.enqueueReadyBatch(batch);
    }
  }

  takeReadyToolUseBatch(): ClientToolUseBatch | null {
    return this.readyBatches.shift() || null;
  }

  waitForReadyToolUseBatch(): Promise<ClientToolUseBatch> {
    const batch = this.takeReadyToolUseBatch();
    if (batch) return Promise.resolve(batch);
    return new Promise((resolve) => {
      this.readyBatchWaiters.push(resolve);
    });
  }

  makeToolUseMessage(batch: ClientToolUseBatch): any {
    const toolUseContent = batch.content.filter((block) => {
      return block.type === "tool_use" && batch.toolUseIds.has(String(block.id || ""));
    });
    return {
      id: batch.messageId,
      type: "message",
      role: "assistant",
      model: this.model,
      content: toolUseContent.length > 0 ? toolUseContent : batch.content,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: batch.usage,
    };
  }

  makeInitialMessage(): any {
    return this.makeToolUseMessage({
      messageId: this.messageId,
      content: this.content,
      toolUseIds: new Set(this.currentToolUseIds),
      usage: this.usage,
    });
  }

  private enqueueReadyBatch(batch: ClientToolUseBatch): void {
    const waiter = this.readyBatchWaiters.shift();
    if (waiter) {
      waiter(batch);
    } else {
      this.readyBatches.push(batch);
    }

    if (!this.initialReadyResolved) {
      this.initialReadyResolved = true;
      this.resolveInitialReady();
    }
  }
}

export function extractToolResults(body: any): ClientToolResultBlock[] {
  if (!Array.isArray(body?.messages)) return [];
  const results: ClientToolResultBlock[] = [];
  for (const message of body.messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.tool_use_id
      ) {
        results.push(block as ClientToolResultBlock);
      }
    }
  }
  return results;
}

function parseToolInput(inputJson: string): unknown {
  if (!inputJson) return {};
  try {
    return JSON.parse(inputJson);
  } catch {
    return {};
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function makeToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, "")}`;
}

function formatMcpToolResult(result: ClientToolResultBlock): McpToolCallResult {
  return {
    content: [{ type: "text", text: toolResultContentToText(result.content) }],
    isError: !!result.is_error,
  };
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}
