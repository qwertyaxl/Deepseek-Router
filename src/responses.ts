import type { OpenAIChatRequest, RouterConfig } from "./types.js";

import {

  buildDeepSeekBody,

  chatStreamFromCollected,

  collectSseText,

  createDeepSeekClient,

  deltaFromPayload,

  normalizeJsonCompletion,

  type CollectedCompletion,

  type DeepSeekClient,

} from "./deepseek.js";

import { HttpError } from "./errors.js";

import type { DeepSeekSession } from "./session.js";

import { extractDsmlToolCalls, type DsmlToolCall } from "./deepseek.js";
import type { AccountPool } from "./accounts.js";

export interface ResponsesDeps {

  client: DeepSeekClient;

  session: DeepSeekSession;

  pool: AccountPool;

  config: RouterConfig;

  now?: () => number;

}

const encoder = new TextEncoder();

function isDefinitelyDsml(pending: string): boolean {

  return pending.includes("<\uFF5C\uFF5CDSML\uFF5C\uFF5C");

}

function resolveModel(requested: unknown, config: RouterConfig): string {

  const thinkingEntry = config.models.find((m) => m.includes("think"));

  const plainEntry = config.models.find((m) => !m.includes("think")) ?? config.models[0]!;

  const preferThinking = process.env.DEEPSEEK_THINKING_DEFAULT === "true";

  if (typeof requested === "string" && requested) {

    if (config.models.includes(requested)) {

      if (preferThinking && requested === plainEntry && thinkingEntry) return thinkingEntry;

      return requested;

    }

    return requested.toLowerCase().includes("think") ? thinkingEntry ?? plainEntry : plainEntry;

  }

  return preferThinking && thinkingEntry ? thinkingEntry : plainEntry;

}

function isThinkingModel(model: string, config: RouterConfig): boolean {

  return model.includes("thinking") && config.thinkingEnabled;

}

/** Convert Responses-API `input` (string or message array) into chat messages. */

function inputToMessages(input: unknown, instructions?: string): unknown {

  const messages: Array<{ role: string; content: string }> = [];

  if (instructions && typeof instructions === "string") {

    messages.push({ role: "system", content: instructions });

  }

  if (typeof input === "string") {

    messages.push({ role: "user", content: input });

    return messages;

  }

  if (!Array.isArray(input)) {

    throw new HttpError(400, "input must be a string or an array", "invalid_input");

  }

  for (const entry of input) {

    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;

    if (record.type === "function_call_output") {

      const output = typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? "");

      messages.push({ role: "assistant", content: `[Tool result]\n${output.slice(0, 8000)}` });

      continue;

    }

    if (record.type === "function_call") {

      const args = typeof record.arguments === "string" ? record.arguments : "{}";

      messages.push({

        role: "assistant",

        content: `[Tool call: ${String(record.name ?? "tool")}(${args.slice(0, 2000)})]`,

      });

      continue;

    }

    if (record.type && record.type !== "message") continue; // reasoning, etc.

    let role = typeof record.role === "string" ? record.role : "user";

    if (role === "developer") role = "system";

    if (role === "tool") role = "assistant";

    const content = record.content;

    if (typeof content === "string") {

      messages.push({ role, content });

      continue;

    }

    if (Array.isArray(content)) {

      const text = content

        .map((part) => {

          if (!part || typeof part !== "object") return "";

          const p = part as Record<string, unknown>;

          if (typeof p.text === "string") return p.text;

          if (p.type === "input_text" || p.type === "output_text") {

            return typeof p.text === "string" ? p.text : "";

          }

          return "";

        })

        .filter(Boolean)

        .join("");

      messages.push({ role, content: text });

    }

  }

  if (messages.length === 0) {

    throw new HttpError(400, "input contains no usable messages", "invalid_input");

  }

  return messages;

}

function sseEvent(event: string, payload: unknown): Uint8Array {

  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

}

/**

 * Translate a DeepSeek web SSE stream into an OpenAI Responses API event

 * stream (the wire format Codex consumes). Only the events Codex needs are

 * emitted: response.created, output item, output_text deltas, completed.

 */

/**
 * Buffered variant: build the full Responses SSE stream from an already-collected
 * completion (used after empty-turn auto-recovery on the streaming path).
 */
export function responsesStreamFromCollected(
  collected: { text: string; lastMessageId?: number | null; finished: boolean },
  model: string,
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const completionId = `resp-ds-${now()}`;
  let sequence = 0;
  const nextSeq = () => ++sequence;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const extracted = extractDsmlToolCalls(collected.text || "");
      const visible = extracted.cleanText;
      const toolCalls = extracted.toolCalls;
      const accumulated = visible;
      const sse = (event: string, data: Record<string, unknown>) =>
        new TextEncoder().encode(`event: ${event}
data: ${JSON.stringify(data)}

`);
      let itemStarted = false;
      if (accumulated) {
        itemStarted = true;
        controller.enqueue(sse("response.created", {
          type: "response.created",
          sequence_number: nextSeq(),
          response: { id: completionId, object: "response", status: "in_progress", model, output: [] },
        }));
        controller.enqueue(sse("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: 0,
          item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },
        }));
        controller.enqueue(sse("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: nextSeq(),
          item_id: "msg_0",
          output_index: 0,
          content_index: 0,
          delta: accumulated,
        }));
      }
      const outputItems: Record<string, unknown>[] = [];
      if (accumulated || !toolCalls.length) {
        outputItems.push({
          id: "msg_0", type: "message", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: accumulated, annotations: [] }],
        });
      }
      for (const call of toolCalls) {
        outputItems.push({
          id: call.callId, type: "function_call", name: call.name,
          arguments: JSON.stringify(call.arguments), call_id: call.callId, status: "completed",
        });
      }
      if (itemStarted) {
        controller.enqueue(sse("response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: nextSeq(),
          item_id: "msg_0",
          output_index: 0,
          content_index: 0,
          text: accumulated,
        }));
        controller.enqueue(sse("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: 0,
          item: { id: "msg_0", type: "message", status: "completed", role: "assistant",
                  content: [{ type: "output_text", text: accumulated, annotations: [] }] },
        }));
      }
      let toolIndex = accumulated || !toolCalls.length ? 1 : 0;
      for (const call of toolCalls) {
        controller.enqueue(sse("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: toolIndex++,
          item: { id: call.callId, type: "function_call", name: call.name,
                  arguments: JSON.stringify(call.arguments), call_id: call.callId, status: "completed" },
        }));
      }
      controller.enqueue(sse("response.completed", {
        type: "response.completed",
        sequence_number: nextSeq(),
        response: {
          id: completionId, object: "response", status: "completed", model,
          output: outputItems,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }));
      controller.close();
    },
  });
}

export function responsesStream(

  upstream: ReadableStream<Uint8Array>,

  model: string,

  now: () => number = Date.now,

): ReadableStream<Uint8Array> {  const completionId = `resp-ds-${now()}`;

  let sequence = 0;

  let cancelled = false;

  let accumulated = "";

  const dsmlState = { pending: "", buffered: "", buffering: false };

  return new ReadableStream<Uint8Array>({

    async start(controller) {

      const reader = upstream.getReader();

      const decoder = new TextDecoder();

      let buffer = "";

      let itemStarted = false;

      let done = false;

      const deltaState = { currentFragmentIsThink: false };

      const nextSeq = () => ++sequence;

      const finish = () => {

        if (done || cancelled) return;

        done = true;

        let toolCalls: DsmlToolCall[] = [];

        const tail = dsmlState.pending + dsmlState.buffered;

        if (tail) {

          const extracted = extractDsmlToolCalls(tail);

          toolCalls = extracted.toolCalls;

          const visible = dsmlState.buffering ? extracted.cleanText : tail;

          if (visible) {

            accumulated += visible;

            if (!itemStarted) {

              itemStarted = true;

              controller.enqueue(sseEvent("response.created", {

                type: "response.created",

                sequence_number: nextSeq(),

                response: { id: completionId, object: "response", status: "in_progress", model, output: [] },

              }));

              controller.enqueue(sseEvent("response.output_item.added", {

                type: "response.output_item.added",

                sequence_number: nextSeq(),

                output_index: 0,

                item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },

              }));

            }

            controller.enqueue(sseEvent("response.output_text.delta", {

              type: "response.output_text.delta",

              sequence_number: nextSeq(),

              item_id: "msg_0",

              output_index: 0,

              content_index: 0,

              delta: visible,

            }));

          }

        }

        const outputItems: Record<string, unknown>[] = [];

        if (accumulated || !toolCalls.length) {

          outputItems.push({

            id: "msg_0",

            type: "message",

            status: "completed",

            role: "assistant",

            content: [{ type: "output_text", text: accumulated, annotations: [] }],

          });

        }

        for (const call of toolCalls) {

          outputItems.push({

            id: call.callId,

            type: "function_call",

            name: call.name,

            arguments: JSON.stringify(call.arguments),

            call_id: call.callId,

          });

        }

        if (itemStarted) {

          controller.enqueue(

            sseEvent("response.output_text.done", {

              type: "response.output_text.done",

              sequence_number: nextSeq(),

              item_id: "msg_0",

              output_index: 0,

              content_index: 0,

            }),

          );

          controller.enqueue(

            sseEvent("response.output_item.done", {

              type: "response.output_item.done",

              sequence_number: nextSeq(),

              output_index: 0,

              item: {

                id: "msg_0",

                type: "message",

                status: "completed",

                role: "assistant",

                content: [{ type: "output_text", text: accumulated, annotations: [] }],

              },

            }),

          );

        }

        let toolIndex = accumulated || !toolCalls.length ? 1 : 0;

        for (const call of toolCalls) {

          controller.enqueue(

            sseEvent("response.output_item.done", {

              type: "response.output_item.done",

              sequence_number: nextSeq(),

              output_index: toolIndex++,

              item: {

                id: call.callId,

                type: "function_call",

                name: call.name,

                arguments: JSON.stringify(call.arguments),

                call_id: call.callId,

                status: "completed",

              },

            }),

          );

        }

        controller.enqueue(

          sseEvent("response.completed", {

            type: "response.completed",

            sequence_number: nextSeq(),

            response: {

              id: completionId,

              object: "response",

              status: "completed",

              model,

              output: (() => {

                const items: Record<string, unknown>[] = [];

                if (accumulated || !toolCalls.length) {

                  items.push({

                    id: "msg_0",

                    type: "message",

                    status: "completed",

                    role: "assistant",

                    content: [{ type: "output_text", text: accumulated, annotations: [] }],

                  });

                }

                for (const call of toolCalls) {

                  items.push({

                    id: call.callId,

                    type: "function_call",

                    name: call.name,

                    arguments: JSON.stringify(call.arguments),

                    call_id: call.callId,

                    status: "completed",

                  });

                }

                return items;

              })(),

              usage: {

                input_tokens: 0,

                output_tokens: 0,

                total_tokens: 0,

              },

            },

          }),

        );

        controller.close();

      };

      const processLine = (line: string) => {

        if (done || cancelled) return;

        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) return;

        const raw = trimmed.slice(5).trim();

        if (!raw || raw === "[DONE]") {

          if (raw === "[DONE]") finish();

          return;

        }

        let text = "";

        try {

          const delta = deltaFromPayload(raw, deltaState);

          text = delta.text;

          if (text) {

            if (dsmlState.buffering) {

              dsmlState.buffered += text;

              return;

            }

            const low = dsmlState.pending + text;

            if (isDefinitelyDsml(low)) {

              dsmlState.buffering = true;

              dsmlState.buffered = low;

              dsmlState.pending = "";

              return;

            }

            if (low.includes("<") && low.length < 64 && !low.includes(">")) {

              dsmlState.pending = low;

              return;

            }

            text = low;

            dsmlState.pending = "";

          }

          // thinking deltas are intentionally not forwarded to the Responses

          // stream; Codex expects either reasoning items or text, and mixing

          // them without proper reasoning item ids breaks the client.

        } catch (error) {

          // Upstream error frame: surface it as a failed response event and stop.

          const message = error instanceof Error ? error.message : "upstream error";

          console.error("[responsesStream] upstream frame error:", message);

          controller.enqueue(

            sseEvent("response.failed", {

              type: "response.failed",

              sequence_number: nextSeq(),

              response: {

                id: completionId,

                object: "response",

                status: "failed",

                model,

                error: { code: "upstream_error", message },

              },

            }),

          );

          done = true;

          controller.close();

          return;

        }

        if (!text) return;

        accumulated += text;

        if (!itemStarted) {

          itemStarted = true;

          controller.enqueue(

            sseEvent("response.created", {

              type: "response.created",

              sequence_number: nextSeq(),

              response: {

                id: completionId,

                object: "response",

                status: "in_progress",

                model,

                output: [],

              },

            }),

          );

          controller.enqueue(

            sseEvent("response.output_item.added", {

              type: "response.output_item.added",

              sequence_number: nextSeq(),

              output_index: 0,

              item: {

                id: "msg_0",

                type: "message",

                status: "in_progress",

                role: "assistant",

                content: [],

              },

            }),

          );

          controller.enqueue(

            sseEvent("response.content_part.added", {

              type: "response.content_part.added",

              sequence_number: nextSeq(),

              item_id: "msg_0",

              output_index: 0,

              content_index: 0,

              part: { type: "output_text", text: "", annotations: [] },

            }),

          );

        }

        controller.enqueue(

          sseEvent("response.output_text.delta", {

            type: "response.output_text.delta",

            sequence_number: nextSeq(),

            item_id: "msg_0",

            output_index: 0,

            content_index: 0,

            delta: text,

          }),

        );

      };

      try {

        while (true) {

          const { done: upstreamDone, value } = await reader.read();

          if (upstreamDone) break;

          if (cancelled) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);

          buffer = lines.pop() ?? "";

          for (const line of lines) processLine(line);

        }

        buffer += decoder.decode();

        if (buffer) processLine(buffer);

        finish();

      } catch (error) {

        if (!cancelled) {

          const message = error instanceof Error ? error.message : "stream error";

          console.error("[responsesStream] stream error:", message);

          controller.enqueue(

            sseEvent("response.failed", {

              type: "response.failed",

              sequence_number: nextSeq(),

              response: {

                id: completionId,

                object: "response",

                status: "failed",

                model,

                error: { code: "stream_error", message },

              },

            }),

          );

          controller.close();

        }

      } finally {

        reader.releaseLock();

      }

    },

    cancel() {

      cancelled = true;

    },

  });

}

export async function handleChatCompletion(

  body: OpenAIChatRequest,

  deps: ResponsesDeps,

  conversationId = "default",

): Promise<Response> {

  const { config, client, now = Date.now } = deps;

  // Unknown model ids (e.g. a stale default in a client config) are mapped to

  // the catalog: any id containing "think" maps to the thinking entry, others

  // to the plain entry. 404 is reserved for genuinely empty catalogs.

  const requestedModel = resolveModel(body.model, config);
  console.error(`[handleChatCompletion] resolved=${requestedModel}`);

  const turn = await deps.pool.pick(conversationId);

  const dsBody = buildDeepSeekBody(body, turn.chatSessionId, isThinkingModel(requestedModel, config), turn.parentMessageId);

  const upstream = await client.streamCompletion(dsBody);

  if (!upstream.ok || !upstream.body) {

    const detail = upstream.body ? await (upstream.body as unknown as { text(): Promise<string> }).text().catch(() => "") : "";

    throw new HttpError(

      upstream.status === 401 || upstream.status === 403 ? 401 : 502,

      `DeepSeek upstream failed: HTTP ${upstream.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,

      "upstream_error",

    );

  }

  // Buffer-first: collect fully (continuations, empty-turn auto-recovery,
  // validation) before any byte reaches the client. Forwards an empty or
  // truncated upstream never — those are real HTTP errors instead.
  const ctx = { chatSessionId: turn.chatSessionId, turn: turn.state, conversationId };
  let collected = await collectWithAutoContinue(upstream, deps, ctx);

  if (collected.rateLimited) {
    deps.pool.markRateLimited(turn.state);
    throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
  }

  // Empty-turn auto-recovery: rotate the web chat session once and retry.
  if (collected.text.length === 0 && collected.thinking.length === 0) {
    const rotated = await deps.pool.rotateConversation(turn.state, conversationId);
    const retryBody = buildDeepSeekBody(body, rotated.chatSessionId, isThinkingModel(requestedModel, config), rotated.parentMessageId);
    const retryUpstream = await client.streamCompletion(retryBody);
    if (!retryUpstream.ok || !retryUpstream.body) {
      throw new HttpError(
        502,
        `DeepSeek upstream failed on empty-turn retry: HTTP ${retryUpstream.status}`,
        "upstream_error",
      );
    }
    collected = await collectWithAutoContinue(
      retryUpstream,
      deps,
      { chatSessionId: rotated.chatSessionId, turn: turn.state, conversationId },
    );
    if (collected.rateLimited) {
      deps.pool.markRateLimited(turn.state);
      throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
    }
  }

  assertCollectedUsable(collected, deps, ctx);

  if (body.stream) {
    return new Response(chatStreamFromCollected(collected, requestedModel, now), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  return Response.json(normalizeJsonCompletion(collected, requestedModel, now));

}

export async function handleResponses(

  body: Record<string, unknown>,

  deps: ResponsesDeps,

  conversationId = "default",

): Promise<Response> {

  const { config, client, now = Date.now } = deps;

  const requestedModel = resolveModel(body.model, config);
  console.error(`[handleChatCompletion] resolved=${requestedModel}`);

  // Codex always declares its built-in tools (shell, apply_patch, ...) — they
  // are bridged via the DSML contract, never executed by DeepSeek web itself.

  console.error(`[handleResponses] tools=${Array.isArray(body.tools) ? body.tools.length : "none"} stream=${body.stream} input_items=${Array.isArray(body.input) ? body.input.length : "str"}`);

  // Tool bridge: Codex declares tools in the request, but DeepSeek web cannot
  // execute function calls natively. Tools pass through to buildDeepSeekBody,
  // which injects the shared DSML contract as a leading system block (same
  // builder the Chat Completions path uses — single source of truth).
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  void body.tool_choice;

  const chatRequest: OpenAIChatRequest = {
    messages: inputToMessages(body.input, typeof body.instructions === "string" ? body.instructions : ""),
    stream: body.stream === true,
    ...(tools.length ? { tools } : {}),
  };

  const turn = await deps.pool.pick(conversationId);

  const dsBody = buildDeepSeekBody(chatRequest, turn.chatSessionId, isThinkingModel(requestedModel, config), turn.parentMessageId);

  const upstream = await client.streamCompletion(dsBody);

  if (!upstream.ok || !upstream.body) {

    const detail = upstream.body ? await (upstream.body as unknown as { text(): Promise<string> }).text().catch(() => "") : "";

    throw new HttpError(

      upstream.status === 401 || upstream.status === 403 ? 401 : 502,

      `DeepSeek upstream failed: HTTP ${upstream.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,

      "upstream_error",

    );

  }

  // Buffer-first: fully collect the upstream SSE (continuations, empty-turn
  // recovery and validation) BEFORE anything reaches the client. Codex treats
  // a completed response with no output items as a finished (empty) turn, so
  // an empty upstream stream must never be forwarded as-is.
  const ctx = { chatSessionId: turn.chatSessionId, turn: turn.state, conversationId };
  let collected = await collectWithAutoContinue(upstream, deps, ctx);

  if (collected.rateLimited) {
    deps.pool.markRateLimited(turn.state);
    throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
  }

  // Empty-turn auto-recovery (responses path): rotate web session once and retry.
  if (collected.text.length === 0 && collected.thinking.length === 0) {
    const rotated = await deps.pool.rotateConversation(turn.state, conversationId);
    const retryBody = buildDeepSeekBody(chatRequest, rotated.chatSessionId, isThinkingModel(requestedModel, config), rotated.parentMessageId);
    const retryUpstream = await client.streamCompletion(retryBody);
    if (!retryUpstream.ok || !retryUpstream.body) {
      throw new HttpError(
        502,
        `DeepSeek upstream failed on empty-turn retry: HTTP ${retryUpstream.status}`,
        "upstream_error",
      );
    }
    collected = await collectWithAutoContinue(
      retryUpstream,
      deps,
      { chatSessionId: rotated.chatSessionId, turn: turn.state, conversationId },
    );
    if (collected.rateLimited) {
      deps.pool.markRateLimited(turn.state);
      throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
    }
  }

  assertCollectedUsable(collected, deps, ctx);

  if (body.stream === true) {
    return new Response(responsesStreamFromCollected(collected, requestedModel, now), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  // Non-streaming shape mirrors responsesStreamFromCollected: DSML blocks are
  // extracted into function_call items, never left as visible text.
  const extracted = extractDsmlToolCalls(collected.text || "");
  const output: Record<string, unknown>[] = [];
  if (extracted.cleanText || extracted.toolCalls.length === 0) {
    output.push({
      id: "msg_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: extracted.cleanText, annotations: [] }],
    });
  }
  for (const call of extracted.toolCalls) {
    output.push({
      id: call.callId,
      type: "function_call",
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      call_id: call.callId,
      status: "completed",
    });
  }

  return Response.json({
    id: `resp-ds-${now()}`,
    object: "response",
    status: "completed",
    model: requestedModel,
    output,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
}

/** Maximum /chat/continue requests after the initial stream (4 streams total). */
const MAX_CONTINUATIONS = 3;

/** Overall wall-clock budget for the whole collect + continue chain. */
const CONTINUE_CHAIN_BUDGET_MS = 180_000;

interface CollectContext {
  chatSessionId: string;
  turn: import("./accounts.js").AccountState;
  conversationId: string;
}

/**
 * Collect an upstream stream, auto-continuing truncated messages (web
 * "Continue"). Shared by both endpoints and both response modes.
 *
 * Stops — and never loops forever — when the message reports FINISHED, when a
 * rate limit is signalled, when a continuation fails, when no visible progress
 * is made, after MAX_CONTINUATIONS continuation requests, or when the
 * wall-clock budget runs out. The continuation budget is checked BEFORE sending
 * another request, so no response is ever issued and discarded. Callers must
 * check `finished` / `rateLimited` before treating the result as success: a
 * truncated chain is surfaced as an error, not an answer.
 */
async function collectWithAutoContinue(
  upstream: Response,
  deps: ResponsesDeps,
  ctx: CollectContext,
): Promise<CollectedCompletion> {
  const now = deps.now ?? Date.now;
  const deadline = now() + CONTINUE_CHAIN_BUDGET_MS;
  let stream = upstream.body;
  let merged: CollectedCompletion | null = null;
  let continuations = 0;

  while (stream) {
    const partial = await collectSseText(stream);
    stream = null;
    // Progress = visible content, an explicit finish, or a throttle signal.
    const hadProgress =
      partial.text.length > 0 ||
      partial.thinking.length > 0 ||
      partial.finished ||
      !!partial.rateLimited;
    merged = merged
      ? {
          text: merged.text + partial.text,
          thinking: merged.thinking + partial.thinking,
          lastMessageId: partial.lastMessageId ?? merged.lastMessageId,
          finished: partial.finished,
          rateLimited: merged.rateLimited || partial.rateLimited,
        }
      : partial;
    if (merged.finished || merged.rateLimited) break;
    if (!hadProgress) break; // nothing to continue from; caller recovers (rotate/retry)
    if (merged.lastMessageId === null) break; // cannot continue without a message id
    if (continuations >= MAX_CONTINUATIONS) break; // budget checked before sending
    if (now() >= deadline) break;
    continuations++;
    // Message truncated: ask DeepSeek to continue it (queued like any other call).
    const cont = await deps.client.continueCompletion(ctx.chatSessionId, merged.lastMessageId);
    if (!cont.ok || !cont.body) break; // caller surfaces this as an incomplete chain
    stream = cont.body;
  }

  const result: CollectedCompletion = merged ?? {
    text: "",
    thinking: "",
    lastMessageId: null,
    finished: false,
  };
  return { ...result, continuationsUsed: continuations };
}

/**
 * Shared post-collection validation: turn a collected completion into either a
 * success for the caller or a thrown HttpError. Never reports an empty turn or
 * a truncated chain as a successful completion.
 */
function assertCollectedUsable(
  collected: CollectedCompletion,
  deps: ResponsesDeps,
  ctx: CollectContext,
): void {
  if (collected.rateLimited) {
    deps.pool.markRateLimited(ctx.turn);
    throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
  }
  if (collected.text.length === 0 && collected.thinking.length === 0) {
    throw new HttpError(502, "DeepSeek web returned an empty completion", "empty_completion");
  }
  if (!collected.finished) {
    throw new HttpError(
      502,
      `DeepSeek web message did not finish after ${collected.continuationsUsed ?? 0} continuation(s)`,
      "incomplete_completion",
    );
  }
  deps.pool.setLastMessageId(ctx.turn, ctx.conversationId, collected.lastMessageId);
  deps.pool.markSuccess(ctx.turn);
}

export function createDeps(

  config: RouterConfig,

  client: DeepSeekClient,

  session: DeepSeekSession,

  pool: AccountPool,

): ResponsesDeps {

  return { config, client, session, pool, now: Date.now };

}

export { createDeepSeekClient };

