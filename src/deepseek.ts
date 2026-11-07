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
  const out: ChatMessage[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new HttpError(400, `messages[${index}] must be an object`, "invalid_messages");
    }
    const record = entry as Record<string, unknown>;
    const role = record.role;

    // OpenAI tool protocol: an assistant turn may carry tool_calls, and each
    // tool turn answers one of them by tool_call_id. Flatten both into text so
    // the web prompt keeps the full call/result transcript.
    if (role === "tool") {
      const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
      const content = typeof record.content === "string" ? record.content : JSON.stringify(record.content ?? "");
      out.push({
        role: "assistant",
        content: `[Tool result${toolCallId ? ` for ${toolCallId}` : ""}]\n${content.slice(0, 8000)}`,
      });
      return;
    }
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new HttpError(
        400,
        `messages[${index}].role must be system, user, assistant, or tool`,
        "unsupported_message_role",
      );
    }
    let content = typeof record.content === "string" ? record.content : "";
    if (role === "assistant" && Array.isArray(record.tool_calls)) {
      const calls = (record.tool_calls as Record<string, unknown>[]).map((call) => {
        const fn = (call?.function ?? {}) as Record<string, unknown>;
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        return `[Tool call: ${String(fn.name ?? "tool")}(${args.slice(0, 2000)})]`;
      });
      content = [content, ...calls].filter(Boolean).join("\n");
    }
    if (typeof record.content !== "string" && !(role === "assistant" && Array.isArray(record.tool_calls))) {
      throw new HttpError(
        400,
        `messages[${index}].content must be a string`,
        "unsupported_content_type",
      );
    }
    out.push({ role, content });
  });
  return out;
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

/**
 * DSML tool contract shared by both endpoints. Clients like Hermes/Codex
 * always declare tools; DeepSeek web cannot execute functions natively, so the
 * schemas are injected into the prompt and the model answers with DSML blocks
 * that the router parses back into structured tool calls.
 */
export function buildToolSystemPrompt(tools: unknown[]): string {
  const defs = tools
    .map((tool) => {
      const fn = ((tool ?? {}) as Record<string, unknown>).function ?? tool;
      const record = (fn ?? {}) as Record<string, unknown>;
      const name = String(record.name ?? "tool");
      const params = JSON.stringify(record.parameters ?? {});
      return `- ${name}: args JSON schema ${params}`;
    })
    .join("\n");
  return [
    "You have access to the following tools in this environment:",
    defs,
    "",
    "To call a tool, output EXACTLY this format and nothing else after it:",
    "<｜｜DSML｜｜ calls>",
    '<｜｜DSML｜｜ invoke name="TOOL_NAME">',
    '<｜｜DSML｜｜ parameter name="PARAM">value</｜｜DSML｜｜ parameter>',
    "</｜｜DSML｜｜ invoke>",
    "</｜｜DSML｜｜ calls>",
    "",
    "Rules: emit at most one calls block per reply; parameters must match the schema names; do not wrap the block in code fences; after the block output nothing else. Wait for tool results before continuing.",
  ].join("\n");
}

export function buildDeepSeekBody(
  input: OpenAIChatRequest,
  chatSessionId: string,
  thinking: boolean,
  parentMessageId: number | null = null,
): Record<string, unknown> {
  const messages = validateMessages(input.messages);
  // Tool bridge: accept declared tools instead of rejecting the request.
  // tool_choice is accepted but ignored (the model decides when to call).
  const tools = Array.isArray(input.tools) ? input.tools : [];
  if (tools.length > 0) {
    messages.unshift({ role: "system", content: buildToolSystemPrompt(tools) });
  }
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

/** Parser state: fragments are tracked individually so full-state updates can
 * be de-duplicated against content already emitted (verified live protocol:
 * fragment content arrives BOTH as appends and later inside full-state list
 * updates). */
export interface DeltaState {
  currentFragmentIsThink: boolean;
  lastMessageId?: number;
  finished?: boolean;
  /** per-fragment THINK flag, keyed by position (internal, lazily created) */
  fragmentTypes?: boolean[];
  /** per-fragment emitted content length (internal, lazily created) */
  fragmentLens?: number[];
}

function ensureFragmentSlots(state: DeltaState, count: number): void {
  state.fragmentTypes ??= [];
  state.fragmentLens ??= [];
  while (state.fragmentTypes.length < count) {
    state.fragmentTypes.push(state.currentFragmentIsThink);
    state.fragmentLens.push(0);
  }
}

/** Emit only the not-yet-emitted suffix of a fragment's content. */
function fragmentSuffix(
  state: DeltaState,
  index: number,
  isThink: boolean,
  full: string,
): { text: string; thinking: string } {
  ensureFragmentSlots(state, index + 1);
  state.fragmentTypes![index] = isThink;
  const prev = state.fragmentLens![index] ?? 0;
  const suffix = full.length > prev ? full.slice(prev) : "";
  if (full.length > prev) state.fragmentLens![index] = full.length;
  state.currentFragmentIsThink = isThink;
  return isThink ? { text: "", thinking: suffix } : { text: suffix, thinking: "" };
}

export function deltaFromPayload(
  raw: string,
  state: DeltaState,
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
      fragments.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const frag = entry as Record<string, unknown>;
        if (frag.type !== "THINK" && frag.type !== "RESPONSE") return;
        const suffix = fragmentSuffix(state, index, frag.type === "THINK", typeof frag.content === "string" ? frag.content : "");
        text += suffix.text;
        thinking += suffix.thinking;
      });
      if (response?.status === "FINISHED") {
        // Fully-contained answer: emit its fragments and mark the chain done.
        state.finished = true;
        return { text, thinking, finishReason: "stop" };
      }
      // WIP (or unknown) status: the stream continues after this envelope.
      // Emit what it already carries; subsequent deltas append to it.
      return { text, thinking, finishReason: null };
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

  if (path !== undefined) {
    // Fragment-addressed frames (verified live protocol):
    //   {"p":"response/fragments","o":"APPEND","v":[{type,content}, ...]}
    //     — new fragment(s) appended after the existing ones;
    //   {"p":"response/fragments","v":[{type,content}, ...]}   (no op)
    //     — FULL state update: re-carries everything emitted so far, so only
    //       the per-fragment suffix beyond what was already emitted is new;
    //   {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
    //     — append to the LAST fragment (-1); positive indexes may appear.
    // Everything else (title, session, BATCH metadata, elapsed_secs, ...) is
    // not answer text.
    if (path === "response/fragments" && Array.isArray(value)) {
      const appendNew = op === "APPEND";
      let text = "";
      let thinking = "";
      value.forEach((entry, offset) => {
        if (!entry || typeof entry !== "object") return;
        const frag = entry as Record<string, unknown>;
        if (frag.type !== "THINK" && frag.type !== "RESPONSE") return;
        const isThink = frag.type === "THINK";
        const content = typeof frag.content === "string" ? frag.content : "";
        if (appendNew) {
          ensureFragmentSlots(state, state.fragmentTypes?.length ?? 0);
          const index = (state.fragmentTypes?.length ?? 0) + offset;
          const suffix = fragmentSuffix(state, index, isThink, content);
          text += suffix.text;
          thinking += suffix.thinking;
        } else {
          const suffix = fragmentSuffix(state, offset, isThink, content);
          text += suffix.text;
          thinking += suffix.thinking;
        }
      });
      return { text, thinking, finishReason: null };
    }
    const contentMatch = /^response\/fragments\/(-?\d+)\/content$/.exec(path);
    if (contentMatch && op === "APPEND" && typeof value === "string" && value) {
      state.fragmentTypes ??= [];
      state.fragmentLens ??= [];
      let index = Number.parseInt(contentMatch[1]!, 10);
      if (Number.isNaN(index) || index < 0) index = Math.max(state.fragmentTypes.length - 1, 0);
      ensureFragmentSlots(state, index + 1);
      const isThink = state.fragmentTypes[index] ?? state.currentFragmentIsThink;
      state.fragmentTypes[index] = isThink;
      state.fragmentLens[index] = (state.fragmentLens[index] ?? 0) + value.length;
      state.currentFragmentIsThink = isThink;
      return isThink
        ? { text: "", thinking: value, finishReason: null }
        : { text: value, thinking: "", finishReason: null };
    }
    // Any other path-bearing frame is metadata.
    return { text: "", thinking: "", finishReason: null };
  }

  if (frame.event === "close") {
    // Transport close. Not proof that a WIP message finished semantically —
    // the collector keeps finished=false so auto-continue can pick it up.
    return { text: "", thinking: "", finishReason: "stop" };
  }

  // Bare delta: {"v":"text"} — appends to the current (last) fragment. Objects
  // here are envelopes/heartbeats with no visible delta. The append must also
  // advance the fragment bookkeeping so later full-state updates do not
  // re-emit this content.
  if (typeof value === "string") {
    state.fragmentTypes ??= [];
    state.fragmentLens ??= [];
    const last = Math.max(state.fragmentTypes.length - 1, 0);
    ensureFragmentSlots(state, last + 1);
    state.fragmentTypes[last] = state.currentFragmentIsThink;
    state.fragmentLens[last] = (state.fragmentLens[last] ?? 0) + value.length;
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
  // Codex's exec_command requires {cmd}; models frequently emit {command}.
  // Only alias for exec-style tools — clients whose schema says {command}
  // (e.g. Hermes's shell tool) must receive their declared names untouched.
  if (n.includes("exec")) {
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
  /** how many /chat/continue requests were issued while collecting */
  continuationsUsed?: number;
}

/**
 * DeepSeek web signals throttling as an in-band hint frame on HTTP 200:
 *   event: hint  data: {"type":"error","content":"Messages too frequent...","finish_reason":"rate_limit_reached"}
 * Detect it structurally so ordinary answer text that merely mentions rate
 * limits is never mistaken for a throttle signal.
 */
function isRateLimitFrame(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      if (parsed.finish_reason === "rate_limit_reached") return true;
      return (
        parsed.type === "error" &&
        typeof parsed.content === "string" &&
        /rate limit|too frequent/i.test(parsed.content)
      );
    }
    return false;
  } catch {
    // Not JSON: only a bare line matching the known error payload counts.
    return raw.includes("rate_limit_reached") || /Messages too frequent/i.test(raw);
  }
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
    if (isRateLimitFrame(raw)) {
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

  function webHeaders(powResponse: string): Record<string, string> {
    return {
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
  }

  async function rawCompletion(body: Record<string, unknown>): Promise<Response> {
    currentBody = body;
    const powResponse = await session.solveFor(completionPath);
    return doFetch(`${baseUrl}${completionPath}`, {
      method: "POST",
      headers: webHeaders(powResponse),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  }

  async function continueCompletion(chatSessionId: string, messageId: number): Promise<Response> {
    // Continuations share the same serialization, spacing and cooldown as
    // completions — chain hops must not jump the rate-limiter queue.
    const prev = chain;
    let release: () => void = () => {};
    chain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      await waitForSlot();
      const continuePath = "/api/v0/chat/continue";
      const powResponse = await session.solveFor(continuePath);
      return await doFetch(`${baseUrl}${continuePath}`, {
        method: "POST",
        headers: webHeaders(powResponse),
        body: JSON.stringify({ chat_session_id: chatSessionId, message_id: messageId, fallback_to_resume: true }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } finally {
      release();
    }
  }

  return { streamCompletion, continueCompletion };
}

export function normalizeJsonCompletion(
  result: CompletionResult,
  model: string,
  now: () => number = Date.now,
): Record<string, unknown> {
  // DSML tool bridge: parse the model's DSML blocks into OpenAI tool_calls so
  // agentic clients (Hermes, any OpenAI SDK) can execute them.
  const { cleanText, toolCalls } = extractDsmlToolCalls(result.text || "");
  const message: Record<string, unknown> = { role: "assistant", content: cleanText };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return {
    id: `chatcmpl-ds-${now()}`,
    object: "chat.completion",
    created: Math.floor(now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
  };
}

const chunkEncoder = new TextEncoder();

/**
 * Chat Completions streaming format (what Hermes/OpenAI SDKs expect):
 * `chat.completion.chunk` deltas terminated by `data: [DONE]`. The router is
 * buffer-first, so the whole answer — including any DSML tool calls — is known
 * before the first chunk is emitted.
 */
export function chatStreamFromCollected(
  collected: CompletionResult,
  model: string,
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const { cleanText, toolCalls } = extractDsmlToolCalls(collected.text || "");
  const id = `chatcmpl-ds-${now()}`;
  const created = Math.floor(now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null): Uint8Array =>
    chunkEncoder.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk({ role: "assistant", content: "" }, null));
      if (cleanText) controller.enqueue(chunk({ content: cleanText }, null));
      toolCalls.forEach((call, index) => {
        controller.enqueue(
          chunk(
            {
              tool_calls: [
                {
                  index,
                  id: call.callId,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ],
            },
            null,
          ),
        );
      });
      controller.enqueue(chunk({}, toolCalls.length > 0 ? "tool_calls" : "stop"));
      controller.enqueue(chunkEncoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

export function newChatSessionId(): string {
  return randomUUID();
}
