import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { type DeepSeekSession } from "./session.js";
import type { ChatMessage, OpenAIChatRequest, RouterConfig } from "./types.js";

type FetchLike = typeof fetch;

export interface DeepSeekDependencies {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "messages must be a non-empty array", "invalid_messages");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new HttpError(400, `messages[${index}] must be an object`, "invalid_messages");
    }
    const { role, content } = entry as Record<string, unknown>;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new HttpError(
        400,
        `messages[${index}].role must be system, user, or assistant`,
        "unsupported_message_role",
      );
    }
    if (typeof content !== "string") {
      throw new HttpError(
        400,
        `messages[${index}].content must be a string`,
        "unsupported_content_type",
      );
    }
    return { role, content };
  });
}

/** Flatten the conversation into DeepSeek web's single prompt string. */
/** Max chars for the flattened web prompt (DeepSeek web practical limit). */
const MAX_PROMPT_CHARS = 60_000;

export function buildPrompt(messages: ChatMessage[]): string {
  const full = messages
    .map((message) => {
      if (message.role === "system") return `[System]\n${message.content}`;
      if (message.role === "assistant") return `[Assistant]\n${message.content}`;
      return message.content;
    })
    .join("\n\n");
  if (full.length <= MAX_PROMPT_CHARS) return full;
  console.error(`[buildPrompt] truncating ${full.length} -> ${MAX_PROMPT_CHARS}`);
  // Keep the opening instructions plus the most recent tail.
  const head = full.slice(0, 30_000);
  const tail = full.slice(-30_000);
  return `${head}\n\n[...middle of the conversation truncated; recent context follows...]\n\n${tail}`;
}

export function buildDeepSeekBody(
  input: OpenAIChatRequest,
  chatSessionId: string,
  thinking: boolean,
  parentMessageId: number | null = null,
): Record<string, unknown> {
  if (input.tools !== undefined || input.tool_choice !== undefined) {
    throw new HttpError(
      400,
      "DeepSeek web routing does not support tools or tool_choice",
      "unsupported_feature",
    );
  }
  const messages = validateMessages(input.messages);
  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== "number" || input.temperature < 0 || input.temperature > 2)
  ) {
    throw new HttpError(400, "temperature must be between 0 and 2", "invalid_parameter");
  }

  return {
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    model_type: "default",
    prompt: buildPrompt(messages),
    ref_file_ids: [],
    thinking_enabled: thinking,
    search_enabled: process.env.DEEPSEEK_SEARCH !== "false",
    action: null,
    preempt: false,
  };
}

/**
 * One SSE frame from DeepSeek web. Stream protocol (verified 2026-10-18):
 *   data: {"v":{...initial response envelope with THINK fragment...}}
 *   data: {"v":"text"}                       — APPEND to current fragment content
 *   data: {"p":"response/fragments","o":"APPEND","v":[{type:"RESPONSE"|"THINK",...}]}
 *   data: {"p":"...","o":"SET"|"BATCH",...}  — metadata updates
 *   event: title / close / update_session
 * The active fragment type switches via APPEND of a new fragment: THINK deltas
 * arrive while the newest fragment is THINK; once a RESPONSE fragment is
 * appended, subsequent bare {"v":"..."} deltas are visible answer text.
 */
export interface StreamDelta {
  text: string;
  thinking: string;
  finishReason: string | null;
}

export function deltaFromPayload(
  raw: string,
  state: { currentFragmentIsThink: boolean; lastMessageId?: number; finished?: boolean },
): StreamDelta {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { text: "", thinking: "", finishReason: null };
  }
  if (!frame || typeof frame !== "object") {
    return { text: "", thinking: "", finishReason: null };
  }

  const path = typeof frame.p === "string" ? frame.p : undefined;
  const op = typeof frame.o === "string" ? frame.o : undefined;
  const value = frame.v;

  // Initial envelope: {"v":{"response":{..., "fragments":[{type,content}, ...]}}}
  // Short answers can arrive fully contained here.
  if (!path && value && typeof value === "object" && !Array.isArray(value)) {
    const response = (value as Record<string, unknown>).response as
      | Record<string, unknown>
      | undefined;
    if (response && typeof response.message_id === "number") {
      state.lastMessageId = response.message_id;
    }
    const fragments = response?.fragments;
    if (Array.isArray(fragments)) {
      let text = "";
      let thinking = "";
      for (const entry of fragments) {
        if (!entry || typeof entry !== "object") continue;
        const frag = entry as Record<string, unknown>;
        if (frag.type === "THINK" && typeof frag.content === "string") thinking += frag.content;
        if (frag.type === "RESPONSE" && typeof frag.content === "string") text += frag.content;
        if (frag.type === "THINK" || frag.type === "RESPONSE") {
          state.currentFragmentIsThink = frag.type === "THINK";
        }
      }
      if (response?.status === "WIP") {
        // Stream opened with initial content (common for short answers):
        // emit it now; subsequent bare deltas append to it.
        return { text, thinking, finishReason: null };
      }
      return { text, thinking, finishReason: "stop" };
    }
    return { text: "", thinking: "", finishReason: null };
  }

  // New fragment appended: switches THINK/RESPONSE mode.
  if (path === "response/fragments" && op === "APPEND" && Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object") {
        const frag = entry as Record<string, unknown>;
        state.currentFragmentIsThink = frag.type === "THINK";
        if (typeof frag.content === "string" && frag.content) {
          if (state.currentFragmentIsThink) {
            return { text: "", thinking: frag.content, finishReason: null };
          }
          return { text: frag.content, thinking: "", finishReason: null };
        }
      }
    }
    return { text: "", thinking: "", finishReason: null };
  }

  if (path === "response/status" && typeof value === "string") {
    if (value === "FINISHED") {
      state.finished = true;
      return { text: "", thinking: "", finishReason: "stop" };
    }
    return { text: "", thinking: "", finishReason: null };
  }
  if (frame.event === "close") {
    return { text: "", thinking: "", finishReason: "stop" };
  }

  // Bare delta: {"v":"text"} — appends to the current fragment.
  if (value === undefined || value === null || (typeof value === "object" && !Array.isArray(value))) {
    // {"v":{...}} envelope / heartbeats carry no visible delta.
    return { text: "", thinking: "", finishReason: null };
  }
  if (typeof value === "string") {
    if (state.currentFragmentIsThink) {
      return { text: "", thinking: value, finishReason: null };
    }
    return { text: value, thinking: "", finishReason: null };
  }
  return { text: "", thinking: "", finishReason: null };
}

export interface CompletionResult {
  text: string;
  thinking: string;
}

export interface DsmlToolCall {
  name: string;
  arguments: Record<string, unknown>;
  callId: string;
}

const DSML_OPEN = "<｜｜DSML｜｜ invoke";
const DSML_CALLS_OPEN = "<｜｜DSML｜｜ calls>";

/**
 * DeepSeek web emits its internal tool-call syntax (DSML) as plain text when
 * the model decides to call a tool. Parse these blocks out of the final text
 * and convert them to structured calls so the Responses layer can surface
 * proper function_call items to clients like Codex.
 * Format observed:
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="shell">
 *   <｜｜DSML｜｜ parameter name="command" string="true">...<｜｜DSML｜｜ /parameter>
 *   ...
 *   <｜｜DSML｜｜ /invoke>
 *   </｜｜DSML｜｜ calls>
 */
/** Codex's exec_command requires {cmd}; models frequently emit {command}/{commandline}. */
/**
 * Repair values where several unclosed parameters merged into one string:
 *   max_output_tokens: "12000falsepowershell"  ->  12000 + login:false + shell:powershell
 * Applies only to known boolean/string enum tails, never to free-form text.
 */
function splitMergedParamValues(args: Record<string, unknown>): void {
  const BOOL_TAIL = /^(\d+)(true|false)(powershell|bash|sh|cmd|zsh)?$/i;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const m = BOOL_TAIL.exec(value.trim());
    if (!m) continue;
    args[key] = Number(m[1]);
    args.login = m[2] === "true";
    if (m[3]) args.shell = m[3].toLowerCase();
  }
  // A workdir value glued onto the tail of cmd without its opener:
  //   "...; where.exe g++C:\Users\..."  ->  cmd + workdir
  if (typeof args.cmd === "string" && args.workdir === undefined) {
    const glued = /^(.*\S)([A-Za-z]:\\[^\n]*)$/.exec(args.cmd);
    if (glued && glued[2]!.includes("\\")) {
      args.cmd = glued[1]!;
      args.workdir = glued[2]!;
    }
  }
  // Numeric-looking strings for known numeric keys (Codex requires u64/usize).
  for (const key of ["yield_time_ms", "max_output_tokens", "timeout_ms", "timeout"]) {
    const v = args[key];
    if (typeof v === "string" && /^\d+$/.test(v.trim())) args[key] = Number(v.trim());
  }
}

function normalizeToolArgs(name: string, args: Record<string, unknown>): void {
  const n = name.toLowerCase();
  if (n.includes("exec") || n.includes("shell") || n.includes("command")) {
    if (args.cmd === undefined) {
      for (const alias of ["command", "commandline", "command_line", "line"]) {
        if (args[alias] !== undefined) {
          args.cmd = args[alias];
          delete args[alias];
          break;
        }
      }
    }
  }
}

export function extractDsmlToolCalls(
  rawText: string,
): { cleanText: string; toolCalls: DsmlToolCall[] } {
  // Normalize closing-tag variants: '<｜｜DSML｜｜ /invoke>' and '</｜｜DSML｜｜ invoke>'
  // are both observed. Canonicalize to '</｜｜DSML｜｜ xxx>' and strip stray whitespace.
  let text = rawText
    .replace(/<｜｜DSML｜｜ \/(invoke|parameter|calls)>/g, "</｜｜DSML｜｜ $1>")
    .replace(/<\/｜｜DSML｜｜\s*(invoke|parameter|calls)>/g, "</｜｜DSML｜｜ $1>")
    // Bare closer '</｜｜DSML｜｜>' (no tag word) observed closing params/invokes in the
    // wild — left in place it glues onto the previous param value ('...settlement</｜｜DSML｜｜>').
    // Convert to a canonical parameter closer; positional context is handled below.
    .replace(/<\/｜｜DSML｜｜>/g, "</｜｜DSML｜｜ parameter>")
    // Single-bar variants '<｜DSML｜｜ ...>' / '</｜DSML｜｜ ...>' observed from a
    // degenerate model turn — normalize to the double-bar canonical form.
    .replace(/<\/?｜DSML｜｜\s*\/?(invoke|parameter|calls)?>/g, (m) => m.replace("｜DSML｜｜", "｜｜DSML｜｜"));

  // Repair: when a parameter value failed to close before the next opener (streaming
  // adjacency corruption), close it just before the opener. Walk openers/closers and
  // insert synthetic closers where a value runs into a new opener or invoke closer.
  {
    const OPEN_PARAM = "<｜｜DSML｜｜ parameter";
    const CLOSE_PARAM = "</｜｜DSML｜｜ parameter>";
    const CLOSE_INVOKE = "</｜｜DSML｜｜ invoke>";
    let repaired = "";
    let pos = 0;
    let inParam = false;
    while (pos < text.length) {
      const nextOpen = text.indexOf(OPEN_PARAM, pos);
      const nextCloseParam = inParam ? text.indexOf(CLOSE_PARAM, pos) : -1;
      const nextCloseInvoke = text.indexOf(CLOSE_INVOKE, pos);
      // Find which comes first among: new opener (with name=), close param (if inParam), close invoke
      if (nextOpen === -1) {
        repaired += text.slice(pos);
        break;
      }
      const isOpenRelevant = text.startsWith("name=", nextOpen + OPEN_PARAM.length) || text.startsWith(" name=", nextOpen + OPEN_PARAM.length);
      if (inParam) {
        // If an opener or close-invoke arrives before our close-param, close the dangling param.
        if (isOpenRelevant && (nextCloseParam === -1 || nextOpen < nextCloseParam)) {
          repaired += text.slice(pos, nextOpen) + CLOSE_PARAM;
          inParam = false;
          pos = nextOpen;
          continue;
        }
        if (nextCloseInvoke !== -1 && (nextCloseParam === -1 || nextCloseInvoke < nextCloseParam)) {
          repaired += text.slice(pos, nextCloseInvoke) + CLOSE_PARAM;
          inParam = false;
          pos = nextCloseInvoke;
          continue;
        }
      } else if (isOpenRelevant) {
        inParam = true;
      }
      // advance to the next interesting token
      const candidates = [nextOpen + OPEN_PARAM.length];
      if (nextCloseParam !== -1) candidates.push(nextCloseParam + CLOSE_PARAM.length);
      if (nextCloseInvoke !== -1) candidates.push(nextCloseInvoke + CLOSE_INVOKE.length);
      const next = Math.min(...candidates.filter((c) => c > pos));
      if (!Number.isFinite(next) || next <= pos) { repaired += text.slice(pos); break; }
      repaired += text.slice(pos, next);
      pos = next;
    }
    text = repaired;
  }
  // Variant seen in the wild: params/invoke closed with bare '<｜｜DSML｜｜>' instead of
  // '</｜｜DSML｜｜ invoke>'. Normalize it to the canonical form before parsing.
  if (text.includes("<｜｜DSML｜｜>") && !text.includes("</｜｜DSML｜｜ invoke>")) {
    const normalized = text
      .replace(/<｜｜DSML｜｜ invoke name="([^"]+)">/g, '<｜｜DSML｜｜ invoke name="$1">')
      .replace(/<｜｜DSML｜｜ parameter ([^>]*)>/g, "<｜｜DSML｜｜ parameter $1>")
      .replace(/<｜｜DSML｜｜>/g, "");
    // Re-wrap: naive normalization is lossy; instead parse structurally below.
  }
  // Secondary format observed when Codex's sandbox instructions differ:
  //   <shell_command>\n<command>...</command>\n</shell_command>
  if (text.includes("<shell_command>") && !text.includes("DSML")) {
    const toolCalls: DsmlToolCall[] = [];
    const blockRe = /<shell_command>\s*<command>([\s\S]*?)<\/command>\s*<\/shell_command>/g;
    let m: RegExpExecArray | null;
    let clean = text;
    while ((m = blockRe.exec(text)) !== null) {
      clean = clean.replace(m[0]!, "");
      toolCalls.push({
        name: "shell",
        arguments: { command: m[1]!.trim() },
        callId: `call_ds_${Math.random().toString(36).slice(2, 10)}`,
      });
    }
    clean = clean.replace(/<\/?shell_command>[\s\S]*$/g, "").trimEnd();
    return { cleanText: clean, toolCalls };
  }
  const toolCalls: DsmlToolCall[] = [];
  let cleanText = text;

  // Salvage: if the closing calls tag never arrived (stream cut), take everything from the
  // first opener as a block.
  let blockSource = text;
  const openIdx = text.indexOf("<｜｜DSML｜｜ calls>");
  if (openIdx >= 0 && !/<\/｜｜DSML｜｜ calls>/.test(text)) {
    blockSource = text.slice(0, openIdx) + text.slice(openIdx) + "</｜｜DSML｜｜ calls>";
  }
  const callsBlockRegex = /<｜｜DSML｜｜ calls>([\s\S]*?)<\/｜｜DSML｜｜ calls>/g;
  let match: RegExpExecArray | null;
  while ((match = callsBlockRegex.exec(blockSource)) !== null) {
    cleanText = cleanText.replace(match[0]!.replace("<\/｜｜DSML｜｜ calls>", ""), "");
    const inner = match[1]!;
    // Salvage unclosed invokes (stream cut mid-block): strip closed ones, then
    // anything starting with an opener is an incomplete call — parse its params.
    const closedInvoke = /<｜｜DSML｜｜ invoke name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜ invoke>/g;
    let innerRest = inner.replace(closedInvoke, "");
    const unclosedInvoke = /<｜｜DSML｜｜ invoke name="([^"]+)">([\s\S]*?)(?=<｜｜DSML｜｜ invoke|$)/g;
    let unclosedMatch: RegExpExecArray | null;
    while ((unclosedMatch = unclosedInvoke.exec(innerRest)) !== null) {
      const name = unclosedMatch[1]!;
      const body = unclosedMatch[2]!;
      const args: Record<string, unknown> = {};
      const salvageParam = /<｜｜DSML｜｜ parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜ parameter>/g;
      let pm2: RegExpExecArray | null;
      while ((pm2 = salvageParam.exec(body)) !== null) {
        let raw = pm2[2]!.trim();
        raw = raw.replace(/<\/?｜｜DSML｜｜[^>]*>/g, "").trim();
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch {}
        args[pm2[1]!] = parsed;
      }
      normalizeToolArgs(name, args);
      splitMergedParamValues(args);
      if (Object.keys(args).length === 0) continue;
      toolCalls.push({
        name,
        arguments: args,
        callId: `call_ds_${Math.random().toString(36).slice(2, 10)}`,
      });
    }
    const invokeRegex = /<｜｜DSML｜｜ invoke name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜ invoke>/g;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = invokeRegex.exec(inner)) !== null) {
      const name = invokeMatch[1]!;
      const body = invokeMatch[2]!;
      const args: Record<string, unknown> = {};
      const paramRegex = /<｜｜DSML｜｜ parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜ parameter>/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(body)) !== null) {
        const paramName = paramMatch[1]!;
        let raw = paramMatch[2]!.trim();
        // Defense-in-depth: strip any residual DSML tag fragments that leaked
        // into a value (closer variants glued onto the tail of the value).
        raw = raw.replace(/<\/?｜｜DSML｜｜[^>]*>/g, "").trim();
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep as string
        }
        args[paramName] = parsed;
      }
      normalizeToolArgs(name, args);
      splitMergedParamValues(args);
      if (Object.keys(args).length === 0) continue;
      toolCalls.push({
        name,
        arguments: args,
        callId: `call_ds_${Math.random().toString(36).slice(2, 10)}`,
      });
    }
  }

  // Salvage unclosed individual invokes: parameter lines may close with '</｜｜DSML｜｜ parameter>'
  // while the invoke itself never closed.
  const salvageInvoke = /<｜｜DSML｜｜ invoke name="([^"]+)">([\s\S]*?)(?=<\/｜｜DSML｜｜ invoke>|<｜｜DSML｜｜ \/invoke>|$)/g;
  if (/<｜｜DSML｜｜ invoke/.test(cleanText) && toolCalls.length === 0) {
    let m2: RegExpExecArray | null;
    while ((m2 = salvageInvoke.exec(cleanText)) !== null) {
      const name = m2[1]!;
      const body = m2[2]!;
      const args: Record<string, unknown> = {};
      const paramRegex = /<｜｜DSML｜｜ parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜ parameter>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRegex.exec(body)) !== null) {
        let raw = pm[2]!.trim();
        raw = raw.replace(/<\/?｜｜DSML｜｜[^>]*>/g, "").trim();
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch {}
        args[pm[1]!] = parsed;
      }
      normalizeToolArgs(name, args);
      splitMergedParamValues(args);
      // Drop salvaged calls whose args are empty — a real exec_command always has a cmd.
      // Pushing empty ones produced 'missing field cmd' parse errors in Codex.
      const hasRequiredArgs = Object.keys(args).length > 0;
      if (!hasRequiredArgs) continue;
      toolCalls.push({
        name,
        arguments: args,
        callId: `call_ds_${Math.random().toString(36).slice(2, 10)}`,
      });
    }
  }

  // Also strip stray DSML fragments/closers from visible text.
  cleanText = cleanText.replace(/<｜｜DSML｜｜[\s\S]*$/g, "");
  cleanText = cleanText.replace(/<\/?｜｜DSML｜｜[^>]*>/g, "");
  cleanText = cleanText.trimEnd();
  return { cleanText, toolCalls };
}

export interface CollectedCompletion extends CompletionResult {
  lastMessageId: number | null;
  /** false when the stream ended while the message was still WIP (needs /chat/continue) */
  finished: boolean;
  /** true when the upstream signalled a rate limit inside an HTTP 200 SSE stream */
  rateLimited?: boolean;
}

export async function collectSseText(
  upstream: ReadableStream<Uint8Array>,
): Promise<CollectedCompletion> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let thinking = "";
  let rateLimited = false;
  const state = {
    currentFragmentIsThink: false,
    lastMessageId: undefined as number | undefined,
    finished: false,
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    // DeepSeek web signals throttling as an in-band hint frame on HTTP 200:
    //   event: hint  data: {"type":"error","content":"Messages too frequent...","finish_reason":"rate_limit_reached"}
    // Without this the stream looks like a successful empty completion.
    if (raw.includes("rate_limit_reached") || raw.includes("Messages too frequent")) {
      rateLimited = true;
      return;
    }
    const delta = deltaFromPayload(raw, state);
    content += delta.text;
    thinking += delta.thinking;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    return {
      text: content,
      thinking,
      lastMessageId: state.lastMessageId ?? null,
      finished: state.finished,
      rateLimited,
    };
  } finally {
    reader.releaseLock();
  }
}

export interface DeepSeekClient {
  /** Perform a chat completion against DeepSeek web; returns the upstream stream. */
  streamCompletion(body: Record<string, unknown>): Promise<Response>;
  /** Continue a truncated assistant message (web UI "Continue" button). */
  continueCompletion(chatSessionId: string, messageId: number): Promise<Response>;
}

/**
 * Sticky session pool: maps a caller-supplied conversation id to one DeepSeek
 * chat_session so consecutive requests in the same task land in the SAME web
 * conversation (same context server-side). Sessions idle > ttlMs are pruned.
 */
export interface StickyEntry {
  chatSessionId: string;
  parentMessageId: number | null;
}

export class StickySessionPool {
  private map = new Map<
    string,
    { sessionId: string; lastUsed: number; parentMessageId: number | null }
  >();
  constructor(
    private createSession: () => Promise<string>,
    private ttlMs = 20 * 60 * 1000,
    private maxEntries = 16,
  ) {}

  async get(conversationId: string): Promise<StickyEntry> {
    this.prune();
    const existing = this.map.get(conversationId);
    if (existing) {
      existing.lastUsed = Date.now();
      return { chatSessionId: existing.sessionId, parentMessageId: existing.parentMessageId };
    }
    const sessionId = await this.createSession();
    this.map.set(conversationId, { sessionId, lastUsed: Date.now(), parentMessageId: null });
    return { chatSessionId: sessionId, parentMessageId: null };
  }

  setLastMessageId(conversationId: string, messageId: number | null): void {
    const existing = this.map.get(conversationId);
    if (existing && messageId !== null) {
      existing.parentMessageId = messageId;
      existing.lastUsed = Date.now();
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.map) {
      if (now - value.lastUsed > this.ttlMs) this.map.delete(key);
    }
    while (this.map.size > this.maxEntries) {
      let oldestKey = "";
      let oldest = Infinity;
      for (const [key, value] of this.map) {
        if (value.lastUsed < oldest) {
          oldest = value.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey) this.map.delete(oldestKey);
    }
  }
}

// Minimum wall-clock spacing between upstream chat calls (DeepSeek web
// rate-limits rapid messages). Configurable via DEEPSEEK_MIN_INTERVAL_MS.
let lastRequestAt = 0;
let rateLimitedUntil = 0;
const inflight = new Promise<void>((r) => r());
let chain: Promise<void> = inflight;

function parseInterval(env: string | undefined, fallback: number): number {
  if (!env) return fallback;
  const v = Number.parseInt(env, 10);
  return Number.isSafeInteger(v) && v >= 0 ? v : fallback;
}

export function createDeepSeekClient(
  config: RouterConfig,
  session: DeepSeekSession,
  deps: DeepSeekDependencies = {},
): DeepSeekClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const completionPath = "/api/v0/chat/completion";
  const minInterval = parseInterval(
    process.env.DEEPSEEK_MIN_INTERVAL_MS,
    20_000,
  );
  const maxRetries = parseInterval(process.env.DEEPSEEK_RATE_RETRIES, 5);
  const baseBackoffMs = parseInterval(process.env.DEEPSEEK_BACKOFF_MS, 60_000);

  async function streamCompletion(body: Record<string, unknown>): Promise<Response> {
    // Serialize upstream calls; enforce global spacing and rate-limit cooldown.
    const prev = chain;
    let release: () => void = () => {};
    chain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await attempt(body);
    } finally {
      release();
    }
  }

  async function waitForSlot(): Promise<void> {
    const now = Date.now();
    if (now < rateLimitedUntil) {
      const wait = rateLimitedUntil - now;
      console.error(`[rate-limiter] cooldown ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < minInterval) {
      const wait = minInterval - elapsed;
      console.error(`[rate-limiter] spacing ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
    lastRequestAt = Date.now();
  }

  async function attempt(body: Record<string, unknown>, tries = maxRetries): Promise<Response> {
    await waitForSlot();
    try {
      const response = await rawCompletion(body);
      if (response.status === 429) {
        response.body?.cancel();
        return retryOrThrow(tries);
      }
      return response;
    } catch (error) {
      if (error instanceof HttpError && error.code === "rate_limited") {
        return retryOrThrow(tries);
      }
      throw error;
    }
  }

  async function retryOrThrow(tries: number): Promise<Response> {
    if (tries <= 0) {
      throw new HttpError(429, "DeepSeek web rate limit persisted after retries", "rate_limited");
    }
    rateLimitedUntil = Date.now() + baseBackoffMs;
    console.error(
      `[rate-limiter] hit limit; backing off ${baseBackoffMs / 1000}s (${tries - 1} retries left)`,
    );
    await sleep(baseBackoffMs);
    return attempt(currentBody!, tries - 1);
  }

  let currentBody: Record<string, unknown> | undefined;

  async function rawCompletion(body: Record<string, unknown>): Promise<Response> {
    currentBody = body;
    const powResponse = await session.solveFor(completionPath);
    const headers = {
      ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
      ...(config.rawCookie ? { cookie: config.rawCookie } : {}),
      "content-type": "application/json",
      accept: "*/*",
      origin: baseUrl,
      referer: `${baseUrl}/`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      "x-client-platform": "web",
      "x-client-version": "2.5.0",
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "0",
      "x-ds-pow-response": powResponse,
    };

    return doFetch(`${baseUrl}${completionPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  }

  async function continueCompletion(chatSessionId: string, messageId: number): Promise<Response> {
    const continuePath = "/api/v0/chat/continue";
    const powResponse = await session.solveFor(continuePath);
    const headers = {
      ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
      ...(config.rawCookie ? { cookie: config.rawCookie } : {}),
      "content-type": "application/json",
      accept: "*/*",
      origin: baseUrl,
      referer: `${baseUrl}/`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      "x-client-platform": "web",
      "x-client-version": "2.5.0",
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "0",
      "x-ds-pow-response": powResponse,
    };
    return doFetch(`${baseUrl}${continuePath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ chat_session_id: chatSessionId, message_id: messageId, fallback_to_resume: true }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  }

  return { streamCompletion, continueCompletion };
}

export function normalizeJsonCompletion(
  result: CompletionResult,
  model: string,
  now: () => number = Date.now,
): Record<string, unknown> {
  return {
    id: `chatcmpl-ds-${now()}`,
    object: "chat.completion",
    created: Math.floor(now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: "stop",
      },
    ],
  };
}

export function newChatSessionId(): string {
  return randomUUID();
}
